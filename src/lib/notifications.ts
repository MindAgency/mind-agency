/**
 * notifications.ts — Mind Agency 统一通知引擎
 *
 * 把分散的信号(群聊新消息/@mention/邮件/邀请/工作流/任务/系统事件)收敛成
 * 一等公民的通知记录:摄入 → 去重 → 持久化 → 路由 → 广播 → 唤醒。
 *
 * 架构(与 DSH 后端兼容):
 *   生产者(文件监视/事件总线/API)
 *     → ingestNotification()        记录 + 去重 + 持久化 + WS 广播
 *     → dispatchNotification()      标记 dispatched + 唤醒 agent(autoRespond)
 *   消费者:
 *     - WebSocket 客户端(attachNotificationBroadcaster 接 ws.broadcast)
 *     - HTTP API(GET /api/notifications、POST /api/notifications/dismiss)
 *     - agent 唤醒(autoRespond,调度器照常轮询)
 *
 * 持久化:.mind/notifications/notifications.jsonl(append-only,启动重放)
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { MIND_DIR } from './data-dir';

// ── Types ────────────────────────────────────────────────

export type NotificationKind =
  | 'group_message'
  | 'mention'
  | 'personal_email'
  | 'group_email'
  | 'group_invitation'
  | 'workflow'
  | 'task_assigned'
  | 'consensus'
  | 'signal'
  | 'system';

export interface NotificationTarget {
  type: 'agent' | 'group' | 'system';
  name: string;
}

export interface NotificationInput {
  kind: NotificationKind;
  target: NotificationTarget;
  source?: string;      // 例如 "bob @ default"
  summary: string;      // 短摘要(不含完整内容,agent 自己去拉)
  meta?: Record<string, unknown>;
  wake?: boolean;       // 摄入后立即唤醒目标 agent
}

export interface Notification extends NotificationInput {
  id: string;
  createdAt: number;
  status: 'pending' | 'dispatched' | 'dismissed';
  dispatchedAt?: number;
}

type Broadcaster = (message: Record<string, unknown>, scope?: string) => void;

// ── State ────────────────────────────────────────────────

const NOTIF_DIR = path.join(MIND_DIR, 'notifications');
const NOTIF_FILE = path.join(NOTIF_DIR, 'notifications.jsonl');
const MAX_IN_MEMORY = 5000;
const MAX_FILE_LINES = 20_000;
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

const memory: Notification[] = [];
const dedupWindow = new Map<string, number>(); // dedupId -> createdAt
let broadcaster: Broadcaster | null = null;

// ── Persistence ──────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(NOTIF_DIR)) fs.mkdirSync(NOTIF_DIR, { recursive: true });
}

function loadFromDisk(): Notification[] {
  try {
    if (!fs.existsSync(NOTIF_FILE)) return [];
    const lines = fs.readFileSync(NOTIF_FILE, 'utf-8').split('\n').filter(Boolean);
    const out: Notification[] = [];
    for (const line of lines.slice(-MAX_IN_MEMORY)) {
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return out;
  } catch {
    return [];
  }
}

function appendToDisk(n: Notification): void {
  try {
    ensureDir();
    fs.appendFileSync(NOTIF_FILE, JSON.stringify(n) + '\n', 'utf-8');
    // 轮转:超长时只保留尾部
    const size = fs.statSync(NOTIF_FILE).size;
    if (size > 8 * 1024 * 1024) {
      const lines = fs.readFileSync(NOTIF_FILE, 'utf-8').split('\n').filter(Boolean);
      fs.writeFileSync(NOTIF_FILE, lines.slice(-MAX_FILE_LINES).join('\n') + '\n', 'utf-8');
    }
  } catch {
    // 持久化失败不阻断通知流程
  }
}

// ── Core ─────────────────────────────────────────────────

function dedupId(input: NotificationInput): string {
  const raw = [input.kind, input.target.type, input.target.name, input.source || '', input.summary].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** 摄入一条通知:去重 → 记录 → 持久化 → 广播 → (可选)唤醒 */
export function ingestNotification(input: NotificationInput): Notification | null {
  const id = dedupId(input);
  const now = Date.now();

  // 去重窗口:同一事件 10 分钟内不重复
  const last = dedupWindow.get(id);
  if (last && now - last < DEDUP_WINDOW_MS) return null;
  dedupWindow.set(id, now);
  // 清理过期窗口条目
  if (dedupWindow.size > 2000) {
    for (const [k, t] of dedupWindow) {
      if (now - t > DEDUP_WINDOW_MS) dedupWindow.delete(k);
    }
  }

  const n: Notification = { ...input, id, createdAt: now, status: 'pending' };
  memory.push(n);
  if (memory.length > MAX_IN_MEMORY) memory.splice(0, memory.length - MAX_IN_MEMORY);
  appendToDisk(n);

  broadcaster?.({
    type: 'notification',
    id: n.id,
    kind: n.kind,
    target: n.target,
    source: n.source,
    summary: n.summary,
    createdAt: n.createdAt,
    status: n.status,
  }, 'notify:' + n.target.type + ':' + n.target.name);

  if (input.wake && n.target.type === 'agent') {
    dispatchNotification(n.target.name).catch(() => { /* best-effort */ });
  }
  return n;
}

/** 把目标 agent 的 pending 通知标记为 dispatched,并唤醒它(autoRespond) */
export async function dispatchNotification(agent: string): Promise<{ dispatched: number; triggered?: boolean }> {
  const now = Date.now();
  let count = 0;
  for (const n of memory) {
    if (n.target.type === 'agent' && n.target.name === agent && n.status === 'pending') {
      n.status = 'dispatched';
      n.dispatchedAt = now;
      count++;
    }
  }
  if (count === 0) return { dispatched: 0 };

  let triggered = false;
  try {
    const { autoRespond } = await import('./auto-respond');
    const r = await autoRespond(agent);
    triggered = r.triggered;
  } catch {
    // 唤醒失败:通知保持 dispatched,调度器下一轮会再扫
  }
  return { dispatched: count, triggered };
}

// ── Query ────────────────────────────────────────────────

export function listNotifications(opts?: {
  target?: { type?: string; name?: string };
  kind?: NotificationKind;
  status?: 'pending' | 'dispatched' | 'dismissed';
  limit?: number;
}): Notification[] {
  let out = [...memory];
  if (opts?.target?.type) out = out.filter(n => n.target.type === opts!.target!.type);
  if (opts?.target?.name) out = out.filter(n => n.target.name === opts!.target!.name);
  if (opts?.kind) out = out.filter(n => n.kind === opts.kind);
  if (opts?.status) out = out.filter(n => n.status === opts.status);
  return out.slice(-(opts?.limit ?? 100)).reverse();
}

export function dismissNotifications(ids: string[]): number {
  let count = 0;
  for (const n of memory) {
    if (ids.includes(n.id) && n.status === 'pending') {
      n.status = 'dismissed';
      count++;
    }
  }
  return count;
}

export function pendingCount(target?: NotificationTarget): number {
  return memory.filter(n => n.status === 'pending' && (!target || (n.target.type === target.type && n.target.name === target.name))).length;
}

// ── Wiring ───────────────────────────────────────────────

export function attachNotificationBroadcaster(fn: Broadcaster): void {
  broadcaster = fn;
}

/** 启动时重放:pending 超 2 分钟的通知重新广播(而非直接唤醒,防启动风暴) */
export function redispatchPendingNotifications(): { replayed: number } {
  const now = Date.now();
  const stale = memory.filter(n => n.status === 'pending' && now - n.createdAt > 2 * 60 * 1000);
  for (const n of stale) {
    broadcaster?.({
      type: 'notification',
      id: n.id,
      kind: n.kind,
      target: n.target,
      source: n.source,
      summary: n.summary,
      createdAt: n.createdAt,
      status: n.status,
      replayed: true,
    }, 'notify:' + n.target.type + ':' + n.target.name);
  }
  return { replayed: stale.length };
}

// 模块加载即载入历史(启动重放的依据)
for (const n of loadFromDisk()) {
  memory.push(n);
}
if (memory.length > MAX_IN_MEMORY) memory.splice(0, memory.length - MAX_IN_MEMORY);
