/**
 * Claude Proxy Provider — Direct API calls with RAG injection.
 *
 * Bypasses the SDK's query() to intercept tool_use blocks.
 * Executes tools locally, injects RAG after each tool result.
 *
 * Opt-in via agent config.json: { "provider": "claude-proxy" }
 */

import type { AgentProvider, SpawnOptions } from './index';
import { registerProvider } from './index';
import type { ChatEvent } from '../chat';
import { loadSkillsContext } from '../skills';
import { getApiKey, getBaseUrl, getModel } from '../api-settings';
import fs from 'fs';
import path from 'path';

// ── Anthropic API types ──────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | AnthropicContentBlock[];
  tool_use_id?: string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ── Built-in tool definitions ────────────────────────────

const BUILTIN_TOOLS: AnthropicTool[] = [
  {
    name: 'Read',
    description: 'Read a file from the filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Line offset to start reading from' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file, creating it if it doesn\'t exist.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Edit a file by replacing old_string with new_string.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        old_string: { type: 'string', description: 'Text to find and replace' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a bash command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Bash command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. **/*.ts)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search for a regex pattern in files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in' },
      },
      required: ['pattern'],
    },
  },
];

// ── Tool executor ────────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  agentName: string,
  workingDir: string,
): Promise<{ content: string; isError: boolean }> {
  try {
    switch (name) {
      case 'Read': {
        const filePath = input.file_path as string;
        const offset = (input.offset as number) || 0;
        const limit = (input.limit as number) || 2000;
        const content = require('fs').readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const sliced = lines.slice(offset, offset + limit);
        return { content: sliced.join('\n'), isError: false };
      }
      case 'Write': {
        const filePath = input.file_path as string;
        const content = input.content as string;
        require('fs').mkdirSync(require('path').dirname(filePath), { recursive: true });
        require('fs').writeFileSync(filePath, content, 'utf-8');
        return { content: `File written: ${filePath}`, isError: false };
      }
      case 'Edit': {
        const filePath = input.file_path as string;
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const fs = require('fs');
        let content = fs.readFileSync(filePath, 'utf-8');
        if (!content.includes(oldStr)) {
          return { content: `old_string not found in ${filePath}`, isError: true };
        }
        content = content.replace(oldStr, newStr);
        fs.writeFileSync(filePath, content, 'utf-8');
        return { content: `File edited: ${filePath}`, isError: false };
      }
      case 'Bash': {
        const command = input.command as string;
        const { execSync } = require('child_process');
        const output = execSync(command, { cwd: workingDir, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        return { content: output || '(no output)', isError: false };
      }
      case 'Glob': {
        const pattern = input.pattern as string;
        const { execSync } = require('child_process');
        const output = execSync(`find . -name "${pattern}" -type f 2>/dev/null | head -50`, { cwd: workingDir, encoding: 'utf-8' });
        return { content: output || '(no matches)', isError: false };
      }
      case 'Grep': {
        const pattern = input.pattern as string;
        const searchPath = (input.path as string) || '.';
        const { execSync } = require('child_process');
        const output = execSync(`grep -rn "${pattern}" "${searchPath}" 2>/dev/null | head -50`, { cwd: workingDir, encoding: 'utf-8' });
        return { content: output || '(no matches)', isError: false };
      }
      default: {
        // v1.2: Handle MCP tools by importing and calling handlers directly
        try {
          const { handleGroupTool } = await import('../../../mcp/tools/group');
          const { handleCommunicationTool } = await import('../../../mcp/tools/communication');
          const { handleWorkflowTool } = await import('../../../mcp/tools/workflow');
          const { handleAgentTool } = await import('../../../mcp/tools/agent');
          const { handleConsensusTool } = await import('../../../mcp/tools/consensus');
          const { handleMemoryTool } = await import('../../../mcp/tools/memory');
          const { handleTaskTool } = await import('../../../mcp/tools/task');
          const { handleEconomyTool } = await import('../../../mcp/tools/economy');
          const { handleSearchTool } = await import('../../../mcp/tools/search');
          const { handleHierarchyTool } = await import('../../../mcp/tools/hierarchy');
          const { handleManagedTool } = await import('../../../mcp/tools/managed');

          let result = '';
          const respond = (_id: string, msg: any) => {
            result = msg?.content?.[0]?.text || JSON.stringify(msg);
          };

          const handlers = [handleGroupTool, handleCommunicationTool, handleWorkflowTool, handleAgentTool, handleConsensusTool, handleMemoryTool, handleTaskTool, handleEconomyTool, handleSearchTool, handleHierarchyTool, handleManagedTool];
          let handled = false;
          for (const handler of handlers) {
            try {
              if (await handler(name, input, agentName, respond, 'tool-call')) {
                handled = true;
                break;
              }
            } catch (handlerErr: any) {
              // Handler threw — try next
            }
          }

          if (handled && result) return { content: result, isError: false };
          if (handled) return { content: 'Tool executed (no output)', isError: false };
          return { content: `Unknown tool: ${name}`, isError: true };
        } catch (e: any) {
          return { content: `MCP tool error: ${e.message}`, isError: true };
        }
      }
    }
  } catch (e: any) {
    return { content: `Error: ${e.message}`, isError: true };
  }
}

// ── RAG skip list ────────────────────────────────────────

const RAG_SKIP_TOOLS = new Set([
  'group_send', 'email_send', 'group_leave', 'group_delete',
  'agent_memory', 'agent_create', 'agent_delete',
  'workflow_create', 'workflow_trigger', 'workflow_cancel',
]);

// ── API client ───────────────────────────────────────────

async function* streamMessages(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  signal?: AbortSignal;
}): AsyncGenerator<{ type: string; content?: string; thinking?: string; tool_use?: any; tool_result?: any; stop_reason?: string }> {
  const { apiKey, baseUrl, model, system, messages, tools, signal } = params;

  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const body = JSON.stringify({
    model,
    max_tokens: 8192,
    system,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    stream: true,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Accumulators for streaming blocks
  let currentBlock: any = null;
  let stopReason = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_start') {
            currentBlock = { ...event.content_block };
          } else if (event.type === 'content_block_delta') {
            if (currentBlock?.type === 'text') {
              currentBlock.text = (currentBlock.text || '') + event.delta.text;
              yield { type: 'text', content: event.delta.text };
            } else if (currentBlock?.type === 'thinking') {
              currentBlock.thinking = (currentBlock.thinking || '') + event.delta.thinking;
              yield { type: 'thinking', thinking: event.delta.thinking };
            } else if (currentBlock?.type === 'tool_use') {
              currentBlock.input = JSON.parse((currentBlock._inputJson || '') + (event.delta.partial_json || ''));
              currentBlock._inputJson = (currentBlock._inputJson || '') + (event.delta.partial_json || '');
            }
          } else if (event.type === 'content_block_stop') {
            if (currentBlock?.type === 'tool_use') {
              yield { type: 'tool_use', tool_use: currentBlock };
            }
            currentBlock = null;
          } else if (event.type === 'message_delta') {
            stopReason = event.delta?.stop_reason || '';
            if (event.usage) {
              yield { type: 'usage', content: JSON.stringify(event.usage) } as any;
            }
          } else if (event.type === 'message_start' && event.message?.usage) {
            yield { type: 'usage', content: JSON.stringify(event.message.usage) } as any;
          }
        } catch (e) { console.error('[lib:providers:claude-proxy]', e); }
      }
    }
  }

  yield { type: 'done', stop_reason: stopReason };
}

// ── Provider ─────────────────────────────────────────────

class ClaudeProxyProvider implements AgentProvider {
  name = 'claude-proxy';
  displayName = 'Claude Proxy (RAG-enabled)';

  isAvailable(): boolean {
    return !!(getApiKey() || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  }

  getDefaultModel(): string {
    return getModel();
  }

  async *execute(spawnOpts: SpawnOptions): AsyncGenerator<ChatEvent> {
    const apiKey = getApiKey(spawnOpts.config);
    const baseUrl = getBaseUrl(spawnOpts.config);
    const model = spawnOpts.config?.model || this.getDefaultModel();
    const system = spawnOpts.systemPrompt || '';
    const workingDir: string = (spawnOpts.config?.cwd as string) || process.cwd();

    // Collect tool definitions from MCP tools
    const mcpTools = await this.getMcpTools();

    // Build initial messages
    const messages: AnthropicMessage[] = [
      { role: 'user', content: spawnOpts.prompt },
    ];

    // Agentic loop
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000); // 5min total
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    try {
      while (true) {
        let stopReason = '';
        const assistantContent: AnthropicContentBlock[] = [];
        const toolUseBlocks: AnthropicContentBlock[] = [];

        // Call API
        for await (const event of streamMessages({
          apiKey, baseUrl, model, system, messages,
          tools: [...BUILTIN_TOOLS, ...mcpTools],
          signal: controller.signal,
        })) {
          if (event.type === 'text') {
            yield { type: 'text', content: event.content || '', timestamp: new Date().toISOString() };
            assistantContent.push({ type: 'text', text: event.content });
          } else if (event.type === 'thinking') {
            yield { type: 'thinking', content: event.thinking || '', timestamp: new Date().toISOString() };
            assistantContent.push({ type: 'thinking', thinking: event.thinking });
          } else if (event.type === 'tool_use') {
            yield { type: 'tool_use', content: event.tool_use.name, toolName: event.tool_use.name, toolInput: JSON.stringify(event.tool_use.input || {}, null, 2), timestamp: new Date().toISOString() };
            assistantContent.push(event.tool_use);
            toolUseBlocks.push(event.tool_use);
          } else if (event.type === 'usage') {
            try {
              const usage = JSON.parse(event.content || '{}');
              totalInputTokens += usage.input_tokens || 0;
              totalOutputTokens += usage.output_tokens || 0;
            } catch (e) { console.error('[lib:providers:claude-proxy]', e); }
          } else if (event.type === 'done') {
            stopReason = event.stop_reason || '';
          }
        }

        // No tool calls → done
        if (stopReason !== 'tool_use' || toolUseBlocks.length === 0) break;

        // Execute each tool and build tool_result blocks
        const toolResults: AnthropicContentBlock[] = [];
        for (const toolUse of toolUseBlocks) {
          const toolName = toolUse.name || 'unknown';
          const toolInput = (toolUse.input || {}) as Record<string, unknown>;
          const result = await executeTool(toolName, toolInput, spawnOpts.agentName, workingDir);

          // RAG injection (skip for certain tools)
          let ragContext = '';
          if (!RAG_SKIP_TOOLS.has(toolName)) {
            try {
              ragContext = await loadSkillsContext(spawnOpts.agentName, result.content);
            } catch (e) { console.error('[lib:providers:claude-proxy]', e); }
          }

          const content = ragContext ? `${result.content}\n\n${ragContext}` : result.content;

          yield { type: 'tool_result', content, toolName, toolOutput: content.slice(0, 500), timestamp: new Date().toISOString() };

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id || '',
            content,
          });
        }

        // Append to messages
        messages.push({ role: 'assistant', content: assistantContent });
        messages.push({ role: 'user', content: toolResults });
      }

      // Report total usage
      yield {
        type: 'usage' as any,
        content: JSON.stringify({
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          model,
        }),
      } as any;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getMcpTools(): Promise<AnthropicTool[]> {
    const tools: AnthropicTool[] = [];
    try {
      const { groupTools } = await import('../../../mcp/tools/group');
      const { communicationTools } = await import('../../../mcp/tools/communication');
      const { workflowTools } = await import('../../../mcp/tools/workflow');
      const { agentTools } = await import('../../../mcp/tools/agent');
      const { consensusTools } = await import('../../../mcp/tools/consensus');
      const { memoryTools } = await import('../../../mcp/tools/memory');
      const { taskTools } = await import('../../../mcp/tools/task');
      const { searchTools } = await import('../../../mcp/tools/search');
      const { hierarchyTools } = await import('../../../mcp/tools/hierarchy');
      const { managedTools } = await import('../../../mcp/tools/managed');

      for (const toolFn of [groupTools, communicationTools, workflowTools, agentTools, consensusTools, memoryTools, taskTools, searchTools, hierarchyTools, managedTools]) {
        const defs = toolFn();
        for (const d of defs) {
          tools.push({
            name: d.name,
            description: d.description,
            input_schema: d.inputSchema,
          });
        }
      }
    } catch (e) {
      console.warn('[claude-proxy] Failed to load MCP tools:', e);
    }
    return tools;
  }
}

registerProvider(new ClaudeProxyProvider());
