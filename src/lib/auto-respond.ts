/**
 * Agent auto-respond -- Signal-based notification protocol.
 *
 * Design:
 *   1. Check WHAT happened (counts, not content).
 *   2. Build a SIGNAL prompt -- tell the Agent "you have N new things, go look".
 *   3. Agent uses MCP tools (group_read, email) to pull content itself.
 *   4. Agent decides whether to respond -- system does NOT auto-post replies.
 *
 * Channels checked:
 *   - Personal email:  Agents/<name>/email/
 *   - Group email:     Groups/<name>/Agents/<name>/email/
 *   - Group chat:      Groups/<name>/chat/    (new messages since lastCheck)
 *   - @mentions:       Group chat messages containing @AgentName
 *
 * Real-time: fs.watch (new files) + 30s polling fallback (content append).
 *
 * Uses AgentProxy for agent operations and EmailProxy for email operations.
 */

import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { chatOnce, getAgentConfig } from './chat';
import { AGENTS_DIR, GROUPS_DIR, MIND_DIR } from './data-dir';
import { loadState, saveState, ensureGroup, getAgentGroups, invalidateGroupsCache, type AgentState } from './state';
import { setActivity, clearActivity } from './agent-activity';
import { agentCache } from './cache';
import { AgentProxy } from './agent-proxy';
import { createLogger } from '@/lib/logger';

const log = createLogger('auto-respond');

// ── Signal debounce: per-agent last-spawn time ─────────

// Module-level last error for observability from silent catch blocks
let _lastError: string | null = null;
export function getAutoRespondLastError(): string | null { return _lastError; }

const lastSpawn = new Map<string, number>();
const DEBOUNCE_URGENT = 5_000;
const DEBOUNCE_IDLE   = 15_000;
const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── v0.4: Request Queue -- prevent duplicate spawns per agent ─────────

// Use shared agent queue from agent-queue.ts (prevents circular dependency with chat.ts)
import { enqueueAgent } from './agent-queue';

// ── Types ────────────────────────────────────────────────

interface EmailInfo { from: string; subject: string; filename: string; mtime: number; }

interface Signal {
  personalEmails: number;
  groupEmails: Record<string, number>;
  newMessages: Record<string, number>;
  mentions: { group: string; from: string; snippet: string }[];
  invitations?: { group: string; invitedBy: string }[];
  urgent: boolean;
  priority: 'critical' | 'normal' | 'low';
}

interface AgentConfig {
  autoRespondToEmail: boolean;
  autoProcessGroupInvites: boolean;
  notifyOnEmail: boolean;
  notifyOnGroupMention: boolean;
}

// ── Config ───────────────────────────────────────────────

// Use cached getAgentConfig from chat.ts instead of reading config.json directly
function getConfig(agentName: string): AgentConfig {
  const config = getAgentConfig(agentName);
  const raw = config as unknown as Record<string, unknown>;
  return {
    autoRespondToEmail: typeof raw.autoRespondToEmail === 'boolean' ? raw.autoRespondToEmail : false,
    autoProcessGroupInvites: typeof raw.autoProcessGroupInvites === 'boolean' ? raw.autoProcessGroupInvites : false,
    notifyOnEmail: typeof raw.notifyOnEmail === 'boolean' ? raw.notifyOnEmail : true,
    notifyOnGroupMention: typeof raw.notifyOnGroupMention === 'boolean' ? raw.notifyOnGroupMention : true,
  };
}

// ── Email scanning ──────────────────────────────────────

/** Scan a single email directory, return files newer than `since` (ms timestamp). */
async function scanEmailDir(dir: string, since: number): Promise<EmailInfo[]> {
  let entries: string[];
  try { entries = await fsPromises.readdir(dir); } catch { return []; }
  const results: EmailInfo[] = [];
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const fp = path.join(dir, f);
    const st = await fsPromises.stat(fp);
    if (st.mtimeMs <= since) continue;
    // Only read content if mtime passes (avoids unnecessary I/O)
    const raw = await fsPromises.readFile(fp, 'utf-8');
    const fm = raw.match(/^---\nfrom:\s*(.+?)\nto:\s*(.+?)\nsubject:\s*(.+?)\n/);
    if (!fm) continue;
    results.push({ from: fm[1].trim(), subject: fm[3].trim(), filename: f, mtime: st.mtimeMs });
  }
  return results;
}

// ── Group chat scanning ─────────────────────────────────

/** Parse a chat .md file into individual message blocks. */
async function parseChatMessages(filePath: string): Promise<{ from: string; date: string; body: string; offset: number }[]> {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf-8');
    const msgs: { from: string; date: string; body: string; offset: number }[] = [];
    // Split on "---\nfrom:" (YAML frontmatter start of each message)
    const blocks = raw.split(/\n(?=---\nfrom:)/);
    for (const block of blocks) {
      const m = block.match(/^---\nfrom:\s*(.+?)\ndate:\s*(.+?)\n---\n\n([\s\S]*)/);
      if (m) {
        msgs.push({ from: m[1].trim(), date: m[2].trim(), body: m[3].trim(), offset: raw.indexOf(block) });
      }
    }
    return msgs;
  } catch (e) { _lastError = `parseChatMessages: ${e instanceof Error ? e.message : String(e)}`; return []; }
}

// ── Signal builder ──────────────────────────────────────

/**
 * Scan all channels for an agent and build a signal.
 *
 * Returns null if nothing new.
 */
async function buildSignal(agent: string): Promise<{ signal: Signal; state: AgentState; dirty: boolean } | null> {
  const state = loadState(agent);
  let dirty = false;
  const now = Date.now();

  const signal: Signal = {
    personalEmails: 0,
    groupEmails: {},
    newMessages: {},
    mentions: [],
    urgent: false,
    priority: 'normal',
  };

  // ── 0. Pending invitations ──────────────────────────
  try {
    const groupsEntries = await fsPromises.readdir(GROUPS_DIR, { withFileTypes: true });
    for (const g of groupsEntries) {
      if (!g.isDirectory() || g.name.startsWith('.')) continue;
      const invDir = path.join(GROUPS_DIR, g.name, '.invitations');
      const invFile = path.join(invDir, `${agent.toLowerCase()}.json`);
      try {
        const raw = await fsPromises.readFile(invFile, 'utf-8');
        const inv = JSON.parse(raw);
        signal.mentions.push({
          group: g.name,
          from: inv.invitedBy || 'unknown',
          snippet: `邀请你加入 ${g.name} 群组`,
        });
        signal.invitations = signal.invitations || [];
        signal.invitations.push({ group: g.name, invitedBy: inv.invitedBy || 'unknown' });
        signal.urgent = true;
        dirty = true;
      } catch { /* no invitation file -- expected */ }
    }
  } catch { /* GROUPS_DIR doesn't exist */ }

  // Yield to event loop between major scan phases
  await sleepMs(0);

  // ── 1. Personal email ─────────────────────────────
  const persDir = path.join(AGENTS_DIR, agent, 'email');
  const newPersEmails = await scanEmailDir(persDir, state.emailCheck);
  if (newPersEmails.length > 0) {
    signal.personalEmails = newPersEmails.length;
    state.emailCheck = now;
    dirty = true;
  }

  // ── 2. Group channels ────────────────────────────
  const currentGroups = getAgentGroups(agent);

  for (const g of currentGroups) {
    const gs = ensureGroup(state, g);

    // 2a. Group email
    const gEmailDir = path.join(GROUPS_DIR, g, 'Agents', agent, 'email');
    const newGEmails = await scanEmailDir(gEmailDir, gs.emailCheck);
    if (newGEmails.length > 0) {
      signal.groupEmails[g] = newGEmails.length;
      gs.emailCheck = now;
      dirty = true;
    }

    // 2b. Group chat -- new messages since lastCheck
    const chatDir = path.join(GROUPS_DIR, g, 'chat');
    let chatDirExists = false;
    try { await fsPromises.access(chatDir); chatDirExists = true; } catch { /* not found */ }
    if (chatDirExists) {
      let newCount = 0;
      const chatFiles = (await fsPromises.readdir(chatDir))
        .filter(f => f.endsWith('.md'))
        .sort();

      for (const cf of chatFiles) {
        const fp = path.join(chatDir, cf);
        try {
          const st = await fsPromises.stat(fp);
          // File modified since last check -> may contain new messages
          if (st.mtimeMs <= gs.chatCheck) continue;
        } catch (e) { _lastError = `buildSignal stat: ${e instanceof Error ? e.message : String(e)}`; continue; }

        for (const msg of await parseChatMessages(fp)) {
          const msgTs = new Date(msg.date).getTime();
          if (msgTs <= gs.chatCheck) continue;
          if (msg.from.toLowerCase() === agent.toLowerCase()) continue;
          newCount++;

          // Check for @mention
          if (msg.body.toLowerCase().includes('@' + agent.toLowerCase())) {
            // Generate hash for dedup
            const hash = createHash('md5').update(g + msg.from + msg.body.slice(0, 100)).digest('hex').slice(0, 12);
            if (gs.lastMention !== hash) {
              signal.mentions.push({
                group: g,
                from: msg.from,
                snippet: msg.body.slice(0, 100),
              });
              gs.lastMention = hash;
              gs.chatCheck = now;     // advance only on actual @mention (agent will be spawned)
              signal.urgent = true;
              dirty = true;
            }
          }
        }
      }

      if (newCount > 0) {
        signal.newMessages[g] = newCount;
        // Advance chatCheck even if no @mention -- prevents re-scanning same files.
        // The agent won't be spawned, but we won't re-detect these messages next tick.
        gs.chatCheck = now;
        dirty = true;
      }
    }
  }

  // Yield to event loop between scan phases
  await sleepMs(0);

  // ── 3. Clean up stale groups from state ────────────
  for (const g of Object.keys(state.groups)) {
    if (!currentGroups.includes(g)) delete state.groups[g];
  }

  // ── 2c. Workflow notifications ─────────────────────
  // v1.2: Use AGENTS_DIR (same path as notifyAgent writes to)
  const notifDir = path.join(AGENTS_DIR, agent, '.workflow-notifications');
  let notifDirExists = false;
  try { await fsPromises.access(notifDir); notifDirExists = true; } catch { /* not found */ }
  if (notifDirExists) {
    const notifEntries = await fsPromises.readdir(notifDir);
    const notifFiles = notifEntries.filter(f => f.endsWith('.json'));
    const oneHourAgo = Date.now() - 3600_000;
    for (const f of notifFiles) {
      try {
        const raw = await fsPromises.readFile(path.join(notifDir, f), 'utf-8');
        const notif = JSON.parse(raw);
        // v0.6: Clean up notifications older than 1 hour
        if (notif.createdAt && notif.createdAt < oneHourAgo) {
          try { await fsPromises.unlink(path.join(notifDir, f)); } catch (e) { log.error('Failed to delete old notification', e); }
          continue;
        }
        signal.mentions.push({
          group: 'workflow',
          from: 'workflow-engine',
          snippet: `[工作流任务] runId=${notif.runId} stepId=${notif.stepId}\n${notif.prompt || ''}`,
        });
        signal.urgent = true;
        dirty = true;
      } catch (e) { log.error('Failed to parse workflow notification', e); }
    }
  }

  // ── 3. Nothing new? ───────────────────────────────
  const totalNew =
    signal.personalEmails +
    Object.values(signal.groupEmails).reduce((a, b) => a + b, 0) +
    Object.values(signal.newMessages).reduce((a, b) => a + b, 0) +
    signal.mentions.length;

  if (totalNew === 0) return null;

  // DON'T save state here -- emailCheck will advance only after the agent
  // successfully processes the email. If the software is closed before
  // autoRespond completes, the email stays "unseen" and gets re-detected
  // on next startup (mtime > old emailCheck).
  return { signal, state, dirty };
}

// ── Signal -> Prompt ─────────────────────────────────────

function signalToPrompt(agent: string, sig: Signal, groupName?: string): string {
  const lines: string[] = [];

  lines.push('[系统通知]');
  lines.push('');

  // Emails
  const emailParts: string[] = [];
  if (sig.personalEmails > 0) emailParts.push(`个人邮箱 ${sig.personalEmails} 封新邮件`);
  for (const [g, n] of Object.entries(sig.groupEmails)) {
    if (n > 0) emailParts.push(`${g} 群邮箱 ${n} 封`);
  }
  if (emailParts.length > 0) lines.push(`📧 ${emailParts.join(' | ')}`);

  // Group chat
  const chatParts: string[] = [];
  for (const [g, n] of Object.entries(sig.newMessages)) {
    if (n > 0) chatParts.push(`${g} 群 ${n} 条`);
  }
  if (chatParts.length > 0) lines.push(`💬 群聊新消息: ${chatParts.join(' | ')}`);

  // Invitations
  if (sig.invitations && sig.invitations.length > 0) {
    lines.push('📨 群组邀请 (用 decide 接受/拒绝):');
    for (const inv of sig.invitations) {
      lines.push(`   ${inv.invitedBy} 邀请你加入 ${inv.group} 群组`);
    }
    lines.push('   接受: decide(group, decision="APPROVED", reason="接受邀请")');
    lines.push('   拒绝: decide(group, decision="REJECTED", reason="拒绝邀请")');
  }

  // @mentions — include the actual task prompt from snippet
  if (sig.mentions.length > 0) {
    lines.push(`@提及:`);
    for (const m of sig.mentions) {
      lines.push(`  ${m.from} 在 ${m.group} 群 @了你`);
      // Include the actual task content from the snippet
      if (m.snippet) {
        lines.push(`  任务内容: ${m.snippet}`);
      }
    }
  }

  lines.push('');
  lines.push('请用中文简短回复。如果有工作流任务，直接执行任务并把结果写在回复中，系统会自动完成回调。');

  return lines.join('\n');
}

// ── Workflow callback processing ──────────────────────────

async function processWorkflowCallbacks(agent: string, reply: string): Promise<void> {
  const notifDir = path.join(AGENTS_DIR, agent, '.workflow-notifications');
  let notifFiles: string[];
  try {
    const entries = await fsPromises.readdir(notifDir);
    notifFiles = entries.filter(f => f.endsWith('.json'));
  } catch { return; }
  if (notifFiles.length === 0) return;

  const { getEngine } = await import('./workflow-bridge');
  const engine = getEngine();

  for (const f of notifFiles) {
    try {
      const raw = await fsPromises.readFile(path.join(notifDir, f), 'utf-8');
      const notif = JSON.parse(raw);

      // Check if agent's reply contains workflow_callback call
      const callbackMatch = reply?.match(/workflow_callback\s*\(\s*runId\s*=\s*"([^"]+)"\s*,\s*stepId\s*=\s*"([^"]+)"\s*,\s*status\s*=\s*"([^"]+)"\s*,\s*summary\s*=\s*"([^"]+)"/);
      let output;
      if (callbackMatch) {
        output = `${callbackMatch[3]}: ${callbackMatch[4]}`;
        log.info(`${agent}: found workflow_callback in text for ${notif.stepId}`);
      } else {
        output = reply || '';  // Empty output will be detected as placeholder by callback handler
      }

      const ok = engine.callback(notif.runId, notif.stepId, output);
      if (ok) {
        log.info(`${agent}: completed workflow step ${notif.stepId}`);
      } else {
        log.info(`${agent}: callback returned false for ${notif.stepId}`);
      }
      // Clean up notification file regardless
      try { await fsPromises.unlink(path.join(notifDir, f)); } catch (e) { log.error('Failed to delete notification file', e); }
    } catch (e) {
      log.info(`${agent}: notification ${f} callback error:`, e);
    }
  }
}

// ── Main entry ──────────────────────────────────────────

/**
 * Run the auto-respond cycle for a single agent.
 *
 * Scans all notification channels (personal email, group email, group chat,
 * @mentions, workflow tasks, and group invitations) and builds a signal. If
 * actionable signals exist and the agent is enabled, a chat prompt is sent
 * and the agent decides whether to act. Results are debounced per-agent to
 * prevent duplicate spawns from overlapping watchers and polls.
 *
 * @param agent   - The agent name to process.
 * @param options - Optional: `groupName` to scope signal scanning, `force` to
 *                  bypass debounce and auto-respond enablement checks.
 * @returns An object indicating whether the agent was triggered, its reply
 *          text (if any), and a reason string when not triggered.
 */
export async function autoRespond(
  agent: string,
  options?: { groupName?: string; force?: boolean }
): Promise<{
  triggered: boolean; reply?: string; reason?: string;
}> {
  const config = getConfig(agent);
  if (!config.autoRespondToEmail && !options?.force) {
    return { triggered: false, reason: 'autoRespond disabled' };
  }

  // Invalidate stale caches -- new agent may have joined since last scan
  // First get current groups (before invalidation), then invalidate all related caches
  const agentGroups = getAgentGroups(agent);
  for (const g of agentGroups) {
    agentCache.invalidate('groupChat', g);
  }
  invalidateGroupsCache(agent);

  // v0.5: Move buildSignal inside enqueueAgent to prevent race condition
  // where two concurrent calls read the same state and overwrite each other
  return enqueueAgent(agent, async () => {
    // Build signal (reads state -- now serialized per agent)
    const result = await buildSignal(agent);

    // Nothing to do
    if (!result) {
      return { triggered: false, reason: 'no new signals' };
    }

    const { signal, state, dirty } = result;

  // Only spawn claude for: @mention, new email, or forced.
  // v0.4: Determine priority based on signal content
  if (signal.urgent || (signal.invitations && signal.invitations.length > 0)) {
    signal.priority = 'critical';
  } else if (signal.mentions.length > 0 || signal.personalEmails > 0) {
    signal.priority = 'normal';
  } else {
    signal.priority = 'low';
  }

  // Chat-only messages -> advance chatCheck (not emailCheck)
  if (!signal.urgent && signal.personalEmails === 0 &&
      Object.values(signal.groupEmails).every(n => n === 0) &&
      !options?.force) {
    // chatCheck was already advanced in buildSignal -- persist that
    saveState(agent, state);
    return { triggered: false, reason: 'chat-only, state updated' };
  }

  // ── Debounce -- prevent duplicate spawns from watcher+poll overlap ──
  // v0.4: Priority-based debounce -- critical bypasses, low has longer window
  const now = Date.now();
  const last = lastSpawn.get(agent) || 0;
  const window = signal.priority === 'critical' ? DEBOUNCE_URGENT : signal.priority === 'low' ? 120_000 : DEBOUNCE_IDLE;
  if (!options?.force && now - last < window) {
    // Save state to advance chatCheck (prevent re-scanning) but don't advance emailCheck
    // so the agent will process emails on next allowed spawn
    saveState(agent, state);
    return { triggered: false, reason: `debounced (${now - last}ms < ${window}ms)` };
  }
  lastSpawn.set(agent, now);

  // Build prompt and call agent with retry
  const prompt = signalToPrompt(agent, signal, options?.groupName);

  const maxRetries = 3;
  const startTime = Date.now();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // v0.6: Check total time budget (5 minutes max for entire auto-respond)
      if (Date.now() - startTime > 300_000) {
        log.info(`${agent}: time budget exhausted after ${Date.now() - startTime}ms`);
        break;
      }
      setActivity(agent, 'processing', signal.urgent ? '处理通知' : '检查更新');
      // v1.1: Enable MCP tools for workflow tasks so agents can self-submit via workflow_callback
      // For non-workflow tasks, keep noMcp to prevent unintended side effects
      const hasWorkflowTasks = signal.mentions.some(m => m.group === 'workflow');
      const { reply } = await chatOnce(agent, prompt, options?.groupName, { noMcp: !hasWorkflowTasks });
      clearActivity(agent);
      saveState(agent, state);

      // v1.3: Process workflow callbacks
      try {
        await processWorkflowCallbacks(agent, reply);
      } catch (e) {
        log.info(`${agent}: workflow callback error:`, e);
      }

      // 通知引擎:记录这次真实唤醒(去重 + 广播)
      try {
        const { ingestNotification } = await import('./notifications');
        ingestNotification({
          kind: 'signal',
          target: { type: 'agent', name: agent },
          source: options?.groupName ? `group:${options.groupName}` : undefined,
          summary: signal.urgent
            ? 'urgent signal'
            : signal.mentions.length > 0
              ? `${signal.mentions.length} mention(s)`
              : 'email / new messages',
        });
      } catch { /* 通知失败不影响唤醒流程 */ }

      return { triggered: true, reply };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isLast = attempt === maxRetries - 1;
      if (isLast) {
        return { triggered: false, reason: `all ${maxRetries} attempts failed: ${msg}` };
      }
      const delay = Math.pow(2, attempt + 1) * 1000;
      log.info(`${agent} chatOnce failed (attempt ${attempt + 1}/${maxRetries}): ${msg}. Retrying in ${delay}ms...`);
      await sleepMs(delay);
    }
  }
  return { triggered: false, reason: 'unreachable' };
  }); // end enqueueAgent
}

// ── Heartbeat ────────────────────────────────────────────
// Periodic wake-up. Enabling autoRespondToEmail fires heartbeat every N seconds.
// No signal scanning, no task injection -- just a gentle "you've been woken" nudge.

const lastHeartbeat = new Map<string, number>();

/**
 * Send a periodic heartbeat nudge to an agent.
 *
 * Unlike {@link autoRespond}, no signal scanning or task injection occurs --
 * the agent simply receives a lightweight wake-up prompt asking it to check
 * for pending work and report progress. Calls are throttled by `intervalMs`
 * to prevent excessive wake-ups.
 *
 * @param agent      - The agent name to wake.
 * @param intervalMs - Minimum interval (in ms) between consecutive heartbeats
 *                     for the same agent. Calls within this window are skipped.
 * @returns An object indicating whether the agent was triggered, its reply
 *          text (if any), and a reason string when not triggered.
 */
export async function agentHeartbeat(agent: string, intervalMs: number): Promise<{ triggered: boolean; reply?: string; reason?: string }> {
  return enqueueAgent(agent, async () => {
    const config = getConfig(agent);
    if (!config.autoRespondToEmail) return { triggered: false, reason: 'autoRespond disabled' };

    const now = Date.now();
    const last = lastHeartbeat.get(agent) || 0;
    if (now - last < intervalMs) {
      return { triggered: false, reason: `throttled (${now - last}ms < ${intervalMs}ms)` };
    }
    lastHeartbeat.set(agent, now);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        setActivity(agent, 'processing', '心跳检查');
        const { reply } = await chatOnce(agent, '[Heartbeat] 你被唤醒了。请自主检查是否有需要处理的事项。如果有，在群里同步进展。如果没有，忽略这条消息即可。用中文。');
        clearActivity(agent);
        return { triggered: true, reply };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === 2) return { triggered: false, reason: `all 3 attempts failed: ${msg}` };
        await sleepMs(Math.pow(2, attempt + 1) * 1000);
      }
    }
    return { triggered: false, reason: 'unreachable' };
  });
}

// ── Batch poll ──────────────────────────────────────────

// Concurrency limit: process at most N agents at a time to avoid flooding the event loop
const POLL_BATCH_SIZE = 3;
// Overall timeout: abort polling if it takes longer than this
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function pollAllAgents(groupName?: string): Promise<{ agent: string; triggered: boolean; reason?: string }[]> {
  // Use AgentProxy for listing agents (async readdir to avoid sync blocking)
  const agents: string[] = [];
  try {
    const entries = await fsPromises.readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const agentProxy = new AgentProxy(entry.name);
        if (agentProxy.exists()) {
          agents.push(entry.name);
        }
      }
    }
  } catch { /* AGENTS_DIR doesn't exist */ }

  if (agents.length === 0) return [];

  const results: { agent: string; triggered: boolean; reason?: string }[] = [];
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  // Process agents in batches to avoid flooding the event loop
  for (let i = 0; i < agents.length; i += POLL_BATCH_SIZE) {
    // Check overall timeout
    if (Date.now() >= deadline) {
      log.warn(`pollAllAgents: timeout reached, ${agents.length - i} agents remaining`);
      for (const remaining of agents.slice(i)) {
        results.push({ agent: remaining, triggered: false, reason: 'timeout' });
      }
      break;
    }

    const batch = agents.slice(i, i + POLL_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (a) => {
        try {
          const result = await autoRespond(a, { groupName });
          return { agent: a, triggered: result.triggered, reason: result.reason };
        } catch (e) {
          _lastError = `pollAllAgents(${a}): ${e instanceof Error ? e.message : String(e)}`;
          return { agent: a, triggered: false, reason: 'error' };
        }
      })
    );
    results.push(...batchResults);

    // Yield to event loop between batches so other requests can be served
    if (i + POLL_BATCH_SIZE < agents.length) {
      await sleepMs(0);
    }
  }

  return results;
}

// ── Targeted single-agent poll (v0.4: MCP direct notify) ──

/** Poll a single agent -- 10x faster than pollAllAgents when you know which agent changed */
export async function pollAgent(agent: string, groupName?: string): Promise<{ agent: string; triggered: boolean; reason?: string }> {
  try {
    const result = await autoRespond(agent, { groupName });
    return { agent, triggered: result.triggered, reason: result.reason };
  } catch (e) {
    _lastError = `pollAgent(${agent}): ${e instanceof Error ? e.message : String(e)}`;
    return { agent, triggered: false, reason: 'error' };
  }
}
