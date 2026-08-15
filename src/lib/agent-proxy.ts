/**
 * AgentProxy — unified agent representation in Next.js process.
 *
 * Consolidates ALL agent logic by composing module files:
 *   - agent-types.ts   (types & defaults)
 *   - agent-config.ts  (config load/save)
 *   - agent-state.ts   (state load/save)
 *   - agent-session.ts (session load/save/clear)
 *   - agent-task.ts    (task load/save/add/complete)
 *   - agent-email.ts   (email load/send/delete)
 *   - agent-skill.ts   (skill load/context)
 *   - agent-memory.ts  (memory CRUD/search)
 *
 * Each agent has one proxy instance with its own claude.exe process.
 * Use AgentRegistry to get/create proxies.
 */

import fs from 'fs';
import path from 'path';
import { AGENTS_DIR, GROUPS_DIR, MCP_DIR, MIND_DIR, default as DATA_DIR, getApiBase, getWsBase } from './data-dir';
import { agentCache } from './cache';
import { getEventBus, EventType, createEvent } from './event-bus';
import { randomUUID } from 'crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('agent-proxy');

import { getMemoryContext } from './memory';
import { loadGoalContext } from './cli-commands';

// ── Re-export types for backward compatibility ─────────────
export type {
  AgentStatus, AgentConfig, GroupState, AgentState,
  AgentActivity, AgentTask, ChatHistory, ChatEvent,
  ChatResult, Email, AgentSkill,
} from './agent-types';

// ── Module imports ─────────────────────────────────────────
import { DEFAULT_CONFIG, DEFAULT_STATE, DEFAULT_ACTIVITY } from './agent-types';
import type { AgentConfig, AgentState, AgentActivity, ChatHistory, ChatEvent, ChatResult, AgentTask, AgentStatus } from './agent-types';
import { loadAgentConfig, saveAgentConfig } from './agent-config';
import { loadAgentState, saveAgentState } from './agent-state';
import { loadSession, saveSession, clearSession } from './session-manager';
import { loadAgentTasks, saveAgentTasks, addAgentTask, completeAgentTask } from './agent-task';
import { loadAgentEmails, sendAgentEmail, deleteAgentEmail, parseEmailFile } from './agent-email';
import { loadAgentSkills, loadAgentSkillsContext } from './agent-skill';
import { readMemory, writeMemory, searchMemory, listMemory } from './memory';
import { AgentIdentity, getAgentIdentity } from './agent-identity';
import { scheduleFullIndex, scheduleSessionIndex } from './rag-indexer';

/** Minimal type for claude-agent-sdk streaming messages */
interface StreamingMessage {
  type: 'assistant' | 'result';
  content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown; tool_use_id?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ── AgentProxy class ──────────────────────────────────────

export class AgentProxy {
  readonly name: string;
  readonly identity: AgentIdentity;

  private _config: AgentConfig = { ...DEFAULT_CONFIG };
  private _state: AgentState = { ...DEFAULT_STATE, groups: {} };
  private _activity: AgentActivity = { ...DEFAULT_ACTIVITY };
  private _configLoaded = false;
  private _stateLoaded = false;

  // Session
  private _session: ChatHistory = { sessionId: null, messages: [], _version: 0 };
  private _sessionLoaded = false;

  // claude.exe process (lifecycle-bound)
  private _warmQuery: { close(): void } | null = null;
  private _processReady = false;
  private _processError: string | null = null;

  // Last error from swallowed catch blocks — callers can inspect
  private _lastError: string | null = null;

  get lastError(): string | null {
    return this._lastError;
  }

  clearLastError(): void {
    this._lastError = null;
  }

  // Token usage
  private _tokenUsage = { input: 0, output: 0 };

  constructor(name: string) {
    this.name = name;
    this.identity = getAgentIdentity(name);
  }

  // ── Config ────────────────────────────────────────────

  get config(): AgentConfig {
    return this._config;
  }

  async loadConfig(): Promise<AgentConfig> {
    if (this._configLoaded) return this._config;

    const cached = agentCache.get<AgentConfig>('config', this.name);
    if (cached) {
      this._config = cached;
      this._configLoaded = true;
      return this._config;
    }

    this._config = await loadAgentConfig(this.name);
    if (Object.keys(this._config).length > 0) {
      agentCache.set('config', this.name, this._config);
    }

    this._configLoaded = true;
    return this._config;
  }

  async saveConfig(): Promise<void> {
    await saveAgentConfig(this.name, this._config);
  }

  // ── State ─────────────────────────────────────────────

  get state(): AgentState {
    return this._state;
  }

  async loadState(): Promise<AgentState> {
    if (this._stateLoaded) return this._state;

    this._state = await loadAgentState(this.name);
    this._stateLoaded = true;
    return this._state;
  }

  async saveState(): Promise<void> {
    await saveAgentState(this.name, this._state);
  }

  /** Public setter for state — handles cache invalidation internally */
  setState(state: AgentState): void {
    this._state = state;
    this._stateLoaded = true;
  }

  // ── Activity ──────────────────────────────────────────

  get activity(): AgentActivity {
    return this._activity;
  }

  setStatus(status: AgentStatus, detail: string = ''): void {
    this._activity = { status, detail, updatedAt: Date.now() };
  }

  clearStatus(): void {
    this.setStatus('idle', '');
  }

  // ── Session (Chat History) ────────────────────────────

  get session(): ChatHistory {
    return this._session;
  }

  async loadSession(): Promise<ChatHistory> {
    if (this._sessionLoaded) return this._session;

    this._session = loadSession(this.name);
    this._sessionLoaded = true;
    return this._session;
  }

  async saveSession(expectedVersion?: number): Promise<void> {
    saveSession(this.name, this._session, expectedVersion);
  }

  clearSession(): void {
    this._session = { sessionId: null, messages: [], _version: 0 };
    this._sessionLoaded = true;
    clearSession(this.name);
  }

  // ── Tasks ─────────────────────────────────────────────

  private _tasks: AgentTask[] = [];

  async loadTasks(): Promise<AgentTask[]> {
    this._tasks = await loadAgentTasks(this.name);
    return this._tasks;
  }

  async saveTasks(): Promise<void> {
    await saveAgentTasks(this.name, this._tasks);
  }

  get tasks(): AgentTask[] {
    return this._tasks;
  }

  async addTask(task: AgentTask): Promise<void> {
    await addAgentTask(this.name, this._tasks, task);
  }

  async completeTask(runId: string, result: string): Promise<void> {
    await completeAgentTask(this.name, this._tasks, runId, result);
  }

  // ── Email ─────────────────────────────────────────────

  private _emails: import('./agent-types').Email[] = [];
  private _emailsLoaded = false;

  async getEmails(): Promise<import('./agent-types').Email[]> {
    if (this._emailsLoaded) return this._emails;

    this._emails = await loadAgentEmails(this.name);
    this._emailsLoaded = true;
    return this._emails;
  }

  private parseEmailFile(content: string, filename: string): import('./agent-types').Email | null {
    return parseEmailFile(content, filename);
  }

  async sendEmail(to: string, subject: string, body: string): Promise<boolean> {
    return sendAgentEmail(this.name, to, subject, body);
  }

  async deleteEmail(filename: string): Promise<boolean> {
    const result = await deleteAgentEmail(this.name, filename);
    if (result) this._emailsLoaded = false;
    return result;
  }

  // ── Token Usage ───────────────────────────────────────

  get tokenUsage(): { input: number; output: number } {
    return this._tokenUsage;
  }

  addTokenUsage(input: number, output: number): void {
    this._tokenUsage.input += input;
    this._tokenUsage.output += output;
  }

  // ── Skills ────────────────────────────────────────────

  private _skills: import('./agent-types').AgentSkill[] = [];
  private _skillsLoaded = false;

  async getSkills(): Promise<import('./agent-types').AgentSkill[]> {
    if (this._skillsLoaded) return this._skills;

    this._skills = await loadAgentSkills(this.name);
    this._skillsLoaded = true;
    return this._skills;
  }

  async loadSkillsContext(context?: string): Promise<string> {
    return loadAgentSkillsContext(this.name, context);
  }

  // ── Memory ────────────────────────────────────────────

  async getMemory(key: string): Promise<import('./memory').MemoryEntry | null> {
    return readMemory(this.name, key);
  }

  async saveMemory(key: string, value: string): Promise<import('./memory').MemoryEntry> {
    return writeMemory(this.name, key, value);
  }

  async searchMemory(query: string): Promise<import('./memory').MemoryEntry[]> {
    return searchMemory(this.name, query);
  }

  async listMemory(): Promise<import('./memory').MemoryEntry[]> {
    return listMemory(this.name);
  }

  // ── System Prompt Building ────────────────────────────

  buildIdentity(): string {
    const config = this._config;

    let identity = this.readClaudeMd();
    if (!identity) {
      const claudeMdAlt = path.join(AGENTS_DIR, this.name, '.claude', 'CLAUDE.md');
      try {
        if (fs.existsSync(claudeMdAlt)) identity = fs.readFileSync(claudeMdAlt, 'utf-8').trim();
      } catch (e) {
        log.error('buildIdentity: failed to read alt CLAUDE.md', e);
        this._lastError = `buildIdentity: failed to read alt CLAUDE.md: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (!identity) identity = `你是${this.name}，Mind Agency 团队成员。`;

    const behavior = config.behavior;
    const behaviorLines: string[] = [];
    if (behavior) {
      if (behavior.style) behaviorLines.push(`- 风格: ${behavior.style}`);
      if (behavior.focus?.length) behaviorLines.push(`- 重点领域: ${behavior.focus.join(', ')}`);
      if (behavior.avoidTopics?.length) behaviorLines.push(`- 避免: ${behavior.avoidTopics.join(', ')}`);
    }
    if (behaviorLines.length > 0) identity += '\n\n【行为偏好】\n' + behaviorLines.join('\n');

    identity += `\n\n【能力边界 — L1·L2·L3】
L1-你的领域: 自己的 chat session、.todo、email 收件箱（只看+删）、.mind 记忆。可自由操作。
L2-协议交互: 跟别人沟通用 group_send/group_read/email（写到对方 Agents/<name>/email/）。不要直接写其他 Agent 的文件。
L3-不可碰: 别人的 config.json、chat session、.todo。不要替别人发言。
违反 L2/L3 会破坏团队信任。

【工具速查】
你可以使用以下MCP工具：
- group_send: 向群组发消息
- group_read: 读取群组消息
- email_send: 发送邮件
- workflow_callback: 报告工作流步骤完成结果
- task: 报告任务进度
- learning_query: 查询团队学习记录

文件系统工具（备用）：
- Read/Write/Edit: 文件读写
- Bash: 执行命令

完成工作流任务后，请用 workflow_callback 工具报告结果：
workflow_callback(runId="...", stepId="...", status="COMPLETED", summary="结果摘要", details="详细说明")
始终用中文回复。`;

    return identity;
  }

  readClaudeMd(): string {
    try {
      const file = path.join(AGENTS_DIR, this.name, 'CLAUDE.md');
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8').trim();
    } catch (e) {
      log.error('readClaudeMd: failed to read CLAUDE.md', e);
      this._lastError = `readClaudeMd: failed to read CLAUDE.md: ${e instanceof Error ? e.message : String(e)}`;
    }
    return '';
  }

  getGroupMembership(): string {
    const groups: string[] = [];
    if (fs.existsSync(GROUPS_DIR)) {
      for (const g of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
        if (!g.isDirectory() || g.name.startsWith('.')) continue;
        const agDir = path.join(GROUPS_DIR, g.name, 'Agents');
        if (!fs.existsSync(agDir)) continue;
        if (fs.readdirSync(agDir, { withFileTypes: true }).some(
          e => e.isDirectory() && e.name.toLowerCase() === this.name.toLowerCase()
        )) {
          groups.push(g.name);
        }
      }
    }
    return groups.length > 0 ? `\n你所在的群组: ${groups.join(', ')}` : '';
  }

  buildGroupChatContext(groupName?: string): string {
    if (!groupName) return '';

    const chatDir = path.join(GROUPS_DIR, groupName, 'chat');
    if (!fs.existsSync(chatDir)) {
      return `\n群聊${groupName}:暂无消息,用group_send发言.`;
    }

    try {
      const files = fs.readdirSync(chatDir).filter(f => f.endsWith('.md')).sort();
      if (files.length === 0) {
        return `\n群聊${groupName}:暂无消息,用group_send发言.`;
      }

      const recentFiles = files.slice(-10);
      const msgs: string[] = [];
      for (const f of recentFiles) {
        try {
          const raw = fs.readFileSync(path.join(chatDir, f), 'utf-8');
          const truncated = raw.length > 1500 ? raw.slice(-1500) : raw;
          msgs.push(`[${f.replace('.md', '')}]\n${truncated}`);
        } catch (e) {
          log.error(`buildGroupChatContext: failed to read ${f}`, e);
          this._lastError = `buildGroupChatContext: failed to read ${f}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return `\n群聊${groupName}最近消息:\n${msgs.join('\n---\n')}`;
    } catch (e) {
      this._lastError = `buildGroupChatContext: outer read failed: ${e instanceof Error ? e.message : String(e)}`;
      return `\n群聊${groupName}:读取失败.`;
    }
  }

  buildMcpConfig(): Record<string, unknown> {
    const isWin = process.platform === 'win32';
    const electronExe = process.env.MIND_ELECTRON_EXE;
    const envBase: Record<string, string> = {
      MIND_DATA_DIR: DATA_DIR, MIND_API_URL: getApiBase(),
      WS_BASE_URL: getWsBase(),
    };

    const bundledPath = path.resolve(MCP_DIR, 'group-server.mjs');
    const sourcePath = path.resolve(MCP_DIR, 'group-server.ts');
    const serverPath = fs.existsSync(bundledPath) ? bundledPath : sourcePath;
    const useTsx = serverPath.endsWith('.ts');

    if (electronExe) {
      return { 'group-chat': { command: electronExe, args: [serverPath, this.name], cwd: DATA_DIR, env: { ELECTRON_RUN_AS_NODE: '1', ...envBase } } };
    }

    if (isWin) {
      if (useTsx) {
        return { 'group-chat': { command: 'cmd.exe', args: ['/c', 'npx.cmd', 'tsx', serverPath, this.name], env: { ...envBase, PATH: process.env.PATH } } };
      }
      return { 'group-chat': { command: 'node', args: [serverPath, this.name], env: envBase } };
    }

    if (useTsx) {
      return { 'group-chat': { command: 'npx', args: ['tsx', serverPath, this.name], cwd: DATA_DIR, env: envBase } };
    }
    return { 'group-chat': { command: 'node', args: [serverPath, this.name], cwd: DATA_DIR, env: envBase } };
  }

  buildSystemPrompt(groupName?: string): string {
    const memCtx = getMemoryContext(this.name);
    const goalsCtx = loadGoalContext(this.name);
    const groupCtx = this.buildGroupChatContext(groupName);

    let prompt = this.buildIdentity();
    prompt += '\n' + this.getGroupMembership();
    if (memCtx) prompt += '\n' + memCtx;
    if (goalsCtx) prompt += '\n\n---\n\n' + goalsCtx;
    if (groupCtx) prompt += groupCtx;

    return prompt;
  }

  // ── Chat (via claude.exe) ──────────────────────────────

  /** Parse streaming messages into reply + events */
  private parseChatEvents(messages: AsyncIterable<StreamingMessage>): Promise<{ reply: string; events: ChatEvent[]; inputTokens: number; outputTokens: number }> {
    return (async () => {
      let reply = '';
      const events: ChatEvent[] = [];
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const msg of messages) {
        if (msg.type === 'assistant') {
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text') {
                reply += block.text || '';
                events.push({ type: 'text', content: block.text, timestamp: new Date().toISOString() });
              } else if (block.type === 'tool_use') {
                events.push({ type: 'tool_use', content: block.name, toolName: block.name, toolInput: JSON.stringify(block.input, null, 2), timestamp: new Date().toISOString() });
              } else if (block.type === 'tool_result') {
                const resultContent = typeof block.content === 'string' ? block.content : '';
                events.push({ type: 'tool_result', content: resultContent, toolName: block.tool_use_id, toolOutput: resultContent.slice(0, 500), timestamp: new Date().toISOString() });
              }
            }
          } else if (typeof msg.content === 'string') {
            reply += msg.content;
            events.push({ type: 'text', content: msg.content, timestamp: new Date().toISOString() });
          }
        } else if (msg.type === 'result') {
          if (msg.usage) { inputTokens = msg.usage.input_tokens || 0; outputTokens = msg.usage.output_tokens || 0; }
          events.push({ type: 'done', timestamp: new Date().toISOString() });
        }
      }
      return { reply, events, inputTokens, outputTokens };
    })();
  }

  /** Append messages to session, truncate to 100, save */
  private async persistChat(userMessage: string, reply: string, events: ChatEvent[], inputTokens: number, outputTokens: number): Promise<void> {
    this._session.messages.push(
      { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
      { role: 'assistant', content: reply, events, timestamp: new Date().toISOString() }
    );
    if (this._session.messages.length > 100) {
      this._session.messages = this._session.messages.slice(-100);
    }
    await this.saveSession();
    this.addTokenUsage(inputTokens, outputTokens);
  }

  async chat(userMessage: string, groupName?: string): Promise<ChatResult> {
    this.setStatus('chatting', 'Processing...');

    try {
      await this.loadSession();
      await this.loadConfig();

      // Route through DeepSeek Harness(headless one-shot)
      const { runDshAgent } = await import('./dsh');

      // Build system prompt (agent identity + instructions + boundaries)
      const systemPrompt = this.buildSystemPrompt(groupName);
      const historyText = this._session.messages.slice(-20)
        .map((m: any) => `[${m.role}] ${m.content}`)
        .join('\n');
      const task = [
        systemPrompt,
        historyText ? `--- 对话历史 ---\n${historyText}` : '',
        `--- 本次任务 ---\n${userMessage}`,
      ].filter(Boolean).join('\n\n');

      const result = await runDshAgent({ task });
      if (!result.ok) {
        throw new Error(result.stderr || 'DSH agent execution failed');
      }

      // Persist to session
      this._session.messages.push(
        { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
        { role: 'assistant', content: result.reply, events: [], timestamp: new Date().toISOString() }
      );
      if (this._session.messages.length > 100) {
        this._session.messages = this._session.messages.slice(-100);
      }
      await this.saveSession();
      this.clearStatus();

      return {
        reply: result.reply,
        events: [],
        sessionId: this._session.sessionId || '',
        // DSH headless 暂不回传 token 用量(Phase B:解析 session 文件)
        tokenUsage: { input: 0, output: 0 },
      };
    } catch (err: unknown) {
      this.clearStatus();
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`${this.name}: chat error: ${msg}`, err);
      throw err;
    }
  }

  // ── claude.exe Process (lifecycle-bound) ──────────────

  async startProcess(): Promise<void> {
    if (this._processReady) return;
    if (this._processError) {
      log.info(`${this.name}: process previously failed: ${this._processError}`);
      return;
    }

    try {
      log.info(`${this.name}: starting claude.exe...`);

      // Load API settings from settings.json
      let apiKey = '';
      let baseUrl = '';
      try {
        const settingsPath = path.join(MIND_DIR, 'settings.json');
        if (fs.existsSync(settingsPath)) {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
          apiKey = settings.apiKey || '';
          baseUrl = settings.baseUrl || '';
        }
      } catch (e) {
        log.error('startProcess: failed to load API settings', e);
        this._lastError = `startProcess: failed to load API settings: ${e instanceof Error ? e.message : String(e)}`;
      }

      const opts: Record<string, unknown> = {
        cwd: path.join(AGENTS_DIR, this.name),
        systemPrompt: this.buildSystemPrompt(),
        mcpServers: this.buildMcpConfig(),
        permissionMode: this._config.permissionMode || 'bypassPermissions',
        allowedTools: this._config.allowedTools?.length ? this._config.allowedTools : ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
        ...(this._config.disallowedTools?.length ? { disallowedTools: this._config.disallowedTools } : {}),
      };

      if (this._config.model) {
        opts.model = this._config.model;
      } else {
        try {
          const settingsPath = path.join(MIND_DIR, 'settings.json');
          if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            if (settings.model) opts.model = settings.model;
          }
        } catch (e) {
          log.error('startProcess: failed to load model setting', e);
          this._lastError = `startProcess: failed to load model setting: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Set API configuration via env option
      // SDK's env option replaces subprocess env entirely
      opts.env = {
        ANTHROPIC_API_KEY: apiKey || '',
        ANTHROPIC_AUTH_TOKEN: apiKey || '',
        ANTHROPIC_BASE_URL: baseUrl || '',
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        TEMP: process.env.TEMP || '',
        TMP: process.env.TMP || '',
      };

      const sdkBin = process.env.CLAUDE_CODE_PATH
        || ['node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
            '../node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
            'resources/app/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe']
            .map(p => path.resolve(process.cwd(), p))
            .find(p => fs.existsSync(p));

      if (sdkBin) {
        opts.pathToClaudeCodeExecutable = sdkBin;
      }

      const { startup } = await import('@anthropic-ai/claude-agent-sdk');
      this._warmQuery = await startup({ options: opts });
      this._processReady = true;
      log.info(`${this.name}: claude.exe ready`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._processError = msg;
      log.error(`${this.name}: failed to start claude.exe: ${msg}`, err);
    }
  }

  stopProcess(): void {
    if (this._warmQuery) {
      try {
        this._warmQuery.close();
      } catch (e) {
        log.error('stopProcess: failed to close warm query', e);
        this._lastError = `stopProcess: failed to close warm query: ${e instanceof Error ? e.message : String(e)}`;
      }
      this._warmQuery = null;
      this._processReady = false;
      this._processError = null;
      log.info(`${this.name}: claude.exe stopped`);
    }
  }

  get isProcessReady(): boolean {
    return this._processReady;
  }

  // ── EventBus ──────────────────────────────────────────

  emitEvent(event: EventType, payload: Record<string, unknown>): void {
    try {
      const bus = getEventBus();
      bus.emit(createEvent(event, payload, this.name));
    } catch (e) {
      log.error(`emitEvent: failed to emit ${event}`, e);
      this._lastError = `emitEvent: failed to emit ${event}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  emitStatusChanged(status: string): void {
    this.emitEvent(EventType.AGENT_STATUS_CHANGED, {
      agent: this.name,
      status,
      since: Date.now(),
    });
  }

  // ── Cleanup ───────────────────────────────────────────

  invalidateCache(): void {
    agentCache.invalidateAgent(this.name);
    this._configLoaded = false;
    this._stateLoaded = false;
    this._sessionLoaded = false;
  }

  destroy(): void {
    this.stopProcess();
    this.invalidateCache();
  }

  exists(): boolean {
    return fs.existsSync(path.join(AGENTS_DIR, this.name));
  }
}
