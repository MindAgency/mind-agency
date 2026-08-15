import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  default: path.join(__dirname, '.test-data'),
}));

vi.mock('../src/lib/auto-respond', () => ({
  autoRespond: vi.fn(async () => ({ triggered: true })),
}));

import {
  ingestNotification, listNotifications, dismissNotifications, pendingCount,
  attachNotificationBroadcaster, dispatchNotification,
} from '../src/lib/notifications';

const NOTIF_DIR = path.join(__dirname, '.test-data', '.mind', 'notifications');
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe('Notification Engine', () => {
  beforeEach(() => {
    if (fs.existsSync(NOTIF_DIR)) fs.rmSync(NOTIF_DIR, { recursive: true, force: true });
  });

  it('ingest 后能查到通知且状态 pending', () => {
    const name = uniq('a');
    const n = ingestNotification({
      kind: 'mention',
      target: { type: 'agent', name },
      source: 'bob @ default',
      summary: 'bob mentioned you',
    });
    expect(n).not.toBeNull();
    expect(n!.status).toBe('pending');
    const list = listNotifications({ target: { type: 'agent', name }, status: 'pending' });
    expect(list.length).toBe(1);
    expect(list[0].summary).toBe('bob mentioned you');
  });

  it('10 分钟窗口内相同事件去重', () => {
    const name = uniq('b');
    const input = { kind: 'mention' as const, target: { type: 'agent' as const, name }, source: 'x', summary: 'same summary' };
    const first = ingestNotification(input);
    const second = ingestNotification(input);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(listNotifications({ target: { type: 'agent', name } }).length).toBe(1);
  });

  it('broadcaster 收到带 scope 的推送', () => {
    const pushed: Array<{ msg: Record<string, unknown>; scope?: string }> = [];
    attachNotificationBroadcaster((msg, scope) => pushed.push({ msg, scope }));
    const name = uniq('c');
    ingestNotification({ kind: 'system', target: { type: 'group', name }, summary: 'hello' });
    expect(pushed.length).toBe(1);
    expect(pushed[0].msg.type).toBe('notification');
    expect(pushed[0].scope).toBe(`notify:group:${name}`);
  });

  it('dismiss 只作用于 pending', () => {
    const name = uniq('d');
    const a = ingestNotification({ kind: 'personal_email', target: { type: 'agent', name }, summary: 'e1' })!;
    ingestNotification({ kind: 'personal_email', target: { type: 'agent', name }, summary: 'e2' });
    const dismissed = dismissNotifications([a.id]);
    expect(dismissed).toBe(1);
    expect(pendingCount({ type: 'agent', name })).toBe(1);
    expect(dismissNotifications([a.id])).toBe(0); // 已 dismissed,不能重复
  });

  it('dispatch 标记 dispatched 并唤醒 agent', async () => {
    const name = uniq('e');
    ingestNotification({ kind: 'task_assigned', target: { type: 'agent', name }, summary: 'task T1' });
    ingestNotification({ kind: 'mention', target: { type: 'agent', name }, summary: 'm1' });
    const r = await dispatchNotification(name);
    expect(r.dispatched).toBe(2);
    expect(r.triggered).toBe(true);
    expect(pendingCount({ type: 'agent', name })).toBe(0);
    const list = listNotifications({ target: { type: 'agent', name } });
    expect(list.every(n => n.status === 'dispatched')).toBe(true);
  });

  it('无 pending 时 dispatch 返回 0', async () => {
    const name = uniq('f');
    const r = await dispatchNotification(name);
    expect(r.dispatched).toBe(0);
  });
});
