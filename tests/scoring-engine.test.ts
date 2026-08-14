/**
 * Scoring Engine Tests
 *
 * Tests for src/lib/scoring-engine.ts covering:
 * - evaluateContent: 6 scoring dimensions (quality, expression, structure,
 *   audience, originality, virality), total, percentage, feedback, suggestions
 * - Content features: title (#), emoji, lists, dialogue marks, length
 * - Feedback thresholds: >=90 优秀, >=70 良好, else 需改进
 * - Suggestions: one per dimension scoring < 7
 *
 * No data-dir dependency — scoring-engine is a pure function.
 *
 * Note on emoji: '\u{1F600}' is 😀 (U+1F600), matched by the engine's emoji
 * regex /[\u{1F600}-\u{1F64F}]/u. It occupies 2 UTF-16 code units, which is
 * accounted for in content.length calculations below.
 */

import { describe, it, expect } from 'vitest';
import { evaluateContent, type ScoreResult } from '../src/lib/scoring-engine';

describe('Scoring Engine', () => {
  const DIMENSIONS = ['quality', 'expression', 'structure', 'audience', 'originality', 'virality'] as const;

  describe('evaluateContent - base scoring', () => {
    it('short content yields lower scores and "需改进" feedback', () => {
      const result = evaluateContent('', 'article');

      // Empty content: every dimension floors at its minimum (5)
      for (const dim of DIMENSIONS) {
        expect(result.scores[dim]).toBe(5);
      }
      // total = 30, percentage = round(30/60*100) = 50
      expect(result.total).toBe(30);
      expect(result.percentage).toBe(50);
      // 50 < 70 -> "需改进"
      expect(result.feedback).toBe('需改进');
    });

    it('long content with title, lists, emoji, and dialogue yields higher scores', () => {
      const shortResult = evaluateContent('', 'article');
      // Title + emoji + list + dialogue + long body
      const content =
        '# Title\n\u{1F600}\n- item one\n- item two\n\n"Dialogue"\n\n' + 'a'.repeat(1500);
      const result = evaluateContent(content, 'article');

      // Long, feature-rich content scores much higher than empty content
      expect(result.total).toBeGreaterThan(shortResult.total);
      expect(result.percentage).toBeGreaterThanOrEqual(90);
      expect(result.feedback).toBe('优秀，可发布');
      // Most dimensions should be at or near the max (10)
      const maxedDimensions = DIMENSIONS.filter(d => result.scores[d] === 10);
      expect(maxedDimensions.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('evaluateContent - content feature boosts', () => {
    it('content with a markdown title (#) boosts the structure score', () => {
      const withoutTitle = evaluateContent('some text here', 'article');
      const withTitle = evaluateContent('# some text here', 'article');

      // hasTitle adds +3 to structure
      expect(withTitle.scores.structure).toBeGreaterThan(withoutTitle.scores.structure);
    });

    it('content with emoji boosts expression, audience, and virality scores', () => {
      // Same length (800 code units) so the only difference is the emoji.
      const base = 'a'.repeat(800);
      const withEmoji = 'a'.repeat(798) + '\u{1F600}'; // 798 + 2 (surrogate pair) = 800

      const without = evaluateContent(base, 'article');
      const withEm = evaluateContent(withEmoji, 'article');

      // emoji adds +1 expression, +2 audience, +2 virality
      expect(withEm.scores.expression).toBeGreaterThan(without.scores.expression);
      expect(withEm.scores.audience).toBeGreaterThan(without.scores.audience);
      expect(withEm.scores.virality).toBeGreaterThan(without.scores.virality);
    });

    it('content with lists boosts the structure score', () => {
      // Use a title to raise the base structure above 5 so the list bonus is visible.
      const withoutList = evaluateContent('# Title\nsome text here', 'article');
      const withList = evaluateContent('# Title\n- item one', 'article');

      // hasList adds +2 to structure
      expect(withList.scores.structure).toBeGreaterThan(withoutList.scores.structure);
    });
  });

  describe('evaluateContent - percentage calculation', () => {
    it('percentage = round(total / 60 * 100)', () => {
      const contents = [
        '',
        '# Title',
        'a'.repeat(500),
        '# Title\n- list\n\n' + 'b'.repeat(300),
        '# Title\n\u{1F600}\n- item one\n- item two\n\n"Dialogue"\n\n' + 'a'.repeat(800),
      ];

      for (const content of contents) {
        const result = evaluateContent(content, 'article');
        expect(result.percentage).toBe(Math.round((result.total / 60) * 100));
      }
    });
  });

  describe('evaluateContent - feedback thresholds', () => {
    it('feedback is "优秀，可发布" when percentage >= 90', () => {
      const content =
        '# Title\n\u{1F600}\n- item one\n- item two\n\n"Dialogue"\n\n' + 'a'.repeat(1500);
      const result = evaluateContent(content, 'article');

      expect(result.percentage).toBeGreaterThanOrEqual(90);
      expect(result.feedback).toBe('优秀，可发布');
    });

    it('feedback is "良好，需小修改" when 70 <= percentage < 90', () => {
      // Medium-length feature-rich content lands in the 70-89 band.
      const content =
        '# Title\n\u{1F600}\n- item one\n- item two\n\n"Dialogue"\n\n' + 'a'.repeat(800);
      const result = evaluateContent(content, 'article');

      expect(result.percentage).toBeGreaterThanOrEqual(70);
      expect(result.percentage).toBeLessThan(90);
      expect(result.feedback).toBe('良好，需小修改');
    });

    it('feedback is "需改进" when percentage < 70', () => {
      const result = evaluateContent('', 'article');

      expect(result.percentage).toBeLessThan(70);
      expect(result.feedback).toBe('需改进');
    });
  });

  describe('evaluateContent - suggestions', () => {
    it('generates one suggestion per dimension scoring below 7', () => {
      // Empty content: every dimension = 5 (< 7) -> 6 suggestions
      const result = evaluateContent('', 'article');

      expect(result.suggestions).toHaveLength(6);
      // Each low dimension has its own piece of advice
      expect(result.suggestions.some(s => s.includes('具体内容'))).toBe(true); // quality
      expect(result.suggestions.some(s => s.includes('生动'))).toBe(true);     // expression
      expect(result.suggestions.some(s => s.includes('标题'))).toBe(true);     // structure
      expect(result.suggestions.some(s => s.includes('emoji'))).toBe(true);    // audience
      expect(result.suggestions.some(s => s.includes('独特视角'))).toBe(true); // originality
      expect(result.suggestions.some(s => s.includes('金句'))).toBe(true);     // virality
    });

    it('produces fewer suggestions when content has good features', () => {
      // Title + list + long body push several dimensions above 7.
      const content = '# Title\n- item one\n- item two\n\n' + 'a'.repeat(2000);
      const result = evaluateContent(content, 'article');

      const lowScoreCount = DIMENSIONS.filter(d => result.scores[d] < 7).length;
      expect(result.suggestions).toHaveLength(lowScoreCount);
      // High-quality content should need fewer than the maximum 6 suggestions
      expect(result.suggestions.length).toBeLessThan(6);
    });
  });

  describe('evaluateContent - return shape', () => {
    it('returns a ScoreResult with all required fields and correct types', () => {
      const result: ScoreResult = evaluateContent('test content', 'article');

      expect(result).toHaveProperty('scores');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('percentage');
      expect(result).toHaveProperty('feedback');
      expect(result).toHaveProperty('suggestions');

      // scores has exactly the 6 dimensions
      expect(Object.keys(result.scores)).toHaveLength(6);
      for (const dim of DIMENSIONS) {
        expect(result.scores).toHaveProperty(dim);
      }

      expect(typeof result.total).toBe('number');
      expect(typeof result.percentage).toBe('number');
      expect(typeof result.feedback).toBe('string');
      expect(Array.isArray(result.suggestions)).toBe(true);
    });

    it('every score dimension is between 5 and 10 inclusive', () => {
      const contents = [
        '',
        '# Title',
        'a'.repeat(2000),
        '# Title\n\u{1F600}\n- list\n\n"dialogue"\n\n' + 'x'.repeat(1000),
      ];

      for (const content of contents) {
        const result = evaluateContent(content, 'article');
        for (const dim of DIMENSIONS) {
          expect(result.scores[dim]).toBeGreaterThanOrEqual(5);
          expect(result.scores[dim]).toBeLessThanOrEqual(10);
        }
      }
    });
  });
});
