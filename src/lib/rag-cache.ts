/**
 * rag-cache.ts — Multi-level caching for RAG queries and embeddings
 *
 * Implements the RAGCache design from rag-optimization-design.md:
 * - Query result cache with TTL and LRU eviction
 * - Embedding cache to avoid redundant model inference
 */

import { createLogger } from './logger';

const log = createLogger('rag-cache');

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

const MAX_QUERY_CACHE_SIZE = 1000;
const MAX_EMBEDDING_CACHE_SIZE = 10000;
const TTL_MS = 3600000; // 1 hour

/**
 * Simple hash function for cache keys.
 */
function hashKey(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * LRU-based query result cache.
 */
class QueryCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() - entry.timestamp > TTL_MS) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Move to end (LRU refresh)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= MAX_QUERY_CACHE_SIZE) {
      // Evict oldest entry (first in Map)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: MAX_QUERY_CACHE_SIZE,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.getHitRate(),
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/**
 * Embedding cache — avoids redundant model inference.
 */
class EmbeddingCache {
  private cache = new Map<string, number[]>();

  get(text: string): number[] | null {
    const key = hashKey(text);
    return this.cache.get(key) || null;
  }

  set(text: string, embedding: number[]): void {
    const key = hashKey(text);
    if (this.cache.size >= MAX_EMBEDDING_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, embedding);
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: MAX_EMBEDDING_CACHE_SIZE,
    };
  }

  clear(): void {
    this.cache.clear();
  }
}

// Singleton instances
export const queryCache = new QueryCache<any>();
export const embeddingCache = new EmbeddingCache();

/**
 * Get combined cache statistics.
 */
export function getCacheStats() {
  return {
    query: queryCache.getStats(),
    embedding: embeddingCache.getStats(),
  };
}

/**
 * Generate a cache key for a RAG query.
 */
export function makeQueryKey(query: string, topK: number, filter?: string): string {
  return hashKey(`${query}:${topK}:${filter || ''}`);
}
