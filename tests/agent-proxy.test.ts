/**
 * Agent Proxy Tests
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';

vi.mock('../src/lib/data-dir', () => ({
  AGENTS_DIR: path.join(__dirname, '.test-data', 'Agents'),
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  AUDIT_DIR: path.join(__dirname, '.test-data', '.audit'),
  GROUPS_DIR: path.join(__dirname, '.test-data', 'Groups'),
  MCP_DIR: path.join(__dirname, '..', 'mcp'),
  SRC_DIR: path.join(__dirname, '..', 'src'),
  DATA_DIR: path.join(__dirname, '.test-data'),
  getApiBase: () => 'http://127.0.0.1:3000',
  getWsBase: () => 'http://127.0.0.1:3001',
  default: path.join(__dirname, '.test-data'),
}));

vi.mock('../src/lib/atomic', () => ({
  atomicWrite: vi.fn((filePath: string, content: string) => {
    const fs = require('fs');
    const p = require('path');
    const dir = p.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
  }),
}));

vi.mock('../src/lib/rag-indexer', () => ({
  scheduleFullIndex: vi.fn().mockReturnValue('job-1'),
  scheduleSessionIndex: vi.fn().mockReturnValue('job-2'),
}));

import { AgentProxy } from '../src/lib/agent-proxy';

describe('AgentProxy', () => {
  it('should create proxy instance', () => {
    const proxy = new AgentProxy('test-proxy');
    expect(proxy).toBeDefined();
    expect(proxy.name).toBe('test-proxy');
  });

  it('should have identity', () => {
    const proxy = new AgentProxy('test-identity');
    expect(proxy.identity).toBeDefined();
    expect(proxy.identity.name).toBe('test-identity');
  });

  it('should build identity', () => {
    const proxy = new AgentProxy('test-build');
    const identity = proxy.buildIdentity();
    expect(typeof identity).toBe('string');
    expect(identity).toContain('test-build');
  });

  it('should read CLAUDE.md', () => {
    const proxy = new AgentProxy('test-claude');
    const content = proxy.readClaudeMd();
    expect(typeof content).toBe('string');
  });

  it('should get group membership', () => {
    const proxy = new AgentProxy('test-membership');
    const membership = proxy.getGroupMembership();
    expect(typeof membership).toBe('string');
  });

  it('should build group chat context', () => {
    const proxy = new AgentProxy('test-group');
    const context = proxy.buildGroupChatContext('test-group');
    expect(typeof context).toBe('string');
  });

  it('should build MCP config', () => {
    const proxy = new AgentProxy('test-mcp');
    const config = proxy.buildMcpConfig();
    expect(config).toHaveProperty('group-chat');
  });

  it('should build system prompt', () => {
    const proxy = new AgentProxy('test-prompt');
    const prompt = proxy.buildSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('should get activity', () => {
    const proxy = new AgentProxy('test-activity');
    expect(proxy.activity).toBeDefined();
  });

  it('should handle session operations', async () => {
    const proxy = new AgentProxy('test-session');
    await proxy.loadSession();
    expect(proxy.session).toBeDefined();
    expect(proxy.session.messages).toEqual([]);
  });
});
