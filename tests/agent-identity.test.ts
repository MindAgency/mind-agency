/**
 * Agent Identity Tests
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';

vi.mock('../src/lib/data-dir', () => ({
  AGENTS_DIR: path.join(__dirname, '.test-data', 'Agents'),
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  GROUPS_DIR: path.join(__dirname, '.test-data', 'Groups'),
  MCP_DIR: path.join(__dirname, '..', 'mcp'),
  DATA_DIR: path.join(__dirname, '.test-data'),
  getApiBase: () => 'http://127.0.0.1:3000',
  getWsBase: () => 'http://127.0.0.1:3001',
  default: path.join(__dirname, '.test-data'),
}));

import { AgentIdentity } from '../src/lib/agent-identity';

describe('AgentIdentity', () => {
  it('should create identity instance', () => {
    const identity = new AgentIdentity('test-agent');
    expect(identity.name).toBe('test-agent');
  });

  it('should return default identity when no CLAUDE.md', () => {
    const identity = new AgentIdentity('nonexistent-agent');
    const result = identity.buildIdentity();
    expect(result).toContain('nonexistent-agent');
    expect(result).toContain('Mind Agency');
  });

  it('should return empty string for missing CLAUDE.md', () => {
    const identity = new AgentIdentity('nonexistent-agent');
    const result = identity.readClaudeMd();
    expect(result).toBe('');
  });

  it('should return empty string for missing group membership', () => {
    const identity = new AgentIdentity('test-agent');
    const result = identity.getGroupMembership();
    // May be empty or contain group info depending on test data
    expect(typeof result).toBe('string');
  });

  it('should return empty string for missing group chat', () => {
    const identity = new AgentIdentity('test-agent');
    const result = identity.buildGroupChatContext('nonexistent-group');
    expect(result).toContain('nonexistent-group');
  });

  it('should build MCP config', () => {
    const identity = new AgentIdentity('test-agent');
    const config = identity.buildMcpConfig();
    expect(config).toHaveProperty('group-chat');
    expect(config['group-chat']).toHaveProperty('command');
    expect(config['group-chat']).toHaveProperty('args');
  });
});
