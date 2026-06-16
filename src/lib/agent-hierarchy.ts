/**
 * Multi-level Agent hierarchy and routing.
 *
 * This is intentionally config-driven: existing agents keep working, while
 * teams can add manager/lead/worker layers without changing workflow YAML.
 */

import fs from 'fs';
import path from 'path';
import { AGENTS_DIR, MIND_DIR } from './data-dir';
import { atomicWrite } from './atomic';
import { getAgentConfig } from './chat';

export type AgentLevel = 'executive' | 'manager' | 'lead' | 'worker' | 'reviewer';

export interface AgentHierarchyNode {
  agent: string;
  level: AgentLevel;
  parent?: string;
  children: string[];
  domains: string[];
  routerHints: string[];
}

export interface AgentRouteDecision {
  goal: string;
  coordinator: string;
  candidates: Array<{ agent: string; score: number; reason: string }>;
  delegatedTo: string[];
}

const HIERARCHY_FILE = path.join(MIND_DIR, 'agent-hierarchy.json');

function normalizeTokens(text: string): string[] {
  return [
    ...(text.toLowerCase().match(/[a-z0-9_]+/g) || []),
    ...(text.match(/[\u4e00-\u9fff]{1,2}/g) || []),
  ].filter(Boolean);
}

function inferLevel(agent: string, roles: string[]): AgentLevel {
  const hay = [agent, ...roles].join(' ').toLowerCase();
  if (/ceo|owner|director|executive|负责人|总监|老板/.test(hay)) return 'executive';
  if (/manager|pm|coordinator|lead|组长|经理|协调/.test(hay)) return 'manager';
  if (/review|qa|test|审查|测试|评审/.test(hay)) return 'reviewer';
  if (/architect|senior|expert|专家|架构/.test(hay)) return 'lead';
  return 'worker';
}

function inferDomains(agent: string, roles: string[]): string[] {
  const raw = [agent, ...roles].join(' ');
  const tokens = normalizeTokens(raw);
  return [...new Set(tokens)].slice(0, 20);
}

export function loadAgentHierarchy(): AgentHierarchyNode[] {
  if (fs.existsSync(HIERARCHY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(HIERARCHY_FILE, 'utf-8'));
      if (Array.isArray(data.nodes)) return data.nodes;
      if (Array.isArray(data)) return data;
    } catch (e) { console.error('[lib:agent-hierarchy]', e); }
  }
  return discoverAgentHierarchy();
}

export function saveAgentHierarchy(nodes: AgentHierarchyNode[]): void {
  if (!fs.existsSync(MIND_DIR)) fs.mkdirSync(MIND_DIR, { recursive: true });
  atomicWrite(HIERARCHY_FILE, JSON.stringify({ version: 1, updatedAt: Date.now(), nodes }, null, 2));
}

export function discoverAgentHierarchy(): AgentHierarchyNode[] {
  const nodes: AgentHierarchyNode[] = [];
  if (!fs.existsSync(AGENTS_DIR)) return nodes;

  for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const config = getAgentConfig(entry.name);
    const roles = config.roles || [];
    nodes.push({
      agent: entry.name,
      level: inferLevel(entry.name, roles),
      children: [],
      domains: inferDomains(entry.name, roles),
      routerHints: roles,
    });
  }

  const managers = nodes.filter(n => n.level === 'executive' || n.level === 'manager');
  const fallbackParent = managers.find(n => n.agent === 'me') || managers[0];
  if (fallbackParent) {
    for (const node of nodes) {
      if (node.agent === fallbackParent.agent || node.parent) continue;
      if (node.level === 'worker' || node.level === 'reviewer' || node.level === 'lead') {
        node.parent = fallbackParent.agent;
        fallbackParent.children.push(node.agent);
      }
    }
  }

  return nodes;
}

export function upsertHierarchyNode(node: AgentHierarchyNode): AgentHierarchyNode[] {
  const nodes = loadAgentHierarchy();
  const idx = nodes.findIndex(n => n.agent.toLowerCase() === node.agent.toLowerCase());
  if (idx >= 0) nodes[idx] = { ...nodes[idx], ...node };
  else nodes.push(node);

  for (const n of nodes) {
    n.children = n.children.filter(c => c !== node.agent);
    if (node.parent && n.agent === node.parent && !n.children.includes(node.agent)) n.children.push(node.agent);
  }
  saveAgentHierarchy(nodes);
  return nodes;
}

export function routeGoalToAgents(goal: string, opts?: { maxDelegates?: number; coordinator?: string }): AgentRouteDecision {
  const nodes = loadAgentHierarchy();
  const maxDelegates = opts?.maxDelegates || 3;
  const query = normalizeTokens(goal);
  const managers = nodes.filter(n => n.level === 'executive' || n.level === 'manager' || n.level === 'lead');
  const coordinator = opts?.coordinator || managers[0]?.agent || nodes[0]?.agent || 'me';

  const candidates = nodes
    .filter(n => n.agent !== coordinator)
    .map(n => {
      const hay = new Set([...n.domains, ...n.routerHints.flatMap(normalizeTokens)]);
      const overlap = query.filter(t => hay.has(t)).length;
      const levelBoost = n.level === 'lead' ? 1.5 : n.level === 'reviewer' ? 1 : n.level === 'worker' ? 0.5 : 0;
      const parentBoost = n.parent === coordinator ? 1 : 0;
      const score = overlap * 2 + levelBoost + parentBoost;
      return {
        agent: n.agent,
        score,
        reason: score > 0 ? `matched ${overlap} capability token(s)` : `fallback ${n.level}`,
      };
    })
    .sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));

  const delegatedTo = candidates.slice(0, maxDelegates).map(c => c.agent);
  return { goal, coordinator, candidates, delegatedTo };
}
