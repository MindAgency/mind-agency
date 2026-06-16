/**
 * Unified Event Bus + Workflow Engine — v0.3
 *
 * Event Bus: 17 event types, filtered subscriptions, UUID dedup, backpressure,
 * Dead Letter Queue + exponential backoff retry.
 *
 * Workflow Engine: YAML-parsed DAG execution, JSONPath condition branching,
 * retry/rollback/compensation, priority scheduling, pluggable StepExecutor.
 *
 * Used by: server.ts (WebSocket on :3001)
 */

import { randomUUID } from 'crypto';
import * as yaml from 'js-yaml';
import fs from 'fs';
import { atomicWrite } from './atomic';
import path from 'path';
import os from 'os';
import { AUDIT_DIR, AGENTS_DIR, GROUPS_DIR, MIND_DIR } from './data-dir';
import { broadcastWs } from './ws-embedded';
import { enqueueTask, completeTask } from './task-queue';
import { checkToolPermission } from './permission-engine';
import {
  saveRunMeta, saveStepCheckpoint, completeRunCheckpoint,
  appendRunHistory, findIncompleteRuns, cleanupCheckpoints,
  type StepCheckpoint,
} from './workflow-checkpoint';
import { createLogger } from '@/lib/logger';

const log = createLogger('event-bus');

// ═══════════════════════════════════════════════════════ Event Bus ═════

/**
 * Enum of all event types supported by the event bus.
 *
 * Covers the full lifecycle of agents, tasks, messages, polling, WebSocket
 * connections, and email -- 17 types total. Used as the primary key when
 * subscribing to or emitting events.
 */
export enum EventType {
  AGENT_STATUS_CHANGED = 'agent.status.changed', AGENT_ERROR = 'agent.error',
  TASK_CREATED = 'task.created', TASK_ASSIGNED = 'task.assigned',
  TASK_IN_PROGRESS = 'task.in_progress', TASK_COMPLETED = 'task.completed',
  TASK_BLOCKED = 'task.blocked', TASK_REVIEW_REQUESTED = 'task.review_requested',
  TASK_REVIEW_COMPLETED = 'task.review_completed',
  MESSAGE_SENT = 'message.sent', MESSAGE_MENTION = 'message.mention',
  POLL_RESULT = 'poll.result', POLL_ERROR = 'poll.error',
  WS_CONNECT = 'ws.connect', WS_DISCONNECT = 'ws.disconnect',
  EMAIL_RECEIVED = 'email.received', EMAIL_SENT = 'email.sent',
}

/**
 * Error codes for event bus operations.
 *
 * Returned as string constants in error payloads when subscriptions or
 * emissions fail, enabling programmatic error handling by consumers.
 */
export enum EventBusError {
  E_DUPLICATE_SUB = 'E_DUPLICATE_SUB', E_INVALID_FILTER = 'E_INVALID_FILTER',
  E_SUB_NOT_FOUND = 'E_SUB_NOT_FOUND', E_EMIT_FAILED = 'E_EMIT_FAILED',
  E_BACKPRESSURE = 'E_BACKPRESSURE',
}

export interface EventMessage { event: EventType; payload: Record<string, unknown>; timestamp: number; source: string; id: string; }
export interface SubscribeFilter { event?: EventType | EventType[]; agent?: string; taskId?: string; }
export interface SubscribeOptions { scope?: 'events' | 'messages' | 'all'; replay?: boolean; since?: number; }

interface SubEntry { subId: string; filter?: SubscribeFilter; options?: SubscribeOptions; clientId: string; send: (e: EventMessage) => void; backpressureCount: number; createdAt: number; }

export interface DeadLetterEntry { event: EventMessage; failedSubIds: string[]; errors: string[]; deadAt: number; retryCount: number; nextRetryAt: number; maxRetries: number; }

const VALID_EVENT_TYPES = new Set(Object.values(EventType)) as Set<string>;
const MAX_DEDUP = 10000; const BP_LIMIT = 1000; const ORPHAN_MS = 300000; const DLQ_MAX = 1000; const DLQ_SCAN_MS = 30000;
const OUTBOX_DIR = path.join(AUDIT_DIR, 'outbox');

/**
 * In-process publish/subscribe event bus with delivery guarantees.
 *
 * Provides filtered subscriptions, UUID-based deduplication, backpressure
 * protection, a Dead Letter Queue (DLQ) with exponential backoff retry, and
 * persistent outbox for crash recovery. Subscriptions are keyed by client ID
 * and automatically cleaned up when a client disconnects.
 */
export class EventBus {
  private subs = new Map<string, SubEntry>();
  private clientSubs = new Map<string, Set<string>>();
  private dedup = new Map<string, null>(); // v0.3.1: unified dedup — replaces Set + dedupHist to fix redundant storage and sync bugs
  private invalidCount = 0;
  private orphanT: ReturnType<typeof setInterval> | null = null;
  private dlqT: ReturnType<typeof setInterval> | null = null;
  private isDev = process.env.NODE_ENV === 'development';
  private deadLetters: DeadLetterEntry[] = [];
  private outboxEnabled = true;

  constructor() {
    this.startOrphanScan();
    this.startDLQScan();
    this.replayOutbox();
    // Cleanup timers on process exit
    const cleanup = () => { this.destroy(); };
    process.on('exit', cleanup);
    // Note: SIGINT/SIGTERM handled by server.ts entry point — not here to avoid double-handler conflict
  }

  emit(event: EventMessage): void {
    if (!VALID_EVENT_TYPES.has(event.event)) {
      this.invalidCount++;
      log.warn(`invalid event type: "${event.event}" (count: ${this.invalidCount})`);
      if (this.invalidCount >= 5) {
        // Emit a system event so monitoring can detect repeated invalid types
        const alertEvent: EventMessage = {
          event: EventType.AGENT_ERROR,
          payload: { code: 'E_INVALID_EVENT_FLOOD', message: `${this.invalidCount} invalid event types received`, lastInvalid: event.event },
          timestamp: Date.now(),
          source: 'system',
          id: randomUUID(),
        };
        this.emit(alertEvent);
      }
      return;
    }
    if (!event.id || event.id.length < 8) event.id = randomUUID();
    // v0.3.1: Map-based dedup — O(1) lookup + FIFO eviction in one structure
    // Fixes: redundant Set+array storage, stale UUIDs after slice, Set not synced during compact
    if (this.dedup.has(event.id)) return;
    this.dedup.set(event.id, null);
    // v0.3.1: Evict oldest entries when over limit (Map preserves insertion order)
    if (this.dedup.size > MAX_DEDUP) {
      const toEvict = this.dedup.size - Math.floor(MAX_DEDUP / 2);
      let evicted = 0;
      for (const key of this.dedup.keys()) {
        if (evicted >= toEvict) break;
        this.dedup.delete(key);
        evicted++;
      }
    }
    if (!event.timestamp) event.timestamp = Date.now();
    if (!event.source) event.source = 'system';
    this.persistToOutbox(event);
    let delivered = 0;
    for (const sub of this.subs.values()) {
      if (!this.matchFilter(event, sub.filter)) continue;
      sub.backpressureCount++; if (sub.backpressureCount > BP_LIMIT) { try { sub.send({ event: EventType.AGENT_ERROR, payload: { code: EventBusError.E_BACKPRESSURE, message: 'Backpressure limit', subId: sub.subId }, timestamp: Date.now(), source: 'system', id: randomUUID() }); } catch (e) { log.error('Failed to send backpressure error', e); } this.unsubscribe(sub.subId); continue; }
      delivered++; try { sub.send(event); sub.backpressureCount = Math.max(0, sub.backpressureCount - 1); } catch (e: any) { this.enqueueDLQ(event, sub.subId, e.message); try { this.unsubscribe(sub.subId); } catch (e) { log.error('Failed to unsubscribe after send error', e); } }
    }
  }

  subscribe(
    filter: SubscribeFilter | undefined,
    opts: SubscribeOptions | undefined,
    clientId: string,
    send: (e: EventMessage) => void,
  ): string {
    if (filter?.event) {
      for (const e of Array.isArray(filter.event) ? filter.event : [filter.event]) {
        if (!VALID_EVENT_TYPES.has(e)) throw new Error(`${EventBusError.E_INVALID_FILTER}: "${e}"`);
      }
    }
    const sid = randomUUID();
    this.subs.set(sid, {
      subId: sid,
      filter: filter ? { event: filter.event, agent: filter.agent, taskId: filter.taskId } : undefined,
      options: { scope: opts?.scope || 'events', replay: opts?.replay, since: opts?.since },
      clientId,
      send,
      backpressureCount: 0,
      createdAt: Date.now(),
    });
    if (!this.clientSubs.has(clientId)) this.clientSubs.set(clientId, new Set());
    this.clientSubs.get(clientId)!.add(sid);
    return sid;
  }

  unsubscribe(subId: string): void {
    const s = this.subs.get(subId);
    if (!s) throw new Error(`${EventBusError.E_SUB_NOT_FOUND}: "${subId}"`);
    this.subs.delete(subId);
    const cs = this.clientSubs.get(s.clientId);
    if (cs) {
      cs.delete(subId);
      if (cs.size === 0) this.clientSubs.delete(s.clientId);
    }
  }

  unsubscribeSilent(subId: string): void {
    try {
      const s = this.subs.get(subId);
      if (!s) return;
      this.subs.delete(subId);
      const cs = this.clientSubs.get(s.clientId);
      if (cs) {
        cs.delete(subId);
        if (cs.size === 0) this.clientSubs.delete(s.clientId);
      }
    } catch (e) {
      log.error('Failed to unsubscribe silently', e);
    }
  }

  cleanupClient(clientId: string): number {
    const sids = this.clientSubs.get(clientId);
    if (!sids) return 0;
    let c = 0;
    for (const sid of sids) {
      this.subs.delete(sid);
      c++;
    }
    this.clientSubs.delete(clientId);
    return c;
  }

  private matchFilter(ev: EventMessage, f?: SubscribeFilter): boolean {
    if (!f) return true;
    if (f.event) {
      const arr = Array.isArray(f.event) ? f.event : [f.event];
      if (!arr.includes(ev.event as EventType)) return false;
    }
    if (f.agent && ev.source !== f.agent) return false;
    if (f.taskId && ev.payload?.taskId !== f.taskId) return false;
    return true;
  }

  // DLQ
  private enqueueDLQ(event: EventMessage, subId: string, error: string): void {
    const exist = this.deadLetters.find(d => d.event.id === event.id && d.failedSubIds.includes(subId)); if (exist) return;
    const same = this.deadLetters.find(d => d.event.id === event.id);
    if (same) { same.failedSubIds.push(subId); same.errors.push(error); return; }
    this.deadLetters.push({ event: { ...event }, failedSubIds: [subId], errors: [error], deadAt: Date.now(), retryCount: 0, nextRetryAt: Date.now() + 1000, maxRetries: 5 });
    while (this.deadLetters.length > DLQ_MAX) this.deadLetters.shift();
    log.warn(`DLQ: ${event.event} → ${subId.slice(0, 8)}... (${this.deadLetters.length})`);
  }

  retryDeadLetters(): number { const now = Date.now(); let r = 0; for (let i = this.deadLetters.length - 1; i >= 0; i--) { const e = this.deadLetters[i]; if (e.nextRetryAt > now) continue; if (e.retryCount >= e.maxRetries) { for (const sid of e.failedSubIds) { const s = this.subs.get(sid); if (s) try { s.send({ event: EventType.AGENT_ERROR, payload: { code: 'E_DLQ_EXHAUSTED', message: 'DLQ exhausted', originalEventId: e.event.id }, timestamp: Date.now(), source: 'system', id: randomUUID() }); } catch (e) { log.error('Failed to send DLQ exhausted error', e); } } this.deadLetters.splice(i, 1); continue; }
    e.retryCount++; let ok = 0; for (const sid of e.failedSubIds) { const s = this.subs.get(sid); if (!s) { ok++; continue; } try { s.send(e.event); ok++; } catch (err: any) { e.errors.push(`r${e.retryCount}: ${err.message}`); } }
    if (ok === e.failedSubIds.length) this.deadLetters.splice(i, 1); else e.nextRetryAt = Date.now() + Math.min(1000 * Math.pow(2, e.retryCount), 60000); r++; } return r; }
  getDeadLetters(): DeadLetterEntry[] { return [...this.deadLetters]; }
  purgeDeadLetters(): number { const c = this.deadLetters.length; this.deadLetters = []; return c; }
  getDLQStats(): { size: number; oldestMs: number; exhausted: number } { const now = Date.now(); return { size: this.deadLetters.length, oldestMs: this.deadLetters.length > 0 ? now - Math.min(...this.deadLetters.map(d => d.deadAt)) : 0, exhausted: this.deadLetters.filter(d => d.retryCount >= d.maxRetries).length }; }

  private startDLQScan(): void { this.dlqT = setInterval(() => { if (this.deadLetters.length > 0) this.retryDeadLetters(); }, DLQ_SCAN_MS); }
  private startOrphanScan(): void { this.orphanT = setInterval(() => { for (const [sid, s] of this.subs) { if (!this.clientSubs.has(s.clientId)) this.subs.delete(sid); } }, ORPHAN_MS); }

  // ── Outbox persistence v0.3 (P1) ─────────────────────────────────

  /**
   * Persist event to .audit/outbox/YYYY-MM-DD.jsonl before delivery.
   *
   * Atomicity note: appendFileSync is NOT atomic in the POSIX sense, but for
   * small writes (< 4KB, which a single JSON line always is) on modern OS
   * kernels (Linux ext4, NTFS, APFS), the write lands in a single disk
   * sector and is effectively atomic. This is the same guarantee that tools
   * like jq and Node.js itself rely on for JSONL append patterns. If the
   * process crashes mid-write, at most the last line may be truncated, and
   * replayOutbox() already skips corrupt lines via JSON.parse catch.
   *
   * The try-catch below handles OS-level failures (disk full, permission
   * denied, directory deleted) gracefully -- outbox persistence is
   * best-effort and must never crash the event bus.
   */
  private persistToOutbox(event: EventMessage): void {
    if (!this.outboxEnabled) return;
    try {
      if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const line = JSON.stringify({ ...event, _outboxAt: Date.now() }) + '\n';
      fs.appendFileSync(path.join(OUTBOX_DIR, `${today}.jsonl`), line, 'utf-8');
    } catch (e: unknown) {
      // Graceful degradation: log and continue. Outbox is best-effort;
      // event delivery to live subscribers still proceeds regardless.
      log.error(`outbox write failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Replay undelivered events from outbox on startup */
  private replayOutbox(): void {
    if (!fs.existsSync(OUTBOX_DIR)) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      for (const f of fs.readdirSync(OUTBOX_DIR)) {
        if (!f.endsWith('.jsonl')) continue;
        // Only replay today's events (older ones are already stale)
        if (f.startsWith(today)) {
          const raw = fs.readFileSync(path.join(OUTBOX_DIR, f), 'utf-8');
          const lines = raw.split('\n').filter(Boolean);
          let replayed = 0;
          for (const line of lines.slice(-100)) { // last 100 lines only
            try {
              const ev = JSON.parse(line) as EventMessage;
              if (!this.dedup.has(ev.id)) {
                this.dedup.set(ev.id, null);
                replayed++;
                // Re-deliver to matching subscribers (existing subs only)
                for (const sub of this.subs.values()) {
                  if (this.matchFilter(ev, sub.filter)) {
                    try { sub.send(ev); } catch { /* sub may be dead */ }
                  }
                }
              }
            } catch { /* corrupt line, skip */ }
          }
          if (replayed > 0) log.info(`outbox replay: ${replayed} events from ${f}`);
        }
      }
      // Clean up outbox files older than 7 days
      const cutoff = Date.now() - 7 * 86400000;
      for (const f of fs.readdirSync(OUTBOX_DIR)) {
        const fp = path.join(OUTBOX_DIR, f);
        try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (e) { log.error('Failed to delete old outbox file', e); }
      }
    } catch (e: unknown) { log.error(`outbox replay failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  getOutboxStats(): { dir: string; files: number; totalBytes: number } {
    let count = 0, bytes = 0;
    if (fs.existsSync(OUTBOX_DIR)) {
      for (const f of fs.readdirSync(OUTBOX_DIR)) { try { const s = fs.statSync(path.join(OUTBOX_DIR, f)); count++; bytes += s.size; } catch (e) { log.error('Failed to read outbox file stats', e); } }
    }
    return { dir: OUTBOX_DIR, files: count, totalBytes: bytes };
  }

  getStats(): {
    subscriptions: number;
    clients: number;
    dedupSize: number;
    dlqSize: number;
    outboxSize: number;
  } {
    return {
      subscriptions: this.subs.size,
      clients: this.clientSubs.size,
      dedupSize: this.dedup.size,
      dlqSize: this.deadLetters.length,
      outboxSize: this.getOutboxStats().files,
    };
  }

  hasClient(cid: string): boolean {
    return this.clientSubs.has(cid) && (this.clientSubs.get(cid)?.size ?? 0) > 0;
  }

  getClientScope(cid: string): 'events' | 'messages' | 'all' | undefined {
    const sids = this.clientSubs.get(cid);
    if (!sids || sids.size === 0) return undefined;
    const first = sids.values().next().value as string;
    return this.subs.get(first)?.options?.scope || 'events';
  }

  destroy(): void {
    if (this.orphanT) {
      clearInterval(this.orphanT);
      this.orphanT = null;
    }
    if (this.dlqT) {
      clearInterval(this.dlqT);
      this.dlqT = null;
    }
    this.subs.clear();
    this.clientSubs.clear();
    this.dedup.clear();
    this.deadLetters = [];
    this.outboxEnabled = false;
  }
}

/**
 * Create a new {@link EventMessage} with a generated UUID and current timestamp.
 *
 * @param ev      - The event type to create.
 * @param payload - Arbitrary key-value data attached to the event.
 * @param source  - Identifier of the component that originated the event
 *                  (e.g. agent name, "system").
 * @returns A fully-formed {@link EventMessage} ready for emission.
 */
export function createEvent(ev: EventType, payload: Record<string, unknown>, source: string): EventMessage { return { event: ev, payload, timestamp: Date.now(), source, id: randomUUID() }; }

// ── v0.4: Singleton EventBus + in-process Pub/Sub ─────────────────────

let _singleton: EventBus | null = null;
/**
 * Replace the global EventBus singleton instance.
 *
 * Typically called once during server startup to inject a pre-configured bus.
 * All subsequent calls to {@link getEventBus} will return this instance.
 *
 * @param bus - The {@link EventBus} instance to use as the global singleton.
 */
export function setEventBus(bus: EventBus): void { _singleton = bus; }

/**
 * Get or lazily create the global EventBus singleton.
 *
 * If no bus has been set via {@link setEventBus}, a new {@link EventBus}
 * is instantiated on first call. Subsequent calls return the same instance.
 *
 * @returns The global {@link EventBus} singleton.
 */
export function getEventBus(): EventBus {
  if (!_singleton) _singleton = new EventBus();
  return _singleton;
}


// Re-export WorkflowEngine types for backward compatibility
export {
  WorkflowEngine,
  WorkflowStatus,
  StepStatus,
  WorkflowPhase,
  SimulatedStepExecutor,
  ChatStepExecutor,
  createStepExecutor,
  parseWorkflowYaml,
  parseReviewFindings,
  phaseForAction,
} from './workflow-engine';
export type {
  WorkflowStep,
  WorkflowTrigger,
  WorkflowDefinition,
  TaskReport,
  WorkflowRunRecord,
  StepExecutor,
  DagNode,
  WorkflowStepRoute,
} from './workflow-engine';
