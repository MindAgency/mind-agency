/**
 * token-enhanced.ts — Enhanced token economy with all improvements
 *
 * Addresses deficiencies:
 *  #3: No redemption code system
 *  #5: No streak system
 *  #6: No time-based rewards
 *  #8: No volume discounts
 *  #11: Leaderboard only shows balance
 *  #12: No pre-paid credit expiry management
 *  #13: Trust decay is manual
 *
 * Integrates:
 *  - token-budget.ts (budget enforcement, per-agent rate limiting)
 *  - token-audit.ts (audit trail, analytics, anomaly detection)
 *  - Streak tracking and multipliers
 *  - Time-based reward bonuses
 *  - Redemption code system
 *  - Volume discount pricing
 *  - Enhanced leaderboard with trust + activity
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MIND_DIR } from './data-dir';
import { atomicWrite } from './atomic';
import { createLogger } from '@/lib/logger';
import {
  getAgentAccount,
  saveAgentAccount,
  getAgentPricing,
  setAgentPricing,
  getAgentTrust,
  recordTaskCompletion,
  type AgentAccount,
  type AgentPricing,
  type AgentTrust,
} from './token-economy';
import { checkBudget, recordSpend, checkTransferRateLimit, recordTransferRate, getBudgetUsage } from './token-budget';
import { appendAuditEntry, generateAnalytics, detectAnomalies, getAgentAnalytics } from './token-audit';

const log = createLogger('token-enhanced');

const ENHANCED_DIR = path.join(MIND_DIR, 'token-enhanced');
const STREAKS_FILE = path.join(ENHANCED_DIR, 'streaks.json');
const REDEMPTION_CODES_FILE = path.join(ENHANCED_DIR, 'redemption-codes.json');

// ── Streak System ───────────────────────────────────────

export interface AgentStreak {
  agent: string;
  currentStreak: number;
  maxStreak: number;
  lastTaskAt: number;
  history: Array<{ task: string; completedAt: number; streakAfter: number }>;
}

const STREAK_RESET_MS = 72 * 3600_000; // 72 hours without a task resets streak
const STREAK_MULTIPLIERS: Record<number, number> = {
  3: 1.1,
  5: 1.2,
  10: 1.5,
  20: 2.0,
};

function loadStreaks(): Record<string, AgentStreak> {
  try {
    if (fs.existsSync(STREAKS_FILE)) return JSON.parse(fs.readFileSync(STREAKS_FILE, 'utf-8'));
  } catch (e) { log.error('Failed to load streaks', e); }
  return {};
}

function saveStreaks(streaks: Record<string, AgentStreak>): void {
  if (!fs.existsSync(ENHANCED_DIR)) fs.mkdirSync(ENHANCED_DIR, { recursive: true });
  atomicWrite(STREAKS_FILE, JSON.stringify(streaks, null, 2));
}

/**
 * Get an agent's streak data.
 */
export function getAgentStreak(agent: string): AgentStreak {
  const streaks = loadStreaks();
  return streaks[agent] || {
    agent,
    currentStreak: 0,
    maxStreak: 0,
    lastTaskAt: 0,
    history: [],
  };
}

/**
 * Get the streak multiplier for a given streak count.
 */
export function getStreakMultiplier(streakCount: number): number {
  let multiplier = 1.0;
  for (const [threshold, mult] of Object.entries(STREAK_MULTIPLIERS)) {
    if (streakCount >= parseInt(threshold)) multiplier = mult;
  }
  return multiplier;
}

/**
 * Record a task completion and update the streak.
 */
export function recordStreakCompletion(agent: string, task: string): AgentStreak {
  const streaks = loadStreaks();
  const streak = streaks[agent] || {
    agent,
    currentStreak: 0,
    maxStreak: 0,
    lastTaskAt: 0,
    history: [],
  };

  const now = Date.now();

  // Check if streak should reset (72 hours since last task)
  if (streak.lastTaskAt > 0 && now - streak.lastTaskAt > STREAK_RESET_MS) {
    streak.currentStreak = 0;
  }

  streak.currentStreak++;
  streak.maxStreak = Math.max(streak.maxStreak, streak.currentStreak);
  streak.lastTaskAt = now;
  streak.history.push({ task, completedAt: now, streakAfter: streak.currentStreak });

  // Keep history bounded
  if (streak.history.length > 100) streak.history = streak.history.slice(-100);

  streaks[agent] = streak;
  saveStreaks(streaks);
  return streak;
}

// ── Time-Based Rewards ──────────────────────────────────

export type CompletionTime = 'early' | 'on_time' | 'late';

const TIME_MULTIPLIERS: Record<CompletionTime, number> = {
  early: 1.3,    // <50% of estimated time
  on_time: 1.0,  // 50%-150% of estimated time
  late: 0.8,     // >150% of estimated time
};

/**
 * Determine completion time category.
 * @param actualTimeMs - Actual time taken
 * @param estimatedTimeMs - Estimated time
 */
export function getCompletionTime(actualTimeMs: number, estimatedTimeMs: number): CompletionTime {
  if (estimatedTimeMs <= 0) return 'on_time';
  const ratio = actualTimeMs / estimatedTimeMs;
  if (ratio < 0.5) return 'early';
  if (ratio > 1.5) return 'late';
  return 'on_time';
}

/**
 * Get the time multiplier for a completion time category.
 */
export function getTimeMultiplier(time: CompletionTime): number {
  return TIME_MULTIPLIERS[time];
}

// ── Enhanced Reward Calculation ─────────────────────────

/**
 * Enhanced reward calculation with streak and time bonuses.
 *
 * TotalReward = BaseReward × DifficultyMultiplier × TrustMultiplier
 *               × StreakMultiplier × TimeMultiplier × QualityMultiplier
 */
export function calculateEnhancedReward(
  agent: string,
  baseReward: number,
  difficulty: string,
  options: {
    actualTimeMs?: number;
    estimatedTimeMs?: number;
    quality?: 'normal' | 'bonus';
  } = {}
): {
  total: number;
  breakdown: {
    base: number;
    difficultyMultiplier: number;
    trustMultiplier: number;
    streakMultiplier: number;
    timeMultiplier: number;
    qualityMultiplier: number;
  };
} {
  const { actualTimeMs, estimatedTimeMs, quality = 'normal' } = options;

  // Difficulty multiplier
  const difficultyMultiplier: Record<string, number> = { easy: 1, medium: 1.5, hard: 2, expert: 3 };
  const diffMult = difficultyMultiplier[difficulty] || 1;

  // Trust multiplier (from existing token-economy.ts)
  const trust = getAgentTrust(agent);
  const trustMult = 1 + (trust.score / 200);

  // Streak multiplier
  const streak = getAgentStreak(agent);
  const streakMult = getStreakMultiplier(streak.currentStreak);

  // Time multiplier
  let timeMult = 1.0;
  if (actualTimeMs !== undefined && estimatedTimeMs !== undefined) {
    const completionTime = getCompletionTime(actualTimeMs, estimatedTimeMs);
    timeMult = getTimeMultiplier(completionTime);
  }

  // Quality multiplier
  const qualityMult = quality === 'bonus' ? 1.5 : 1.0;

  const total = Math.ceil(baseReward * diffMult * trustMult * streakMult * timeMult * qualityMult);

  return {
    total,
    breakdown: {
      base: baseReward,
      difficultyMultiplier: diffMult,
      trustMultiplier: trustMult,
      streakMultiplier: streakMult,
      timeMultiplier: timeMult,
      qualityMultiplier: qualityMult,
    },
  };
}

// ── Redemption Code System ──────────────────────────────

export interface RedemptionCode {
  code: string;
  amount: number;
  createdAt: number;
  expiresAt: number;
  redeemedBy: string | null;
  redeemedAt: number | null;
  batchId: string | null;
  status: 'active' | 'redeemed' | 'expired';
}

function loadCodes(): RedemptionCode[] {
  try {
    if (fs.existsSync(REDEMPTION_CODES_FILE)) return JSON.parse(fs.readFileSync(REDEMPTION_CODES_FILE, 'utf-8'));
  } catch (e) { log.error('Failed to load redemption codes', e); }
  return [];
}

function saveCodes(codes: RedemptionCode[]): void {
  if (!fs.existsSync(ENHANCED_DIR)) fs.mkdirSync(ENHANCED_DIR, { recursive: true });
  atomicWrite(REDEMPTION_CODES_FILE, JSON.stringify(codes, null, 2));
}

/**
 * Generate a redemption code.
 */
export function generateRedemptionCode(
  amount: number,
  expiryDays: number = 30,
  batchId: string | null = null
): RedemptionCode {
  const code = 'MA-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const now = Date.now();
  const code_entry: RedemptionCode = {
    code,
    amount,
    createdAt: now,
    expiresAt: now + expiryDays * 86400_000,
    redeemedBy: null,
    redeemedAt: null,
    batchId,
    status: 'active',
  };

  const codes = loadCodes();
  codes.push(code_entry);
  saveCodes(codes);
  return code_entry;
}

/**
 * Generate a batch of redemption codes.
 */
export function generateRedemptionBatch(
  count: number,
  amount: number,
  expiryDays: number = 30
): RedemptionCode[] {
  const batchId = 'BATCH-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const codes: RedemptionCode[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(generateRedemptionCode(amount, expiryDays, batchId));
  }
  return codes;
}

/**
 * Redeem a code for an agent.
 * Returns the amount credited, or 0 if the code is invalid/expired/already redeemed.
 */
export function redeemCode(agent: string, code: string): number {
  const codes = loadCodes();
  const entry = codes.find(c => c.code === code);

  if (!entry) {
    log.warn(`Redemption failed: code ${code} not found`);
    return 0;
  }

  if (entry.status === 'redeemed') {
    log.warn(`Redemption failed: code ${code} already redeemed by ${entry.redeemedBy}`);
    return 0;
  }

  if (Date.now() > entry.expiresAt || entry.status === 'expired') {
    entry.status = 'expired';
    saveCodes(codes);
    log.warn(`Redemption failed: code ${code} expired`);
    return 0;
  }

  // Redeem
  entry.status = 'redeemed';
  entry.redeemedBy = agent;
  entry.redeemedAt = Date.now();
  saveCodes(codes);

  // Credit the agent
  const account = getAgentAccount(agent);
  account.balance += entry.amount;
  account.earned += entry.amount;
  account.transactions.push({
    type: 'deposit',
    amount: entry.amount,
    reason: `Redeemed code ${code}`,
    timestamp: Date.now(),
  });
  saveAgentAccount(account);

  // Audit
  appendAuditEntry(agent, 'redeem_code', entry.amount, account.balance, { code });

  log.info(`Agent ${agent} redeemed code ${code} for ${entry.amount} tokens`);
  return entry.amount;
}

/**
 * List active (unredeemed, unexpired) codes.
 */
export function listActiveCodes(): RedemptionCode[] {
  const codes = loadCodes();
  const now = Date.now();
  return codes.filter(c => c.status === 'active' && now < c.expiresAt);
}

/**
 * Clean up expired codes.
 */
export function cleanupExpiredCodes(): number {
  const codes = loadCodes();
  const now = Date.now();
  let count = 0;
  for (const c of codes) {
    if (c.status === 'active' && now > c.expiresAt) {
      c.status = 'expired';
      count++;
    }
  }
  if (count > 0) saveCodes(codes);
  return count;
}

// ── Volume Discounts ────────────────────────────────────

export interface VolumeDiscount {
  threshold: number;  // Cumulative tokens used
  discount: number;   // 0.1 = 10% discount
}

const DEFAULT_VOLUME_DISCOUNTS: VolumeDiscount[] = [
  { threshold: 10000, discount: 0.05 },   // 5% after 10K tokens
  { threshold: 50000, discount: 0.10 },   // 10% after 50K tokens
  { threshold: 100000, discount: 0.15 },  // 15% after 100K tokens
  { threshold: 500000, discount: 0.20 },  // 20% after 500K tokens
];

/**
 * Get volume discount rate based on cumulative usage.
 */
export function getVolumeDiscountRate(cumulativeUsage: number): number {
  let discount = 0;
  for (const tier of DEFAULT_VOLUME_DISCOUNTS) {
    if (cumulativeUsage >= tier.threshold) discount = tier.discount;
  }
  return discount;
}

/**
 * Apply volume discount to a cost.
 */
export function applyVolumeDiscount(cost: number, cumulativeUsage: number): {
  originalCost: number;
  discountRate: number;
  discountAmount: number;
  finalCost: number;
} {
  const discountRate = getVolumeDiscountRate(cumulativeUsage);
  const discountAmount = Math.ceil(cost * discountRate);
  return {
    originalCost: cost,
    discountRate,
    discountAmount,
    finalCost: cost - discountAmount,
  };
}

/**
 * Enhanced cost calculation with volume discount.
 */
export function calculateEnhancedCost(
  agent: string,
  baseCost: number
): {
  originalCost: number;
  finalCost: number;
  discountRate: number;
  discountAmount: number;
} {
  const account = getAgentAccount(agent);
  const cumulativeUsage = account.spent;
  return applyVolumeDiscount(baseCost, cumulativeUsage);
}

// ── Enhanced Leaderboard ────────────────────────────────

export interface LeaderboardEntry {
  rank: number;
  agent: string;
  balance: number;
  earned: number;
  spent: number;
  trustScore: number;
  trustTier: string;
  streak: number;
  maxStreak: number;
  completedTasks: number;
  bonusTasks: number;
  compositeScore: number;
}

/**
 * Get enhanced leaderboard with trust, streak, and activity metrics.
 * Composite score = balance * 0.3 + trust * 50 + streak * 10 + completedTasks * 5
 */
export function getEnhancedLeaderboard(limit: number = 20): LeaderboardEntry[] {
  const { listAgentAccounts } = require('./token-economy');
  const accounts: AgentAccount[] = listAgentAccounts();

  const entries: LeaderboardEntry[] = accounts.map(account => {
    const trust = getAgentTrust(account.agent);
    const streak = getAgentStreak(account.agent);

    const compositeScore =
      account.balance * 0.3 +
      trust.score * 50 +
      streak.currentStreak * 10 +
      trust.completedTasks * 5;

    return {
      rank: 0,
      agent: account.agent,
      balance: account.balance,
      earned: account.earned,
      spent: account.spent,
      trustScore: trust.score,
      trustTier: getTrustTierLabel(trust.score),
      streak: streak.currentStreak,
      maxStreak: streak.maxStreak,
      completedTasks: trust.completedTasks,
      bonusTasks: trust.bonusTasks,
      compositeScore: Math.round(compositeScore * 100) / 100,
    };
  });

  entries.sort((a, b) => b.compositeScore - a.compositeScore);
  entries.forEach((e, i) => { e.rank = i + 1; });

  return entries.slice(0, limit);
}

function getTrustTierLabel(score: number): string {
  if (score >= 80) return 'elite';
  if (score >= 60) return 'trusted';
  if (score >= 40) return 'standard';
  if (score >= 20) return 'newcomer';
  return 'untrusted';
}

// ── Enhanced Transfer with Budget + Audit ───────────────

/**
 * Enhanced transfer with budget enforcement, per-agent rate limiting,
 * and audit trail logging.
 */
export async function enhancedTransfer(
  from: string,
  to: string,
  amount: number,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  if (!from || !to || from === to || amount <= 0) {
    return { success: false, error: 'Invalid transfer parameters' };
  }

  // Check per-agent rate limit
  const rateError = checkTransferRateLimit(from);
  if (rateError) return { success: false, error: rateError };

  // Check budget
  const budgetError = checkBudget(from, amount);
  if (budgetError) return { success: false, error: budgetError };

  // Record spend against budget
  if (!recordSpend(from, amount)) {
    return { success: false, error: 'Failed to record budget spend' };
  }

  // Record transfer rate
  recordTransferRate(from, amount);

  // Use original transfer logic
  const { transfer } = require('./token-economy');
  const success = await transfer(from, to, amount, reason);

  if (success) {
    // Audit both sides
    const fromAccount = getAgentAccount(from);
    const toAccount = getAgentAccount(to);
    appendAuditEntry(from, 'transfer', -amount, fromAccount.balance, { to, reason });
    appendAuditEntry(to, 'transfer', amount, toAccount.balance, { from, reason });
  }

  return { success, error: success ? undefined : 'Transfer failed' };
}

// ── Enhanced Reward with Streak + Time + Audit ──────────

/**
 * Enhanced reward with streak tracking, time bonuses, and audit logging.
 */
export async function enhancedReward(
  agent: string,
  baseReward: number,
  task: string,
  difficulty: string,
  options: {
    actualTimeMs?: number;
    estimatedTimeMs?: number;
    quality?: 'normal' | 'bonus';
  } = {}
): Promise<{
  account: AgentAccount;
  rewardAmount: number;
  breakdown: any;
  streak: AgentStreak;
  trust: AgentTrust;
}> {
  // Calculate enhanced reward
  const { total, breakdown } = calculateEnhancedReward(agent, baseReward, difficulty, options);

  // Record streak
  const streak = recordStreakCompletion(agent, task);

  // Record trust
  const trust = recordTaskCompletion(agent, options.quality || 'normal', task);

  // Use original reward function
  const { reward } = require('./token-economy');
  const account = await reward(agent, total, task, options.quality);

  // Audit
  appendAuditEntry(agent, 'reward', total, account.balance, { task, difficulty, breakdown });

  return { account, rewardAmount: total, breakdown, streak, trust };
}

// ── Get Enhanced Stats ──────────────────────────────────

/**
 * Get comprehensive statistics for an agent.
 */
export function getEnhancedAgentStats(agent: string) {
  const account = getAgentAccount(agent);
  const trust = getAgentTrust(agent);
  const streak = getAgentStreak(agent);
  const budgetUsage = getBudgetUsage(agent);
  const analytics = getAgentAnalytics(agent);

  return {
    account: {
      balance: account.balance,
      earned: account.earned,
      spent: account.spent,
      transactionCount: account.transactions.length,
    },
    trust: {
      score: trust.score,
      tier: getTrustTierLabel(trust.score),
      completedTasks: trust.completedTasks,
      failedTasks: trust.failedTasks,
      bonusTasks: trust.bonusTasks,
    },
    streak: {
      current: streak.currentStreak,
      max: streak.maxStreak,
      multiplier: getStreakMultiplier(streak.currentStreak),
    },
    budget: budgetUsage,
    analytics: {
      totalTransactions: analytics.totalTransactions,
      totalVolume: analytics.totalVolume,
      netFlow: analytics.netFlow,
      averageTransactionSize: analytics.averageTransactionSize,
    },
    volumeDiscount: {
      cumulativeUsage: account.spent,
      discountRate: getVolumeDiscountRate(account.spent),
    },
  };
}

// ── Scheduled Tasks ─────────────────────────────────────

/**
 * Run scheduled maintenance tasks.
 * Should be called daily via cron or similar.
 */
export function runScheduledTasks(): {
  trustDecay: number;
  expiredCodes: number;
  auditRetention: { deleted: number; remaining: number };
  anomalies: number;
} {
  // 1. Apply trust decay
  const { applyTrustDecay } = require('./token-economy');
  applyTrustDecay();

  // 2. Clean up expired codes
  const expiredCodes = cleanupExpiredCodes();

  // 3. Run audit retention
  const { runRetention } = require('./token-audit');
  const auditRetention = runRetention();

  // 4. Detect anomalies
  const anomalies = detectAnomalies().length;

  log.info(`Scheduled tasks complete: expiredCodes=${expiredCodes}, auditDeleted=${auditRetention.deleted}, anomalies=${anomalies}`);

  return {
    trustDecay: 0, // applyTrustDecay doesn't return a count
    expiredCodes,
    auditRetention,
    anomalies,
  };
}
