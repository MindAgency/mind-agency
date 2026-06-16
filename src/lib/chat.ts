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
        console.log(`[chat] model changed: ${prev || '(none)'} → ${curr || '(none)'}`);
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
  if (old) { try { old.close(); } catch (e) { console.error('[lib:chat]', e); } }
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
        console.log(`[chat] ${agentName}/${filename} changed → cache invalidated`);
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
} catch (e) { console.error('[lib:chat]', e); }

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
} catch (e) { console.error('[lib:chat]', e); }

process.on('exit', () => {
  try { settingsWatcher?.close(); } catch (e) { console.error('[lib:chat]', e); }
  try { agentDirWatcher?.close(); } catch (e) { console.error('[lib:chat]', e); }
  for (const w of configWatchers.values()) try { w.close(); } catch (e) { console.error('[lib:chat]', e); }
  for (const t of watchDebounce.values()) clearTimeout(t);
});

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
      const existingKeys = new Set(merged.messages.map(m => `${m.role}:${m.content.slice(0, 50)}`));
      for (const msg of data.messages) {
        const key = `${msg.role}:${msg.content.slice(0, 50)}`;
        if (!existingKeys.has(key)) {
          merged.messages.push(msg);
        }
      }
      // Keep last 50 messages
      if (merged.messages.length > 50) merged.messages = merged.messages.slice(-50);
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
    console.error(`[chat] saveChatHistory failed for ${agentName}:`, err);
  }
}

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
    } catch (e) { console.error('[lib:chat]', e); }
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
  } catch (e) { console.error('[lib:chat]', e); }
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
    console.log(`[chat] savePartialState: ${agentName}, msgs=${ih.messages.length}, version=${ih._version}`);
    saveChatHistory(agentName, ih, expectedVersion);
    console.log(`[chat] savePartialState: ${agentName} saved successfully`);
  } catch (err) {
    console.error(`[chat] savePartialState failed for ${agentName}:`, err);
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
          allEvents.push(evt);
          ctrl.enqueue(evt);
          if (evt.type === 'text') { fullReply += evt.content || ''; }
        }
      } catch (err: any) {
        ctrl.enqueue({ type: 'error', content: err.message || String(err), timestamp: ts() });
      } finally {
        clearActivity(agentName);
        untrackQuery(abortController);
        ctrl.enqueue({ type: 'done', content: '', timestamp: ts() });
        ctrl.close();
      }
    },
  });
}

export async function createChatStream(agentName: string, userMessage: string, groupName?: string, modelOverride?: string, optsOverrides?: Record<string, unknown>, fresh?: boolean): Promise<ReadableStream<ChatEvent>> {
  const agentDir = path.join(AGENTS_DIR, agentName);
  if (!fs.existsSync(agentDir)) return quickError(`Agent "${agentName}" not found`);

  // ── Route ALL requests through relay (RAG + token billing) ──
  // Agent → Relay → RAG → AI Provider
  try {
    const { relay } = await import('./relay');

    // Build conversation context for relay
    const history = getChatHistory(agentName);
    let skillContext = '';
    try {
      skillContext = await getSkillProxy().loadSkillsContext(agentName, userMessage);
    } catch (e) { console.error('[lib:chat]', e); }
    const routedUserMessage = skillContext
      ? `${userMessage}\n\n---\n\n${skillContext}`
      : userMessage;
    const messages = [
      ...history.messages.slice(-20).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: routedUserMessage },
    ];

    const result = await relay({
      agent: agentName,
      messages,
      model: modelOverride,
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
    console.error(`[chat] ${agentName}: relay error:`, err.message);
    return quickError(`Relay error: ${err.message}`);
  }

  // Fallback: direct provider call (should not be reached)
  const agentConfig = loadAgentConfig(agentName);
  const providerName = (agentConfig?.provider as string) || 'claude-proxy';
  if (providerName !== 'claude') {
    const provider = getProvider(providerName);
    if (provider) {
      return createProviderStream(provider as AgentProvider, agentName, userMessage, groupName, modelOverride, agentConfig || null);
    }
  }

  // Build task context
  const baseOpts = buildBaseOptions(agentName);
  const groupChatCtx = buildGroupChatContext(agentName, groupName);
  const goalsCtx = loadGoalContext(agentName);

  // Skills: RAG uses full accumulated context
  let skillsCtx = '';
  try {
    // Delegate to AgentProxy for skill context loading
    const agency = await import('./agency').then(m => m.getAgency());
    const agentProxy = agency.getAgent(agentName);
    // Build RAG context: full conversation history + user message
    const history = getChatHistory(agentName);
    const fullContext = history.messages
      .map(m => `[${m.role}] ${m.content.slice(0, 300)}`)
      .join('\n');
    const ragContext = fullContext ? fullContext + '\n[user] ' + userMessage : userMessage;
    skillsCtx = await agentProxy.loadSkillsContext(ragContext);
  } catch (e) { console.error('[lib:chat]', e); }

  const fullPrompt = groupChatCtx
    ? groupChatCtx + (goalsCtx ? '\n' + goalsCtx : '') + '\n\n---\n\n' + userMessage + (skillsCtx ? '\n\n' + skillsCtx : '')
    : (goalsCtx ? goalsCtx + '\n\n---\n\n' : '') + userMessage + (skillsCtx ? '\n\n' + skillsCtx : '');
  const ts = () => new Date().toISOString();

  return new ReadableStream<ChatEvent>({
    async start(ctrl) {
      // Register in-memory active stream — frontend re-mounts can read via GET /api/.../chat
      const allEvents: ChatEvent[] = [];
      let fullReply = '';
      let sessionId = '';
      let hasContent = false;
      let incrementalSaveCounter = 0;
      // ── Activity tracking — visible in sidebar ──
      setActivity(agentName, 'chatting', '对话中');
      // ── Process tracking — enables clean shutdown ──
      // Declared before try so it's accessible in both try and catch blocks.
      const abortController = trackQuery();

      try {
        // In Electron, tell the SDK to use our Electron binary as the Node.js runtime.
        // SDK executes: <node> <claude-code-entry> --output-format stream-json ...
        const electronExe = process.env.MIND_ELECTRON_EXE;
        const opts: any = { ...baseOpts, abortController };
        if (!fresh) opts.continue = true;
        if (modelOverride) opts.model = modelOverride;
        if (electronExe) {
          (opts as any).executable = electronExe;
          process.env.ELECTRON_RUN_AS_NODE = '1';
        }

        // Apply CLI command overrides (from /plan, etc.)
        if (optsOverrides) {
          for (const [k, v] of Object.entries(optsOverrides)) {
            opts[k] = v;
          }
          if (optsOverrides.permissionMode === 'plan') {
            console.log(`[chat] plan mode: ${optsOverrides.planModeInstructions || '(no topic)'}`);
          }
          // v0.7: Debug log for MCP disable
          if (optsOverrides.mcpServers && Object.keys(optsOverrides.mcpServers).length === 0) {
            console.log(`[chat] ${agentName}: MCP tools disabled`);
          }
        }

        // SDK binary path: use dynamic path resolution instead of require.resolve()
        // (require.resolve would make webpack try to bundle the .exe binary.)
        const sdkBin = process.env.CLAUDE_CODE_PATH
          || ['node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
              '../node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
              'resources/app/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe']
              .map(p => path.resolve(process.cwd(), p))
              .find(p => fs.existsSync(p));
        if (sdkBin) {
          opts.pathToClaudeCodeExecutable = sdkBin;
          console.log('[chat] SDK binary:', sdkBin);
        } else {
          console.warn('[chat] SDK binary not found — SDK will use its own resolution');
        }

        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const messages = query({ prompt: fullPrompt, options: opts });

        // Save user message immediately — visible even before first response chunk
        try { savePartialState(agentName, { userMessage, fullReply, allEvents, sessionId }); } catch (e) { console.error('[lib:chat]', e); }

        // v0.4: Timeout protection — if SDK hangs, show error after 30s
        let firstChunk = false;
        const timeout = setTimeout(() => {
          if (!firstChunk) {
            ctrl.enqueue({ type: 'error', content: 'Claude SDK 超时（30s 无响应）。请检查：1) API Key 是否配置 2) 网络是否正常 3) API 地址是否正确', timestamp: ts() });
            ctrl.enqueue({ type: 'done', content: '', timestamp: ts() });
            ctrl.close();
          }
        }, 30_000);

        for await (const msg of messages) {
          if (!firstChunk) { firstChunk = true; clearTimeout(timeout); }
          if ('session_id' in msg && !sessionId) sessionId = (msg as any).session_id;

          if (isAssistantMsg(msg)) {
            for (const block of msg.message?.content || []) {
              if (isThinkingBlock(block) && block.thinking) {
                allEvents.push({ type: 'thinking', content: block.thinking, timestamp: ts() });
                ctrl.enqueue(allEvents[allEvents.length - 1]);
                // Save during thinking phase too — user can leave and come back
                if (allEvents.filter(e => e.type === 'thinking').length % 3 === 0 && sessionId) {
                  try { savePartialState(agentName, { userMessage, fullReply, allEvents, sessionId }); } catch (e) { console.error('[lib:chat]', e); }
                }
              } else if (isToolUseBlock(block)) {
                allEvents.push({ type: 'tool_use', content: block.name, toolName: block.name, toolInput: JSON.stringify(block.input || {}, null, 2), timestamp: ts() });
                ctrl.enqueue(allEvents[allEvents.length - 1]);
                // v0.4: Save session on every tool call (prevents data loss on page switch)
                if (sessionId) { try { savePartialState(agentName, { userMessage, fullReply, allEvents, sessionId }); } catch (e) { console.error('[lib:chat]', e); } }
                // Audit log for file operations
                const input = block.input as Record<string, any> | undefined;
                const filePath = input?.file_path || input?.path || '';
                if (block.name === 'Write' || block.name === 'Edit' || block.name === 'Delete' || block.name === 'Rename') {
                  try { writeAudit({ agent: agentName, action: `file.${block.name.toLowerCase()}`, resource: filePath || 'unknown', details: block.name === 'Write' ? (input?.content || '').slice(0, 100) : '' }); } catch (e) { console.error('[lib:chat]', e); }
                } else if (block.name === 'Bash') {
                  try { writeAudit({ agent: agentName, action: 'file.bash', resource: '', details: (input?.command || '').slice(0, 120) }); } catch (e) { console.error('[lib:chat]', e); }
                }
              } else if (isTextBlock(block) && block.text) {
                fullReply += block.text; hasContent = true;
                allEvents.push({ type: 'text', content: block.text, timestamp: ts() });
                ctrl.enqueue(allEvents[allEvents.length - 1]);

                // ── Incremental save: every 8 text chunks, persist partial state ──
                // Allows users to navigate away and come back to see partial results.
                incrementalSaveCounter++;
                if (incrementalSaveCounter % 8 === 0 && sessionId) {
                  try { savePartialState(agentName, { userMessage, fullReply, allEvents, sessionId }); } catch (e) { console.error('[lib:chat]', e); }
                }
              }
            }
          }
          if (isUserMsg(msg)) {
            for (const block of msg.message?.content || []) {
              if (isToolResultBlock(block)) {
                const out = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
                allEvents.push({ type: 'tool_result', content: out.slice(0, 3000), toolOutput: out.slice(0, 3000), timestamp: ts() });
                ctrl.enqueue(allEvents[allEvents.length - 1]);
              }
            }
          }
          if (isResultSuccess(msg)) {
            if (msg.is_error && !hasContent) {
              ctrl.enqueue({ type: 'error', content: 'Execution error', timestamp: ts() });
            }
            // Record token usage (fire-and-forget via raw http — don't block stream)
            const usage = getTokenUsage(msg);
            if (usage) {
              const tokensIn = usage.input_tokens;
              const tokensOut = usage.output_tokens;
              const model = usage.modelUsage ? Object.keys(usage.modelUsage)[0] || 'unknown' : 'unknown';
              // DeepSeek pricing (CNY per 1M tokens), cache-miss by default
              // V4-Pro: input ¥3.00, output ¥6.00 | V4-Flash: input ¥1.00, output ¥2.00
              const isDS = /deepseek/i.test(model);
              const isFlash = isDS && /flash|chat/i.test(model) && !/pro/i.test(model);
              // Claude pricing fallback (CNY, ~7.2 rate):
              // Opus:  $15/$75 → ¥108/540 | Sonnet: $3/$15 → ¥21.6/108 | Haiku: $0.25/$1.25 → ¥1.8/9
              const isClaude = /claude/i.test(model);
              const isOpus = isClaude && /opus/i.test(model);
              const isSonnet = isClaude && /sonnet/i.test(model);
              const cost = isDS
                ? (tokensIn * (isFlash ? 1.0 : 3.0) + tokensOut * (isFlash ? 2.0 : 6.0)) / 1_000_000
                : Number(msg.total_cost_usd) || (isOpus ? (tokensIn * 108 + tokensOut * 540) / 1_000_000
                    : isSonnet ? (tokensIn * 21.6 + tokensOut * 108) / 1_000_000
                    : isClaude ? (tokensIn * 3.6 + tokensOut * 18) / 1_000_000
                    : 0);
              const payload = JSON.stringify({
                agent: agentName,
                tokensIn,
                tokensOut,
                cost,
                model,
              });
              try {
                const apiPort = parseInt(process.env.PORT || '3000', 10);
                const req = http.request({ hostname: '127.0.0.1', port: apiPort, path: '/api/system/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res: any) => res.resume());
                req.on('error', () => {});
                req.write(payload);
                req.end();
              } catch (e) { console.error('[lib:chat]', e); }
            }
          }
        }

        // ── Final save: persist final state ──
        clearTimeout(timeout);
        savePartialState(agentName, { userMessage, fullReply, allEvents, sessionId });
        ctrl.enqueue({ type: 'done', content: '', timestamp: ts() });
        clearActivity(agentName);
        untrackQuery(abortController);

      } catch (err: any) {
        clearActivity(agentName);
        untrackQuery(abortController);
        // v0.6: Always save session on error — prevents message loss
        try { savePartialState(agentName, { userMessage, fullReply, allEvents, sessionId }); } catch (e) { console.error('[lib:chat]', e); }
        ctrl.enqueue({ type: 'error', content: err.message || String(err), timestamp: ts() });
        ctrl.enqueue({ type: 'done', content: '', timestamp: ts() });
      }
      ctrl.close();
    },
  });
}

export async function chatOnce(agentName: string, userMessage: string, groupName?: string, opts?: { noMcp?: boolean }): Promise<{ reply: string; events: ChatEvent[] }> {
  // v0.8: Skip enqueueAgent if already inside one (prevent deadlock)
  const inAgentQueue = (global as any).__currentAgent === agentName;
  const doWork = async () => {
    const overrides = opts?.noMcp ? { mcpServers: undefined, permissionMode: 'bypassPermissions', allowedTools: [] } : undefined;
    const forceFresh = opts?.noMcp;
    const stream = await createChatStream(agentName, userMessage, groupName, undefined, overrides, forceFresh);
    // v0.7: Add overall timeout to prevent infinite hangs
    const MAX_CHAT_TIME = 60_000; // 60 seconds max per chat
    const reader = stream.getReader();
    let reply = '';
    const events: ChatEvent[] = [];
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Chat timeout after ${MAX_CHAT_TIME}ms`)), MAX_CHAT_TIME);
    });
    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(value);
        if (value.type === 'text') reply += value.content || '';
        if (value.type === 'done') break;
      }
    })();
    try {
      await Promise.race([readPromise, timeoutPromise]);
    } catch (e: any) {
      if (e.message?.includes('timeout')) {
        console.log(`[chat] ${agentName}: ${e.message}`);
        reader.cancel().catch(() => {});
      } else { throw e; }
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
    start(c) { c.enqueue({ type: 'error', content: msg, timestamp: ts }); c.enqueue({ type: 'done', content: '', timestamp: ts }); c.close(); },
  });
}
