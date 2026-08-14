/**
 * RAG Cache Tests
 *
 * Tests for src/lib/rag-cache.ts covering:
 * - queryCache: set/get hit, miss, hit rate, stats, clear
 * - embeddingCache: set/get, stats
 * - makeQueryKey: consistency and uniqueness
 * - getCacheStats: combined stats
 *
 * queryCache and embeddingCache are singletons, so each test clears them
 * in beforeEach to keep tests self-contained.
 *
 * No data-dir dependency — rag-cache only imports the logger.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  queryCache,
  embeddingCache,
  getCacheStats,
  makeQueryKey,
} from '../src/lib/rag-cache';

describe('RAG Cache', () => {
  beforeEach(() => {
    // Reset both singleton caches before every test for isolation.
    queryCache.clear();
    embeddingCache.clear();
  });

  describe('QueryCache', () => {
    it('set and get returns the stored value (hit)', () => {
      const value = { results: [{ id: 'doc1', score: 0.9 }] };
      queryCache.set('test-key', value);

      const retrieved = queryCache.get('test-key');

      expect(retrieved).toEqual(value);
    });

    it('miss returns null for a non-existent key', () => {
      const retrieved = queryCache.get('non-existent-key');

      expect(retrieved).toBeNull();
    });

    it('hit rate calculation = hits / (hits + misses)', () => {
      queryCache.set('key1', 'value1');

      queryCache.get('key1'); // hit
      queryCache.get('key1'); // hit
      queryCache.get('does-not-exist'); // miss

      const hitRate = queryCache.getHitRate();

      // 2 hits / (2 hits + 1 miss) = 2/3 ≈ 0.6667
      expect(hitRate).toBeCloseTo(2 / 3, 2);
    });

    it('getStats returns correct size, maxSize, hits, misses, and hitRate', () => {
      queryCache.set('key1', 'value1');
      queryCache.get('key1');   // hit
      queryCache.get('missing'); // miss

      const stats = queryCache.getStats();

      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(1000);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      // 1 hit / (1 hit + 1 miss) = 0.5
      expect(stats.hitRate).toBe(0.5);
    });

    it('clear resets cache size and all counters to zero', () => {
      queryCache.set('key1', 'value1');
      queryCache.set('key2', 'value2');
      queryCache.get('key1');    // hit
      queryCache.get('missing'); // miss

      queryCache.clear();

      const stats = queryCache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
      // A previously-set key is gone after clear
      expect(queryCache.get('key1')).toBeNull();
    });
  });

  describe('EmbeddingCache', () => {
    it('set and get returns the stored embedding', () => {
      const embedding = [0.1, 0.2, 0.3, 0.4];
      embeddingCache.set('hello world', embedding);

      const retrieved = embeddingCache.get('hello world');

      expect(retrieved).toEqual(embedding);
    });

    it('getStats returns correct size and maxSize', () => {
      embeddingCache.set('text1', [1, 2]);
      embeddingCache.set('text2', [3, 4]);

      const stats = embeddingCache.getStats();

      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(10000);
    });
  });

  describe('makeQueryKey', () => {
    it('generates consistent keys for the same input', () => {
      const key1 = makeQueryKey('test query', 5);
      const key2 = makeQueryKey('test query', 5);

      expect(key1).toBe(key2);
      expect(typeof key1).toBe('string');
    });

    it('generates consistent keys for the same input including a filter', () => {
      const key1 = makeQueryKey('test query', 5, 'filter1');
      const key2 = makeQueryKey('test query', 5, 'filter1');

      expect(key1).toBe(key2);
    });

    it('generates different keys for different input', () => {
      const keyA = makeQueryKey('query a', 5);
      const keyB = makeQueryKey('query b', 5);
      const keyTopK = makeQueryKey('query a', 10);
      const keyFilter1 = makeQueryKey('query a', 5, 'f1');
      const keyFilter2 = makeQueryKey('query a', 5, 'f2');

      // Different query text
      expect(keyA).not.toBe(keyB);
      // Different topK
      expect(keyA).not.toBe(keyTopK);
      // Different filter
      expect(keyFilter1).not.toBe(keyFilter2);
    });
  });

  describe('getCacheStats', () => {
    it('returns combined stats for query and embedding caches', () => {
      queryCache.set('q1', 'value1');
      embeddingCache.set('e1', [1, 2, 3]);

      const stats = getCacheStats();

      expect(stats).toHaveProperty('query');
      expect(stats).toHaveProperty('embedding');
      expect(stats.query.size).toBe(1);
      expect(stats.embedding.size).toBe(1);
      // Query stats carry the full shape
      expect(stats.query).toHaveProperty('hits');
      expect(stats.query).toHaveProperty('misses');
      expect(stats.query).toHaveProperty('hitRate');
      expect(stats.query).toHaveProperty('maxSize');
      // Embedding stats carry size + maxSize
      expect(stats.embedding).toHaveProperty('maxSize');
    });

    it('reflects updates to the individual caches', () => {
      queryCache.set('q1', 'value1');
      queryCache.set('q2', 'value2');
      embeddingCache.set('e1', [1]);

      const stats = getCacheStats();

      expect(stats.query.size).toBe(2);
      expect(stats.embedding.size).toBe(1);
    });
  });
});
