/**
 * RAG Evaluation Tests
 *
 * Tests for src/lib/rag-eval.ts covering:
 * - evaluateRAG: precision@K, recall@K, MRR, NDCG, latency, empty queries
 * - reciprocalRankFusion: single list, two lists (dedup + fusion), topK limit
 * - formatMetrics: string output format
 *
 * No data-dir dependency — rag-eval only imports the logger.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateRAG,
  reciprocalRankFusion,
  formatMetrics,
  type EvalQuery,
  type RAGMetrics,
} from '../src/lib/rag-eval';

describe('RAG Evaluation', () => {
  describe('evaluateRAG', () => {
    it('perfect retrieval: all relevant docs in top-K -> precision=1, recall=1, mrr=1', async () => {
      const testQueries: EvalQuery[] = [
        { query: 'machine learning', relevantDocIds: ['doc1', 'doc2'] },
      ];
      // Both retrieved docs are relevant and appear at the top.
      const searchFn = async () => [
        { id: 'doc1', score: 0.9 },
        { id: 'doc2', score: 0.8 },
      ];

      const metrics = await evaluateRAG(testQueries, searchFn, 5);

      // 2 relevant out of 2 retrieved -> precision = 1
      // 2 relevant out of 2 total relevant -> recall = 1
      // First relevant doc at index 0 -> MRR = 1/(0+1) = 1
      // DCG == IDCG -> NDCG = 1
      expect(metrics.precisionAtK).toBe(1);
      expect(metrics.recallAtK).toBe(1);
      expect(metrics.mrr).toBe(1);
      expect(metrics.ndcg).toBe(1);
      expect(metrics.totalQueries).toBe(1);
    });

    it('partial retrieval -> correct precision and recall calculation', async () => {
      const testQueries: EvalQuery[] = [
        { query: 'machine learning', relevantDocIds: ['doc1', 'doc2', 'doc3'] },
      ];
      // 3 retrieved: doc1 (relevant), doc4 (irrelevant), doc2 (relevant)
      const searchFn = async () => [
        { id: 'doc1', score: 0.9 },
        { id: 'doc4', score: 0.8 },
        { id: 'doc2', score: 0.7 },
      ];

      const metrics = await evaluateRAG(testQueries, searchFn, 5);

      // 2 relevant out of 3 retrieved -> precision = 2/3
      // 2 relevant out of 3 total relevant -> recall = 2/3
      // First relevant doc at index 0 -> MRR = 1
      expect(metrics.precisionAtK).toBeCloseTo(2 / 3, 5);
      expect(metrics.recallAtK).toBeCloseTo(2 / 3, 5);
      expect(metrics.mrr).toBe(1);
      // NDCG: DCG = 1/log2(2) + 0/log2(3) + 1/log2(4) = 1 + 0 + 0.5 = 1.5
      //       IDCG = 1/log2(2) + 1/log2(3) + 1/log2(4) ≈ 2.13093
      //       NDCG = 1.5 / 2.13093 ≈ 0.7040
      expect(metrics.ndcg).toBeCloseTo(1.5 / (1 + 1 / Math.log2(3) + 1 / Math.log2(4)), 3);
    });

    it('no relevant docs retrieved -> precision=0, recall=0, mrr=0', async () => {
      const testQueries: EvalQuery[] = [
        { query: 'machine learning', relevantDocIds: ['doc1', 'doc2'] },
      ];
      const searchFn = async () => [
        { id: 'doc3', score: 0.9 },
        { id: 'doc4', score: 0.8 },
      ];

      const metrics = await evaluateRAG(testQueries, searchFn, 5);

      expect(metrics.precisionAtK).toBe(0);
      expect(metrics.recallAtK).toBe(0);
      expect(metrics.mrr).toBe(0);
      expect(metrics.ndcg).toBe(0);
    });

    it('empty test queries -> all metrics 0', async () => {
      const metrics = await evaluateRAG([], async () => [], 5);

      expect(metrics.precisionAtK).toBe(0);
      expect(metrics.recallAtK).toBe(0);
      expect(metrics.mrr).toBe(0);
      expect(metrics.ndcg).toBe(0);
      expect(metrics.avgLatencyMs).toBe(0);
      expect(metrics.totalQueries).toBe(0);
    });
  });

  describe('reciprocalRankFusion', () => {
    it('single list: scores match 1/(k+rank+1) with default k=60', () => {
      const result = reciprocalRankFusion([
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      ]);

      expect(result).toHaveLength(3);
      // rank is 0-indexed; score = 1/(k + rank + 1) = 1/(60 + rank + 1)
      expect(result[0].id).toBe('a');
      expect(result[0].score).toBeCloseTo(1 / (60 + 0 + 1), 10); // 1/61
      expect(result[1].id).toBe('b');
      expect(result[1].score).toBeCloseTo(1 / (60 + 1 + 1), 10); // 1/62
      expect(result[2].id).toBe('c');
      expect(result[2].score).toBeCloseTo(1 / (60 + 2 + 1), 10); // 1/63
      // Sorted descending by score
      expect(result[0].score).toBeGreaterThan(result[1].score);
      expect(result[1].score).toBeGreaterThan(result[2].score);
    });

    it('two ranked lists: overlapping docs get higher fused scores and are deduplicated', () => {
      const result = reciprocalRankFusion([
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [{ id: 'a' }, { id: 'b' }, { id: 'd' }],
      ]);

      // 4 unique documents after deduplication (a, b appear in both lists)
      expect(result).toHaveLength(4);

      // 'a' is rank 0 in both lists -> 1/61 + 1/61 = 2/61 (highest)
      expect(result[0].id).toBe('a');
      expect(result[0].score).toBeCloseTo(2 / 61, 10);
      // 'b' is rank 1 in both lists -> 1/62 + 1/62 = 2/62
      expect(result[1].id).toBe('b');
      expect(result[1].score).toBeCloseTo(2 / 62, 10);
      // 'c' and 'd' each appear once at rank 2 -> 1/63
      const remaining = result.slice(2).map(r => r.id).sort();
      expect(remaining).toEqual(['c', 'd']);
      expect(result[2].score).toBeCloseTo(1 / 63, 10);
      expect(result[3].score).toBeCloseTo(1 / 63, 10);

      // Overlapping docs score higher than non-overlapping ones
      expect(result[0].score).toBeGreaterThan(result[2].score);
      expect(result[1].score).toBeGreaterThan(result[2].score);
    });

    it('topK limit restricts the number of returned results', () => {
      const result = reciprocalRankFusion(
        [[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]],
        60,
        3, // topK = 3
      );

      expect(result).toHaveLength(3);
      // The top 3 by rank should be returned
      expect(result.map(r => r.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('formatMetrics', () => {
    it('returns a formatted string containing all metric names and values', () => {
      const metrics: RAGMetrics = {
        precisionAtK: 0.85,
        recallAtK: 0.72,
        mrr: 0.68,
        ndcg: 0.79,
        avgLatencyMs: 42,
        totalQueries: 10,
      };

      const formatted = formatMetrics(metrics);

      expect(typeof formatted).toBe('string');
      // All metric labels present
      expect(formatted).toContain('Precision@K');
      expect(formatted).toContain('Recall@K');
      expect(formatted).toContain('MRR');
      expect(formatted).toContain('NDCG');
      expect(formatted).toContain('Avg Latency');
      expect(formatted).toContain('Queries');
      // Values are formatted (precision/recall to 4 decimals, latency to integer)
      expect(formatted).toContain('0.8500');
      expect(formatted).toContain('0.7200');
      expect(formatted).toContain('0.6800');
      expect(formatted).toContain('0.7900');
      expect(formatted).toContain('42ms');
      expect(formatted).toContain('10');
    });
  });
});
