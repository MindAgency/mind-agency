/**
 * token-budget.ts — Per-agent budget enforcement with multi-period limits
 *
 * Addresses deficiency #1: No budget enforcement mechanism
 * Addresses deficiency #9: Rate limiting is global, not per-agent
 *
 * Features:
 *  - Daily / weekly / monthly budget limits per agent
 *  - Real-time spend tracking and enforcement
 *  - Budget reset and rollover policies
 *  - Per-agent rate limiting (replaces global rate-limits.json)
 */

import fs from 'fs';
import path from 'path';
import { MIND_DIR } from './data-dir';
import { atomicWrite } from './atomic';
import { createLogger } from '@/lib/logger';

const log = createLogger('token-budget');

const BUDGET_DIR = path.join(MIND_DIR, 'agent-budgets');

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

export interface BudgetLimit {
  period: BudgetPeriod;
  limit: number;
  used: number;
  resetAt: number;      // Unix timestamp for next reset
  createdAt: number;
}

export interface AgentBudget {
  agent: string;
  limits: BudgetLimit[];
  rateLimits: {
    transfers: Array<{ timestamp: number; amount: number }>;
    apiCalls: Array<{ timestamp: number; cost: number }>;
    maxTransfersPerHour: number;
    maxApiCallsPerHour: number;
  };
  updatedAt: number;
}

// Default budget limits by role
export const DEFAULT_BUDGET_LIMITS: Record<string, Record<BudgetPeriod, number>> = {
  CEO:       { daily: 5000,  weekly: 25000,  monthly: 100000 },
  PM:        { daily: 3000,  weekly: 15000,  monthly: 60000 },
  developer: { daily: 2000,  weekly: 10000,  monthly: 40000 },
  designer:  { daily: 2000,  weekly: 10000,  monthly: 40000 },
  analyst:   { daily: 2000,  weekly: 10000,  monthly: 40000 },
  default:   { daily: 1000,  weekly: 5000,   monthly: 20000 },
};

const PERIOD_MS: Record<BudgetPeriod, number> = {
  daily: 86400_000,
  weekly: 604800_000,
  monthly: 2592000_000, // 30 days
};

function ensureDir(): void {
  if (!fs.existsSync(BUDGET_DIR)) fs.mkdirSync(BUDGET_DIR, { recursive: true });
}

function getBudgetPath(agent: string): string {
  return path.join(BUDGET_DIR, `${agent}.json`);
}

/**
 * Load an agent's budget configuration.
 * Creates default budgets if none exist.
 */
export function getAgentBudget(agent: string, role?: string): AgentBudget {
  ensureDir();
  const fp = getBudgetPath(agent);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { log.error('Failed to read agent budget', e); }

  // Create default budget based on role
  const roleKey = role || 'default';
  const defaults = DEFAULT_BUDGET_LIMITS[roleKey] || DEFAULT_BUDGET_LIMITS.default;
  const now = Date.now();

  return {
    agent,
    limits: [
      { period: 'daily', limit: defaults.daily, used: 0, resetAt: now + PERIOD_MS.daily, createdAt: now },
      { period: 'weekly', limit: defaults.weekly, used: 0, resetAt: now + PERIOD_MS.weekly, createdAt: now },
      { period: 'monthly', limit: defaults.monthly, used: 0, resetAt: now + PERIOD_MS.monthly, createdAt: now },
    ],
    rateLimits: {
      transfers: [],
      apiCalls: [],
      maxTransfersPerHour: 20,
      maxApiCallsPerHour: 100,
    },
    updatedAt: now,
  };
}

/**
 * Save an agent's budget configuration.
 */
export function saveAgentBudget(budget: AgentBudget): void {
  ensureDir();
  budget.updatedAt = Date.now();
  atomicWrite(getBudgetPath(budget.agent), JSON.stringify(budget, null, 2));
}

/**
 * Check and reset expired budget periods.
 */
function checkAndResetPeriods(budget: AgentBudget): AgentBudget {
  const now = Date.now();
  let changed = false;

  for (const limit of budget.limits) {
    if (now >= limit.resetAt) {
      limit.used = 0;
      limit.resetAt = now + PERIOD_MS[limit.period];
      changed = true;
    }
  }

  // Clean up old rate limit entries (older than 1 hour)
  const hourAgo = now - 3600_000;
  budget.rateLimits.transfers = budget.rateLimits.transfers.filter(t => t.timestamp > hourAgo);
  budget.rateLimits.apiCalls = budget.rateLimits.apiCalls.filter(t => t.timestamp > hourAgo);

  if (changed) saveAgentBudget(budget);
  return budget;
}

/**
 * Check if an agent can spend the given amount.
 * Returns null if OK, or an error message if budget exceeded.
 */
export function checkBudget(agent: string, amount: number, role?: string): string | null {
  if (amount <= 0) return 'amount must be positive';

  const budget = checkAndResetPeriods(getAgentBudget(agent, role));

  // Check each budget period
  for (const limit of budget.limits) {
    if (limit.used + amount > limit.limit) {
      const remaining = limit.limit - limit.used;
      return `${limit.period} budget exceeded: used ${limit.used}/${limit.limit}, need ${amount}, remaining ${remaining}`;
    }
  }

  return null; // OK
}

/**
 * Record a spend against an agent's budget.
 */
export function recordSpend(agent: string, amount: number, role?: string): boolean {
  const error = checkBudget(agent, amount, role);
  if (error) {
    log.warn(`Budget check failed for ${agent}: ${error}`);
    return false;
  }

  const budget = checkAndResetPeriods(getAgentBudget(agent, role));
  for (const limit of budget.limits) {
    limit.used += amount;
  }
  saveAgentBudget(budget);
  return true;
}

/**
 * Set or update a budget limit for a specific period.
 */
export function setBudgetLimit(agent: string, period: BudgetPeriod, limit: number): void {
  const budget = checkAndResetPeriods(getAgentBudget(agent));
  const existing = budget.limits.find(l => l.period === period);
  if (existing) {
    existing.limit = limit;
  } else {
    budget.limits.push({
      period,
      limit,
      used: 0,
      resetAt: Date.now() + PERIOD_MS[period],
      createdAt: Date.now(),
    });
  }
  saveAgentBudget(budget);
}

/**
 * Get budget usage statistics for an agent.
 */
export function getBudgetUsage(agent: string): {
  period: BudgetPeriod;
  limit: number;
  used: number;
  remaining: number;
  utilization: number;
  resetAt: number;
}[] {
  const budget = checkAndResetPeriods(getAgentBudget(agent));
  return budget.limits.map(l => ({
    period: l.period,
    limit: l.limit,
    used: l.used,
    remaining: l.limit - l.used,
    utilization: l.limit > 0 ? l.used / l.limit : 0,
    resetAt: l.resetAt,
  }));
}

/**
 * Check per-agent rate limit for transfers.
 */
export function checkTransferRateLimit(agent: string): string | null {
  const budget = checkAndResetPeriods(getAgentBudget(agent));
  const now = Date.now();
  const recentTransfers = budget.rateLimits.transfers.filter(t => now - t.timestamp < 3600_000);
  if (recentTransfers.length >= budget.rateLimits.maxTransfersPerHour) {
    return `Rate limit exceeded: ${recentTransfers.length}/${budget.rateLimits.maxTransfersPerHour} transfers this hour`;
  }
  return null;
}

/**
 * Record a transfer for per-agent rate limiting.
 */
export function recordTransferRate(agent: string, amount: number): void {
  const budget = checkAndResetPeriods(getAgentBudget(agent));
  budget.rateLimits.transfers.push({ timestamp: Date.now(), amount });
  saveAgentBudget(budget);
}

/**
 * Check per-agent rate limit for API calls.
 */
export function checkApiCallRateLimit(agent: string): string | null {
  const budget = checkAndResetPeriods(getAgentBudget(agent));
  const now = Date.now();
  const recentCalls = budget.rateLimits.apiCalls.filter(t => now - t.timestamp < 3600_000);
  if (recentCalls.length >= budget.rateLimits.maxApiCallsPerHour) {
    return `API rate limit exceeded: ${recentCalls.length}/${budget.rateLimits.maxApiCallsPerHour} calls this hour`;
  }
  return null;
}

/**
 * Record an API call for per-agent rate limiting.
 */
export function recordApiCallRate(agent: string, cost: number): void {
  const budget = checkAndResetPeriods(getAgentBudget(agent));
  budget.rateLimits.apiCalls.push({ timestamp: Date.now(), cost });
  saveAgentBudget(budget);
}

/**
 * Get all agents' budget summaries.
 */
export function listAllBudgets(): AgentBudget[] {
  ensureDir();
  const files = fs.readdirSync(BUDGET_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(BUDGET_DIR, f), 'utf-8')); }
    catch { return null; }
  }).filter(Boolean);
}
