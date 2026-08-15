/**
 * token-audit.ts — Immutable audit trail with cryptographic hash chaining
 *
 * Addresses deficiency #7: No audit trail
 * Addresses deficiency #10: No analytics/usage statistics
 *
 * Features:
 *  - Append-only audit log with SHA-256 hash chaining
 *  - Tamper detection via hash verification
 *  - 90-day retention policy with automatic cleanup
 *  - Analytics: cost breakdown, usage trends, spending patterns
 *  - Anomaly detection: Z-score based spending anomaly detection
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MIND_DIR } from './data-dir';
import { atomicWrite } from './atomic';
import { createLogger } from '@/lib/logger';

const log = createLogger('token-audit');

const AUDIT_DIR = path.join(MIND_DIR, 'audit-trail');
const AUDIT_LOG_FILE = path.join(AUDIT_DIR, 'audit-log.jsonl');
const ANALYTICS_FILE = path.join(AUDIT_DIR, 'analytics.json');
const RETENTION_DAYS = 90;
const ANOMALY_Z_SCORE_THRESHOLD = 2.5;

export interface AuditEntry {
  seq: number;              // Sequence number (monotonically increasing)
  timestamp: number;
  agent: string;
  action: string;           // 'transfer' | 'deposit' | 'withdraw' | 'reward' | 'api_call' | 'budget_set' | 'penalty'
  amount: number;
  balanceAfter: number;
  metadata: Record<string, any>;
  prevHash: string;         // Hash of the previous entry
  hash: string;             // SHA-256 hash of this entry
}

export interface AnalyticsSummary {
  totalTransactions: number;
  totalVolume: number;
  uniqueAgents: number;
  byAction: Record<string, { count: number; volume: number }>;
  byAgent: Record<string, { count: number; volume: number; netFlow: number }>;
  byDay: Record<string, { count: number; volume: number }>;
  averageTransactionSize: number;
  largestTransaction: { agent: string; amount: number; action: string; timestamp: number } | null;
  period: { start: number; end: number };
}

export interface AnomalyResult {
  agent: string;
  zScore: number;
  amount: number;
  averageAmount: number;
  timestamp: number;
  description: string;
}

let seqCounter = 0;
let lastHash = 'GENESIS';

/**
 * Initialize the audit trail.
 * Loads the last sequence number and hash from the existing log.
 */
export function initAuditTrail(): void {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }

  if (fs.existsSync(AUDIT_LOG_FILE)) {
    // Read the last line to get the last hash and seq
    const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      try {
        const lastEntry: AuditEntry = JSON.parse(lines[lines.length - 1]);
        seqCounter = lastEntry.seq;
        lastHash = lastEntry.hash;
      } catch (e) {
        log.warn('Failed to parse last audit entry, starting fresh');
        seqCounter = 0;
        lastHash = 'GENESIS';
      }
    } else {
      seqCounter = 0;
      lastHash = 'GENESIS';
    }
  } else {
    // 无日志文件 → 全新审计链(测试隔离依赖此行为)
    seqCounter = 0;
    lastHash = 'GENESIS';
  }

  log.info(`Audit trail initialized: seq=${seqCounter}, lastHash=${lastHash.slice(0, 16)}...`);
}

/**
 * Compute SHA-256 hash of an audit entry.
 */
function computeHash(entry: Omit<AuditEntry, 'hash'>): string {
  const data = JSON.stringify({
    seq: entry.seq,
    timestamp: entry.timestamp,
    agent: entry.agent,
    action: entry.action,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    metadata: entry.metadata,
    prevHash: entry.prevHash,
  });
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Append a new audit entry to the immutable log.
 */
export function appendAuditEntry(
  agent: string,
  action: string,
  amount: number,
  balanceAfter: number,
  metadata: Record<string, any> = {}
): AuditEntry {
  const entry: Omit<AuditEntry, 'hash'> = {
    seq: ++seqCounter,
    timestamp: Date.now(),
    agent,
    action,
    amount,
    balanceAfter,
    metadata,
    prevHash: lastHash,
  };

  const hash = computeHash(entry);
  const fullEntry: AuditEntry = { ...entry, hash };
  lastHash = hash;

  // Append to log file (append-only)
  fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(fullEntry) + '\n', 'utf-8');

  return fullEntry;
}

/**
 * Verify the integrity of the audit trail.
 * Returns true if all hashes are valid, false if tampering is detected.
 */
export function verifyAuditTrail(): { valid: boolean; brokenAt: number | null; totalEntries: number } {
  if (!fs.existsSync(AUDIT_LOG_FILE)) {
    return { valid: true, brokenAt: null, totalEntries: 0 };
  }

  const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  let prevHash = 'GENESIS';
  let count = 0;

  for (const line of lines) {
    try {
      const entry: AuditEntry = JSON.parse(line);
      count++;

      if (entry.prevHash !== prevHash) {
        log.error(`Audit trail broken at seq ${entry.seq}: prevHash mismatch`);
        return { valid: false, brokenAt: entry.seq, totalEntries: count };
      }

      const expectedHash = computeHash(entry);
      if (entry.hash !== expectedHash) {
        log.error(`Audit trail tampered at seq ${entry.seq}: hash mismatch`);
        return { valid: false, brokenAt: entry.seq, totalEntries: count };
      }

      prevHash = entry.hash;
    } catch (e) {
      log.error('Failed to parse audit entry during verification', e);
      return { valid: false, brokenAt: count, totalEntries: count };
    }
  }

  return { valid: true, brokenAt: null, totalEntries: count };
}

/**
 * Query audit entries with optional filters.
 */
export function queryAuditEntries(options: {
  agent?: string;
  action?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}): AuditEntry[] {
  if (!fs.existsSync(AUDIT_LOG_FILE)) return [];

  const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const results: AuditEntry[] = [];
  const limit = options.limit || 1000;

  // Read in reverse for recent entries
  for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
    try {
      const entry: AuditEntry = JSON.parse(lines[i]);
      if (options.agent && entry.agent !== options.agent) continue;
      if (options.action && entry.action !== options.action) continue;
      if (options.startTime && entry.timestamp < options.startTime) continue;
      if (options.endTime && entry.timestamp > options.endTime) continue;
      results.push(entry);
    } catch { continue; }
  }

  return results;
}

/**
 * Run retention policy: delete entries older than 90 days.
 */
export function runRetention(): { deleted: number; remaining: number } {
  if (!fs.existsSync(AUDIT_LOG_FILE)) return { deleted: 0, remaining: 0 };

  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const kept: string[] = [];
  let deleted = 0;

  for (const line of lines) {
    try {
      const entry: AuditEntry = JSON.parse(line);
      if (entry.timestamp < cutoff) {
        deleted++;
      } else {
        kept.push(line);
      }
    } catch {
      deleted++; // Remove unparseable entries
    }
  }

  if (deleted > 0) {
    atomicWrite(AUDIT_LOG_FILE, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
    log.info(`Retention: deleted ${deleted} entries, ${kept.length} remaining`);
  }

  return { deleted, remaining: kept.length };
}

/**
 * Generate analytics summary from audit trail.
 */
export function generateAnalytics(): AnalyticsSummary {
  const entries = queryAuditEntries({ limit: 100000 });
  if (entries.length === 0) {
    return {
      totalTransactions: 0,
      totalVolume: 0,
      uniqueAgents: 0,
      byAction: {},
      byAgent: {},
      byDay: {},
      averageTransactionSize: 0,
      largestTransaction: null,
      period: { start: 0, end: 0 },
    };
  }

  const byAction: Record<string, { count: number; volume: number }> = {};
  const byAgent: Record<string, { count: number; volume: number; netFlow: number }> = {};
  const byDay: Record<string, { count: number; volume: number }> = {};
  let totalVolume = 0;
  let largestTx = { agent: '', amount: 0, action: '', timestamp: 0 };
  const agents = new Set<string>();
  const timestamps: number[] = [];

  for (const entry of entries) {
    const day = new Date(entry.timestamp).toISOString().slice(0, 10);
    const absAmount = Math.abs(entry.amount);

    // By action
    if (!byAction[entry.action]) byAction[entry.action] = { count: 0, volume: 0 };
    byAction[entry.action].count++;
    byAction[entry.action].volume += absAmount;

    // By agent
    if (!byAgent[entry.agent]) byAgent[entry.agent] = { count: 0, volume: 0, netFlow: 0 };
    byAgent[entry.agent].count++;
    byAgent[entry.agent].volume += absAmount;
    byAgent[entry.agent].netFlow += entry.amount;

    // By day
    if (!byDay[day]) byDay[day] = { count: 0, volume: 0 };
    byDay[day].count++;
    byDay[day].volume += absAmount;

    totalVolume += absAmount;
    agents.add(entry.agent);
    timestamps.push(entry.timestamp);

    if (absAmount > largestTx.amount) {
      largestTx = { agent: entry.agent, amount: absAmount, action: entry.action, timestamp: entry.timestamp };
    }
  }

  const summary: AnalyticsSummary = {
    totalTransactions: entries.length,
    totalVolume,
    uniqueAgents: agents.size,
    byAction,
    byAgent,
    byDay,
    averageTransactionSize: entries.length > 0 ? totalVolume / entries.length : 0,
    largestTransaction: largestTx.amount > 0 ? largestTx : null,
    period: {
      start: Math.min(...timestamps),
      end: Math.max(...timestamps),
    },
  };

  // Cache the summary
  atomicWrite(ANALYTICS_FILE, JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * Detect spending anomalies using Z-score.
 * Returns transactions that deviate significantly from the agent's average.
 */
export function detectAnomalies(): AnomalyResult[] {
  const entries = queryAuditEntries({ limit: 100000 });
  const agentAmounts: Record<string, number[]> = {};
  const anomalies: AnomalyResult[] = [];

  // Group amounts by agent
  for (const entry of entries) {
    const absAmount = Math.abs(entry.amount);
    if (!agentAmounts[entry.agent]) agentAmounts[entry.agent] = [];
    agentAmounts[entry.agent].push(absAmount);
  }

  // Calculate Z-scores for each agent's transactions
  for (const [agent, amounts] of Object.entries(agentAmounts)) {
    if (amounts.length < 5) continue; // Need at least 5 data points

    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) continue; // No variation

    // Check recent transactions for anomalies
    const agentEntries = entries.filter(e => e.agent === agent);
    for (const entry of agentEntries) {
      const absAmount = Math.abs(entry.amount);
      const zScore = (absAmount - mean) / stdDev;

      if (zScore > ANOMALY_Z_SCORE_THRESHOLD) {
        anomalies.push({
          agent,
          zScore: Math.round(zScore * 100) / 100,
          amount: absAmount,
          averageAmount: Math.round(mean * 100) / 100,
          timestamp: entry.timestamp,
          description: `Agent ${agent} transaction of ${absAmount} tokens is ${zScore.toFixed(1)}σ above average (${mean.toFixed(1)})`,
        });
      }
    }
  }

  return anomalies.sort((a, b) => b.zScore - a.zScore);
}

/**
 * Get agent-specific analytics.
 */
export function getAgentAnalytics(agent: string): {
  totalTransactions: number;
  totalVolume: number;
  netFlow: number;
  averageTransactionSize: number;
  byAction: Record<string, { count: number; volume: number }>;
  recentTransactions: AuditEntry[];
} {
  const entries = queryAuditEntries({ agent, limit: 10000 });
  const byAction: Record<string, { count: number; volume: number }> = {};
  let totalVolume = 0;
  let netFlow = 0;

  for (const entry of entries) {
    const absAmount = Math.abs(entry.amount);
    if (!byAction[entry.action]) byAction[entry.action] = { count: 0, volume: 0 };
    byAction[entry.action].count++;
    byAction[entry.action].volume += absAmount;
    totalVolume += absAmount;
    netFlow += entry.amount;
  }

  return {
    totalTransactions: entries.length,
    totalVolume,
    netFlow,
    averageTransactionSize: entries.length > 0 ? totalVolume / entries.length : 0,
    byAction,
    recentTransactions: entries.slice(0, 20),
  };
}

// Initialize on module load
initAuditTrail();
