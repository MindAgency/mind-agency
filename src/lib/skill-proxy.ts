/**
 * SkillProxy — unified skill management in Next.js process.
 *
 * Consolidates ALL skill logic:
 *   - Agent skill listing (from agent skills directory)
 *   - Skill context loading (RAG-based injection)
 *   - Skill search (TF-IDF relevance)
 *
 * Singleton instance — use getSkillProxy() to access.
 */

import fs from 'fs';
import path from 'path';
import { AGENTS_DIR } from './data-dir';
import {
  loadSkillsContext as loadSkillsContextFromDisk,
  searchRelevantSkills as searchRelevantSkillsFromDisk,
  getInstalledSkills,
  type Skill,
} from './skills';

// ── Types ─────────────────────────────────────────────────

export interface AgentSkill {
  name: string;
  prompt?: string;
}

export interface SkillSearchResult {
  skillId: string;
  skillName: string;
  content: string;
  score: number;
}

// ── SkillProxy class ──────────────────────────────────────

export class SkillProxy {
  private _agentSkillsCache: Map<string, AgentSkill[]> = new Map();
  private _loaded: Map<string, boolean> = new Map();

  constructor() {}

  // ── Agent Skills ─────────────────────────────────────

  /**
   * Get skills installed for a specific agent.
   */
  async getSkills(agentName: string): Promise<AgentSkill[]> {
    if (this._loaded.get(agentName)) {
      return this._agentSkillsCache.get(agentName) || [];
    }

    const skills: AgentSkill[] = [];
    try {
      const agentDir = path.join(AGENTS_DIR, agentName, 'skills');
      if (!fs.existsSync(agentDir)) {
        this._agentSkillsCache.set(agentName, skills);
        this._loaded.set(agentName, true);
        return skills;
      }

      const entries = fs.readdirSync(agentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const promptPath = path.join(agentDir, entry.name, 'prompt.md');
        let prompt: string | undefined;
        try {
          if (fs.existsSync(promptPath)) {
            prompt = fs.readFileSync(promptPath, 'utf-8').trim();
          }
        } catch (e) { console.error('[lib:skill-proxy]', e); }
        skills.push({ name: entry.name, prompt });
      }
    } catch (e) { console.error('[lib:skill-proxy]', e); }

    this._agentSkillsCache.set(agentName, skills);
    this._loaded.set(agentName, true);
    return skills;
  }

  /**
   * Load skills context for injection into agent prompt.
   * Uses RAG if taskContext is provided, otherwise returns all skills.
   */
  async loadSkillsContext(agentName: string, context?: string): Promise<string> {
    return loadSkillsContextFromDisk(agentName, context);
  }

  /**
   * Search relevant skills across all installed skills.
   */
  async searchRelevantSkills(query: string, limit: number = 3): Promise<SkillSearchResult[]> {
    const results = searchRelevantSkillsFromDisk(query, limit);
    return results.map(r => ({
      skillId: r.skillId,
      skillName: r.skillName,
      content: r.content,
      score: r.score || 0,
    }));
  }

  // ── Cleanup ──────────────────────────────────────────

  /**
   * Invalidate skills cache for an agent.
   */
  invalidateCache(agentName?: string): void {
    if (agentName) {
      this._agentSkillsCache.delete(agentName);
      this._loaded.delete(agentName);
    } else {
      this._agentSkillsCache.clear();
      this._loaded.clear();
    }
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    this._agentSkillsCache.clear();
    this._loaded.clear();
  }
}

// ── Singleton ─────────────────────────────────────────────

let instance: SkillProxy | null = null;

export function getSkillProxy(): SkillProxy {
  if (!instance) {
    instance = new SkillProxy();
  }
  return instance;
}
