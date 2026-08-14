/**
 * Token Budget Tests
 *
 * Tests for per-agent budget enforcement with multi-period limits.
 * Source: src/lib/token-budget.ts
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  default: path.join(__dirname, '.test-data'),
}));

import {
  getAgentBudget,
  checkBudget,
  recordSpend,
  setBudgetLimit,
  getBudgetUsage,
  checkTransferRateLimit,
  recordTransferRate,
  checkApiCallRateLimit,
  recordApiCallRate,
  listAllBudgets,
  DEFAULT_BUDGET_LIMITS,
} from '../src/lib/token-budget';

describe('Token Budget', () => {
  /** Generate a unique agent name to keep tests isolated. */
  const uniqueAgent = (prefix: string): string =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ──────────────────────────────────────────────
  // DEFAULT_BUDGET_LIMITS verification
  // ──────────────────────────────────────────────
  describe('DEFAULT_BUDGET_LIMITS', () => {
    it('should have correct CEO limits (5000 / 25000 / 100000)', () => {
      expect(DEFAULT_BUDGET_LIMITS.CEO.daily).toBe(5000);
      expect(DEFAULT_BUDGET_LIMITS.CEO.weekly).toBe(25000);
      expect(DEFAULT_BUDGET_LIMITS.CEO.monthly).toBe(100000);
    });

    it('should have correct default limits (1000 / 5000 / 20000)', () => {
      expect(DEFAULT_BUDGET_LIMITS.default.daily).toBe(1000);
      expect(DEFAULT_BUDGET_LIMITS.default.weekly).toBe(5000);
      expect(DEFAULT_BUDGET_LIMITS.default.monthly).toBe(20000);
    });

    it('should define limits for all known roles', () => {
      for (const role of ['CEO', 'PM', 'developer', 'designer', 'analyst', 'default']) {
        expect(DEFAULT_BUDGET_LIMITS[role]).toBeDefined();
        expect(DEFAULT_BUDGET_LIMITS[role].daily).toBeGreaterThan(0);
        expect(DEFAULT_BUDGET_LIMITS[role].weekly).toBeGreaterThan(0);
        expect(DEFAULT_BUDGET_LIMITS[role].monthly).toBeGreaterThan(0);
      }
    });
  });

  // ──────────────────────────────────────────────
  // Default budget creation
  // ──────────────────────────────────────────────
  describe('Default budget creation', () => {
    it('should create a budget with CEO role limits', () => {
      const agent = uniqueAgent('ceo-create');
      const budget = getAgentBudget(agent, 'CEO');

      expect(budget.agent).toBe(agent);
      expect(budget.limits).toHaveLength(3);

      const daily = budget.limits.find(l => l.period === 'daily');
      expect(daily?.limit).toBe(5000);
      expect(daily?.used).toBe(0);

      const weekly = budget.limits.find(l => l.period === 'weekly');
      expect(weekly?.limit).toBe(25000);

      const monthly = budget.limits.find(l => l.period === 'monthly');
      expect(monthly?.limit).toBe(100000);
    });

    it('should create a budget with default limits when no role is specified', () => {
      const agent = uniqueAgent('norole-create');
      const budget = getAgentBudget(agent);

      const daily = budget.limits.find(l => l.period === 'daily');
      expect(daily?.limit).toBe(1000);
    });

    it('should fall back to default limits for an unknown role', () => {
      const agent = uniqueAgent('unknownrole-create');
      const budget = getAgentBudget(agent, 'nonexistent-role');

      const daily = budget.limits.find(l => l.period === 'daily');
      expect(daily?.limit).toBe(1000);
    });

    it('should initialise rate limits with correct maximums', () => {
      const agent = uniqueAgent('ratelimits-init');
      const budget = getAgentBudget(agent);

      expect(budget.rateLimits.transfers).toEqual([]);
      expect(budget.rateLimits.apiCalls).toEqual([]);
      expect(budget.rateLimits.maxTransfersPerHour).toBe(20);
      expect(budget.rateLimits.maxApiCallsPerHour).toBe(100);
    });

    it('should set resetAt timestamps in the future', () => {
      const agent = uniqueAgent('resetat-create');
      const now = Date.now();
      const budget = getAgentBudget(agent, 'CEO');

      for (const limit of budget.limits) {
        expect(limit.resetAt).toBeGreaterThan(now);
        expect(limit.createdAt).toBeGreaterThan(0);
      }
    });
  });

  // ──────────────────────────────────────────────
  // Budget limit checking
  // ──────────────────────────────────────────────
  describe('Budget limit checking', () => {
    it('should return null when the amount is within the budget', () => {
      const agent = uniqueAgent('check-within');
      // CEO daily limit is 5000
      expect(checkBudget(agent, 500, 'CEO')).toBeNull();
    });

    it('should return null when the amount exactly equals the limit', () => {
      const agent = uniqueAgent('check-exact');
      // default daily limit is 1000
      expect(checkBudget(agent, 1000)).toBeNull();
    });

    it('should return an error string when the daily budget is exceeded', () => {
      const agent = uniqueAgent('check-exceed');
      // default daily limit is 1000
      const error = checkBudget(agent, 1001);
      expect(error).not.toBeNull();
      expect(error).toContain('daily budget exceeded');
    });

    it('should return an error string when accumulated spend exceeds the limit', () => {
      const agent = uniqueAgent('check-accumulated');
      recordSpend(agent, 800); // default daily 1000, used 800
      const error = checkBudget(agent, 300); // 800 + 300 = 1100 > 1000
      expect(error).not.toBeNull();
      expect(error).toContain('daily budget exceeded');
    });
  });

  // ──────────────────────────────────────────────
  // Negative / zero amount rejection
  // ──────────────────────────────────────────────
  describe('Negative and zero amount rejection', () => {
    it('should reject a zero amount in checkBudget', () => {
      const agent = uniqueAgent('zero-check');
      expect(checkBudget(agent, 0)).toBe('amount must be positive');
    });

    it('should reject a negative amount in checkBudget', () => {
      const agent = uniqueAgent('neg-check');
      expect(checkBudget(agent, -100)).toBe('amount must be positive');
    });

    it('should return false for a zero amount in recordSpend', () => {
      const agent = uniqueAgent('zero-spend');
      expect(recordSpend(agent, 0)).toBe(false);
    });

    it('should return false for a negative amount in recordSpend', () => {
      const agent = uniqueAgent('neg-spend');
      expect(recordSpend(agent, -50)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────
  // Recording spend
  // ──────────────────────────────────────────────
  describe('Recording spend', () => {
    it('should record a valid spend and return true', () => {
      const agent = uniqueAgent('spend-ok');
      expect(recordSpend(agent, 100, 'CEO')).toBe(true);
    });

    it('should return false when the spend exceeds the budget', () => {
      const agent = uniqueAgent('spend-exceed');
      // default daily limit is 1000
      expect(recordSpend(agent, 1001)).toBe(false);
    });

    it('should increase usage across all periods after a spend', () => {
      const agent = uniqueAgent('spend-verify');
      recordSpend(agent, 200, 'CEO');

      const budget = getAgentBudget(agent);
      const daily = budget.limits.find(l => l.period === 'daily');
      const weekly = budget.limits.find(l => l.period === 'weekly');
      const monthly = budget.limits.find(l => l.period === 'monthly');

      expect(daily?.used).toBe(200);
      expect(weekly?.used).toBe(200);
      expect(monthly?.used).toBe(200);
    });

    it('should accumulate spend across multiple calls', () => {
      const agent = uniqueAgent('spend-multi');
      recordSpend(agent, 300, 'CEO');
      recordSpend(agent, 200, 'CEO');

      const budget = getAgentBudget(agent);
      const daily = budget.limits.find(l => l.period === 'daily');
      expect(daily?.used).toBe(500);
    });

    it('should reject further spend after the budget is exhausted', () => {
      const agent = uniqueAgent('spend-exhaust');
      // default daily limit is 1000
      expect(recordSpend(agent, 1000)).toBe(true);
      expect(recordSpend(agent, 1)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────
  // Setting custom budget limits
  // ──────────────────────────────────────────────
  describe('Setting custom budget limits', () => {
    it('should set a custom daily limit', () => {
      const agent = uniqueAgent('custom-daily');
      setBudgetLimit(agent, 'daily', 9999);

      const budget = getAgentBudget(agent);
      const daily = budget.limits.find(l => l.period === 'daily');
      expect(daily?.limit).toBe(9999);
    });

    it('should set a custom weekly limit', () => {
      const agent = uniqueAgent('custom-weekly');
      setBudgetLimit(agent, 'weekly', 50000);

      const budget = getAgentBudget(agent);
      const weekly = budget.limits.find(l => l.period === 'weekly');
      expect(weekly?.limit).toBe(50000);
    });

    it('should set a custom monthly limit', () => {
      const agent = uniqueAgent('custom-monthly');
      setBudgetLimit(agent, 'monthly', 200000);

      const budget = getAgentBudget(agent);
      const monthly = budget.limits.find(l => l.period === 'monthly');
      expect(monthly?.limit).toBe(200000);
    });

    it('should allow spending up to the new custom limit', () => {
      const agent = uniqueAgent('custom-spend');
      setBudgetLimit(agent, 'daily', 5000);

      expect(checkBudget(agent, 5000)).toBeNull();
      expect(recordSpend(agent, 5000)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────
  // Budget usage statistics
  // ──────────────────────────────────────────────
  describe('Budget usage statistics', () => {
    it('should return usage stats with all required fields', () => {
      const agent = uniqueAgent('usage-fields');
      const usage = getBudgetUsage(agent);

      expect(usage).toHaveLength(3);
      for (const stat of usage) {
        expect(stat).toHaveProperty('period');
        expect(stat).toHaveProperty('limit');
        expect(stat).toHaveProperty('used');
        expect(stat).toHaveProperty('remaining');
        expect(stat).toHaveProperty('utilization');
        expect(stat).toHaveProperty('resetAt');
      }
    });

    it('should calculate remaining correctly', () => {
      const agent = uniqueAgent('usage-remaining');
      recordSpend(agent, 300, 'CEO'); // daily limit 5000

      const usage = getBudgetUsage(agent);
      const daily = usage.find(u => u.period === 'daily');
      expect(daily?.used).toBe(300);
      expect(daily?.remaining).toBe(5000 - 300);
    });

    it('should calculate utilization correctly', () => {
      const agent = uniqueAgent('usage-util');
      recordSpend(agent, 1000, 'CEO'); // daily limit 5000, used 1000 -> 0.2

      const usage = getBudgetUsage(agent);
      const daily = usage.find(u => u.period === 'daily');
      expect(daily?.utilization).toBeCloseTo(0.2, 5);
    });

    it('should show 0 utilization for an unused budget', () => {
      const agent = uniqueAgent('usage-empty');
      const usage = getBudgetUsage(agent);
      const daily = usage.find(u => u.period === 'daily');

      expect(daily?.utilization).toBe(0);
      expect(daily?.used).toBe(0);
      expect(daily?.remaining).toBe(daily?.limit);
    });

    it('should reflect spend in all periods of the usage stats', () => {
      const agent = uniqueAgent('usage-allperiods');
      recordSpend(agent, 250, 'CEO');

      const usage = getBudgetUsage(agent);
      for (const stat of usage) {
        expect(stat.used).toBe(250);
        expect(stat.remaining).toBe(stat.limit - 250);
      }
    });
  });

  // ──────────────────────────────────────────────
  // Transfer rate limiting
  // ──────────────────────────────────────────────
  describe('Transfer rate limiting', () => {
    it('should allow transfers when under the limit (19 of 20)', () => {
      const agent = uniqueAgent('transfer-under');
      for (let i = 0; i < 19; i++) {
        recordTransferRate(agent, 10);
      }
      expect(checkTransferRateLimit(agent)).toBeNull();
    });

    it('should block transfers when the limit is reached (20 of 20)', () => {
      const agent = uniqueAgent('transfer-at');
      for (let i = 0; i < 20; i++) {
        recordTransferRate(agent, 10);
      }
      const error = checkTransferRateLimit(agent);
      expect(error).not.toBeNull();
      expect(error).toContain('Rate limit exceeded');
      expect(error).toContain('20/20');
    });

    it('should allow transfers for a fresh agent', () => {
      const agent = uniqueAgent('transfer-fresh');
      expect(checkTransferRateLimit(agent)).toBeNull();
    });
  });

  // ──────────────────────────────────────────────
  // API call rate limiting
  // ──────────────────────────────────────────────
  describe('API call rate limiting', () => {
    it('should allow API calls when under the limit (99 of 100)', () => {
      const agent = uniqueAgent('api-under');
      for (let i = 0; i < 99; i++) {
        recordApiCallRate(agent, 1);
      }
      expect(checkApiCallRateLimit(agent)).toBeNull();
    });

    it('should block API calls when the limit is reached (100 of 100)', () => {
      const agent = uniqueAgent('api-at');
      for (let i = 0; i < 100; i++) {
        recordApiCallRate(agent, 1);
      }
      const error = checkApiCallRateLimit(agent);
      expect(error).not.toBeNull();
      expect(error).toContain('API rate limit exceeded');
      expect(error).toContain('100/100');
    });

    it('should allow API calls for a fresh agent', () => {
      const agent = uniqueAgent('api-fresh');
      expect(checkApiCallRateLimit(agent)).toBeNull();
    });
  });

  // ──────────────────────────────────────────────
  // listAllBudgets
  // ──────────────────────────────────────────────
  describe('listAllBudgets', () => {
    it('should return an array of agent budgets', () => {
      const agent = uniqueAgent('list-all');
      // recordSpend persists the budget to disk
      recordSpend(agent, 10, 'CEO');

      const budgets = listAllBudgets();
      expect(Array.isArray(budgets)).toBe(true);
      expect(budgets.length).toBeGreaterThanOrEqual(1);

      const found = budgets.find(b => b.agent === agent);
      expect(found).toBeDefined();
      expect(found?.agent).toBe(agent);
      expect(found?.limits).toHaveLength(3);
    });

    it('should include persisted budgets with correct structure', () => {
      const agent = uniqueAgent('list-structure');
      recordSpend(agent, 42, 'CEO');

      const budgets = listAllBudgets();
      const found = budgets.find(b => b.agent === agent);
      expect(found).toBeDefined();
      expect(found).toHaveProperty('rateLimits');
      expect(found).toHaveProperty('updatedAt');
      expect(found?.rateLimits).toHaveProperty('maxTransfersPerHour');
      expect(found?.rateLimits).toHaveProperty('maxApiCallsPerHour');
    });
  });
});
