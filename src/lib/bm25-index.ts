/**
 * bm25-index.ts — Global persistent BM25 index
 *
 * Replaces the on-the-fly BM25 calculation in rag.ts with a proper
 * global index that maintains document frequencies, term frequencies,
 * and document lengths across the entire corpus.
 *
 * Persistence: JSON file at RAG_DIR/bm25-index.json
 */

import fs from 'fs';
import path from 'path';
import { MIND_DIR } from './data-dir';
import { createLogger } from './logger';

const log = createLogger('bm25-index');

const RAG_DIR = path.join(MIND_DIR, 'rag');
const BM25_INDEX_FILE = path.join(RAG_DIR, 'bm25-index.json');

// BM25 parameters
const K1 = 1.5;   // term frequency saturation
const B = 0.75;    // length normalization

interface BM25Data {
  docFreq: Record<string, number>;        // term -> number of docs containing it
  termFreqs: Record<string, Record<string, number>>; // docId -> (term -> freq)
  docLengths: Record<string, number>;      // docId -> token count
  totalDocs: number;
  totalTokens: number;
}

/**
 * Chinese-aware tokenizer for BM25.
 * Splits English by words, Chinese by bigrams + unigrams.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // English words
  const englishWords = lower.match(/[a-z0-9_]+/g) || [];
  for (const w of englishWords) tokens.push(w);

  // Chinese character bigrams + unigrams
  const cnPhrases = lower.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const phrase of cnPhrases) {
    // Bigrams for better context
    for (let i = 0; i <= phrase.length - 2; i++) {
      tokens.push(phrase.slice(i, i + 2));
    }
    // Also add individual characters
    for (const ch of phrase) {
      tokens.push(ch);
    }
  }

  return tokens;
}

export class BM25Index {
  private data: BM25Data;
  private dirty = false;

  constructor() {
    this.data = { docFreq: {}, termFreqs: {}, docLengths: {}, totalDocs: 0, totalTokens: 0 };
    this.load();
  }

  /**
   * Add a document to the BM25 index.
   */
  addDocument(docId: string, text: string): void {
    // If document already exists, remove it first
    if (this.data.termFreqs[docId]) {
      this.removeDocument(docId);
    }

    const tokens = tokenize(text);
    const tf: Record<string, number> = {};

    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }

    this.data.termFreqs[docId] = tf;
    this.data.docLengths[docId] = tokens.length;
    this.data.totalDocs++;
    this.data.totalTokens += tokens.length;

    // Update document frequency
    for (const token of new Set(tokens)) {
      this.data.docFreq[token] = (this.data.docFreq[token] || 0) + 1;
    }

    this.dirty = true;
  }

  /**
   * Remove a document from the BM25 index.
   */
  removeDocument(docId: string): void {
    const tf = this.data.termFreqs[docId];
    if (!tf) return;

    const docLen = this.data.docLengths[docId] || 0;

    // Decrement document frequency
    for (const token of Object.keys(tf)) {
      this.data.docFreq[token] = (this.data.docFreq[token] || 1) - 1;
      if (this.data.docFreq[token] <= 0) {
        delete this.data.docFreq[token];
      }
    }

    delete this.data.termFreqs[docId];
    delete this.data.docLengths[docId];
    this.data.totalDocs--;
    this.data.totalTokens -= docLen;
    this.dirty = true;
  }

  /**
   * Search the BM25 index and return scored results.
   */
  search(query: string, topK: number = 10): Array<{ docId: string; score: number }> {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.data.totalDocs === 0) return [];

    const avgDocLength = this.data.totalTokens / this.data.totalDocs;
    const scores: Array<{ docId: string; score: number }> = [];

    for (const [docId, tf] of Object.entries(this.data.termFreqs)) {
      let score = 0;
      const docLength = this.data.docLengths[docId] || 0;

      for (const qt of queryTokens) {
        const termFreq = tf[qt] || 0;
        if (termFreq === 0) continue;

        const df = this.data.docFreq[qt] || 0;
        const idf = Math.log((this.data.totalDocs - df + 0.5) / (df + 0.5) + 1);

        const tfNorm = (termFreq * (K1 + 1)) /
          (termFreq + K1 * (1 - B + B * (docLength / avgDocLength)));

        score += idf * tfNorm;
      }

      if (score > 0) {
        scores.push({ docId, score });
      }
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Get BM25 score for a specific document given a query.
   */
  getScore(query: string, docId: string): number {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.data.totalDocs === 0) return 0;

    const tf = this.data.termFreqs[docId];
    if (!tf) return 0;

    const avgDocLength = this.data.totalTokens / this.data.totalDocs;
    const docLength = this.data.docLengths[docId] || 0;
    let score = 0;

    for (const qt of queryTokens) {
      const termFreq = tf[qt] || 0;
      if (termFreq === 0) continue;

      const df = this.data.docFreq[qt] || 0;
      const idf = Math.log((this.data.totalDocs - df + 0.5) / (df + 0.5) + 1);
      const tfNorm = (termFreq * (K1 + 1)) /
        (termFreq + K1 * (1 - B + B * (docLength / avgDocLength)));
      score += idf * tfNorm;
    }

    return score;
  }

  /**
   * Persist the index to disk.
   */
  save(): void {
    if (!this.dirty) return;

    try {
      if (!fs.existsSync(RAG_DIR)) {
        fs.mkdirSync(RAG_DIR, { recursive: true });
      }
      fs.writeFileSync(BM25_INDEX_FILE, JSON.stringify(this.data), 'utf-8');
      this.dirty = false;
      log.info(`BM25 index saved: ${this.data.totalDocs} docs, ${Object.keys(this.data.docFreq).length} terms`);
    } catch (error) {
      log.error('Failed to save BM25 index:', error);
    }
  }

  /**
   * Load the index from disk.
   */
  private load(): void {
    try {
      if (fs.existsSync(BM25_INDEX_FILE)) {
        const raw = fs.readFileSync(BM25_INDEX_FILE, 'utf-8');
        this.data = JSON.parse(raw);
        log.info(`BM25 index loaded: ${this.data.totalDocs} docs, ${Object.keys(this.data.docFreq).length} terms`);
      }
    } catch (error) {
      log.warn('Failed to load BM25 index, starting fresh:', error);
      this.data = { docFreq: {}, termFreqs: {}, docLengths: {}, totalDocs: 0, totalTokens: 0 };
    }
  }

  /**
   * Get index statistics.
   */
  getStats(): { totalDocs: number; totalTerms: number; avgDocLength: number } {
    return {
      totalDocs: this.data.totalDocs,
      totalTerms: Object.keys(this.data.docFreq).length,
      avgDocLength: this.data.totalDocs > 0 ? this.data.totalTokens / this.data.totalDocs : 0,
    };
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.data = { docFreq: {}, termFreqs: {}, docLengths: {}, totalDocs: 0, totalTokens: 0 };
    this.dirty = true;
    this.save();
  }
}

// Singleton instance
export const bm25Index = new BM25Index();
