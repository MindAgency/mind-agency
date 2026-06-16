/**
 * token-economy.ts — Token economy + agent accounts + pricing + trust.
 *
 * Features:
 *  - Pre-paid credit model with balance management
 *  - Per-agent pricing rates (role-based tiers)
 *  - Trust/reputation scoring from task completion history
 *  - Anti-abuse: rate limiting, daily caps, min balance thresholds
 *  - Task marketplace with persistence
 */

import fs from 'fs';
import path from 'path';
import { MIND_DIR } from './data-dir';
import { atomicWrite } from './atomic';
import { createLogger } from '@/lib/logger';

const log = createLogger('token-economy');

const ACCOUNTS_DIR = path.join(MIND_DIR, 'agent-accounts');
const PRICING_DIR = path.join(MIND_DIR, 'agent-pricing');
const TRUST_DIR = path.join(MIND_DIR, 'agent-trust');
const RATE_LIMIT_FILE = path.join(MIND_DIR, 'rate-limits.json');
const MARKETPLACE_DIR = path.join(MIND_DIR, 'marketplace');

function ensureDir(dir?: string): void {
  const d = dir || ACCOUNTS_DIR;
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── Anti-abuse constants ──────────────────────────────────
const MAX_TRANSFERS_PER_HOUR = 20;
const MAX_SINGLE_TRANSFER = 10000;
const MIN_BALANCE_THRESHOLD = 0;
const DAILY_SPEND_CAP = 50000;
const RATE_LIMIT_WINDOW_MS = 3600_000; // 1 hour

// ── In-memory locks for concurrency safety ────────────────
const agentLocks = new Map<string, Promise<void>>();
const rateLimitLock = { promise: Promise.resolve() as Promise<void> };

async function withAgentLock<T>(agent: string, fn: () => T | Promise<T>): Promise<T> {
  // Wait for any previous operation on this agent to finish
  const prev = agentLocks.get(agent) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  agentLocks.set(agent, next);

  try {
    await prev;
    return await fn();
  } finally {
    release!();
    // Clean up if this is still the latest lock
    if (agentLocks.get(agent) === next) agentLocks.delete(agent);
  }
}

async function withRateLimitLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = rateLimitLock.promise;
  let release: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  rateLimitLock.promise = next;

  try {
    await prev;
    return await fn();
  } finally {
    release!();
  }
}

// ── Pricing tiers (role-based defaults) ───────────────────
/**
 * Default per-call pricing rates keyed by role name.
 *
 * Used as the fallback when an agent has no custom pricing configured.
 * Higher-tier roles (e.g. CEO) cost more per API call. The `default` tier
 * applies to any role not explicitly listed.
 */
export const DEFAULT_PRICING_TIERS: Record<string, number> = {
  CEO: 10,      // highest tier — strategic decisions
  PM: 8,        // project management
  developer: 5, // standard development
  designer: 5,  // creative work
  analyst: 5,   // data analysis
  default: 3,   // fallback for unlisted roles
};

// ── Trust scoring constants ───────────────────────────────
const TRUST_DECAY_FACTOR = 0.95;     // trust decays 5% per scoring period
const TASK_COMPLETION_BONUS = 5;     // +5 trust per completed task
const TASK_QUALITY_BONUS = 10;       // +10 trust per bonus-quality task
const TASK_FAILURE_PENALTY = -15;    // -15 trust per failed task
const MAX_TRUST = 100;
const MIN_TRUST = 0;

export type Transaction =
  | { type: 'deposit'; amount: number; reason?: string; timestamp: number }
  | { type: 'withdraw'; amount: number; reason?: string; timestamp: number }
  | { type: 'transfer'; amount: number; from: string; to: string; reason?: string; timestamp: number }
  | { type: 'transfer-in'; amount: number; from: string; reason?: string; timestamp: number }
  | { type: 'transfer-out'; amount: number; to: string; reason?: string; timestamp: number }
  | { type: 'reward'; amount: number; task?: string; quality?: string; reason?: string; stepId?: string; timestamp: number }
  | { type: 'bonus'; amount: number; reason?: string; timestamp: number }
  | { type: 'api_call'; amount: number; model?: string; tokensIn?: number; tokensOut?: number; timestamp: number };

export interface AgentAccount {
  agent: string;
  balance: number;
  earned: number;
  spent: number;
  transactions: Transaction[];
}

export interface AgentPricing {
  agent: string;
  role: string;
  ratePerCall: number;
  ratePerToken: number;    // cost per 1K tokens
  dailyCap: number;         // max daily spend
  customRates: Record<string, number>; // skill-specific overrides
  updatedAt: number;
}

export interface AgentTrust {
  agent: string;
  score: number;            // 0-100
  completedTasks: number;
  failedTasks: number;
  bonusTasks: number;
  lastActivity: number;
  history: Array<{
    event: 'task_complete' | 'task_fail' | 'task_bonus' | 'decay' | 'manual';
    delta: number;
    timestamp: number;
    reason?: string;
  }>;
}

export interface RateLimitState {
  transfers: Array<{ timestamp: number; amount: number }>;
  dailySpend: number;
  dailySpendDate: string; // YYYY-MM-DD
}

export interface MarketplaceTask {
  id: string;
  group: string;
  title: string;
  description: string;
  reward: number;
  requiredSkills: string[];
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  maxClaims: number;
  postedBy: string;
  assignedTo?: string;
  claims: Array<{ agent: string; message: string; claimedAt: number }>;
  status: 'open' | 'assigned' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  createdAt: number;
  completedAt?: number;
  quality?: 'normal' | 'bonus';
  rating?: number; // 1-5 stars
}

/**
 * Load an agent's token account from disk.
 *
 * Reads the JSON account file at `.mind/agent-accounts/<agent>.json`.
 * If the file does not exist or cannot be parsed, a fresh account with a
 * zero balance is returned.
 *
 * @param agent - The agent name.
 * @returns The agent's {@link AgentAccount} with balance, earnings, spend,
 *          and transaction history.
 */
export function getAgentAccount(agent: string): AgentAccount {
  ensureDir();
  const fp = path.join(ACCOUNTS_DIR, `${agent}.json`);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { log.error('Failed to read agent account', e); }
  return { agent, balance: 0, earned: 0, spent: 0, transactions: [] };
}

/**
 * Persist an agent's token account to disk.
 *
 * Writes the account data to `.mind/agent-accounts/<agent>.json` using
 * atomic write to prevent corruption from concurrent processes.
 *
 * @param account - The {@link AgentAccount} to save.
 */
export function saveAgentAccount(account: AgentAccount): void {
  ensureDir();
  const fp = path.join(ACCOUNTS_DIR, `${account.agent}.json`);
  atomicWrite(fp, JSON.stringify(account, null, 2));
}

/**
 * List all agent accounts stored on disk.
 *
 * Scans `.mind/agent-accounts/` for JSON files and parses each into an
 * {@link AgentAccount}. Corrupt or unreadable files are silently skipped.
 *
 * @returns Array of all agent accounts, possibly empty.
 */
export function listAgentAccounts(): AgentAccount[] {
  ensureDir();
  const files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, f), 'utf-8')); }
    catch { return null; }
  }).filter(Boolean);
}

/** Get balance for an agent */
export function getBalance(agent: string): number {
  return getAgentAccount(agent).balance;
}

/** Transfer tokens from one agent to another */
export async function transfer(from: string, to: string, amount: number, reason?: string): Promise<boolean> {
  if (!from || !to) return false;
  if (from === to) return false;
  if (amount <= 0) return false;

  // Lock both agents in canonical order to prevent deadlocks
  const [first, second] = from < to ? [from, to] : [to, from];
  return withAgentLock(first, async () => {
    return withAgentLock(second, async () => {
      const fromAccount = getAgentAccount(from);
      const toAccount = getAgentAccount(to);

      if (fromAccount.balance < amount) return false;

      fromAccount.balance -= amount;
      fromAccount.spent += amount;
      fromAccount.transactions.push({ type: 'transfer', amount, from, to, reason, timestamp: Date.now() });

      toAccount.balance += amount;
      toAccount.earned += amount;
      toAccount.transactions.push({ type: 'transfer', amount, from, to, reason, timestamp: Date.now() });

      saveAgentAccount(fromAccount);
      saveAgentAccount(toAccount);
      return true;
    });
  });
}

/** Deposit tokens to an agent */
export async function deposit(agent: string, amount: number, reason?: string): Promise<number> {
  if (amount <= 0) return 0;
  return withAgentLock(agent, () => {
    const account = getAgentAccount(agent);
    account.balance += amount;
    account.earned += amount;
    account.transactions.push({ type: 'deposit', amount, reason, timestamp: Date.now() });
    saveAgentAccount(account);
    return account.balance;
  });
}

/** Get leaderboard sorted by balance */
export function getLeaderboard(): AgentAccount[] {
  return listAgentAccounts().sort((a, b) => b.balance - a.balance);
}

/** Reward tokens to an agent */
export async function reward(agent: string, amount: number, task?: string, quality: 'normal' | 'bonus' = 'normal'): Promise<AgentAccount> {
  if (amount <= 0) return getAgentAccount(agent);
  return withAgentLock(agent, () => {
    const account = getAgentAccount(agent);
    const actualAmount = quality === 'bonus' ? amount * 1.5 : amount;
    account.balance += actualAmount;
    account.earned += actualAmount;
    account.transactions.push({
      type: 'reward',
      amount: actualAmount,
      task,
      quality,
      timestamp: Date.now(),
    });
    saveAgentAccount(account);
    return account;
  });
}

/** Withdraw tokens from an agent (penalty) */
export async function withdraw(agent: string, amount: number, reason?: string): Promise<AgentAccount> {
  if (amount <= 0) return getAgentAccount(agent);
  return withAgentLock(agent, () => {
    const account = getAgentAccount(agent);
    account.balance = Math.max(0, account.balance - amount);
    account.spent += amount;
    account.transactions.push({
      type: 'withdraw',
      amount,
      reason,
      timestamp: Date.now(),
    });
    saveAgentAccount(account);
    return account;
  });
}

/** Penalize an agent (alias for withdraw) */
export async function penalize(agent: string, amount: number, reason?: string): Promise<AgentAccount> {
  return withdraw(agent, amount, reason);
}

// ── Pricing Management ───────────────────────────────────

/**
 * Load an agent's pricing configuration from disk.
 *
 * Returns the stored pricing for the agent, or a default pricing record
 * using {@link DEFAULT_PRICING_TIERS} when no custom pricing exists.
 *
 * @param agent - The agent name.
 * @returns The agent's {@link AgentPricing} with role, rates, and daily cap.
 */
export function getAgentPricing(agent: string): AgentPricing {
  ensureDir(PRICING_DIR);
  const fp = path.join(PRICING_DIR, `${agent}.json`);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { log.error('Failed to read agent pricing', e); }
  // Default pricing for new agents
  return {
    agent,
    role: 'default',
    ratePerCall: DEFAULT_PRICING_TIERS.default,
    ratePerToken: 0.001,
    dailyCap: DAILY_SPEND_CAP,
    customRates: {},
    updatedAt: Date.now(),
  };
}

/**
 * Update an agent's pricing configuration.
 *
 * Merges the provided fields into the agent's existing pricing and
 * persists the result. When the `role` field changes and no explicit
 * `ratePerCall` is provided, the rate is automatically adjusted to match
 * {@link DEFAULT_PRICING_TIERS} for the new role.
 *
 * @param agent   - The agent name.
 * @param updates - Partial pricing fields to merge (role, rates, caps, etc.).
 * @returns The updated {@link AgentPricing} record.
 */
export function setAgentPricing(agent: string, updates: Partial<Omit<AgentPricing, 'agent' | 'updatedAt'>>): AgentPricing {
  ensureDir(PRICING_DIR);
  const pricing = getAgentPricing(agent);
  Object.assign(pricing, updates, { updatedAt: Date.now() });

  // Auto-set rate based on role if role changed and no custom ratePerCall
  if (updates.role && !updates.ratePerCall) {
    pricing.ratePerCall = DEFAULT_PRICING_TIERS[updates.role] || DEFAULT_PRICING_TIERS.default;
  }

  fs.writeFileSync(path.join(PRICING_DIR, `${agent}.json`), JSON.stringify(pricing, null, 2), 'utf-8');
  return pricing;
}

/** Calculate cost for a task based on pricing tier and difficulty */
export function calculateTaskCost(agent: string, difficulty: string, tokenEstimate: number): number {
  const pricing = getAgentPricing(agent);
  const difficultyMultiplier: Record<string, number> = { easy: 1, medium: 1.5, hard: 2, expert: 3 };
  const mult = difficultyMultiplier[difficulty] || 1;
  const callCost = pricing.ratePerCall * mult;
  const tokenCost = (tokenEstimate / 1000) * pricing.ratePerToken;
  return Math.ceil(callCost + tokenCost);
}

// ── Trust / Reputation Scoring ────────────────────────────

/**
 * Load an agent's trust/reputation record from disk.
 *
 * Trust scores range from 0 to 100 and reflect the agent's task completion
 * history. If no record exists, a neutral score of 50 is returned.
 *
 * @param agent - The agent name.
 * @returns The agent's {@link AgentTrust} with score, task counts, and history.
 */
export function getAgentTrust(agent: string): AgentTrust {
  ensureDir(TRUST_DIR);
  const fp = path.join(TRUST_DIR, `${agent}.json`);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { log.error('Failed to read agent trust', e); }
  return {
    agent,
    score: 50, // start at neutral
    completedTasks: 0,
    failedTasks: 0,
    bonusTasks: 0,
    lastActivity: Date.now(),
    history: [],
  };
}

/**
 * Persist an agent's trust/reputation record to disk.
 *
 * Writes the trust data to `.mind/agent-trust/<agent>.json` using atomic
 * write to prevent corruption.
 *
 * @param trust - The {@link AgentTrust} record to save.
 */
export function saveAgentTrust(trust: AgentTrust): void {
  ensureDir(TRUST_DIR);
  atomicWrite(path.join(TRUST_DIR, `${trust.agent}.json`), JSON.stringify(trust, null, 2));
}

/**
 * Record a task completion event and update the agent's trust score.
 *
 * Applies the appropriate delta: +5 for normal completion, +15 for bonus
 * quality, or -15 for failure. The score is clamped to [0, 100] and the
 * event is appended to the trust history (capped at 200 entries).
 *
 * @param agent   - The agent name.
 * @param quality - Task outcome: `'normal'`, `'bonus'`, or `'failed'`.
 * @param reason  - Optional human-readable reason for the score change.
 * @returns The updated {@link AgentTrust} record.
 */
export function recordTaskCompletion(agent: string, quality: 'normal' | 'bonus' | 'failed', reason?: string): AgentTrust {
  const trust = getAgentTrust(agent);
  const now = Date.now();
  let delta = 0;

  if (quality === 'failed') {
    trust.failedTasks++;
    delta = TASK_FAILURE_PENALTY;
  } else if (quality === 'bonus') {
    trust.bonusTasks++;
    trust.completedTasks++;
    delta = TASK_COMPLETION_BONUS + TASK_QUALITY_BONUS;
  } else {
    trust.completedTasks++;
    delta = TASK_COMPLETION_BONUS;
  }

  trust.score = Math.max(MIN_TRUST, Math.min(MAX_TRUST, trust.score + delta));
  trust.lastActivity = now;
  trust.history.push({ event: quality === 'failed' ? 'task_fail' : quality === 'bonus' ? 'task_bonus' : 'task_complete', delta, timestamp: now, reason });

  // Keep history bounded (last 200 entries)
  if (trust.history.length > 200) trust.history = trust.history.slice(-200);

  saveAgentTrust(trust);
  return trust;
}

/** Apply periodic trust decay (call this daily) */
export function applyTrustDecay(): void {
  ensureDir(TRUST_DIR);
  const files = fs.readdirSync(TRUST_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const trust: AgentTrust = JSON.parse(fs.readFileSync(path.join(TRUST_DIR, f), 'utf-8'));
      const daysSinceActivity = (Date.now() - trust.lastActivity) / (86400_000);
      if (daysSinceActivity > 7) {
        const oldScore = trust.score;
        trust.score = Math.max(MIN_TRUST, Math.round(trust.score * TRUST_DECAY_FACTOR));
        if (trust.score !== oldScore) {
          trust.history.push({ event: 'decay', delta: trust.score - oldScore, timestamp: Date.now(), reason: `decay after ${Math.floor(daysSinceActivity)}d inactive` });
          fs.writeFileSync(path.join(TRUST_DIR, f), JSON.stringify(trust, null, 2), 'utf-8');
        }
      }
    } catch (e) { log.error('Failed to apply trust decay', e); }
  }
}

/** Get trust tier label */
export function getTrustTier(score: number): string {
  if (score >= 80) return 'elite';
  if (score >= 60) return 'trusted';
  if (score >= 40) return 'standard';
  if (score >= 20) return 'newcomer';
  return 'untrusted';
}

// ── Anti-Abuse: Rate Limiting ─────────────────────────────

function loadRateLimitState(): RateLimitState {
  try {
    if (fs.existsSync(RATE_LIMIT_FILE)) return JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, 'utf-8'));
  } catch (e) { log.error('Failed to read rate limit state', e); }
  return { transfers: [], dailySpend: 0, dailySpendDate: todayStr() };
}

function saveRateLimitState(state: RateLimitState): void {
  ensureDir();
  atomicWrite(RATE_LIMIT_FILE, JSON.stringify(state, null, 2));
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Check if a transfer is allowed (anti-abuse). Returns null if OK, or error message. */
export async function checkTransferLimits(agent: string, amount: number): Promise<string | null> {
  if (amount <= 0) return 'amount must be positive';
  if (amount > MAX_SINGLE_TRANSFER) return `单笔转账上限: ${MAX_SINGLE_TRANSFER} tokens`;

  return withRateLimitLock(() => {
    const state = loadRateLimitState();
    const now = Date.now();

    // Reset daily spend if new day
    if (state.dailySpendDate !== todayStr()) {
      state.dailySpend = 0;
      state.dailySpendDate = todayStr();
    }

    // Check hourly rate limit
    const recentTransfers = state.transfers.filter(t => now - t.timestamp < RATE_LIMIT_WINDOW_MS);
    if (recentTransfers.length >= MAX_TRANSFERS_PER_HOUR) {
      return `每小时转账上限: ${MAX_TRANSFERS_PER_HOUR} 次`;
    }

    // Check daily spend cap
    if (state.dailySpend + amount > DAILY_SPEND_CAP) {
      return `每日支出上限: ${DAILY_SPEND_CAP} tokens`;
    }

    // Check min balance
    const account = getAgentAccount(agent);
    if (account.balance - amount < MIN_BALANCE_THRESHOLD) {
      return `余额不足或低于最低阈值`;
    }

    return null; // allowed
  });
}

/** Record a successful transfer for rate limiting */
export async function recordTransfer(amount: number): Promise<void> {
  return withRateLimitLock(() => {
    const state = loadRateLimitState();
    const now = Date.now();

    // Purge old entries
    state.transfers = state.transfers.filter(t => now - t.timestamp < RATE_LIMIT_WINDOW_MS);
    state.transfers.push({ timestamp: now, amount });

    state.dailySpend += amount;
    state.dailySpendDate = todayStr();

    saveRateLimitState(state);
  });
}

// ── Task Marketplace (persistent) ─────────────────────────

function ensureMarketplaceDir(): void {
  ensureDir(MARKETPLACE_DIR);
}

/**
 * Persist a marketplace task to disk.
 *
 * Writes the task JSON to `.mind/marketplace/<group>/<taskId>.json`,
 * creating the group directory if needed.
 *
 * @param task - The {@link MarketplaceTask} to save.
 */
export function saveMarketplaceTask(task: MarketplaceTask): void {
  ensureMarketplaceDir();
  const taskDir = path.join(MARKETPLACE_DIR, task.group);
  if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, `${task.id}.json`), JSON.stringify(task, null, 2), 'utf-8');
}

/**
 * Load a single marketplace task from disk.
 *
 * @param group  - The group the task belongs to.
 * @param taskId - The unique task identifier.
 * @returns The {@link MarketplaceTask} if found and parseable, or `null`.
 */
export function loadMarketplaceTask(group: string, taskId: string): MarketplaceTask | null {
  const fp = path.join(MARKETPLACE_DIR, group, `${taskId}.json`);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { log.error('Failed to load marketplace task', e); }
  return null;
}

/**
 * List marketplace tasks for a group, optionally filtered by status.
 *
 * Scans `.mind/marketplace/<group>/` for task JSON files. Tasks that are
 * still `'open'` but older than 24 hours are automatically marked as
 * `'expired'` and persisted. Results are sorted newest-first.
 *
 * @param group  - The group whose tasks to list.
 * @param status - Optional status filter (e.g. `'open'`, `'assigned'`).
 * @returns Array of matching {@link MarketplaceTask} objects.
 */
export function listMarketplaceTasks(group: string, status?: string): MarketplaceTask[] {
  ensureMarketplaceDir();
  const taskDir = path.join(MARKETPLACE_DIR, group);
  if (!fs.existsSync(taskDir)) return [];

  const files = fs.readdirSync(taskDir).filter(f => f.endsWith('.json'));
  const tasks: MarketplaceTask[] = [];
  for (const f of files) {
    try {
      const task: MarketplaceTask = JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf-8'));
      if (!status || task.status === status) tasks.push(task);
    } catch (e) { log.error('Failed to read marketplace task', e); }
  }

  // Auto-expire tasks older than 24h
  const now = Date.now();
  for (const task of tasks) {
    if (task.status === 'open' && now - task.createdAt > 86400_000) {
      task.status = 'expired';
      saveMarketplaceTask(task);
    }
  }

  return tasks.sort((a, b) => b.createdAt - a.createdAt);
}

/** Calculate reward based on difficulty and trust */
export function calculateReward(agent: string, baseReward: number, difficulty: string): number {
  const trust = getAgentTrust(agent);
  const difficultyMultiplier: Record<string, number> = { easy: 1, medium: 1.5, hard: 2, expert: 3 };
  const trustMultiplier = 1 + (trust.score / 200); // 1.0 - 1.5x based on trust
  return Math.ceil(baseReward * (difficultyMultiplier[difficulty] || 1) * trustMultiplier);
}
