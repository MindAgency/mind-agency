/**
 * RAG Enhanced Module Tests
 *
 * Tests for:
 * - BM25 persistent index (bm25-index.ts)
 * - RAG cache (rag-cache.ts)
 * - RAG evaluation framework (rag-eval.ts)
 * - RRF fusion
 * - Enhanced search integration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BM25Index, tokenize } from '../src/lib/bm25-index';
import { queryCache, embeddingCache, makeQueryKey, getCacheStats } from '../src/lib/rag-cache';
import { evaluateRAG, reciprocalRankFusion, formatMetrics } from '../src/lib/rag-eval';

// ── BM25 Index Tests ───────────────────────────────────

describe('BM25 Index', () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
    index.clear();
  });

  it('should tokenize Chinese text into bigrams and unigrams', () => {
    const tokens = tokenize('你好世界');
    // Should contain bigrams: 你好, 好世, 世界 + unigrams: 你, 好, 世, 界
    expect(tokens).toContain('你好');
    expect(tokens).toContain('好世');
    expect(tokens).toContain('世界');
    expect(tokens).toContain('你');
    expect(tokens).toContain('好');
    expect(tokens).toContain('世');
    expect(tokens).toContain('界');
  });

  it('should tokenize English text by words', () => {
    const tokens = tokenize('hello world test');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).toContain('test');
  });

  it('should tokenize mixed Chinese-English text', () => {
    const tokens = tokenize('RAG检索增强生成');
    expect(tokens).toContain('rag');
    expect(tokens).toContain('检索');
    expect(tokens).toContain('增强');
    expect(tokens).toContain('生成');
  });

  it('should add documents and update statistics', () => {
    index.addDocument('doc1', 'machine learning is great');
    index.addDocument('doc2', 'deep learning neural networks');

    const stats = index.getStats();
    expect(stats.totalDocs).toBe(2);
    expect(stats.totalTerms).toBeGreaterThan(0);
    expect(stats.avgDocLength).toBeGreaterThan(0);
  });

  it('should search and return scored results', () => {
    index.addDocument('doc1', 'machine learning algorithms');
    index.addDocument('doc2', 'cooking recipes food');
    index.addDocument('doc3', 'learning machine concepts');

    const results = index.search('machine learning', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    // doc1 and doc3 should score higher than doc2
    const doc1Result = results.find(r => r.docId === 'doc1');
    const doc2Result = results.find(r => r.docId === 'doc2');
    expect(doc1Result).toBeDefined();
    expect(doc2Result).toBeUndefined(); // doc2 has no matching terms
  });

  it('should handle Chinese search queries', () => {
    index.addDocument('doc1', '检索增强生成是AI的重要技术');
    index.addDocument('doc2', '今天天气很好适合出门');

    const results = index.search('检索增强', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].docId).toBe('doc1');
  });

  it('should remove documents correctly', () => {
    index.addDocument('doc1', 'test document one');
    index.addDocument('doc2', 'test document two');

    index.removeDocument('doc1');

    const stats = index.getStats();
    expect(stats.totalDocs).toBe(1);

    const results = index.search('test', 5);
    expect(results.every(r => r.docId !== 'doc1')).toBe(true);
  });

  it('should return score 0 for non-existent document', () => {
    index.addDocument('doc1', 'hello world');
    const score = index.getScore('hello', 'nonexistent');
    expect(score).toBe(0);
  });

  it('should handle empty query', () => {
    index.addDocument('doc1', 'some content');
    const results = index.search('', 5);
    expect(results).toEqual([]);
  });

  it('should handle empty index', () => {
    const results = index.search('anything', 5);
    expect(results).toEqual([]);
  });
});

// ── RAG Cache Tests ────────────────────────────────────

describe('RAG Cache', () => {
  beforeEach(() => {
    queryCache.clear();
    embeddingCache.clear();
  });

  it('should store and retrieve query results', () => {
    const key = makeQueryKey('test query', 5, 'agent=me');
    const results = [{ id: 'doc1', score: 0.9 }];

    queryCache.set(key, results);
    const retrieved = queryCache.get(key);

    expect(retrieved).toEqual(results);
  });

  it('should return null for cache miss', () => {
    const result = queryCache.get('nonexistent-key');
    expect(result).toBeNull();
  });

  it('should track hit rate', () => {
    const key = makeQueryKey('test', 5);

    // Miss
    queryCache.get(key);
    // Set and hit
    queryCache.set(key, [{ id: 'doc1' }]);
    queryCache.get(key);

    const stats = queryCache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it('should store and retrieve embeddings', () => {
    const text = 'hello world';
    const embedding = [0.1, 0.2, 0.3];

    embeddingCache.set(text, embedding);
    const retrieved = embeddingCache.get(text);

    expect(retrieved).toEqual(embedding);
  });

  it('should return null for embedding cache miss', () => {
    const result = embeddingCache.get('nonexistent text');
    expect(result).toBeNull();
  });

  it('should generate consistent cache keys', () => {
    const key1 = makeQueryKey('test', 5, 'filter1');
    const key2 = makeQueryKey('test', 5, 'filter1');
    const key3 = makeQueryKey('test', 5, 'filter2');

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('should report combined cache stats', () => {
    queryCache.set('key1', [{ id: 'doc1' }]);
    embeddingCache.set('text1', [0.1, 0.2]);

    const stats = getCacheStats();
    expect(stats.query.size).toBeGreaterThan(0);
    expect(stats.embedding.size).toBeGreaterThan(0);
  });
});

// ── RRF Fusion Tests ───────────────────────────────────

describe('Reciprocal Rank Fusion', () => {
  it('should merge two ranked lists', () => {
    const list1 = [
      { id: 'doc1', score: 0.9 },
      { id: 'doc2', score: 0.8 },
      { id: 'doc3', score: 0.7 },
    ];
    const list2 = [
      { id: 'doc2', score: 0.95 },
      { id: 'doc1', score: 0.85 },
      { id: 'doc4', score: 0.6 },
    ];

    const fused = reciprocalRankFusion([list1, list2], 60, 10);

    expect(fused.length).toBe(4); // doc1, doc2, doc3, doc4
    // doc1 and doc2 appear in both lists, so should rank higher
    const doc1Score = fused.find(f => f.id === 'doc1')?.score;
    const doc3Score = fused.find(f => f.id === 'doc3')?.score;
    expect(doc1Score!).toBeGreaterThan(doc3Score!);
  });

  it('should handle single list', () => {
    const list = [
      { id: 'doc1', score: 0.9 },
      { id: 'doc2', score: 0.8 },
    ];

    const fused = reciprocalRankFusion([list], 60, 10);
    expect(fused.length).toBe(2);
    expect(fused[0].id).toBe('doc1');
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  it('should respect topK limit', () => {
    const list1 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const list2 = [{ id: 'e' }, { id: 'f' }, { id: 'g' }, { id: 'h' }];

    const fused = reciprocalRankFusion([list1, list2], 60, 3);
    expect(fused.length).toBe(3);
  });

  it('should handle empty lists', () => {
    const fused = reciprocalRankFusion([[], []], 60, 10);
    expect(fused).toEqual([]);
  });

  it('should give higher scores to documents ranked high in multiple lists', () => {
    const list1 = [{ id: 'doc1' }, { id: 'doc2' }];
    const list2 = [{ id: 'doc1' }, { id: 'doc3' }];

    const fused = reciprocalRankFusion([list1, list2], 60, 10);
    // doc1 is rank 1 in both lists — should have highest RRF score
    expect(fused[0].id).toBe('doc1');

    const doc1Score = fused.find(f => f.id === 'doc1')!.score;
    const doc2Score = fused.find(f => f.id === 'doc2')!.score;
    const doc3Score = fused.find(f => f.id === 'doc3')!.score;
    expect(doc1Score).toBeGreaterThan(doc2Score);
    expect(doc1Score).toBeGreaterThan(doc3Score);
    // doc2 and doc3 are both rank 2 in one list each — should have equal scores
    expect(doc2Score).toBeCloseTo(doc3Score, 5);
  });
});

// ── RAG Evaluation Tests ───────────────────────────────

describe('RAG Evaluation', () => {
  it('should compute Precision@K correctly', async () => {
    const testQueries = [
      {
        query: 'machine learning',
        relevantDocIds: ['doc1', 'doc2'],
      },
    ];

    const searchFn = async () => [
      { id: 'doc1', score: 0.9 },
      { id: 'doc3', score: 0.8 },
      { id: 'doc2', score: 0.7 },
      { id: 'doc4', score: 0.6 },
      { id: 'doc5', score: 0.5 },
    ];

    const metrics = await evaluateRAG(testQueries, searchFn, 5);
    // 2 relevant out of 5 retrieved = 0.4
    expect(metrics.precisionAtK).toBeCloseTo(0.4, 2);
  });

  it('should compute Recall@K correctly', async () => {
    const testQueries = [
      {
        query: 'test',
        relevantDocIds: ['doc1', 'doc2', 'doc3'],
      },
    ];

    const searchFn = async () => [
      { id: 'doc1', score: 0.9 },
      { id: 'doc4', score: 0.8 },
      { id: 'doc2', score: 0.7 },
    ];

    const metrics = await evaluateRAG(testQueries, searchFn, 3);
    // 2 relevant retrieved out of 3 total relevant = 0.667
    expect(metrics.recallAtK).toBeCloseTo(2 / 3, 2);
  });

  it('should compute MRR correctly', async () => {
    const testQueries = [
      {
        query: 'test1',
        relevantDocIds: ['doc2'],
      },
      {
        query: 'test2',
        relevantDocIds: ['doc1'],
      },
    ];

    const searchFn = async (query: string) => {
      if (query === 'test1') {
        return [
          { id: 'doc3' },
          { id: 'doc2' },  // First relevant at position 2 → 1/2
        ];
      }
      return [
        { id: 'doc1' },  // First relevant at position 1 → 1/1
      ];
    };

    const metrics = await evaluateRAG(testQueries, searchFn, 5);
    // MRR = (1/2 + 1/1) / 2 = 0.75
    expect(metrics.mrr).toBeCloseTo(0.75, 2);
  });

  it('should compute NDCG correctly', async () => {
    const testQueries = [
      {
        query: 'test',
        relevantDocIds: ['doc1', 'doc2'],
      },
    ];

    const searchFn = async () => [
      { id: 'doc1' },  // relevant at rank 1
      { id: 'doc3' },  // not relevant at rank 2
      { id: 'doc2' },  // relevant at rank 3
    ];

    const metrics = await evaluateRAG(testQueries, searchFn, 3);
    // DCG = 1/log2(2) + 0 + 1/log2(4) = 1 + 0 + 0.5 = 1.5
    // IDCG = 1/log2(2) + 1/log2(3) = 1 + 0.6309 = 1.6309
    // NDCG = 1.5 / 1.6309 ≈ 0.919
    expect(metrics.ndcg).toBeGreaterThan(0.9);
    expect(metrics.ndcg).toBeLessThan(1.0);
  });

  it('should handle no relevant results', async () => {
    const testQueries = [
      {
        query: 'test',
        relevantDocIds: ['doc99'],
      },
    ];

    const searchFn = async () => [
      { id: 'doc1' },
      { id: 'doc2' },
    ];

    const metrics = await evaluateRAG(testQueries, searchFn, 5);
    expect(metrics.precisionAtK).toBe(0);
    expect(metrics.recallAtK).toBe(0);
    expect(metrics.mrr).toBe(0);
    expect(metrics.ndcg).toBe(0);
  });

  it('should format metrics for display', () => {
    const metrics = {
      precisionAtK: 0.7,
      recallAtK: 0.8,
      mrr: 0.65,
      ndcg: 0.72,
      avgLatencyMs: 150,
      totalQueries: 10,
    };

    const formatted = formatMetrics(metrics);
    expect(formatted).toContain('Precision@K: 0.7000');
    // formatMetrics 对齐用多空格填充(MRR:         0.6500),按空白归一化断言
    expect(formatted).toMatch(/MRR:\s+0\.6500/);
    expect(formatted).toMatch(/NDCG:\s+0\.7200/);
  });
});
