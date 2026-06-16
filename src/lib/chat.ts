/**
 * Agent Chat — Multi-provider backend (v0.4)
 *
 * Supports multiple AI providers via the provider abstraction layer.
 * Default: Claude Agent SDK with DeepSeek backend.
 * Alternative: Codex (OpenAI API).
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { SYSTEM_BOUNDARY_PROMPT } from './agent-identity';
import { getProvider, type AgentProvider } from './providers';
import { createLogger } from '@/lib/logger';

// ── Global error handlers — prevent worker crashes from unhandled rejections ──
// Next.js runs API routes in Jest workers. An unhandled rejection or uncaught
// exception kills the worker, making the entire dev server unresponsive.
// These handlers log the error and prevent process termination.
const _chatLog = createLogger('chat:global');
if (!process.listeners('unhandledRejection').length) {
  process.on('unhandledRejection', (reason: any) => {
    _chatLog.error('Unhandled promise rejection (worker survived)', reason);
  });
}
if (!process.listeners('uncaughtException').length) {
  process.on('uncaughtException', (err: Error) => {
    _chatLog.error('Uncaught exception (worker survived)', err);
    // Do NOT re-throw — let the worker continue serving requests
  });
}

// ── Periodic memory pressure check ──
// Runs every 30s to catch gradual memory leaks before they OOM the worker.
// When heap exceeds threshold, forces GC if available and logs a warning.
const MEMORY_CHECK_INTERVAL = 30_000;
const MEMORY_THRESHOLD_MB = 500;
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  if (heapMB > MEMORY_THRESHOLD_MB) {
    _chatLog.warn(`High memory usage: ${heapMB}MB heap (RSS: ${Math.round(mem.rss / 1024 / 1024)}MB)`);
    if (global.gc) {
      global.gc();
      const afterMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      _chatLog.info(`GC reduced heap: ${heapMB}MB -> ${afterMB}MB`);
    }
  }
}, MEMORY_CHECK_INTERVAL).unref?.();

const log = createLogger('chat');

// Ensure providers are registered
import './providers/claude';
import './providers/codex';
import './providers/claude-proxy';
import { AGENTS_DIR, GROUPS_DIR, MCP_DIR, MIND_DIR, default as DATA_DIR } from './data-dir';
import { getMemoryContext, invalidateMemoryCache } from './memory';
import { AgentProxy } from './agent-proxy';
import { getSkillProxy } from './skill-proxy';
import { getMemoryProxy } from './memory-proxy';
import { getSystemProxy } from './system-proxy';
import {
  isAssistantMsg, isUserMsg, isResultSuccess,
  isThinkingBlock, isTextBlock, isToolUseBlock, isToolResultBlock,
  getTokenUsage,
} from './sdk-types';
import { trackQuery, untrackQuery, killAllQueries } from './process-tracker';
import { enqueueAgent } from './agent-queue';
import { loadGoalContext, invalidateGoalsCache } from './cli-commands';
import { setActivity, clearActivity } from './agent-activity';
import { writeAudit } from './audit';

// ── Load API settings from frontend-configurable settings.json ──
// Uses api-settings.ts module (no process.env mutation).
import { getApiSettings, invalidateApiSettings } from './api-settings';

// Watch settings.json for runtime changes (user edits via /settings page)
// Also invalidates all agent caches so config changes propagate immediately.
let settingsWatcher: fs.FSWatcher | null = null;
try {
  const settingsFile = path.join(MIND_DIR, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    settingsWatcher = fs.watch(settingsFile, () => {
      const prev = getApiSettings().model;
      invalidateApiSettings();
      const curr = getApiSettings().model;
      if (curr !== prev) {
        log.info(`model changed: ${prev || '(none)'} → ${curr || '(none)'}`);
      }
      // Invalidate all agent caches — API key/URL/model change affects everyone
      agentCache.invalidateRegion('config');
    });
  }
} catch { /* watcher optional */ }

// ── Per-agent config.json watchers ────────────────────────────
// Invalidate agent cache the moment their config.json or CLAUDE.md changes
// (edits via the /agents/[name] UI page or direct file writes).
const configWatchers = new Map<string, fs.FSWatcher>();
const watchDebounce = new Map<string, ReturnType<typeof setTimeout>>();

function watchAgentConfig(agentName: string): void {
  const configPath = path.join(AGENTS_DIR, agentName, 'config.json');
  const claudePath = path.join(AGENTS_DIR, agentName, 'CLAUDE.md');
  if (!fs.existsSync(configPath)) return;
  // Close any existing watcher for this agent
  const old = configWatchers.get(agentName);
  if (old) { try { old.close(); } catch (e) { log.error('Failed to close old config watcher', e); } }
  try {
    // Watch the agent directory — catches both config.json and CLAUDE.md changes
    const w = fs.watch(path.join(AGENTS_DIR, agentName), (eventType, filename) => {
      if (!filename || !/^(config\.json|CLAUDE\.md)$/.test(filename)) return;
      // Debounce 500ms — save operations fire multiple events
      const existing = watchDebounce.get(agentName);
      if (existing) clearTimeout(existing);
      watchDebounce.set(agentName, setTimeout(() => {
        watchDebounce.delete(agentName);
        invalidateAgentCache(agentName);
        log.info(`${agentName}/${filename} changed → cache invalidated`);
      }, 500));
    });
    configWatchers.set(agentName, w);
  } catch { /* permission issue on dir watch — non-fatal */ }
}

// Initial scan of existing agents
try {
  if (fs.existsSync(AGENTS_DIR)) {
    for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) watchAgentConfig(entry.name);
    }
  }
} catch (e) { log.error('Failed to scan agents directory', e); }

// On new agent creation, the scheduler's tick() refreshes file watchers via
// refreshFileWatchers(). Also watch for new agent directories appearing.
let agentDirWatcher: fs.FSWatcher | null = null;
try {
  if (fs.existsSync(AGENTS_DIR)) {
    agentDirWatcher = fs.watch(AGENTS_DIR, (eventType, filename) => {
      if (!filename) return;
      // A new directory appearing → watch its config
      if (!configWatchers.has(filename)) watchAgentConfig(filename);
    });
  }
} catch (e) { log.error('Failed to watch agents directory', e); }

process.on('exit', () => {
  try { settingsWatcher?.close(); } catch (e) { log.error('Failed to close settings watcher', e); }
  try { agentDirWatcher?.close(); } catch (e) { log.error('Failed to close agent directory watcher', e); }
  for (const w of configWatchers.values()) try { w.close(); } catch (e) { log.error('Failed to close config watcher', e); }
  for (const t of watchDebounce.values()) clearTimeout(t);
});

/**
 * Kill all running Claude query processes across every agent.
 *
 * Delegates to the process tracker to abort every tracked query and
 * returns the number of processes that were terminated.
 *
 * @returns Number of killed processes.
 */
export function killAllClaudeProcesses(): number {
  return killAllQueries();
}

// ── Caches (unified via agentCache) ──
import { agentCache } from './cache';

export interface ChatEvent {
  type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  timestamp: string;
}

export interface ChatHistory {
  sessionId: string | null;
  messages: { role: 'user' | 'assistant'; content: string; events?: ChatEvent[]; timestamp: string }[];
  _version?: number;  // v0.5: concurrent-safe version counter
}

function sessionFile(agentName: string) {
  return path.join(AGENTS_DIR, agentName, 'chat', 'session.json');
}

// Session cache — avoid repeated reads of session.json during streaming
// Returns a deep copy to prevent concurrent modification issues
export function getChatHistory(agentName: string): ChatHistory {
  // Check cache first
  const cached = agentCache.get<ChatHistory>('session', agentName);
  if (cached) return JSON.parse(JSON.stringify(cached)); // Deep copy

  const file = sessionFile(agentName);
  let data: ChatHistory;
  if (!fs.existsSync(file)) {
    data = { sessionId: null, messages: [], _version: 0 };
  } else {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (typeof data._version !== 'number') data._version = 0;
    }
    catch { data = { sessionId: null, messages: [], _version: 0 }; }
  }

  agentCache.set('session', agentName, data);
  return JSON.parse(JSON.stringify(data)); // Deep copy
}

function saveChatHistory(agentName: string, data: ChatHistory, expectedVersion?: number) {
  // v0.5: Version check — prevent concurrent overwrites
  if (expectedVersion !== undefined) {
    const cached = agentCache.get<ChatHistory>('session', agentName);
    if (cached && cached._version !== undefined && cached._version !== expectedVersion) {
      // Another request modified the session — merge messages instead of overwrite
      const merged = JSON.parse(JSON.stringify(cached)) as ChatHistory;
      // Append new messages that aren't in the cached version
      // Use full content as dedup key (not truncated) to avoid false deduplication
      // of different messages that happen to share the same first 50 chars.
      const existingKeys = new Set(merged.messages.map(m => `${m.role}:${m.content}`));
      for (const msg of data.messages) {
        const key = `${msg.role}:${msg.content}`;
        if (!existingKeys.has(key)) {
          merged.messages.push(msg);
        }
      }
      // Keep last 100 messages (matches savePartialState limit)
      if (merged.messages.length > 100) merged.messages = merged.messages.slice(-100);
      merged.sessionId = data.sessionId || merged.sessionId;
      merged._version = (cached._version || 0) + 1;
      data = merged;
    }
  }

  const dir = path.join(AGENTS_DIR, agentName, 'chat');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = sessionFile(agentName);
    const tmp = file + '.tmp';
    data._version = (data._version || 0) + 1;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    agentCache.set('session', agentName, data);
  } catch (err) {
    log.error(`saveChatHistory failed for ${agentName}`, err);
  }
}

/**
 * Clear the chat session history for the specified agent.
 *
 * Resets the agent's session by delegating to {@link AgentProxy.clearSession},
 * which removes the session file and invalidates any cached session data.
 *
 * @param agentName - The agent whose chat history should be cleared.
 */
export function clearChat(agentName: string) {
  // Delegate to AgentProxy for session clearing
  const proxy = new AgentProxy(agentName);
  proxy.clearSession();
}

// ── Builders ──────────────────────────────────────────────

function buildIdentity(agentName: string): string {
  const config = getAgentConfig(agentName);

  // Read agent's own CLAUDE.md — cached for performance
  let identity = readClaudeMd(agentName);
  if (!identity) {
    // Fallback: try .claude/CLAUDE.md
    const claudeMdAlt = path.join(AGENTS_DIR, agentName, '.claude', 'CLAUDE.md');
    try {
      if (fs.existsSync(claudeMdAlt)) identity = fs.readFileSync(claudeMdAlt, 'utf-8').trim();
    } catch (e) { log.error('Failed to read fallback CLAUDE.md', e); }
  }
  if (!identity) identity = `你是${agentName}，Mind Agency 团队成员。`;

  // Append behavioral config if agent has it
  const behavior = config.behavior;
  const behaviorLines: string[] = [];
  if (behavior) {
    if (behavior.style) behaviorLines.push(`- 风格: ${behavior.style}`);
    if (behavior.focus?.length) behaviorLines.push(`- 重点领域: ${behavior.focus.join(', ')}`);
    if (behavior.avoidTopics?.length) behaviorLines.push(`- 避免: ${behavior.avoidTopics.join(', ')}`);
  }
  if (behaviorLines.length > 0) identity += '\n\n【行为偏好】\n' + behaviorLines.join('\n');

  // Append L1/L2/L3 boundaries + tools reference (from shared constant)
  identity += `\n\n${SYSTEM_BOUNDARY_PROMPT}`;

  // Instruction compliance: ensure AI follows user's explicit instructions
  // This prevents the AI from substituting its own topic when the user gives
  // a specific instruction (e.g., user says "write about X" but agent writes about Y).
  identity += '\n\n【强制规则 — 指令遵从】用户在对话中给出的任何明确指令（如"写关于X"、"讨论Y"、"分析Z"），你必须严格按照指示执行。不要自行替换用户指定的主题、角度或内容要求。用户说什么就做什么，不要擅自更改。';

  return identity;
}

/** Read agent config.json — cached in memory */
interface AgentFullConfig {
  roles: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
  autoRespondToEmail?: boolean;
  autoProcessGroupInvites?: boolean;
  /** Behavior profile — injected into system prompt */
  behavior?: {
    style?: string;        // e.g. "直接、简洁" or "温和、细致"
    focus?: string[];      // e.g. ["代码审查", "安全审计"]
    preferences?: Record<string, string>; // e.g. { "decision": "偏保守", "review": "严格" }
    avoidTopics?: string[]; // e.g. ["闲聊", "未经证实的猜测"]
  };
}

/**
 * Read and cache an agent's `config.json` configuration.
 *
 * Returns a typed {@link AgentFullConfig} with roles, allowed/disallowed tools,
 * permission mode, behavior profile, and other agent-level settings.
 * Results are cached in the unified agent cache so repeated reads are free.
 *
 * @param agentName - The agent whose config should be loaded.
 * @returns The agent's full configuration, or a default empty-config object if
 *          the file does not exist or cannot be parsed.
 */
export function getAgentConfig(agentName: string): AgentFullConfig {
  const cached = agentCache.get<AgentFullConfig>('config', agentName);
  if (cached) return cached;
  try {
    const cf = path.join(AGENTS_DIR, agentName, 'config.json');
    if (fs.existsSync(cf)) {
      const data = JSON.parse(fs.readFileSync(cf, 'utf-8'));
      const cfg: AgentFullConfig = {
        roles: data.roles || [],
        allowedTools: data.allowedTools,
        disallowedTools: data.disallowedTools,
        permissionMode: data.permissionMode,
        maxTurns: data.maxTurns,
        behavior: data.behavior,
        autoRespondToEmail: data.autoRespondToEmail,
        autoProcessGroupInvites: data.autoProcessGroupInvites,
      };
      agentCache.set('config', agentName, cfg);
      return cfg;
    }
  } catch (e) { log.error('Failed to read agent config', e); }
  const def = { roles: [] };
  agentCache.set('config', agentName, def);
  return def;
}

function getGroupMembership(agentName: string): string {
  const cached = agentCache.get<string>('membership', agentName);
  if (cached !== null) return cached;

  // Delegate to AgentProxy for group membership scanning
  const proxy = new AgentProxy(agentName);
  const result = proxy.getGroupMembership();

  agentCache.set('membership', agentName, result);
  return result;
}

function buildGroupChatContext(_agentName: string, groupName?: string): string {
  if (!groupName) return '';

  // Check cache first (use group name as key with 30s TTL)
  const cached = agentCache.get<string>('groupChat', groupName, 30_000);
  if (cached !== null) return cached;

  // Delegate to AgentProxy for group chat context building
  const proxy = new AgentProxy(_agentName);
  const result = proxy.buildGroupChatContext(groupName);

  agentCache.set('groupChat', groupName, result);
  return result;
}

/**
 * Build MCP server config for the SDK.
 * Delegates to AgentProxy for the actual config building.
 */
function buildMcpConfig(agentName: string) {
  // Delegate to AgentProxy for MCP config building
  const proxy = new AgentProxy(agentName);
  return proxy.buildMcpConfig();
}

// ── Shared options (stable across calls → cache hit) ──────
// We want a single set of base options per agent. The SDK picks
// up options from the previous session via `continue: true`.

// ── CLAUDE.md content cache (via agentCache) ──────────────

function readClaudeMd(agentName: string): string {
  const cached = agentCache.get<string>('identity', agentName);
  if (cached !== null) return cached;

  // Delegate to AgentProxy for file reading
  const proxy = new AgentProxy(agentName);
  const content = proxy.readClaudeMd();

  agentCache.set('identity', agentName, content);
  return content;
}

/**
 * Invalidate all cached data for the specified agent.
 *
 * Clears the agent's config, identity, session, and membership caches from
 * the unified cache store. Also invalidates the memory and goals caches so
 * that subsequent reads pick up fresh data from disk.
 *
 * @param agentName - The agent whose caches should be invalidated.
 */
export function invalidateAgentCache(agentName: string): void {
  agentCache.invalidateAgent(agentName);
  // Also invalidate baseOptions cache (contains system prompt with memory)
  agentCache.invalidate('config', agentName + ':baseOptions');
  // Invalidate memory cache if agent name provided
  if (typeof invalidateMemoryCache === 'function') invalidateMemoryCache(agentName);
  // Invalidate goals cache
  if (typeof invalidateGoalsCache === 'function') invalidateGoalsCache(agentName);
}

function buildBaseOptions(agentName: string, taskContext?: string) {
  // Don't cache if we have task context (RAG changes per task)
  const cacheKey = agentName + ':baseOptions' + (taskContext ? ':rag' : '');
  if (!taskContext) {
    const cached = agentCache.get<Record<string, any>>('config', cacheKey);
    if (cached) return cached;
  }

  const agentDir = path.join(AGENTS_DIR, agentName);
  // Memory context layer — agent carries past context across sessions
  const memCtx = getMemoryContext(agentName);
  // Skills: RAG-based, injected into user message (not system prompt)
  // This keeps system prompt stable for better KV cache
  // v1.2: Team learnings are NOT injected here — agents query via learning_query MCP tool
  const sysPrompt = buildIdentity(agentName) + '\n' + getGroupMembership(agentName) + (memCtx ? '\n' + memCtx : '');
  const mcpServers = buildMcpConfig(agentName);
  const agentConfig = getAgentConfig(agentName);

  const opts = {
    cwd: agentDir,
    systemPrompt: sysPrompt,
    mcpServers,
    permissionMode: agentConfig.permissionMode || 'bypassPermissions',
    allowedTools: agentConfig.allowedTools?.length ? agentConfig.allowedTools : ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    ...(agentConfig.disallowedTools?.length ? { disallowedTools: agentConfig.disallowedTools } : {}),
    // maxTurns removed — agents can run indefinitely
  };

  agentCache.set('config', cacheKey, opts);
  return opts;
}

/**
 * Save partial streaming state to `session.json` so users can navigate away
 * and come back without losing progress.
 *
 * Self-contained — inspects history to decide what to append:
 *   - Empty history → push {user, message}
 *   - Last entry is user → push {assistant, reply} (first content chunk)
 *   - Last entry is assistant → replace it (subsequent chunks)
 *
 * This eliminates the old `userMessageSaved` flag and 3× inline duplicates.
 */
export function savePartialState(agentName: string, opts: {
  userMessage: string;
  fullReply: string;
  allEvents: ChatEvent[];
  sessionId: string;
}): void {
  const ih = getChatHistory(agentName);
  const expectedVersion = ih._version;
  const last = ih.messages[ih.messages.length - 1];

  if (!last) {
    // No prior save — persist user message so it's visible immediately
    ih.messages.push({ role: 'user', content: opts.userMessage, timestamp: new Date().toISOString() });
  } else if (last.role === 'user' && last.content === opts.userMessage) {
    // Same user message — append partial assistant reply (first chunk)
    ih.messages.push({ role: 'assistant', content: opts.fullReply, events: [...opts.allEvents], timestamp: new Date().toISOString() });
  } else if (last.role === 'assistant' && ih.messages.length >= 2 && ih.messages[ih.messages.length - 2]?.content === opts.userMessage) {
    // Subsequent chunk of same conversation — replace the partial assistant reply
    last.content = opts.fullReply || last.content;
    last.events = [...opts.allEvents];
  } else {
    // New conversation — append both user message and assistant reply
    ih.messages.push({ role: 'user', content: opts.userMessage, timestamp: new Date().toISOString() });
    ih.messages.push({ role: 'assistant', content: opts.fullReply, events: [...opts.allEvents], timestamp: new Date().toISOString() });
  }

  // v0.5: Keep last 100 messages (increased from 50 for better context retention)
  if (ih.messages.length > 100) {
    ih.messages = ih.messages.slice(-100);
  }

  ih.sessionId = opts.sessionId || ih.sessionId;
  try {
    log.info(`savePartialState: ${agentName}, msgs=${ih.messages.length}, version=${ih._version}`);
    saveChatHistory(agentName, ih, expectedVersion);
    log.info(`savePartialState: ${agentName} saved successfully`);
  } catch (err) {
    log.error(`savePartialState failed for ${agentName}`, err);
  }
}

// ── Main stream ──────────────────────────────────────────

/**
 * @param fresh - When true, skip `continue: true` so SDK starts a brand new session.
 *   Used after /clear so the old session is fully discarded.
 */
// ── v0.4: Provider-based chat stream ─────────────────────

// Use cached getAgentConfig instead of uncached loadAgentConfig
function loadAgentConfig(agentName: string): Record<string, unknown> | null {
  const config = getAgentConfig(agentName);
  return config as unknown as Record<string, unknown> | null;
}

function createProviderStream(
  provider: AgentProvider, agentName: string, userMessage: string,
  groupName?: string, modelOverride?: string, agentConfig?: Record<string, unknown> | null,
): ReadableStream<ChatEvent> {
  const ts = () => new Date().toISOString();
  const MAX_PROVIDER_EVENTS = 500; // cap to prevent OOM on long tool chains
  return new ReadableStream<ChatEvent>({
    async start(ctrl) {
      const allEvents: ChatEvent[] = [];
      let fullReply = '';
      setActivity(agentName, 'chatting', '对话中');
      const abortController = trackQuery();

      try {
        const baseOpts = buildBaseOptions(agentName);
        const groupChatCtx = buildGroupChatContext(agentName, groupName);
        const goalsCtx = loadGoalContext(agentName);
        const fullPrompt = groupChatCtx
          ? groupChatCtx + (goalsCtx ? '\n' + goalsCtx : '') + '\n\n---\n\n' + userMessage
          : (goalsCtx ? goalsCtx + '\n\n---\n\n' : '') + userMessage;

        // Build MCP servers config
        const mcpServers: Record<string, unknown> = {};
        const serverPath = path.join(MCP_DIR, 'group-server.mjs');
        if (fs.existsSync(serverPath)) {
          mcpServers['group-chat'] = {
            command: process.platform === 'win32' ? 'cmd.exe' : 'node',
            args: process.platform === 'win32'
              ? ['/c', 'node', serverPath, agentName]
              : [serverPath, agentName],
          };
        }

        const stream = provider.execute({
          agentName,
          prompt: fullPrompt,
          systemPrompt: baseOpts.systemPrompt,
          mcpServers,
          config: {
            model: modelOverride || (agentConfig as any)?.model,
            apiKey: (agentConfig as any)?.apiKey,
            baseUrl: (agentConfig as any)?.baseUrl,
          },
        });

        for await (const evt of stream) {
          // Cap events array to prevent memory explosion
          if (allEvents.length < MAX_PROVIDER_EVENTS) allEvents.push(evt);
          ctrl.enqueue(evt);
          if (evt.type === 'text') { fullReply += evt.content || ''; }
        }
      } catch (err: any) {
        ctrl.enqueue({ type: 'error', content: err.message || String(err), timestamp: ts() });
      } finally {
        clearActivity(agentName);
        untrackQuery(abortController);
        try {
          ctrl.enqueue({ type: 'done', content: '', timestamp: ts() });
          ctrl.close();
        } catch { /* controller may already be closed */ }
      }
    },
  });
}

// ── Active stream counter for safe process.env mutation ──
let activeStreams = 0;

/**
 * Create a streaming chat response for an agent.
 *
 * Routes the request through the relay layer (RAG context injection + token
 * billing) and returns a `ReadableStream<ChatEvent>` that yields thinking,
 * tool_use, tool_result, text, error, and done events as the AI responds.
 *
 * @param agentName   - The agent to chat with.
 * @param userMessage - The user's message text.
 * @param groupName   - Optional group context; when provided, group chat
 *                      history is injected into the prompt.
 * @param modelOverride - Optional model name to override the agent's default.
 * @param optsOverrides - Optional provider option overrides (e.g. disable MCP).
 * @param fresh       - When `true`, skip session continuation so the SDK
 *                      starts a brand-new session (used after /clear).
 * @returns A readable stream of {@link ChatEvent} objects.
 */
export async function createChatStream(agentName: string, userMessage: string, groupName?: string, modelOverride?: string, optsOverrides?: Record<string, unknown>, fresh?: boolean): Promise<ReadableStream<ChatEvent>> {
  const agentDir = path.join(AGENTS_DIR, agentName);
  if (!fs.existsSync(agentDir)) return quickError(`Agent "${agentName}" not found`);

  // ── Route ALL requests through relay (RAG + token billing) ──
  // Agent → Relay → RAG → AI Provider
  try {
    const { relay } = await import('./relay');

    // Build system prompt (agent identity + tools + boundaries)
    const baseOpts = buildBaseOptions(agentName);
    const groupChatCtx = buildGroupChatContext(agentName, groupName);
    const goalsCtx = loadGoalContext(agentName);

    // Build user message with context
    const fullPrompt = groupChatCtx
      ? groupChatCtx + (goalsCtx ? '\n' + goalsCtx : '') + '\n\n---\n\n' + userMessage
      : (goalsCtx ? goalsCtx + '\n\n---\n\n' : '') + userMessage;

    // Build conversation context for relay — include last 30 messages for better context retention
    const history = getChatHistory(agentName);
    const messages = [
      ...history.messages.slice(-30).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: fullPrompt },
    ];

    const result = await relay({
      agent: agentName,
      messages,
      model: modelOverride,
      systemPrompt: baseOpts.systemPrompt,
    });

    // Convert relay response to ReadableStream<ChatEvent>
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send text event
        controller.enqueue(encoder.encode(JSON.stringify({
          type: 'text', content: result.content, timestamp: new Date().toISOString()
        }) + '\n'));
        // Send done event
        controller.enqueue(encoder.encode(JSON.stringify({
          type: 'done', timestamp: new Date().toISOString()
        }) + '\n'));
        controller.close();
      }
    });

    return stream;
  } catch (err: any) {
    log.error(`${agentName}: relay error: ${err.message}`, err);
    return quickError(`Relay error: ${err.message}`);
  }
}

/**
 * Send a single message to an agent and wait for the complete reply.
 *
 * Convenience wrapper around {@link createChatStream} that reads the full
 * stream into memory and returns the final text reply and all events.
 * Automatically queues via the agent queue to prevent concurrent access
 * (unless already executing inside an agent queue context).
 *
 * @param agentName   - The agent to chat with.
 * @param userMessage - The user's message text.
 * @param groupName   - Optional group context for the conversation.
 * @param opts        - Options: `noMcp` disables MCP tool servers.
 * @returns An object with the complete `reply` text and the full `events` array.
 * @throws If the stream encounters an unrecoverable error.
 */
export async function chatOnce(agentName: string, userMessage: string, groupName?: string, opts?: { noMcp?: boolean }): Promise<{ reply: string; events: ChatEvent[] }> {
  // v0.8: Skip enqueueAgent if already inside one (prevent deadlock)
  const inAgentQueue = (global as any).__currentAgent === agentName;
  const doWork = async () => {
    const overrides = opts?.noMcp ? { mcpServers: undefined, permissionMode: 'bypassPermissions', allowedTools: [] } : undefined;
    const forceFresh = opts?.noMcp;
    const stream = await createChatStream(agentName, userMessage, groupName, undefined, overrides, forceFresh);
    // v0.7: Add overall timeout to prevent infinite hangs
    const MAX_CHAT_TIME = 60_000; // 60 seconds max per chat
    const MAX_EVENTS = 500;       // cap events array to prevent OOM
    const reader = stream.getReader();
    let reply = '';
    const events: ChatEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Chat timeout after ${MAX_CHAT_TIME}ms`)), MAX_CHAT_TIME);
    });
    const decoder = new TextDecoder();
    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // value may be Uint8Array (encoded JSON) or plain object
        let event: any = value;
        if (value instanceof Uint8Array) {
          try { event = JSON.parse(decoder.decode(value)); } catch { continue; }
        }
        // Cap events array to prevent memory explosion on long-running tool chains
        if (events.length < MAX_EVENTS) events.push(event);
        if (event.type === 'error') throw new Error(event.content || 'Unknown stream error');
        if (event.type === 'text') reply += event.content || '';
        if (event.type === 'done') break;
      }
    })();
    try {
      await Promise.race([readPromise, timeoutPromise]);
    } catch (e: any) {
      if (e.message?.includes('timeout')) {
        log.info(`${agentName}: ${e.message}`);
        reader.cancel().catch(() => {});
      } else { throw e; }
    } finally {
      // CRITICAL: clear the timeout timer to prevent memory leak
      // Without this, each chatOnce call leaks a timer that holds references
      // to the events array and fullReply string, eventually OOM-ing the worker.
      if (timer) clearTimeout(timer);
    }
    return { reply, events };
  };
  // v0.8: Skip enqueueAgent if already inside one (prevent deadlock)
  if (inAgentQueue) return doWork();
  return enqueueAgent(agentName, doWork);
}

function quickError(msg: string): ReadableStream<ChatEvent> {
  const ts = new Date().toISOString();
  return new ReadableStream({
    start(c) {
      c.enqueue({ type: 'error', content: msg, timestamp: ts } as ChatEvent);
      c.enqueue({ type: 'done', content: '', timestamp: ts } as ChatEvent);
      c.close();
    },
  });
}
