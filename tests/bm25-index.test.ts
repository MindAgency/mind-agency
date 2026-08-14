/**
 * BM25 Index Tests
 *
 * Tests for src/lib/bm25-index.ts covering:
 * - tokenize: English words, Chinese bigrams + unigrams, mixed text
 * - BM25Index: addDocument, removeDocument, search, getScore, getStats, clear
 *
 * bm25-index.ts persists to MIND_DIR/rag/bm25-index.json, so the data-dir
 * module is mocked to point at a test-local directory. Each test builds a
 * fresh BM25Index instance and clears it in beforeEach/afterEach so the
 * suite is self-contained.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  default: path.join(__dirname, '.test-data'),
}));

import { tokenize, BM25Index } from '../src/lib/bm25-index';

describe('BM25 Index', () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
    index.clear();
  });

  afterEach(() => {
    index.clear();
  });

  describe('tokenize', () => {
    it('English text splits into lowercase word tokens', () => {
      const tokens = tokenize('hello world foo bar');

      expect(tokens).toContain('hello');
      expect(tokens).toContain('world');
      expect(tokens).toContain('foo');
      expect(tokens).toContain('bar');
      // No Chinese characters -> only the 4 English words
      expect(tokens).toHaveLength(4);
    });

    it('Chinese text produces bigrams and unigrams', () => {
      // "机器学习" has 4 characters:
      //   bigrams: 机器, 器学, 学习 (3)
      //   unigrams: 机, 器, 学, 习 (4)
      // total = 7 tokens
      const tokens = tokenize('机器学习');

      expect(tokens).toContain('机器');
      expect(tokens).toContain('器学');
      expect(tokens).toContain('学习');
      expect(tokens).toContain('机');
      expect(tokens).toContain('器');
      expect(tokens).toContain('学');
      expect(tokens).toContain('习');
      expect(tokens).toHaveLength(7);
    });

    it('mixed Chinese and English text combines both token sets', () => {
      // "hello 世界 foo"
      //   English: hello, foo (2)
      //   Chinese "世界": bigram 世界 (1) + unigrams 世, 界 (2) = 3
      // total = 5 tokens
      const tokens = tokenize('hello 世界 foo');

      expect(tokens).toContain('hello');
      expect(tokens).toContain('foo');
      expect(tokens).toContain('世界');
      expect(tokens).toContain('世');
      expect(tokens).toContain('界');
      expect(tokens).toHaveLength(5);
    });
  });

  describe('BM25Index', () => {
    it('addDocument and search: relevant docs score higher', () => {
      index.addDocument('doc1', 'machine learning is great');
      index.addDocument('doc2', 'cooking recipes for dinner');
      index.addDocument('doc3', 'machine learning models');

      const results = index.search('machine learning', 10);

      // doc1 and doc3 contain the query terms; doc2 does not
      const docIds = results.map(r => r.docId);
      expect(docIds).toContain('doc1');
      expect(docIds).toContain('doc3');
      expect(docIds).not.toContain('doc2');

      // Results are sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
      }
      // Every returned score is positive
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
      }
    });

    it('removeDocument: document no longer appears in search results', () => {
      index.addDocument('doc1', 'hello world');
      index.addDocument('doc2', 'hello foo');

      index.removeDocument('doc1');

      const results = index.search('hello', 10);
      const docIds = results.map(r => r.docId);

      expect(docIds).not.toContain('doc1');
      expect(docIds).toContain('doc2');
    });

    it('search with no documents returns an empty array', () => {
      const results = index.search('hello world', 10);

      expect(results).toEqual([]);
    });

    it('search with no matching tokens returns an empty array', () => {
      index.addDocument('doc1', 'hello world');

      const results = index.search('cooking recipes', 10);

      expect(results).toEqual([]);
    });

    it('getScore returns a positive score for a matching doc and 0 for others', () => {
      index.addDocument('doc1', 'machine learning');
      index.addDocument('doc2', 'cooking recipes');

      // Matching document -> positive score
      const scoreMatching = index.getScore('machine learning', 'doc1');
      expect(scoreMatching).toBeGreaterThan(0);

      // Non-matching existing document -> 0
      const scoreNonMatching = index.getScore('machine learning', 'doc2');
      expect(scoreNonMatching).toBe(0);

      // Non-existing document -> 0
      const scoreMissing = index.getScore('machine learning', 'does-not-exist');
      expect(scoreMissing).toBe(0);
    });

    it('getStats returns correct totalDocs, totalTerms, and avgDocLength', () => {
      index.addDocument('doc1', 'hello world foo');   // 3 tokens
      index.addDocument('doc2', 'hello bar baz');     // 3 tokens

      const stats = index.getStats();

      expect(stats.totalDocs).toBe(2);
      // Unique terms across the corpus: hello, world, foo, bar, baz = 5
      expect(stats.totalTerms).toBe(5);
      // avgDocLength = totalTokens / totalDocs = (3 + 3) / 2 = 3
      expect(stats.avgDocLength).toBe(3);
    });

    it('clear removes all documents and resets stats', () => {
      index.addDocument('doc1', 'hello world');
      index.addDocument('doc2', 'foo bar');

      index.clear();

      const stats = index.getStats();
      expect(stats.totalDocs).toBe(0);
      expect(stats.totalTerms).toBe(0);
      expect(stats.avgDocLength).toBe(0);

      // Search returns nothing after clear
      const results = index.search('hello', 10);
      expect(results).toEqual([]);
    });

    it('re-adding the same docId updates the document instead of duplicating', () => {
      index.addDocument('doc1', 'hello world');

      // Re-add with new content
      index.addDocument('doc1', 'foo bar');

      const stats = index.getStats();
      expect(stats.totalDocs).toBe(1);

      // The document now matches "foo", not "hello"
      expect(index.search('foo', 10).map(r => r.docId)).toContain('doc1');
      expect(index.search('hello', 10).map(r => r.docId)).not.toContain('doc1');
    });
  });
});
