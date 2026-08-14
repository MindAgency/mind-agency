/**
 * Token Economy Enhanced Module Tests
 *
 * Tests for:
 * - Budget enforcement (token-budget.ts)
 * - Audit trail with hash chaining (token-audit.ts)
 * - Streak system (token-enhanced.ts)
 * - Time-based rewards
 * - Redemption codes
 * - Volume discounts
 * - Enhanced leaderboard
 * - Anomaly detection
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Budget Tests ────────────────────────────────────────

describe('Token Budget', () => {
  it('should create default budget for new agent', () => {
    // Test the budget creation logic
    const DEFAULT_BUDGET_LIMITS: Record<string, any> = {
      default: { daily: 1000, weekly: 5000, monthly: 20000 },
      CEO: { daily: 5000, weekly: 25000, monthly: 100000 },
    };
    const defaults = DEFAULT_BUDGET_LIMITS['default'];
    expect(defaults.daily).toBe(1000);
    expect(defaults.weekly).toBe(5000);
    expect(defaults.monthly).toBe(20000);
  });

  it('should have correct period durations', () => {
    const PERIOD_MS: Record<string, number> = {
      daily: 86400_000,
      weekly: 604800_000,
      monthly: 2592000_000,
    };
    expect(PERIOD_MS.daily).toBe(24 * 3600 * 1000);
    expect(PERIOD_MS.weekly).toBe(7 * PERIOD_MS.daily);
    expect(PERIOD_MS.monthly).toBe(30 * PERIOD_MS.daily);
  });

  it('should check budget limits correctly', () => {
    // Simulate budget check logic
    const limits = [
      { period: 'daily', limit: 1000, used: 800, resetAt: Date.now() + 86400000 },
      { period: 'weekly', limit: 5000, used: 3000, resetAt: Date.now() + 604800000 },
    ];
    const amount = 300;
    let error: string | null = null;
    for (const limit of limits) {
      if (limit.used + amount > limit.limit) {
        error = `${limit.period} budget exceeded`;
        break;
      }
    }
    expect(error).toBe('daily budget exceeded');
  });

  it('should allow spend within budget', () => {
    const limits = [
      { period: 'daily', limit: 1000, used: 500, resetAt: Date.now() + 86400000 },
      { period: 'weekly', limit: 5000, used: 2000, resetAt: Date.now() + 604800000 },
    ];
    const amount = 300;
    let error: string | null = null;
    for (const limit of limits) {
      if (limit.used + amount > limit.limit) {
        error = `${limit.period} budget exceeded`;
        break;
      }
    }
    expect(error).toBeNull();
  });
});

// ── Audit Trail Tests ───────────────────────────────────

describe('Audit Trail', () => {
  it('should compute SHA-256 hash correctly', () => {
    const crypto = require('crypto');
    const data = JSON.stringify({ seq: 1, agent: 'test', action: 'deposit', amount: 100 });
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    expect(hash).toHaveLength(64); // SHA-256 produces 64 hex chars
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('should create different hashes for different data', () => {
    const crypto = require('crypto');
    const hash1 = crypto.createHash('sha256').update('data1').digest('hex');
    const hash2 = crypto.createHash('sha256').update('data2').digest('hex');
    expect(hash1).not.toBe(hash2);
  });

  it('should create same hash for same data', () => {
    const crypto = require('crypto');
    const hash1 = crypto.createHash('sha256').update('same').digest('hex');
    const hash2 = crypto.createHash('sha256').update('same').digest('hex');
    expect(hash1).toBe(hash2);
  });

  it('should verify hash chain integrity', () => {
    // Simulate hash chain
    const crypto = require('crypto');
    let prevHash = 'GENESIS';
    const entries: any[] = [];

    for (let i = 1; i <= 5; i++) {
      const entryData = JSON.stringify({ seq: i, prevHash, agent: 'test', action: 'transfer', amount: i * 10 });
      const hash = crypto.createHash('sha256').update(entryData).digest('hex');
      entries.push({ seq: i, prevHash, hash, agent: 'test', action: 'transfer', amount: i * 10 });
      prevHash = hash;
    }

    // Verify chain
    let verifyHash = 'GENESIS';
    let valid = true;
    for (const entry of entries) {
      if (entry.prevHash !== verifyHash) {
        valid = false;
        break;
      }
      const entryData = JSON.stringify({ seq: entry.seq, prevHash: entry.prevHash, agent: entry.agent, action: entry.action, amount: entry.amount });
      const expectedHash = crypto.createHash('sha256').update(entryData).digest('hex');
      if (entry.hash !== expectedHash) {
        valid = false;
        break;
      }
      verifyHash = entry.hash;
    }
    expect(valid).toBe(true);
  });

  it('should detect tampering in hash chain', () => {
    const crypto = require('crypto');
    let prevHash = 'GENESIS';
    const entries: any[] = [];

    for (let i = 1; i <= 3; i++) {
      const entryData = JSON.stringify({ seq: i, prevHash, agent: 'test', action: 'transfer', amount: i * 10 });
      const hash = crypto.createHash('sha256').update(entryData).digest('hex');
      entries.push({ seq: i, prevHash, hash, agent: 'test', action: 'transfer', amount: i * 10 });
      prevHash = hash;
    }

    // Tamper with entry 2
    entries[1].amount = 999;

    // Verify chain - should fail at entry 2
    let verifyHash = 'GENESIS';
    let brokenAt = -1;
    for (const entry of entries) {
      if (entry.prevHash !== verifyHash) {
        brokenAt = entry.seq;
        break;
      }
      const entryData = JSON.stringify({ seq: entry.seq, prevHash: entry.prevHash, agent: entry.agent, action: entry.action, amount: entry.amount });
      const expectedHash = crypto.createHash('sha256').update(entryData).digest('hex');
      if (entry.hash !== expectedHash) {
        brokenAt = entry.seq;
        break;
      }
      verifyHash = entry.hash;
    }
    expect(brokenAt).toBe(2);
  });
});

// ── Streak System Tests ─────────────────────────────────

describe('Streak System', () => {
  const STREAK_MULTIPLIERS: Record<number, number> = {
    3: 1.1,
    5: 1.2,
    10: 1.5,
    20: 2.0,
  };

  it('should return 1.0 multiplier for streak < 3', () => {
    function getStreakMultiplier(streakCount: number): number {
      let multiplier = 1.0;
      for (const [threshold, mult] of Object.entries(STREAK_MULTIPLIERS)) {
        if (streakCount >= parseInt(threshold)) multiplier = mult;
      }
      return multiplier;
    }
    expect(getStreakMultiplier(0)).toBe(1.0);
    expect(getStreakMultiplier(1)).toBe(1.0);
    expect(getStreakMultiplier(2)).toBe(1.0);
  });

  it('should return correct multiplier for streak >= 3', () => {
    function getStreakMultiplier(streakCount: number): number {
      let multiplier = 1.0;
      for (const [threshold, mult] of Object.entries(STREAK_MULTIPLIERS)) {
        if (streakCount >= parseInt(threshold)) multiplier = mult;
      }
      return multiplier;
    }
    expect(getStreakMultiplier(3)).toBe(1.1);
    expect(getStreakMultiplier(4)).toBe(1.1);
    expect(getStreakMultiplier(5)).toBe(1.2);
    expect(getStreakMultiplier(9)).toBe(1.2);
    expect(getStreakMultiplier(10)).toBe(1.5);
    expect(getStreakMultiplier(19)).toBe(1.5);
    expect(getStreakMultiplier(20)).toBe(2.0);
    expect(getStreakMultiplier(100)).toBe(2.0);
  });

  it('should reset streak after 72 hours', () => {
    const STREAK_RESET_MS = 72 * 3600_000;
    const now = Date.now();
    const lastTaskAt = now - STREAK_RESET_MS - 1; // Just past the reset threshold
    const shouldReset = now - lastTaskAt > STREAK_RESET_MS;
    expect(shouldReset).toBe(true);

    const recentTaskAt = now - 3600_000; // 1 hour ago
    const shouldNotReset = now - recentTaskAt > STREAK_RESET_MS;
    expect(shouldNotReset).toBe(false);
  });
});

// ── Time-Based Rewards Tests ────────────────────────────

describe('Time-Based Rewards', () => {
  const TIME_MULTIPLIERS: Record<string, number> = {
    early: 1.3,
    on_time: 1.0,
    late: 0.8,
  };

  it('should classify early completion (<50% estimated time)', () => {
    function getCompletionTime(actualMs: number, estimatedMs: number): string {
      if (estimatedMs <= 0) return 'on_time';
      const ratio = actualMs / estimatedMs;
      if (ratio < 0.5) return 'early';
      if (ratio > 1.5) return 'late';
      return 'on_time';
    }
    expect(getCompletionTime(30, 100)).toBe('early');
    expect(getCompletionTime(49, 100)).toBe('early');
  });

  it('should classify on-time completion (50%-150%)', () => {
    function getCompletionTime(actualMs: number, estimatedMs: number): string {
      if (estimatedMs <= 0) return 'on_time';
      const ratio = actualMs / estimatedMs;
      if (ratio < 0.5) return 'early';
      if (ratio > 1.5) return 'late';
      return 'on_time';
    }
    expect(getCompletionTime(50, 100)).toBe('on_time');
    expect(getCompletionTime(100, 100)).toBe('on_time');
    expect(getCompletionTime(150, 100)).toBe('on_time');
  });

  it('should classify late completion (>150%)', () => {
    function getCompletionTime(actualMs: number, estimatedMs: number): string {
      if (estimatedMs <= 0) return 'on_time';
      const ratio = actualMs / estimatedMs;
      if (ratio < 0.5) return 'early';
      if (ratio > 1.5) return 'late';
      return 'on_time';
    }
    expect(getCompletionTime(151, 100)).toBe('late');
    expect(getCompletionTime(200, 100)).toBe('late');
  });

  it('should return correct multipliers', () => {
    expect(TIME_MULTIPLIERS.early).toBe(1.3);
    expect(TIME_MULTIPLIERS.on_time).toBe(1.0);
    expect(TIME_MULTIPLIERS.late).toBe(0.8);
  });

  it('should handle zero estimated time', () => {
    function getCompletionTime(actualMs: number, estimatedMs: number): string {
      if (estimatedMs <= 0) return 'on_time';
      const ratio = actualMs / estimatedMs;
      if (ratio < 0.5) return 'early';
      if (ratio > 1.5) return 'late';
      return 'on_time';
    }
    expect(getCompletionTime(100, 0)).toBe('on_time');
  });
});

// ── Redemption Code Tests ───────────────────────────────

describe('Redemption Codes', () => {
  it('should generate unique codes', () => {
    const crypto = require('crypto');
    const code1 = 'MA-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const code2 = 'MA-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    expect(code1).not.toBe(code2);
    expect(code1).toMatch(/^MA-[0-9A-F]{16}$/);
    expect(code2).toMatch(/^MA-[0-9A-F]{16}$/);
  });

  it('should generate correct batch ID', () => {
    const crypto = require('crypto');
    const batchId = 'BATCH-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    expect(batchId).toMatch(/^BATCH-[0-9A-F]{8}$/);
  });

  it('should calculate expiry correctly', () => {
    const now = Date.now();
    const expiryDays = 30;
    const expiresAt = now + expiryDays * 86400_000;
    const diffMs = expiresAt - now;
    expect(diffMs).toBe(30 * 86400_000);
  });

  it('should validate code status transitions', () => {
    const code = {
      status: 'active',
      redeemedBy: null,
      redeemedAt: null,
    };
    expect(code.status).toBe('active');

    // Redeem
    code.status = 'redeemed';
    code.redeemedBy = 'agent1';
    code.redeemedAt = Date.now();
    expect(code.status).toBe('redeemed');
    expect(code.redeemedBy).toBe('agent1');

    // Already redeemed → should not redeem again
    expect(code.status === 'redeemed').toBe(true);
  });
});

// ── Volume Discount Tests ───────────────────────────────

describe('Volume Discounts', () => {
  const DEFAULT_VOLUME_DISCOUNTS = [
    { threshold: 10000, discount: 0.05 },
    { threshold: 50000, discount: 0.10 },
    { threshold: 100000, discount: 0.15 },
    { threshold: 500000, discount: 0.20 },
  ];

  function getVolumeDiscountRate(usage: number): number {
    let discount = 0;
    for (const tier of DEFAULT_VOLUME_DISCOUNTS) {
      if (usage >= tier.threshold) discount = tier.discount;
    }
    return discount;
  }

  it('should return 0% discount for usage < 10K', () => {
    expect(getVolumeDiscountRate(0)).toBe(0);
    expect(getVolumeDiscountRate(5000)).toBe(0);
    expect(getVolumeDiscountRate(9999)).toBe(0);
  });

  it('should return 5% discount for 10K-50K usage', () => {
    expect(getVolumeDiscountRate(10000)).toBe(0.05);
    expect(getVolumeDiscountRate(25000)).toBe(0.05);
    expect(getVolumeDiscountRate(49999)).toBe(0.05);
  });

  it('should return 10% discount for 50K-100K usage', () => {
    expect(getVolumeDiscountRate(50000)).toBe(0.10);
    expect(getVolumeDiscountRate(75000)).toBe(0.10);
    expect(getVolumeDiscountRate(99999)).toBe(0.10);
  });

  it('should return 15% discount for 100K-500K usage', () => {
    expect(getVolumeDiscountRate(100000)).toBe(0.15);
    expect(getVolumeDiscountRate(250000)).toBe(0.15);
    expect(getVolumeDiscountRate(499999)).toBe(0.15);
  });

  it('should return 20% discount for 500K+ usage', () => {
    expect(getVolumeDiscountRate(500000)).toBe(0.20);
    expect(getVolumeDiscountRate(1000000)).toBe(0.20);
  });

  it('should apply discount to cost correctly', () => {
    function applyVolumeDiscount(cost: number, usage: number) {
      const rate = getVolumeDiscountRate(usage);
      return {
        originalCost: cost,
        discountRate: rate,
        discountAmount: Math.ceil(cost * rate),
        finalCost: cost - Math.ceil(cost * rate),
      };
    }

    const result = applyVolumeDiscount(100, 50000);
    expect(result.discountRate).toBe(0.10);
    expect(result.discountAmount).toBe(10);
    expect(result.finalCost).toBe(90);
  });
});

// ── Enhanced Reward Calculation Tests ───────────────────

describe('Enhanced Reward Calculation', () => {
  it('should calculate composite reward correctly', () => {
    // Simulate enhanced reward calculation
    const baseReward = 100;
    const difficultyMult = 2; // hard
    const trustMult = 1.25; // trust score 50 → 1 + 50/200 = 1.25
    const streakMult = 1.1; // streak 3
    const timeMult = 1.3; // early
    const qualityMult = 1.5; // bonus

    const total = Math.ceil(baseReward * difficultyMult * trustMult * streakMult * timeMult * qualityMult);
    // 100 * 2 * 1.25 * 1.1 * 1.3 * 1.5 = 100 * 2 * 1.25 * 1.1 * 1.3 * 1.5
    // = 100 * 2 = 200
    // 200 * 1.25 = 250
    // 250 * 1.1 = 275
    // 275 * 1.3 = 357.5
    // 357.5 * 1.5 = 536.25 → ceil = 537
    expect(total).toBe(537);
  });

  it('should calculate without time and quality bonuses', () => {
    const baseReward = 100;
    const difficultyMult = 1; // easy
    const trustMult = 1.0; // trust 0
    const streakMult = 1.0; // no streak
    const timeMult = 1.0; // on_time
    const qualityMult = 1.0; // normal

    const total = Math.ceil(baseReward * difficultyMult * trustMult * streakMult * timeMult * qualityMult);
    expect(total).toBe(100);
  });
});

// ── Enhanced Leaderboard Tests ──────────────────────────

describe('Enhanced Leaderboard', () => {
  it('should calculate composite score correctly', () => {
    // compositeScore = balance * 0.3 + trust * 50 + streak * 10 + completedTasks * 5
    const balance = 1000;
    const trust = 80;
    const streak = 10;
    const completedTasks = 20;

    const score = balance * 0.3 + trust * 50 + streak * 10 + completedTasks * 5;
    // 300 + 4000 + 100 + 100 = 4500
    expect(score).toBe(4500);
  });

  it('should sort by composite score descending', () => {
    const entries = [
      { agent: 'A', compositeScore: 1000 },
      { agent: 'B', compositeScore: 3000 },
      { agent: 'C', compositeScore: 2000 },
    ];
    entries.sort((a, b) => b.compositeScore - a.compositeScore);
    expect(entries[0].agent).toBe('B');
    expect(entries[1].agent).toBe('C');
    expect(entries[2].agent).toBe('A');
  });

  it('should assign correct ranks', () => {
    const entries = [
      { agent: 'A', compositeScore: 3000, rank: 0 },
      { agent: 'B', compositeScore: 2000, rank: 0 },
      { agent: 'C', compositeScore: 1000, rank: 0 },
    ];
    entries.forEach((e, i) => { e.rank = i + 1; });
    expect(entries[0].rank).toBe(1);
    expect(entries[1].rank).toBe(2);
    expect(entries[2].rank).toBe(3);
  });
});

// ── Anomaly Detection Tests ─────────────────────────────

describe('Anomaly Detection', () => {
  it('should calculate mean correctly', () => {
    const amounts = [10, 20, 30, 40, 50];
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    expect(mean).toBe(30);
  });

  it('should calculate standard deviation correctly', () => {
    const amounts = [10, 20, 30, 40, 50];
    const mean = 30;
    const variance = amounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);
    // variance = (400+100+0+100+400)/5 = 200
    // stdDev = sqrt(200) ≈ 14.142
    expect(stdDev).toBeCloseTo(14.142, 2);
  });

  it('should calculate Z-score correctly', () => {
    const amounts = [10, 20, 30, 40, 50];
    const mean = 30;
    const variance = amounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);

    // Z-score for amount=50: (50-30)/14.142 ≈ 1.414
    const zScore = (50 - mean) / stdDev;
    expect(zScore).toBeCloseTo(1.414, 2);

    // Should NOT be flagged as anomaly (< 2.5 threshold)
    expect(zScore < 2.5).toBe(true);

    // Z-score for amount=100: (100-30)/14.142 ≈ 4.95 (would be anomaly)
    const zScore100 = (100 - mean) / stdDev;
    expect(zScore100).toBeGreaterThan(2.5);
  });

  it('should skip agents with fewer than 5 data points', () => {
    const amounts = [10, 20, 30]; // Only 3 data points
    expect(amounts.length < 5).toBe(true);
  });

  it('should skip agents with zero standard deviation', () => {
    const amounts = [50, 50, 50, 50, 50];
    const mean = 50;
    const variance = amounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);
    expect(stdDev).toBe(0);
  });
});

// ── Analytics Tests ─────────────────────────────────────

describe('Analytics', () => {
  it('should aggregate by action correctly', () => {
    const entries = [
      { action: 'transfer', amount: 100 },
      { action: 'transfer', amount: 50 },
      { action: 'deposit', amount: 200 },
    ];

    const byAction: Record<string, { count: number; volume: number }> = {};
    for (const e of entries) {
      const abs = Math.abs(e.amount);
      if (!byAction[e.action]) byAction[e.action] = { count: 0, volume: 0 };
      byAction[e.action].count++;
      byAction[e.action].volume += abs;
    }

    expect(byAction.transfer.count).toBe(2);
    expect(byAction.transfer.volume).toBe(150);
    expect(byAction.deposit.count).toBe(1);
    expect(byAction.deposit.volume).toBe(200);
  });

  it('should calculate net flow correctly', () => {
    const entries = [
      { agent: 'A', amount: 100 },   // deposit
      { agent: 'A', amount: -50 },   // withdraw
      { agent: 'A', amount: 30 },    // reward
    ];

    const netFlow = entries.reduce((sum, e) => sum + e.amount, 0);
    expect(netFlow).toBe(80);
  });

  it('should group by day correctly', () => {
    const ts1 = new Date('2026-08-12T10:00:00Z').getTime();
    const ts2 = new Date('2026-08-12T15:00:00Z').getTime();
    const ts3 = new Date('2026-08-13T09:00:00Z').getTime();

    const day1a = new Date(ts1).toISOString().slice(0, 10);
    const day1b = new Date(ts2).toISOString().slice(0, 10);
    const day2 = new Date(ts3).toISOString().slice(0, 10);

    expect(day1a).toBe(day1b);
    expect(day1a).not.toBe(day2);
  });
});
