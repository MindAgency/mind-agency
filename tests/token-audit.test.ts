/**
 * Token Audit Tests
 *
 * Tests for the immutable audit trail with SHA-256 hash chaining,
 * tamper detection, analytics, and anomaly detection.
 * Source: src/lib/token-audit.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  default: path.join(__dirname, '.test-data'),
}));

import {
  initAuditTrail,
  appendAuditEntry,
  verifyAuditTrail,
  queryAuditEntries,
  runRetention,
  generateAnalytics,
  detectAnomalies,
  getAgentAnalytics,
} from '../src/lib/token-audit';

/** Path to the audit log file (matches MIND_DIR/audit-trail/audit-log.jsonl). */
const AUDIT_DIR = path.join(__dirname, '.test-data', '.mind', 'audit-trail');
const AUDIT_LOG_FILE = path.join(AUDIT_DIR, 'audit-log.jsonl');

describe('Token Audit', () => {
  /** Reset the audit log and in-memory state before each test for isolation. */
  beforeEach(() => {
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      fs.unlinkSync(AUDIT_LOG_FILE);
    }
    initAuditTrail();
  });

  /** Generate a unique agent name. */
  const uniqueAgent = (prefix: string): string =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ──────────────────────────────────────────────
  // Audit entry creation and hash chain
  // ──────────────────────────────────────────────
  describe('Audit entry creation and hash chain', () => {
    it('should create an entry with all required fields', () => {
      const agent = uniqueAgent('entry-create');
      const entry = appendAuditEntry(agent, 'transfer', 100, 900, { note: 'test' });

      expect(entry.seq).toBe(1);
      expect(entry.agent).toBe(agent);
      expect(entry.action).toBe('transfer');
      expect(entry.amount).toBe(100);
      expect(entry.balanceAfter).toBe(900);
      expect(entry.metadata).toEqual({ note: 'test' });
      expect(entry.prevHash).toBe('GENESIS');
      expect(entry.hash).toBeTruthy();
      expect(entry.timestamp).toBeGreaterThan(0);
    });

    it('should chain entries via prevHash', () => {
      const agent = uniqueAgent('chain');
      const entry1 = appendAuditEntry(agent, 'deposit', 100, 100);
      const entry2 = appendAuditEntry(agent, 'transfer', 30, 70);
      const entry3 = appendAuditEntry(agent, 'withdraw', 20, 50);

      expect(entry1.prevHash).toBe('GENESIS');
      expect(entry2.prevHash).toBe(entry1.hash);
      expect(entry3.prevHash).toBe(entry2.hash);
    });

    it('should increment seq numbers monotonically', () => {
      const agent = uniqueAgent('seq');
      const e1 = appendAuditEntry(agent, 'deposit', 10, 10);
      const e2 = appendAuditEntry(agent, 'deposit', 20, 30);
      const e3 = appendAuditEntry(agent, 'deposit', 30, 60);

      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(e3.seq).toBe(3);
    });

    it('should persist entries to the JSONL log file', () => {
      const agent = uniqueAgent('persist');
      appendAuditEntry(agent, 'transfer', 100, 900);
      appendAuditEntry(agent, 'transfer', 50, 850);

      const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]);
      expect(first.agent).toBe(agent);
      expect(first.amount).toBe(100);
    });
  });

  // ──────────────────────────────────────────────
  // Hash determinism
  // ──────────────────────────────────────────────
  describe('Hash determinism', () => {
    it('should produce a deterministic SHA-256 hash for the same data', () => {
      const agent = uniqueAgent('deterministic');
      const entry = appendAuditEntry(agent, 'transfer', 50, 950, { tx: 'abc' });

      // Recompute the hash using the same algorithm as the source
      const hashData = JSON.stringify({
        seq: entry.seq,
        timestamp: entry.timestamp,
        agent: entry.agent,
        action: entry.action,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        metadata: entry.metadata,
        prevHash: entry.prevHash,
      });
      const expectedHash = crypto.createHash('sha256').update(hashData).digest('hex');

      expect(entry.hash).toBe(expectedHash);
    });

    it('should produce different hashes for different data', () => {
      const agent = uniqueAgent('diff-hash');
      const e1 = appendAuditEntry(agent, 'transfer', 50, 950);
      const e2 = appendAuditEntry(agent, 'transfer', 100, 850);

      expect(e1.hash).not.toBe(e2.hash);
    });

    it('should produce a 64-character hex hash', () => {
      const agent = uniqueAgent('hexlen');
      const entry = appendAuditEntry(agent, 'deposit', 10, 10);

      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ──────────────────────────────────────────────
  // Audit trail verification
  // ──────────────────────────────────────────────
  describe('Audit trail verification', () => {
    it('should verify a valid chain as valid', () => {
      const agent = uniqueAgent('verify-valid');
      appendAuditEntry(agent, 'deposit', 100, 100);
      appendAuditEntry(agent, 'transfer', 30, 70);
      appendAuditEntry(agent, 'withdraw', 20, 50);

      const result = verifyAuditTrail();
      expect(result.valid).toBe(true);
      expect(result.brokenAt).toBeNull();
      expect(result.totalEntries).toBe(3);
    });

    it('should detect a tampered hash (amount modified)', () => {
      const agent = uniqueAgent('verify-tampered');
      appendAuditEntry(agent, 'deposit', 100, 100);
      appendAuditEntry(agent, 'transfer', 30, 70);

      // Tamper: change the amount of the first entry but keep its old hash
      const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      const entry = JSON.parse(lines[0]);
      entry.amount = 99999;
      lines[0] = JSON.stringify(entry);
      fs.writeFileSync(AUDIT_LOG_FILE, lines.join('\n') + '\n');

      const result = verifyAuditTrail();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).not.toBeNull();
      expect(result.totalEntries).toBeGreaterThan(0);
    });

    it('should detect a broken prevHash chain', () => {
      const agent = uniqueAgent('verify-broken');
      appendAuditEntry(agent, 'deposit', 100, 100);
      appendAuditEntry(agent, 'transfer', 30, 70);

      // Tamper: set the second entry's prevHash to a fake value
      const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
      const lines = content.trim().split('\n');
      const entry = JSON.parse(lines[1]);
      entry.prevHash = 'FAKE_HASH_VALUE';
      lines[1] = JSON.stringify(entry);
      fs.writeFileSync(AUDIT_LOG_FILE, lines.join('\n') + '\n');

      const result = verifyAuditTrail();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2); // seq of the second entry
    });

    it('should return valid:true with totalEntries:0 for an empty trail', () => {
      // File was deleted in beforeEach, so no log exists
      const result = verifyAuditTrail();
      expect(result.valid).toBe(true);
      expect(result.brokenAt).toBeNull();
      expect(result.totalEntries).toBe(0);
    });
  });

  // ──────────────────────────────────────────────
  // Querying audit entries
  // ──────────────────────────────────────────────
  describe('Querying audit entries', () => {
    it('should filter by agent', () => {
      const agent1 = uniqueAgent('q-agent1');
      const agent2 = uniqueAgent('q-agent2');

      appendAuditEntry(agent1, 'transfer', 10, 90);
      appendAuditEntry(agent2, 'transfer', 20, 80);
      appendAuditEntry(agent1, 'deposit', 30, 120);

      const results = queryAuditEntries({ agent: agent1 });
      expect(results).toHaveLength(2);
      expect(results.every(e => e.agent === agent1)).toBe(true);
    });

    it('should filter by action', () => {
      const agent = uniqueAgent('q-action');

      appendAuditEntry(agent, 'transfer', 10, 90);
      appendAuditEntry(agent, 'deposit', 30, 120);
      appendAuditEntry(agent, 'transfer', 20, 100);

      const results = queryAuditEntries({ agent, action: 'transfer' });
      expect(results).toHaveLength(2);
      expect(results.every(e => e.action === 'transfer')).toBe(true);
    });

    it('should filter by time range', () => {
      const agent = uniqueAgent('q-time');
      const start = Date.now();

      appendAuditEntry(agent, 'transfer', 10, 90);
      const mid = Date.now();
      appendAuditEntry(agent, 'transfer', 20, 70);
      const end = Date.now();

      const results = queryAuditEntries({
        agent,
        startTime: mid,
        endTime: end + 5000,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every(e => e.timestamp >= mid)).toBe(true);
    });

    it('should respect the limit parameter', () => {
      const agent = uniqueAgent('q-limit');

      for (let i = 0; i < 10; i++) {
        appendAuditEntry(agent, 'transfer', i * 10, 1000 - i * 10);
      }

      const results = queryAuditEntries({ agent, limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('should return entries in reverse order (most recent first)', () => {
      const agent = uniqueAgent('q-order');

      appendAuditEntry(agent, 'transfer', 10, 90);
      appendAuditEntry(agent, 'transfer', 20, 70);
      appendAuditEntry(agent, 'transfer', 30, 40);

      const results = queryAuditEntries({ agent });
      expect(results[0].amount).toBe(30);
      expect(results[1].amount).toBe(20);
      expect(results[2].amount).toBe(10);
    });

    it('should return an empty array when no entries match', () => {
      const results = queryAuditEntries({ agent: 'nonexistent-agent-xyz' });
      expect(results).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────
  // Analytics generation
  // ──────────────────────────────────────────────
  describe('Analytics generation', () => {
    it('should generate analytics with correct totals', () => {
      const agent1 = uniqueAgent('a-total1');
      const agent2 = uniqueAgent('a-total2');

      appendAuditEntry(agent1, 'transfer', 100, 900);
      appendAuditEntry(agent2, 'deposit', 200, 200);
      appendAuditEntry(agent1, 'reward', 50, 950);

      const analytics = generateAnalytics();

      expect(analytics.totalTransactions).toBe(3);
      expect(analytics.totalVolume).toBe(350); // 100 + 200 + 50
      expect(analytics.uniqueAgents).toBe(2);
    });

    it('should break down volume by action', () => {
      const agent = uniqueAgent('a-action');

      appendAuditEntry(agent, 'transfer', 100, 900);
      appendAuditEntry(agent, 'transfer', 50, 850);
      appendAuditEntry(agent, 'deposit', 200, 1050);

      const analytics = generateAnalytics();

      expect(analytics.byAction.transfer.count).toBe(2);
      expect(analytics.byAction.transfer.volume).toBe(150);
      expect(analytics.byAction.deposit.count).toBe(1);
      expect(analytics.byAction.deposit.volume).toBe(200);
    });

    it('should break down by agent with netFlow (signed amounts)', () => {
      const agent1 = uniqueAgent('a-flow1');
      const agent2 = uniqueAgent('a-flow2');

      appendAuditEntry(agent1, 'deposit', 100, 100);    // +100
      appendAuditEntry(agent1, 'withdraw', -30, 70);    // -30
      appendAuditEntry(agent2, 'deposit', 50, 50);      // +50

      const analytics = generateAnalytics();

      expect(analytics.byAgent[agent1].count).toBe(2);
      expect(analytics.byAgent[agent1].volume).toBe(130); // |100| + |-30|
      expect(analytics.byAgent[agent1].netFlow).toBe(70); // 100 + (-30)
      expect(analytics.byAgent[agent2].count).toBe(1);
      expect(analytics.byAgent[agent2].netFlow).toBe(50);
    });

    it('should calculate average transaction size', () => {
      const agent = uniqueAgent('a-avg');

      appendAuditEntry(agent, 'transfer', 100, 900);
      appendAuditEntry(agent, 'transfer', 200, 700);
      appendAuditEntry(agent, 'transfer', 300, 400);

      const analytics = generateAnalytics();
      expect(analytics.averageTransactionSize).toBeCloseTo(200, 1); // (100+200+300)/3
    });

    it('should identify the largest transaction', () => {
      const agent = uniqueAgent('a-largest');

      appendAuditEntry(agent, 'transfer', 100, 900);
      appendAuditEntry(agent, 'transfer', 500, 400);
      appendAuditEntry(agent, 'transfer', 200, 200);

      const analytics = generateAnalytics();

      expect(analytics.largestTransaction).not.toBeNull();
      expect(analytics.largestTransaction?.amount).toBe(500);
      expect(analytics.largestTransaction?.agent).toBe(agent);
      expect(analytics.largestTransaction?.action).toBe('transfer');
    });

    it('should handle an empty trail gracefully', () => {
      const analytics = generateAnalytics();

      expect(analytics.totalTransactions).toBe(0);
      expect(analytics.totalVolume).toBe(0);
      expect(analytics.uniqueAgents).toBe(0);
      expect(analytics.largestTransaction).toBeNull();
      expect(analytics.averageTransactionSize).toBe(0);
      expect(analytics.byAction).toEqual({});
      expect(analytics.byAgent).toEqual({});
    });
  });

  // ──────────────────────────────────────────────
  // Agent-specific analytics
  // ──────────────────────────────────────────────
  describe('Agent-specific analytics', () => {
    it('should return stats scoped to a single agent', () => {
      const agent = uniqueAgent('spec-agent');
      const other = uniqueAgent('spec-other');

      appendAuditEntry(agent, 'transfer', 100, 900);
      appendAuditEntry(agent, 'deposit', 50, 950);
      appendAuditEntry(other, 'transfer', 999, 999);

      const stats = getAgentAnalytics(agent);

      expect(stats.totalTransactions).toBe(2);
      expect(stats.totalVolume).toBe(150); // 100 + 50
      expect(stats.netFlow).toBe(150);     // 100 + 50 (both positive)
      expect(stats.byAction.transfer.count).toBe(1);
      expect(stats.byAction.deposit.count).toBe(1);
      expect(stats.recentTransactions).toHaveLength(2);
    });

    it('should return empty stats for an agent with no entries', () => {
      const agent = uniqueAgent('spec-empty');

      const stats = getAgentAnalytics(agent);

      expect(stats.totalTransactions).toBe(0);
      expect(stats.totalVolume).toBe(0);
      expect(stats.netFlow).toBe(0);
      expect(stats.averageTransactionSize).toBe(0);
      expect(stats.recentTransactions).toHaveLength(0);
      expect(stats.byAction).toEqual({});
    });
  });

  // ──────────────────────────────────────────────
  // Retention
  // ──────────────────────────────────────────────
  describe('Retention', () => {
    it('should delete entries older than 90 days', () => {
      const agent = uniqueAgent('retain-old');

      // Two recent entries
      appendAuditEntry(agent, 'transfer', 100, 900);
      appendAuditEntry(agent, 'transfer', 200, 700);

      // Manually append an old entry (91 days ago)
      const oldTimestamp = Date.now() - 91 * 86400_000;
      const oldEntry = {
        seq: 999,
        timestamp: oldTimestamp,
        agent,
        action: 'transfer',
        amount: 50,
        balanceAfter: 650,
        metadata: {},
        prevHash: 'GENESIS',
        hash: 'fake-old-hash',
      };
      fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(oldEntry) + '\n', 'utf-8');

      const result = runRetention();

      expect(result.deleted).toBe(1);
      expect(result.remaining).toBe(2);
    });

    it('should keep entries within the retention period', () => {
      const agent = uniqueAgent('retain-keep');

      appendAuditEntry(agent, 'transfer', 100, 900);
      appendAuditEntry(agent, 'transfer', 200, 700);

      const result = runRetention();

      expect(result.deleted).toBe(0);
      expect(result.remaining).toBe(2);
    });

    it('should handle an empty trail', () => {
      // No file exists
      const result = runRetention();
      expect(result.deleted).toBe(0);
      expect(result.remaining).toBe(0);
    });
  });

  // ──────────────────────────────────────────────
  // Anomaly detection
  // ──────────────────────────────────────────────
  describe('Anomaly detection', () => {
    it('should detect anomalous transactions using Z-score (threshold 2.5)', () => {
      const agent = uniqueAgent('anomaly-detect');

      // 10 normal transactions of amount 10
      for (let i = 0; i < 10; i++) {
        appendAuditEntry(agent, 'transfer', 10, 1000 - i * 10);
      }
      // 1 outlier transaction — Z-score well above 2.5
      appendAuditEntry(agent, 'transfer', 10000, 0);

      const anomalies = detectAnomalies();

      const agentAnomaly = anomalies.find(a => a.agent === agent);
      expect(agentAnomaly).toBeDefined();
      expect(agentAnomaly!.zScore).toBeGreaterThan(2.5);
      expect(agentAnomaly!.amount).toBe(10000);
      expect(agentAnomaly!.description).toContain(agent);
    });

    it('should return no anomalies for uniform transactions (stdDev = 0)', () => {
      const agent = uniqueAgent('anomaly-uniform');

      for (let i = 0; i < 10; i++) {
        appendAuditEntry(agent, 'transfer', 100, 1000);
      }

      const anomalies = detectAnomalies();
      const agentAnomalies = anomalies.filter(a => a.agent === agent);
      expect(agentAnomalies).toHaveLength(0);
    });

    it('should skip agents with fewer than 5 transactions', () => {
      const agent = uniqueAgent('anomaly-few');

      // Only 3 transactions, one extreme
      appendAuditEntry(agent, 'transfer', 100, 900);
      appendAuditEntry(agent, 'transfer', 100, 800);
      appendAuditEntry(agent, 'transfer', 1000000, -200000);

      const anomalies = detectAnomalies();
      const agentAnomalies = anomalies.filter(a => a.agent === agent);
      expect(agentAnomalies).toHaveLength(0);
    });
  });
});
