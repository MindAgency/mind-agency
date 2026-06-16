/**
 * MCP Server — Shared utilities
 *
 * Common functions used by all tool modules.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { randomUUID } from 'crypto';

// ── Config ────────────────────────────────────────────────

export const WS_BASE_URL = process.env.WS_BASE_URL || 'http://127.0.0.1:3001';
export const WS_BROADCAST_URL = process.env.WS_BROADCAST_URL || `${WS_BASE_URL}/broadcast`;
export const WS_EVENTS_URL = process.env.WS_EVENTS_URL || `${WS_BASE_URL}/events`;
export const API_BASE_URL = process.env.MIND_API_URL || 'http://127.0.0.1:3000';
export const PROJECT_ROOT = process.env.MIND_DATA_DIR || process.cwd();
export const AGENTS_DIR = path.join(PROJECT_ROOT, 'Agents');

// ── File helpers ──────────────────────────────────────────

export function groupsDir() { return path.join(PROJECT_ROOT, 'Groups'); }
export function exists(p: string) { return fs.existsSync(p); }
export function readDir(p: string) { return exists(p) ? fs.readdirSync(p, { withFileTypes: true }) : []; }

export function getAgentGroups(agentName: string): string[] {
  const gd = groupsDir();
  if (!exists(gd)) return [];
  return readDir(gd)
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .filter(e => {
      const agDir = path.join(gd, e.name, 'Agents');
      if (!exists(agDir)) return false;
      return readDir(agDir).some(d => d.isDirectory() && d.name.toLowerCase() === agentName.toLowerCase());
    })
    .map(e => e.name);
}

// ── HTTP helpers ──────────────────────────────────────────

/** Fire-and-forget HTTP POST (v0.4: timeout + error logging) */
export function httpPost(urlStr: string, body: Record<string, unknown>) {
  try {
    const data = JSON.stringify(body);
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Connection': 'keep-alive' },
      timeout: 5000,
    }, (res) => { res.resume(); });
    req.on('error', (e) => {
      console.error(`[mcp] httpPost FAILED ${urlStr}: ${e.message} (code=${(e as any).code || 'unknown'})`);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error(`[mcp] httpPost TIMEOUT ${urlStr} after 5s`);
    });
    req.write(data);
    req.end();
  } catch (e: unknown) {
    console.error(`[mcp] httpPost EXCEPTION ${urlStr}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Simple JSON fetch with timeout */
export function fetchJSON(urlStr: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.get(u, (res) => {
      let body = '';
      res.on('data', (c: string) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** POST with JSON response (for API calls that return data) */
export function fetchPost(urlStr: string, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) },
      timeout: 120000,
    }, (res) => {
      let body = '';
      res.on('data', (c: string) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Chat helpers ──────────────────────────────────────────

export interface ChatMsg { from: string; date: string; body: string; }

export function readGroupChat(groupName: string, limit = 20): ChatMsg[] {
  const chatDir = path.join(groupsDir(), groupName, 'chat');
  if (!exists(chatDir)) return [];
  const files = readDir(chatDir)
    .filter(f => f.name.endsWith('.md'))
    .map(f => f.name)
    .sort()
    .slice(-limit);
  const msgs: ChatMsg[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(chatDir, f), 'utf-8');
      const blocks = raw.split(/\n(?=---\nfrom:)/);
      for (const block of blocks) {
        const fmMatch = block.trim().match(/^---\nfrom:\s*(.+?)\ndate:\s*(.+?)\n---\n\n([\s\S]*)/);
        if (fmMatch) msgs.push({ from: fmMatch[1].trim(), date: fmMatch[2].trim(), body: fmMatch[3].trim() });
      }
    } catch { /* skip */ }
  }
  return msgs.slice(-limit);
}

export function appendToChat(group: string, from: string, message: string) {
  const chatDir = path.join(groupsDir(), group, 'chat');
  if (!exists(chatDir)) fs.mkdirSync(chatDir, { recursive: true });
  const ts = Date.now();
  const safe = from.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  const fpath = path.join(chatDir, `${ts}_${safe}.md`);
  const content = `---\nfrom: ${from}\ndate: ${new Date().toISOString()}\n---\n\n${message}\n`;
  const tmp = fpath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, fpath);
}

// ── Event helpers ─────────────────────────────────────────

/** 触发 auto-respond 定向检查 */
export function triggerPoll(agent?: string, group?: string) {
  if (agent) {
    httpPost(`${API_BASE_URL}/api/poll/agent`, { agent, group, trigger: 'mcp' });
  } else {
    httpPost(`${API_BASE_URL}/api/poll`, { trigger: 'mcp' });
  }
}

/** Fire-and-forget broadcast to WebSocket clients */
export function broadcast(msg: Record<string, unknown>) {
  httpPost(WS_BROADCAST_URL, { ...msg, timestamp: new Date().toISOString() });
}

/** Emit an Event Bus event via HTTP POST */
export function emitBusEvent(event: string, payload: Record<string, unknown>, source?: string) {
  httpPost(WS_EVENTS_URL, {
    event, payload, timestamp: Date.now(),
    source: source || 'mcp-server', id: randomUUID(),
  });
}

// ── Audit ─────────────────────────────────────────────────

/**
 * Write audit log entry. Delegates to src/lib/audit.ts for consistent JSONL format.
 * Falls back to local .json write if import fails (e.g., MCP standalone mode).
 */
export function writeAudit(entry: { agent: string; action: string; resource: string; details?: string }) {
  try {
    // Try to use the unified audit module
    const { writeAudit: unifiedWrite } = require('../../src/lib/audit');
    unifiedWrite({ ...entry, status: 'success' as const });
  } catch {
    // Fallback: write to .audit/YYYY-MM-DD.json (legacy format)
    try {
      const auditDir = path.join(PROJECT_ROOT, '.audit');
      if (!exists(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
      fs.appendFileSync(path.join(auditDir, `${today}.json`), line, 'utf-8');
    } catch { /* ignore */ }
  }
}
