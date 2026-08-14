/**
 * Memory System Tests — Three-layer memory (long-term layer)
 *
 * Tests writeMemory / readMemory: file creation with YAML frontmatter,
 * timestamp preservation, independent agent spaces, and key sanitization.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  AGENTS_DIR: path.join(__dirname, '.test-data', 'Agents'),
  GROUPS_DIR: path.join(__dirname, '.test-data', 'Groups'),
  default: path.join(__dirname, '.test-data'),
}));

vi.mock('../src/lib/cache', () => ({
  agentCache: {
    get: vi.fn(() => undefined),
    set: vi.fn(),
    invalidate: vi.fn(),
    invalidateRegion: vi.fn(),
  },
}));

import { writeMemory, readMemory, type MemoryEntry } from '../src/lib/memory';

// Helper: compute the memory file path for assertions
function memFilePath(agentName: string, key: string): string {
  const sanitize = (k: string) => k.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').slice(0, 64);
  return path.join(
    __dirname, '.test-data', '.mind', 'agents', agentName, 'memory',
    `${sanitize(key)}.md`,
  );
}

// ── writeMemory: file creation ────────────────────────────

describe('Memory — writeMemory creates memory file with correct format', () => {
  // 1. writeMemory creates memory file with correct format
  it('creates a .md file with YAML frontmatter and content', () => {
    const agent = 'fmt-agent-' + Date.now();
    const key = 'format-test';
    const content = 'This is test memory content.';

    writeMemory(agent, key, content);

    const filePath = memFilePath(agent, key);
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = fs.readFileSync(filePath, 'utf-8');
    // YAML frontmatter delimiters
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain('\n---\n\n');
    // Fields inside frontmatter
    expect(raw).toContain('key: format-test');
    expect(raw).toMatch(/created:\s*.+/);
    expect(raw).toMatch(/updated:\s*.+/);
    // Content after frontmatter
    expect(raw).toContain(content);
  });
});

// ── readMemory: non-existent key ──────────────────────────

describe('Memory — readMemory returns null for non-existent key', () => {
  // 2. readMemory returns null for non-existent key
  it('returns null when no memory file exists for the key', () => {
    const agent = 'null-agent-' + Date.now();
    const result = readMemory(agent, 'does-not-exist-' + Date.now());
    expect(result).toBeNull();
  });
});

// ── readMemory: correct content ───────────────────────────

describe('Memory — readMemory returns correct content for existing key', () => {
  // 3. readMemory returns correct content for existing key
  it('returns the same content that was written', () => {
    const agent = 'read-agent-' + Date.now();
    const key = 'content-test';
    const content = 'The quick brown fox jumps over the lazy dog.';

    writeMemory(agent, key, content);
    const entry = readMemory(agent, key);

    expect(entry).not.toBeNull();
    expect(entry!.content).toBe(content);
  });

  it('returns the correct key in the entry', () => {
    const agent = 'key-agent-' + Date.now();
    const key = 'my-special-key';
    writeMemory(agent, key, 'some content');
    const entry = readMemory(agent, key);
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe(key);
  });
});

// ── writeMemory: timestamp preservation ──────────────────

describe('Memory — writeMemory preserves created timestamp on update', () => {
  // 4. writeMemory preserves created timestamp on update
  it('keeps the original created timestamp when memory is overwritten', async () => {
    const agent = 'ts-agent-' + Date.now();
    const key = 'timestamp-preserve';

    writeMemory(agent, key, 'first version');
    const first = readMemory(agent, key);
    expect(first).not.toBeNull();
    const originalCreated = first!.created;

    // Small delay to ensure updated timestamp differs
    await new Promise(resolve => setTimeout(resolve, 10));

    writeMemory(agent, key, 'second version');
    const second = readMemory(agent, key);
    expect(second).not.toBeNull();
    expect(second!.created).toBe(originalCreated);
  });

  // 5. writeMemory updates updated timestamp
  it('changes the updated timestamp when memory is overwritten', async () => {
    const agent = 'upd-agent-' + Date.now();
    const key = 'timestamp-update';

    writeMemory(agent, key, 'first version');
    const first = readMemory(agent, key);
    expect(first).not.toBeNull();
    const firstUpdated = first!.updated;

    await new Promise(resolve => setTimeout(resolve, 10));

    writeMemory(agent, key, 'second version');
    const second = readMemory(agent, key);
    expect(second).not.toBeNull();
    expect(second!.updated).toBeGreaterThan(firstUpdated);
  });
});

// ── MemoryEntry: required fields ──────────────────────────

describe('Memory — MemoryEntry has all required fields', () => {
  // 6. Memory entry has all required fields (key, content, created, updated)
  it('returns an object with key, content, created, and updated', () => {
    const agent = 'fields-agent-' + Date.now();
    const key = 'fields-test';
    const content = 'Memory with all fields.';

    writeMemory(agent, key, content);
    const entry: MemoryEntry | null = readMemory(agent, key);

    expect(entry).not.toBeNull();
    expect(entry).toHaveProperty('key');
    expect(entry).toHaveProperty('content');
    expect(entry).toHaveProperty('created');
    expect(entry).toHaveProperty('updated');

    expect(typeof entry!.key).toBe('string');
    expect(typeof entry!.content).toBe('string');
    expect(typeof entry!.created).toBe('number');
    expect(typeof entry!.updated).toBe('number');
  });

  it('returns correct values for each field', () => {
    const agent = 'values-agent-' + Date.now();
    const key = 'values-test';
    const content = 'Exact content check.';

    writeMemory(agent, key, content);
    const entry = readMemory(agent, key);

    expect(entry!.key).toBe(key);
    expect(entry!.content).toBe(content);
    expect(entry!.created).toBeGreaterThan(0);
    expect(entry!.updated).toBeGreaterThanOrEqual(entry!.created);
  });
});

// ── Multiple agents: independent memory spaces ───────────

describe('Memory — Multiple agents have independent memory spaces', () => {
  // 7. Multiple agents have independent memory spaces
  it('stores separate memories for different agents with the same key', () => {
    const agentA = 'indep-a-' + Date.now();
    const agentB = 'indep-b-' + Date.now();
    const key = 'shared-key';
    const contentA = 'Memory for agent A';
    const contentB = 'Memory for agent B';

    writeMemory(agentA, key, contentA);
    writeMemory(agentB, key, contentB);

    const entryA = readMemory(agentA, key);
    const entryB = readMemory(agentB, key);

    expect(entryA).not.toBeNull();
    expect(entryB).not.toBeNull();
    expect(entryA!.content).toBe(contentA);
    expect(entryB!.content).toBe(contentB);
    expect(entryA!.content).not.toBe(entryB!.content);
  });

  it('writing to one agent does not affect another agent memory', () => {
    const agentA = 'isolated-a-' + Date.now();
    const agentB = 'isolated-b-' + Date.now();
    const key = 'isolation-test';

    writeMemory(agentA, key, 'original A');
    writeMemory(agentB, key, 'original B');

    // Overwrite agent A only
    writeMemory(agentA, key, 'updated A');

    const entryB = readMemory(agentB, key);
    expect(entryB!.content).toBe('original B');
  });
});

// ── Key sanitization ──────────────────────────────────────

describe('Memory — Special characters in key are sanitized', () => {
  // 8. Special characters in key are sanitized
  it('sanitizes slashes and spaces in the key for the file name', () => {
    const agent = 'san-agent-' + Date.now();
    const key = 'my/key with spaces';
    const content = 'Sanitized key content.';

    writeMemory(agent, key, content);

    // The file should exist under the sanitized name (slashes and spaces → _)
    const expectedFile = memFilePath(agent, key);
    expect(fs.existsSync(expectedFile)).toBe(true);
  });

  it('can read back memory written with special-character key', () => {
    const agent = 'san-read-' + Date.now();
    const key = 'key/with/slashes and spaces!';
    const content = 'Read back after sanitize.';

    writeMemory(agent, key, content);
    const entry = readMemory(agent, key);

    expect(entry).not.toBeNull();
    expect(entry!.content).toBe(content);
    // The key in the frontmatter is the original (unsanitized) key
    expect(entry!.key).toBe(key);
  });

  it('preserves Chinese characters in the key', () => {
    const agent = 'cn-agent-' + Date.now();
    const key = '测试记忆';
    const content = 'Chinese key content.';

    writeMemory(agent, key, content);
    const entry = readMemory(agent, key);

    expect(entry).not.toBeNull();
    expect(entry!.key).toBe(key);
    expect(entry!.content).toBe(content);
  });

  it('truncates very long keys to 64 characters in the file name', () => {
    const agent = 'long-agent-' + Date.now();
    const longKey = 'a'.repeat(100);
    const content = 'Long key content.';

    writeMemory(agent, longKey, content);

    const expectedFile = memFilePath(agent, longKey);
    expect(fs.existsSync(expectedFile)).toBe(true);

    // File name should be at most 64 chars + '.md'
    const fileName = path.basename(expectedFile);
    expect(fileName.length).toBeLessThanOrEqual(64 + '.md'.length);
  });
});
