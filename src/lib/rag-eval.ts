/**
 * rag-eval.ts — RAG evaluation framework (RAGAS-inspired)
 *
 * Implements core retrieval evaluation metrics:
 * - Precision@K: fraction of relevant docs in top-K
 * - Recall@K: fraction of all relevant docs retrieved
 * - MRR: Mean Reciprocal Rank
 * - NDCG: Normalized Discounted Cumulative Gain
 *
 * References: RAGAS framework, TREC evaluation methodology
 */

import { createLogger } from './logger';

const log = createLogger('rag-eval');

export interface EvalQuery {
  query: string;
  relevantDocIds: string[];  // Ground truth relevant document IDs
}

export interface RAGMetrics {
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  ndcg: number;
  avgLatencyMs: number;
  totalQueries: number;
}

/**
 * Evaluate a search function using a set of test queries.
 *
 * @param testQueries - Array of {query, relevantDocIds}
 * @param searchFn - Function that takes a query and returns results with document IDs
 * @param k - The K for Precision@K and Recall@K (default 5)
 */
export async function evaluateRAG(
  testQueries: EvalQuery[],
  searchFn: (query: string) => Promise<Array<{ id: string; score?: number }>>,
  k: number = 5
): Promise<RAGMetrics> {
  let totalPrecision = 0;
  let totalRecall = 0;
  let totalMrr = 0;
  let totalNdcg = 0;
  let totalLatency = 0;

  for (const { query, relevantDocIds } of testQueries) {
    const startTime = Date.now();
    const results = await searchFn(query);
    const latency = Date.now() - startTime;
    totalLatency += latency;

    const retrievedIds = results.slice(0, k).map(r => r.id);
    const relevantSet = new Set(relevantDocIds);

    // Precision@K
    const relevantRetrieved = retrievedIds.filter(id => relevantSet.has(id)).length;
    totalPrecision += retrievedIds.length > 0 ? relevantRetrieved / retrievedIds.length : 0;

    // Recall@K
    totalRecall += relevantDocIds.length > 0 ? relevantRetrieved / relevantDocIds.length : 0;

    // MRR — position of first relevant document
    const firstRelevantIdx = results.findIndex(r => relevantSet.has(r.id));
    if (firstRelevantIdx >= 0) {
      totalMrr += 1 / (firstRelevantIdx + 1);
    }

    // NDCG@K
    const dcg = retrievedIds.reduce((sum, id, idx) => {
      const relevance = relevantSet.has(id) ? 1 : 0;
      return sum + (relevance / Math.log2(idx + 2));
    }, 0);

    const idealGains = relevantDocIds.slice(0, k).map((_, idx) => 1 / Math.log2(idx + 2));
    const idcg = idealGains.reduce((a, b) => a + b, 0);
    totalNdcg += idcg > 0 ? dcg / idcg : 0;
  }

  const n = testQueries.length;
  const metrics: RAGMetrics = {
    precisionAtK: n > 0 ? totalPrecision / n : 0,
    recallAtK: n > 0 ? totalRecall / n : 0,
    mrr: n > 0 ? totalMrr / n : 0,
    ndcg: n > 0 ? totalNdcg / n : 0,
    avgLatencyMs: n > 0 ? totalLatency / n : 0,
    totalQueries: n,
  };

  log.info('RAG evaluation complete:', metrics);
  return metrics;
}

/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked lists.
 *
 * RRF_score(d) = Σ 1/(k + rank_i(d))
 *
 * @param rankedLists - Array of ranked result lists, each with {id, score?}
 * @param k - RRF constant (default 60)
 * @param topK - Maximum results to return
 */
export function reciprocalRankFusion(
  rankedLists: Array<Array<{ id: string; score?: number }>>,
  k: number = 60,
  topK: number = 10
): Array<{ id: string; score: number }> {
  const rrfScores = new Map<string, number>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const docId = list[rank].id;
      const rrfScore = 1 / (k + rank + 1); // rank is 0-indexed, so +1
      rrfScores.set(docId, (rrfScores.get(docId) || 0) + rrfScore);
    }
  }

  return Array.from(rrfScores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Format metrics for display.
 */
export function formatMetrics(metrics: RAGMetrics): string {
  return [
    `Precision@K: ${metrics.precisionAtK.toFixed(4)}`,
    `Recall@K:    ${metrics.recallAtK.toFixed(4)}`,
    `MRR:         ${metrics.mrr.toFixed(4)}`,
    `NDCG:        ${metrics.ndcg.toFixed(4)}`,
    `Avg Latency: ${metrics.avgLatencyMs.toFixed(0)}ms`,
    `Queries:     ${metrics.totalQueries}`,
  ].join('\n');
}
