/**
 * Runtime tool registry.
 *
 * Tools are metadata records first. Built-in handlers can be wired in code,
 * while user-defined HTTP tools can be added without rebuilding the app.
 */

import fs from 'fs';
import path from 'path';
import { MIND_DIR } from './data-dir';
import { atomicWrite } from './atomic';

export interface ManagedTool {
  name: string;
  description: string;
  type: 'builtin' | 'http';
  enabled: boolean;
  risk: 'low' | 'medium' | 'high';
  inputSchema?: Record<string, unknown>;
  endpoint?: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

const TOOLS_FILE = path.join(MIND_DIR, 'tools.json');

const BUILTIN_TOOLS: ManagedTool[] = [
  {
    name: 'web_search',
    description: 'Search the web and return cited snippets for time-sensitive or external facts.',
    type: 'builtin',
    enabled: false,
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number' },
        provider: { type: 'string' },
      },
      required: ['query'],
    },
    createdAt: 0,
    updatedAt: 0,
  },
];

function ensureDir(): void {
  if (!fs.existsSync(MIND_DIR)) fs.mkdirSync(MIND_DIR, { recursive: true });
}

function readCustomTools(): ManagedTool[] {
  ensureDir();
  try {
    if (fs.existsSync(TOOLS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf-8'));
      if (Array.isArray(data.tools)) return data.tools;
      if (Array.isArray(data)) return data;
    }
  } catch (e) { console.error('[lib:tool-registry]', e); }
  return [];
}

function writeCustomTools(tools: ManagedTool[]): void {
  ensureDir();
  atomicWrite(TOOLS_FILE, JSON.stringify({ version: 1, tools }, null, 2));
}

export function listManagedTools(): ManagedTool[] {
  const custom = readCustomTools();
  const byName = new Map<string, ManagedTool>();
  for (const tool of BUILTIN_TOOLS) byName.set(tool.name, tool);
  for (const tool of custom) byName.set(tool.name, tool);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getManagedTool(name: string): ManagedTool | undefined {
  return listManagedTools().find(t => t.name === name);
}

export function isToolEnabled(name: string): boolean {
  return getManagedTool(name)?.enabled === true;
}

export function upsertManagedTool(input: Omit<ManagedTool, 'createdAt' | 'updatedAt'> & Partial<Pick<ManagedTool, 'createdAt' | 'updatedAt'>>): ManagedTool {
  const custom = readCustomTools();
  const now = Date.now();
  const existing = custom.find(t => t.name === input.name) || BUILTIN_TOOLS.find(t => t.name === input.name);
  const tool: ManagedTool = {
    ...existing,
    ...input,
    createdAt: input.createdAt || existing?.createdAt || now,
    updatedAt: now,
  } as ManagedTool;

  const idx = custom.findIndex(t => t.name === tool.name);
  if (idx >= 0) custom[idx] = tool;
  else custom.push(tool);
  writeCustomTools(custom);
  return tool;
}

export function deleteManagedTool(name: string): boolean {
  if (BUILTIN_TOOLS.some(t => t.name === name)) {
    upsertManagedTool({ ...BUILTIN_TOOLS.find(t => t.name === name)!, enabled: false });
    return true;
  }
  const custom = readCustomTools();
  const next = custom.filter(t => t.name !== name);
  if (next.length === custom.length) return false;
  writeCustomTools(next);
  return true;
}

export async function callManagedHttpTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const tool = getManagedTool(name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  if (!tool.enabled) throw new Error(`Tool is disabled: ${name}`);
  if (tool.type !== 'http' || !tool.endpoint) throw new Error(`Tool is not an HTTP tool: ${name}`);

  const method = tool.method || 'POST';
  const headers = { 'Content-Type': 'application/json', ...(tool.headers || {}) };
  const url = method === 'GET' ? new URL(tool.endpoint) : null;
  if (url) {
    for (const [k, v] of Object.entries(input || {})) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url ? url.toString() : tool.endpoint, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(input || {}),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return data;
}
