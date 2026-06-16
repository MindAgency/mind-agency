/**
 * rag.ts — Industrial-grade RAG system
 *
 * Components:
 * - Embedding: BGE-small-zh via @xenova/transformers
 * - Vector Store: LanceDB (local, no server needed)
 * - Chunking: 512 tokens with 50 overlap
 * - Reranking: BGE-Reranker
 * - Hybrid scoring: BM25 (TF-IDF) + neural embedding fusion via SimHash
 * - Deduplication: SimHash fingerprints for fast near-duplicate detection
 */

import fs from 'fs';
import path from 'path';
import { MIND_DIR, AGENTS_DIR, GROUPS_DIR } from './data-dir';
import { createLogger } from '@/lib/logger';
import type { Connection, Table } from '@lancedb/lancedb';

const log = createLogger('rag');

// ── Types ────────────────────────────────────────────────

export interface RAGDocument {
  id: string;
  content: string;
  metadata: {
    source: 'memory' | 'skill' | 'knowledge' | 'group_knowledge' | 'session';
    agent?: string;
    group?: string;
    key?: string;
    fileName?: string;
    chunkIndex?: number;
    timestamp: number;
  };
}

export interface RAGResult {
  document: RAGDocument;
  score: number;
  scoreBreakdown?: { bm25: number; neural: number; fused: number };
}

export interface ChunkOptions {
  maxTokens?: number;
  overlap?: number;
}

/** Shape of a record inserted into the LanceDB vector table. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface LanceRecord extends Record<string, unknown> {
  id: string;
  content: string;
  vector: number[];
  source: string;
  agent: string;
  group: string;
  key: string;
  fileName: string;
  chunkIndex: number;
  timestamp: number;
}

/** Shape of a row returned from a LanceDB query. */
interface LanceRow {
  id: string;
  content: string;
  source: string;
  agent: string;
  group: string;
  key: string;
  fileName: string;
  chunkIndex: number;
  timestamp: number;
  _distance?: number;
}

/** Callable signature shared by @xenova/transformers pipeline outputs. */
type PipelineFn = (input: unknown, options?: Record<string, unknown>) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

/** Callable signature for reranker pipeline output. */
type RerankerFn = (input: unknown, options?: Record<string, unknown>) => Promise<Array<{ score: number }>>;

// ── Constants ────────────────────────────────────────────

const RAG_DIR = path.join(MIND_DIR, 'rag');
const LANCE_DIR = path.join(RAG_DIR, 'lance');
const MODELS_DIR = path.join(RAG_DIR, 'models');
const TFIDF_DIR = path.join(RAG_DIR, 'tfidf');
const SIMHASH_DIR = path.join(RAG_DIR, 'simhash');

const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 512,
  overlap: 50,
};

const EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5';
const RERANKER_MODEL = 'Xenova/bge-reranker-base-zh-v1.5';

const TABLE_NAME = 'mind_rag';

// Hybrid scoring weights (tunable)
const HYBRID_BM25_WEIGHT = 0.4;
const HYBRID_NEURAL_WEIGHT = 0.6;

// SimHash deduplication threshold (Hamming distance)
const SIMHASH_DEDUP_THRESHOLD = 3;

// ── Globals ──────────────────────────────────────────────

let embeddingPipeline: unknown = null;
let rerankerPipeline: unknown = null;
let db: Connection | null = null;
let table: Table | null = null;

// ── SimHash for fast deduplication ───────────────────────
// SimHash produces a 64-bit fingerprint using two 32-bit halves;
// documents with Hamming distance <= threshold are near-duplicates.

function simHash(text: string): [number, number] {
  // Tokenize into shingles (3-grams)
  const clean = text.toLowerCase().replace(/[^\w一-鿿]/g, ' ');
  const tokens = clean.split(/\s+/).filter(t => t.length > 0);
  const shingles: string[] = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    shingles.push(tokens[i] + tokens[i + 1] + tokens[i + 2]);
  }
  if (shingles.length === 0) {
    // Fallback: use full text hash
    const h = simpleStringHash(text);
    return [h, h ^ 0x5BD1E995];
  }

  // Hash each shingle to 64 bits, then combine via weighted voting
  const v = new Array(64).fill(0);
  for (const s of shingles) {
    const h = simpleStringHash(s);
    const h2 = simpleStringHash(s + '_salt');
    // Use h for lower 32 bits, h2 for upper 32 bits
    for (let i = 0; i < 32; i++) {
      v[i] += ((h >>> i) & 1) === 1 ? 1 : -1;
      v[i + 32] += ((h2 >>> i) & 1) === 1 ? 1 : -1;
    }
  }

  // Convert to two 32-bit numbers
  let lo = 0, hi = 0;
  for (let i = 0; i < 32; i++) {
    if (v[i] > 0) lo |= (1 << i);
    if (v[i + 32] > 0) hi |= (1 << i);
  }
  return [lo, hi];
}

function escapeLike(s: string): string {
  return s.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function simpleStringHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function hammingDistance(a: [number, number], b: [number, number]): number {
  let xor = (a[0] ^ b[0]) | 0;
  let count = 0;
  // Count bits in lower half
  let x = xor;
  while (x !== 0) { count += x & 1; x = x >>> 1; }
  // Count bits in upper half
  xor = (a[1] ^ b[1]) | 0;
  x = xor;
  while (x !== 0) { count += x & 1; x = x >>> 1; }
  return count;
}

// SimHash index: store fingerprints for dedup
const simHashIndex = new Map<string, { fingerprint: [number, number]; docId: string }[]>();

function addToSimHashIndex(docId: string, content: string): boolean {
  const fp = simHash(content);
  const bucket = content.slice(0, 10); // rough bucket by prefix
  const entries = simHashIndex.get(bucket) || [];

  // Check for near-duplicates
  for (const entry of entries) {
    if (hammingDistance(entry.fingerprint, fp) <= SIMHASH_DEDUP_THRESHOLD) {
      return true; // duplicate found
    }
  }

  entries.push({ fingerprint: fp, docId });
  simHashIndex.set(bucket, entries);
  return false; // not a duplicate
}

// ── Initialization ───────────────────────────────────────

async function ensureDirs(): Promise<void> {
  for (const dir of [RAG_DIR, LANCE_DIR, MODELS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

async function getEmbeddingPipeline(): Promise<unknown> {
  if (embeddingPipeline) return embeddingPipeline;

  try {
    const { pipeline } = await import('@xenova/transformers');
    embeddingPipeline = await pipeline('feature-extraction', EMBEDDING_MODEL, {
      cache_dir: MODELS_DIR,
    });
    log.info('Embedding model loaded:', EMBEDDING_MODEL);
    return embeddingPipeline;
  } catch (error) {
    log.warn('Failed to load embedding model, using fallback:', error);
    // Fallback: simple hash-based embedding
    return {
      async call(text: string) {
        const hash = simpleHash(text);
        return { data: hash };
      }
    };
  }
}

async function getRerankerPipeline(): Promise<unknown> {
  if (rerankerPipeline) return rerankerPipeline;

  try {
    const { pipeline } = await import('@xenova/transformers');
    rerankerPipeline = await pipeline('text-classification', RERANKER_MODEL, {
      cache_dir: MODELS_DIR,
    });
    log.info('Reranker model loaded:', RERANKER_MODEL);
    return rerankerPipeline;
  } catch (error) {
    log.warn('Failed to load reranker model, will skip reranking:', error);
    // Return null to indicate reranking is not available
    return null;
  }
}

// Simple hash-based embedding fallback
function simpleHash(text: string): number[] {
  const hash = new Array(384).fill(0);
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    hash[i % 384] += charCode;
  }
  // Normalize
  const norm = Math.sqrt(hash.reduce((sum, val) => sum + val * val, 0));
  return hash.map(val => val / (norm || 1));
}

async function getDb(): Promise<Connection> {
  if (db) return db;

  await ensureDirs();
  const lancedb = await import('@lancedb/lancedb');
  db = await lancedb.connect(LANCE_DIR);
  log.info('LanceDB initialized at:', LANCE_DIR);
  return db;
}

async function getTable(): Promise<Table> {
  if (table) return table;

  const database = await getDb();

  try {
    // Try to open existing table
    table = await database.openTable(TABLE_NAME);
    log.info('Opened existing table:', TABLE_NAME);
  } catch {
    // Create new table with schema
    table = await database.createTable(TABLE_NAME, [
      {
        id: 'placeholder',
        content: 'placeholder',
        vector: new Array(384).fill(0), // BGE-small-zh produces 384-dim vectors
        source: 'memory',
        agent: '',
        group: '',
        key: '',
        fileName: '',
        chunkIndex: 0,
        timestamp: Date.now(),
      },
    ]);
    // Remove placeholder
    await table.delete('id = "placeholder"');
    log.info('Created new table:', TABLE_NAME);
  }

  return table;
}

// ── Embedding ────────────────────────────────────────────

/**
 * Generates a 384-dimensional embedding vector for the given text.
 *
 * Uses BGE-small-zh-v1.5 via a local ONNX pipeline. Falls back to a
 * simple hash-based embedding when the model is unavailable.
 *
 * @param text - The text to embed.
 * @returns A 384-element numeric vector representing the semantic content.
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline() as PipelineFn;
  try {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch {
    // Fallback for simple hash
    return simpleHash(text);
  }
}

/**
 * Generates embedding vectors for an array of texts in batches of 32.
 *
 * More efficient than calling {@link embed} in a loop because it leverages
 * batched inference on the ONNX model.
 *
 * @param texts - The texts to embed.
 * @returns An array of 384-dimensional embedding vectors, one per input text.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const pipe = await getEmbeddingPipeline() as PipelineFn;
  try {
    const results: number[][] = [];

    // Process in batches of 32
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32);
      const output = await pipe(batch, { pooling: 'mean', normalize: true });
      if (output.dims) {
        // Normal embedding output with dims metadata
        for (let j = 0; j < batch.length; j++) {
          results.push(Array.from(output.data.slice(j * output.dims[1], (j + 1) * output.dims[1])));
        }
      } else {
        // Fallback (simpleHash) — output.data is already the full vector
        for (let j = 0; j < batch.length; j++) {
          results.push(Array.from(output.data));
        }
      }
    }

    return results;
  } catch {
    // Fallback for simple hash
    return texts.map(t => simpleHash(t));
  }
}

// ── Chunking ─────────────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough estimate: 1 Chinese char ≈ 2 tokens, 1 English word ≈ 1 token
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  return chineseChars * 2 + englishWords;
}

/**
 * Splits text into overlapping chunks suitable for embedding.
 *
 * Structure-aware: respects markdown H1/H2/H3 headings by merging each
 * heading with its following content before chunking. Falls back to
 * paragraph-level splitting when no headings are present.
 *
 * @param text   - The full text to split.
 * @param options - Optional chunk size and overlap settings.
 * @param options.maxTokens - Maximum tokens per chunk (default 512).
 * @param options.overlap   - Number of overlapping tokens between chunks (default 50).
 * @returns An array of text chunks, each within the token limit.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const { maxTokens = 512, overlap = 50 } = options;

  // ── Structure-aware splitting: respect markdown headings ──
  // Split on H1/H2/H3 headings to keep semantic units together
  const sections = text.split(/^(#{1,3}\s+.+)$/m).filter(s => s.trim());
  const chunks: string[] = [];

  // Merge heading with its content
  const mergedSections: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (/^#{1,3}\s+/.test(sections[i]) && i + 1 < sections.length) {
      mergedSections.push(sections[i] + '\n\n' + sections[i + 1]);
      i++; // skip next section (already merged)
    } else {
      mergedSections.push(sections[i]);
    }
  }

  // If we have meaningful sections, chunk within them
  if (mergedSections.length > 1) {
    for (const section of mergedSections) {
      const sectionTokens = estimateTokens(section);
      if (sectionTokens <= maxTokens) {
        chunks.push(section.trim());
      } else {
        // Section too large — fall back to paragraph splitting within it
        chunks.push(...chunkParagraphs(section, maxTokens, overlap));
      }
    }
  } else {
    // No headings found — use paragraph splitting
    chunks.push(...chunkParagraphs(text, maxTokens, overlap));
  }

  return chunks.length > 0 ? chunks : [text];
}

function chunkParagraphs(text: string, maxTokens: number, overlap: number): string[] {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  const chunks: string[] = [];
  let currentChunk = '';
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);

    if (currentTokens + paragraphTokens > maxTokens && currentChunk) {
      chunks.push(currentChunk.trim());
      // Overlap: keep last part of current chunk
      const overlapText = currentChunk.split(/\s+/).slice(-overlap).join(' ');
      currentChunk = overlapText + '\n\n' + paragraph;
      currentTokens = estimateTokens(currentChunk);
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      currentTokens += paragraphTokens;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // If no chunks (single paragraph), split by sentences
  if (chunks.length === 0) {
    const sentences = text.split(/[。！？.!?\n]+/).filter(s => s.trim());
    let current = '';
    for (const sentence of sentences) {
      if (estimateTokens(current + sentence) > maxTokens && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  return chunks;
}

// ── Document Indexing ────────────────────────────────────

/**
 * Chunks, embeds, deduplicates, and stores a single document in the vector index.
 *
 * Near-duplicate chunks are detected and skipped via SimHash fingerprinting.
 *
 * @param doc - The RAG document to index. Must include a unique `id`, `content`, and `metadata`.
 */
export async function indexDocument(doc: RAGDocument): Promise<void> {
  const tbl = await getTable();

  // Chunk the content
  const chunks = chunkText(doc.content, DEFAULT_CHUNK_OPTIONS);

  // Generate embeddings for all chunks
  const embeddings = await embedBatch(chunks);

  // Prepare data for LanceDB, with SimHash dedup
  const records: LanceRecord[] = [];
  let dedupedCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `${doc.id}_chunk_${i}`;
    if (isDuplicate(chunkId, chunks[i])) {
      dedupedCount++;
      continue; // skip near-duplicate chunk
    }
    records.push({
      id: chunkId,
      content: chunks[i],
      vector: embeddings[i],
      source: doc.metadata.source,
      agent: doc.metadata.agent || '',
      group: doc.metadata.group || '',
      key: doc.metadata.key || '',
      fileName: doc.metadata.fileName || '',
      chunkIndex: i,
      timestamp: doc.metadata.timestamp,
    });
  }

  // Add to table
  if (records.length > 0) {
    await tbl.add(records);
  }

  log.info(`Indexed document ${doc.id} (${records.length} chunks, ${dedupedCount} deduped)`);
}

/**
 * Indexes multiple documents sequentially into the vector store.
 *
 * Convenience wrapper that calls {@link indexDocument} for each document.
 *
 * @param docs - Array of RAG documents to index.
 */
export async function indexDocuments(docs: RAGDocument[]): Promise<void> {
  for (const doc of docs) {
    await indexDocument(doc);
  }
}

/**
 * Removes all chunks belonging to the given document from the vector index.
 *
 * @param docId - The document ID whose chunks should be deleted (e.g. `"memory:me:recall"`).
 * @throws {Error} If `docId` contains invalid characters.
 */
export async function deleteDocument(docId: string): Promise<void> {
  // Validate docId to prevent injection
  if (!/^[a-zA-Z0-9_\-:.]+$/.test(docId)) {
    throw new Error(`Invalid document ID: ${docId}`);
  }

  const tbl = await getTable();

  // Delete all chunks of this document
  await tbl.delete(`id LIKE '${escapeLike(docId)}_chunk_%'`);

  log.info(`Deleted document ${docId}`);
}

// ── Retrieval ────────────────────────────────────────────

/**
 * Performs a hybrid (neural + BM25) similarity search over the vector index.
 *
 * The search pipeline: neural retrieval from LanceDB, optional BM25 fusion
 * scoring, and optional neural reranking via BGE-Reranker.
 *
 * @param query   - The natural-language search query.
 * @param options - Search configuration.
 * @param options.topK    - Maximum number of results to return (default 10).
 * @param options.filter  - LanceDB WHERE clause for metadata filtering (e.g. `agent = 'me'`).
 * @param options.rerank  - Whether to apply neural reranking (default true).
 * @param options.hybrid  - Whether to blend BM25 + neural scores (default true).
 * @returns Sorted array of {@link RAGResult} with relevance scores.
 */
export async function search(
  query: string,
  options: {
    topK?: number;
    filter?: string;
    rerank?: boolean;
    hybrid?: boolean; // enable BM25 + neural fusion
  } = {}
): Promise<RAGResult[]> {
  const { topK = 10, filter, rerank = true, hybrid = true } = options;

  const tbl = await getTable();

  // Embed query
  const queryEmbedding = await embed(query);

  // Search in LanceDB (neural retrieval)
  let queryBuilder = tbl.search(queryEmbedding).limit(topK * 2); // fetch more for fusion

  // Apply filter if provided
  if (filter) {
    queryBuilder = queryBuilder.where(filter);
  }

  const results = await queryBuilder.toArray();

  // Convert to RAGResult[]
  let ragResults: RAGResult[] = results.map((row: LanceRow) => ({
    document: {
      id: row.id.replace(/_chunk_\d+$/, ''),
      content: row.content,
      metadata: {
        source: row.source as RAGDocument['metadata']['source'],
        agent: row.agent || undefined,
        group: row.group || undefined,
        key: row.key || undefined,
        fileName: row.fileName || undefined,
        chunkIndex: row.chunkIndex,
        timestamp: row.timestamp,
      },
    },
    score: 1 - (row._distance || 0), // Convert distance to similarity
  }));

  // ── Hybrid scoring: BM25 + Neural fusion ──
  if (hybrid && ragResults.length > 0) {
    ragResults = hybridScore(query, ragResults);
  }

  // Trim to topK after fusion
  ragResults = ragResults.slice(0, topK);

  // Rerank if enabled
  if (rerank && ragResults.length > 1) {
    ragResults = await rerankResults(query, ragResults);
  }

  return ragResults;
}

// ── BM25 Scoring ─────────────────────────────────────────
// Lightweight BM25 implementation (no external dependencies)

interface BM25Params {
  k1: number;   // term frequency saturation (default 1.5)
  b: number;    // length normalization (default 0.75)
}

const BM25_DEFAULTS: BM25Params = { k1: 1.5, b: 0.75 };

function tokenize(text: string): string[] {
  // Chinese-aware tokenization: split by characters + English words
  const tokens: string[] = [];
  const segments = text.toLowerCase().replace(/[^\w一-鿿]/g, ' ').split(/\s+/);
  for (const seg of segments) {
    if (seg.length === 0) continue;
    // If Chinese, split into individual characters (unigram)
    if (/[一-鿿]/.test(seg)) {
      for (const ch of seg) {
        if (/[一-鿿]/.test(ch)) tokens.push(ch);
      }
    } else {
      tokens.push(seg);
    }
  }
  return tokens;
}

function computeBM25Score(
  queryTokens: string[],
  docTokens: string[],
  docLength: number,
  avgDocLength: number,
  docFreq: Map<string, number>,
  totalDocs: number,
  params: BM25Params = BM25_DEFAULTS
): number {
  let score = 0;
  const tfMap = new Map<string, number>();
  for (const t of docTokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);

  for (const qt of queryTokens) {
    const tf = tfMap.get(qt) || 0;
    const df = docFreq.get(qt) || 0;
    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (params.k1 + 1)) / (tf + params.k1 * (1 - params.b + params.b * (docLength / avgDocLength)));
    score += idf * tfNorm;
  }
  return score;
}

// ── Hybrid Score Fusion ──────────────────────────────────

function hybridScore(query: string, neuralResults: RAGResult[]): RAGResult[] {
  const queryTokens = tokenize(query);

  // Build document frequency map from all results
  const docFreq = new Map<string, number>();
  const allDocTokens: string[][] = [];
  for (const r of neuralResults) {
    const dt = tokenize(r.document.content);
    allDocTokens.push(dt);
    const seen = new Set<string>();
    for (const t of dt) {
      if (!seen.has(t)) {
        docFreq.set(t, (docFreq.get(t) || 0) + 1);
        seen.add(t);
      }
    }
  }

  const totalDocs = neuralResults.length;
  const avgDocLength = allDocTokens.reduce((sum, dt) => sum + dt.length, 0) / (totalDocs || 1);

  // Normalize neural scores to [0, 1]
  const maxNeural = Math.max(...neuralResults.map(r => r.score), 0.001);

  // Compute fused scores
  const fused = neuralResults.map((r, i) => {
    const bm25 = computeBM25Score(queryTokens, allDocTokens[i], allDocTokens[i].length, avgDocLength, docFreq, totalDocs);
    const neuralNorm = r.score / maxNeural; // normalize to [0, 1]

    // BM25 normalization (rough: divide by max possible)
    const bm25Max = Math.max(bm25, 0.001);
    const bm25Norm = bm25 / (bm25Max * 2); // rough normalization

    const fusedScore = HYBRID_BM25_WEIGHT * bm25Norm + HYBRID_NEURAL_WEIGHT * neuralNorm;

    return {
      ...r,
      score: fusedScore,
      scoreBreakdown: {
        bm25: bm25,
        neural: r.score,
        fused: fusedScore,
      },
    };
  });

  // Sort by fused score descending
  fused.sort((a, b) => b.score - a.score);
  return fused;
}

// ── Dedup Integration ────────────────────────────────────

function isDuplicate(docId: string, content: string): boolean {
  return addToSimHashIndex(docId, content);
}

async function rerankResults(query: string, results: RAGResult[]): Promise<RAGResult[]> {
  try {
    const pipe = await getRerankerPipeline() as RerankerFn | null;

    // If reranker is not available, return original results
    if (!pipe) {
      return results;
    }

    // Prepare pairs for reranking
    const pairs = results.map(r => ({ text: query, text_pair: r.document.content }));

    // Get reranker scores
    const scores = await pipe(pairs, { top_k: 1 });

    // Combine with original scores
    const reranked = results.map((r, i) => ({
      ...r,
      score: scores[i].score,
    }));

    // Sort by reranker score
    reranked.sort((a, b) => b.score - a.score);

    return reranked;
  } catch (error) {
    log.warn('Reranking failed, using original order:', error);
    // Return results with original scores
    return results;
  }
}

// ── Data Source Indexing ─────────────────────────────────

/**
 * Indexes all markdown memory files for the given agent.
 *
 * Reads `.md` files from `Agents/<agent>/memory/`, parses YAML frontmatter
 * (including tags), and indexes the body text with enriched metadata.
 *
 * @param agent - The agent name whose memories should be indexed.
 * @returns The number of memory documents indexed.
 */
export async function indexAgentMemory(agent: string): Promise<number> {
  const memDir = path.join(MIND_DIR, 'agents', agent, 'memory');
  if (!fs.existsSync(memDir)) return 0;

  const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
  const docs: RAGDocument[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(memDir, file), 'utf-8');
    // Parse frontmatter
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (match) {
      const key = file.replace('.md', '');

      // Extract tags from frontmatter for enhanced metadata
      const fmLines = match[1].split('\n');
      const tags: string[] = [];
      const importance: string = 'normal';
      for (const line of fmLines) {
        if (line.startsWith('tags:')) {
          const tagStr = line.replace('tags:', '').trim();
          tags.push(...tagStr.split(',').map((t: string) => t.trim()));
        }
        if (line.startsWith('importance:')) {
          // could be used for weighted indexing
        }
      }

      const body = match[2].trim();
      // Include tags as searchable prefix for better recall
      const indexedContent = tags.length > 0
        ? `[标签: ${tags.join(', ')}] ${body}`
        : body;

      docs.push({
        id: `memory:${agent}:${key}`,
        content: indexedContent,
        metadata: {
          source: 'memory',
          agent,
          key,
          timestamp: Date.now(),
        },
      });
    }
  }

  await indexDocuments(docs);
  return docs.length;
}

/**
 * Indexes the prompt files for all skills owned by the given agent.
 *
 * Reads `prompt.md` from each subdirectory under `Agents/<agent>/skills/`.
 *
 * @param agent - The agent name whose skills should be indexed.
 * @returns The number of skill documents indexed.
 */
export async function indexAgentSkills(agent: string): Promise<number> {
  const skillsDir = path.join(AGENTS_DIR, agent, 'skills');
  if (!fs.existsSync(skillsDir)) return 0;

  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const docs: RAGDocument[] = [];

  for (const skillName of skillDirs) {
    const promptPath = path.join(skillsDir, skillName, 'prompt.md');
    if (fs.existsSync(promptPath)) {
      const content = fs.readFileSync(promptPath, 'utf-8');
      docs.push({
        id: `skill:${agent}:${skillName}`,
        content,
        metadata: {
          source: 'skill',
          agent,
          key: skillName,
          timestamp: Date.now(),
        },
      });
    }
  }

  await indexDocuments(docs);
  return docs.length;
}

/**
 * Indexes all knowledge files (`.md` and `.txt`) for the given agent.
 *
 * Reads files from `Agents/<agent>/knowledge/`.
 *
 * @param agent - The agent name whose knowledge base should be indexed.
 * @returns The number of knowledge documents indexed.
 */
export async function indexAgentKnowledge(agent: string): Promise<number> {
  const knowledgeDir = path.join(AGENTS_DIR, agent, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return 0;

  const files = fs.readdirSync(knowledgeDir).filter(f =>
    f.endsWith('.md') || f.endsWith('.txt')
  );

  const docs: RAGDocument[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8');
    docs.push({
      id: `knowledge:${agent}:${file}`,
      content,
      metadata: {
        source: 'knowledge',
        agent,
        fileName: file,
        timestamp: Date.now(),
      },
    });
  }

  await indexDocuments(docs);
  return docs.length;
}

/**
 * Indexes all shared knowledge files for the given group.
 *
 * Reads `.md` and `.txt` files from `Groups/<group>/knowledge/`.
 *
 * @param group - The group name whose shared knowledge should be indexed.
 * @returns The number of group knowledge documents indexed.
 */
export async function indexGroupKnowledge(group: string): Promise<number> {
  const knowledgeDir = path.join(GROUPS_DIR, group, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return 0;

  const files = fs.readdirSync(knowledgeDir).filter(f =>
    f.endsWith('.md') || f.endsWith('.txt')
  );

  const docs: RAGDocument[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8');
    docs.push({
      id: `group_knowledge:${group}:${file}`,
      content,
      metadata: {
        source: 'group_knowledge',
        group,
        fileName: file,
        timestamp: Date.now(),
      },
    });
  }

  await indexDocuments(docs);
  return docs.length;
}

// ── Session Context ──────────────────────────────────────

/**
 * Indexes recent chat messages as session context for the given agent.
 *
 * Only the last 10 messages are indexed to avoid noise. Messages are
 * formatted as `[role] content` pairs.
 *
 * @param agent    - The agent name to associate the session context with.
 * @param messages - Array of chat messages with `role` and `content`.
 */
export async function indexSessionContext(agent: string, messages: Array<{ role: string; content: string }>): Promise<void> {
  // Only index last N messages to avoid noise
  const recentMessages = messages.slice(-10);

  const content = recentMessages
    .map(m => `[${m.role}] ${m.content}`)
    .join('\n\n');

  const doc: RAGDocument = {
    id: `session:${agent}:${Date.now()}`,
    content,
    metadata: {
      source: 'session',
      agent,
      timestamp: Date.now(),
    },
  };

  await indexDocument(doc);
}

// ── Full Indexing ────────────────────────────────────────

/**
 * Performs a full re-index of all data sources for the given agent.
 *
 * Runs memory, skills, knowledge, and optional group-knowledge indexing
 * in parallel. Returns a breakdown of how many documents were indexed
 * per source.
 *
 * @param agent - The agent name to index all data sources for.
 * @param group - Optional group name; if provided, group knowledge is also indexed.
 * @returns Counts of indexed documents per source type.
 */
export async function indexAll(agent: string, group?: string): Promise<{
  memory: number;
  skills: number;
  knowledge: number;
  groupKnowledge: number;
}> {
  const [memory, skills, knowledge, groupKnowledge] = await Promise.all([
    indexAgentMemory(agent),
    indexAgentSkills(agent),
    indexAgentKnowledge(agent),
    group ? indexGroupKnowledge(group) : Promise.resolve(0),
  ]);

  log.info(`Full index for ${agent}: memory=${memory}, skills=${skills}, knowledge=${knowledge}, group=${groupKnowledge}`);
  return { memory, skills, knowledge, groupKnowledge };
}

// ── RAG Query (Main Entry Point) ─────────────────────────

/**
 * High-level RAG query that searches, formats, and returns context for an AI prompt.
 *
 * Filters results to the specified agent's memory/skills/knowledge plus
 * any shared group knowledge. Returns a formatted string suitable for
 * injection into an AI system prompt.
 *
 * @param agent   - The agent to retrieve context for.
 * @param query   - The natural-language query.
 * @param options - Query options.
 * @param options.group           - Group name to include group knowledge in results.
 * @param options.topK            - Maximum results to return (default 5).
 * @param options.includeSession  - Whether to include session context (reserved).
 * @param options.sessionMessages - Chat messages for session context (reserved).
 * @returns A formatted string of RAG context blocks, or an empty string if nothing was found.
 */
export async function ragQuery(
  agent: string,
  query: string,
  options: {
    group?: string;
    topK?: number;
    includeSession?: boolean;
    sessionMessages?: Array<{ role: string; content: string }>;
  } = {}
): Promise<string> {
  const { group, topK = 5 } = options;

  // Validate agent name to prevent injection
  if (!/^[a-zA-Z0-9_\-]+$/.test(agent)) {
    log.warn(`Invalid agent name: ${agent}`);
    return '';
  }

  // Build filter for this agent/group
  // Include: memory, skill, knowledge for this agent + group_knowledge
  const safeAgent = agent.replace(/'/g, "''");
  const filter = `(agent = '${safeAgent}' AND (source = 'memory' OR source = 'skill' OR source = 'knowledge')) OR source = 'group_knowledge'`;

  // Search
  const results = await search(query, {
    topK,
    filter,
    rerank: true,
  });

  if (results.length === 0) return '';

  // Format results
  const parts = results.map(r => {
    const source = r.document.metadata.source;
    const label = source === 'memory' ? '记忆'
      : source === 'skill' ? '技能'
      : source === 'knowledge' ? '知识'
      : source === 'group_knowledge' ? '群组知识'
      : '对话';

    const key = r.document.metadata.key || r.document.metadata.fileName || '';
    const prefix = key ? `[${label}: ${key}]` : `[${label}]`;

    return `${prefix} ${r.document.content.slice(0, 500)}`;
  });

  return '\n\n--- RAG Context ---\n' + parts.join('\n---\n') + '\n--- End ---';
}

// ── Cleanup ──────────────────────────────────────────────

/**
 * Drops the entire RAG vector table from LanceDB, effectively clearing all indexed data.
 *
 * After calling this function the table must be re-created on the next
 * {@link indexDocument} or {@link search} call.
 */
export async function clearCollection(): Promise<void> {
  const database = await getDb();

  try {
    await database.dropTable(TABLE_NAME);
    table = null;
    log.info('Table dropped');
  } catch {
    // Table might not exist
  }
}

/**
 * Returns usage statistics for the RAG vector collection.
 *
 * @returns An object with total chunk count, a breakdown of chunks by
 *          source type, and the number of SimHash dedup entries in memory.
 */
export async function getCollectionStats(): Promise<{
  count: number;
  sources: Record<string, number>;
  simHashEntries: number;
}> {
  const tbl = await getTable();

  // Count rows
  const count = await tbl.countRows();

  // Get sample to count sources
  const sample = await tbl.query().limit(1000).toArray();
  const sources: Record<string, number> = {};
  for (const row of sample) {
    const source = row.source || 'unknown';
    sources[source] = (sources[source] || 0) + 1;
  }

  return {
    count,
    sources,
    simHashEntries: simHashIndex.size,
  };
}
