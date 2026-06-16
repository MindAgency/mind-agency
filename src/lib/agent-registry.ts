/**
 * AgentRegistry — singleton manager for all AgentProxy instances.
 *
 * Provides centralized access to agent proxies:
 *   - getOrCreate(name) — get existing or create new proxy
 *   - getAll() — list all proxies
 *   - getByGroup(groupName) — find agents in a group
 *   - remove(name) — remove proxy from registry
 *   - cleanupZombies(pattern) — remove agents matching a pattern
 */

import fs from 'fs';
import path from 'path';
import { AGENTS_DIR, GROUPS_DIR } from './data-dir';
import { AgentProxy } from './agent-proxy';
import { createLogger } from '@/lib/logger';

const log = createLogger('agent-registry');

class AgentRegistry {
  private proxies = new Map<string, AgentProxy>();

  /**
   * Get existing proxy or create new one.
   * If agent doesn't exist on disk, still creates proxy (for pre-creation).
   */
  getOrCreate(name: string): AgentProxy {
    let proxy = this.proxies.get(name);
    if (!proxy) {
      proxy = new AgentProxy(name);
      this.proxies.set(name, proxy);
    }
    return proxy;
  }

  /**
   * Get proxy if it exists in registry.
   */
  get(name: string): AgentProxy | undefined {
    return this.proxies.get(name);
  }

  /**
   * Get all proxies for agents that exist on disk.
   * Auto-discovers agents from AGENTS_DIR.
   */
  getAll(): AgentProxy[] {
    this.discoverAgents();

    const result: AgentProxy[] = [];
    for (const proxy of this.proxies.values()) {
      if (proxy.exists()) {
        result.push(proxy);
      }
    }
    return result;
  }

  /**
   * Get all agent names that exist on disk.
   */
  getAllNames(): string[] {
    return this.getAll().map(p => p.name);
  }

  /**
   * Find all agents that belong to a specific group.
   */
  getByGroup(groupName: string): AgentProxy[] {
    const agentsDir = path.join(GROUPS_DIR, groupName, 'Agents');
    if (!fs.existsSync(agentsDir)) return [];

    const result: AgentProxy[] = [];
    try {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          result.push(this.getOrCreate(entry.name));
        }
      }
    } catch (e) { console.error('[lib:agent-registry]', e); }

    return result;
  }

  /**
   * Remove proxy from registry (e.g., when agent is deleted).
   */
  remove(name: string): void {
    const proxy = this.proxies.get(name);
    if (proxy) {
      proxy.destroy(); // Stop claude.exe process
      this.proxies.delete(name);
    }
  }

  /**
   * Invalidate cache for a specific agent.
   */
  invalidate(name: string): void {
    const proxy = this.proxies.get(name);
    if (proxy) {
      proxy.invalidateCache();
    }
  }

  /**
   * Invalidate all caches.
   */
  invalidateAll(): void {
    for (const proxy of this.proxies.values()) {
      proxy.invalidateCache();
    }
  }

  /**
   * v1.0 P1: Cleanup zombie agents matching a pattern.
   *
   * Removes agents from both registry and disk if their name matches the
   * provided regex pattern. Returns list of removed agent names.
   *
   * @param pattern - Regex pattern to match agent names (default: real-test-.*)
   * @param dryRun  - If true, return matching agents without removing them
   * @returns Array of removed (or would-be-removed) agent names
   */
  cleanupZombies(pattern: string = 'real-test-.*', dryRun: boolean = false): string[] {
    // First discover agents on disk that may not be in the in-memory registry yet
    this.discoverAgents();
    const regex = new RegExp(pattern, 'i');
    const removed: string[] = [];

    for (const [name, proxy] of this.proxies) {
      if (regex.test(name)) {
        removed.push(name);
        if (!dryRun) {
          try {
            // Remove from disk
            const agentDir = path.join(AGENTS_DIR, name);
            if (fs.existsSync(agentDir)) {
              fs.rmSync(agentDir, { recursive: true, force: true });
              log.info(`cleanupZombies: Removed agent directory: ${agentDir}`);
            }
            // Remove from all groups
            if (fs.existsSync(GROUPS_DIR)) {
              for (const group of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
                if (group.isDirectory() && !group.name.startsWith('.')) {
                  const groupAgentDir = path.join(GROUPS_DIR, group.name, 'Agents', name);
                  if (fs.existsSync(groupAgentDir)) {
                    fs.rmSync(groupAgentDir, { recursive: true, force: true });
                    log.info(`cleanupZombies: Removed from group ${group.name}: ${groupAgentDir}`);
                  }
                }
              }
            }
            // Remove from registry
            proxy.destroy();
            this.proxies.delete(name);
            log.info(`cleanupZombies: Removed agent from registry: ${name}`);
          } catch (e) {
            log.error(`cleanupZombies: Failed to remove ${name}`, e);
          }
        }
      }
    }

    log.info(`cleanupZombies: Found ${removed.length} matching agents${dryRun ? ' (dry run)' : ''}`);
    return removed;
  }

  /**
   * Discover agents from disk and add to registry.
   */
  private discoverAgents(): void {
    if (!fs.existsSync(AGENTS_DIR)) return;

    try {
      const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          if (!this.proxies.has(entry.name)) {
            this.proxies.set(entry.name, new AgentProxy(entry.name));
          }
        }
      }
    } catch (e) { console.error('[lib:agent-registry]', e); }
  }
}

// Singleton instance
let registry: AgentRegistry | null = null;

/** Auto-cleanup patterns for test agents that should never persist */
const AUTO_CLEANUP_PATTERNS = [
  /^real-test-.*$/i,
  /^test-agent-.*$/i,
  /^temp-.*$/i,
  /^debug-.*$/i,
];

export function getAgentRegistry(): AgentRegistry {
  if (!registry) {
    registry = new AgentRegistry();
    // Auto-cleanup test agents on first initialization (prevents accumulation)
    try {
      for (const pattern of AUTO_CLEANUP_PATTERNS) {
        const removed = registry.cleanupZombies(pattern.source, false);
        if (removed.length > 0) {
          log.info(`Auto-cleanup: removed ${removed.length} agents matching ${pattern.source}`);
        }
      }
    } catch (e) {
      log.error('Auto-cleanup failed', e);
    }
  }
  return registry;
}

export { AgentRegistry };
