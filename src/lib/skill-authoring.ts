/**
 * Skill authoring from completed work.
 *
 * Agents can propose skills, but the skill lands as a draft until a user or
 * admin enables it. This keeps self-improvement auditable.
 */

import fs from 'fs';
import path from 'path';
import { AGENTS_DIR, MIND_DIR } from './data-dir';
import { atomicWrite } from './atomic';
import { enableSkill, registerLocalSkill } from './skills';

const DRAFT_DIR = path.join(MIND_DIR, 'skill-drafts');
const GLOBAL_SKILLS_DIR = path.join(MIND_DIR, 'skills');

export interface SkillDraft {
  id: string;
  agent: string;
  name: string;
  description: string;
  triggers: string[];
  content: string;
  source: 'manual' | 'agent_analysis';
  status: 'draft' | 'published';
  createdAt: number;
  publishedAt?: number;
}

function ensureDirs(): void {
  for (const dir of [MIND_DIR, DRAFT_DIR, GLOBAL_SKILLS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'new-skill';
}

function draftPath(id: string): string {
  return path.join(DRAFT_DIR, `${id}.json`);
}

export function listSkillDrafts(): SkillDraft[] {
  ensureDirs();
  return fs.readdirSync(DRAFT_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, f), 'utf-8')) as SkillDraft; }
      catch { return null; }
    })
    .filter(Boolean) as SkillDraft[];
}

export function createSkillDraft(input: {
  agent: string;
  name: string;
  description: string;
  triggers?: string[];
  content: string;
  source?: SkillDraft['source'];
}): SkillDraft {
  ensureDirs();
  const id = `${safeName(input.name)}-${Date.now().toString(36)}`;
  const draft: SkillDraft = {
    id,
    agent: input.agent,
    name: safeName(input.name),
    description: input.description,
    triggers: input.triggers || [],
    content: input.content,
    source: input.source || 'manual',
    status: 'draft',
    createdAt: Date.now(),
  };
  atomicWrite(draftPath(id), JSON.stringify(draft, null, 2));
  return draft;
}

export function analyzeSessionToDraft(agent: string, name?: string): SkillDraft {
  const sessionPath = path.join(AGENTS_DIR, agent, 'chat', 'session.json');
  let messages: Array<{ role: string; content: string }> = [];
  try {
    if (fs.existsSync(sessionPath)) {
      messages = (JSON.parse(fs.readFileSync(sessionPath, 'utf-8')).messages || []).slice(-12);
    }
  } catch (e) { console.error('[lib:skill-authoring]', e); }

  const text = messages.map(m => `[${m.role}] ${m.content}`).join('\n\n').slice(-8000);
  const title = name || `${agent}-lesson`;
  const content = `---
description: Reusable lessons extracted from ${agent}'s recent work.
triggers: [${title}, review, repeat task, memory]
---

# ${title}

Use this skill when a future task resembles the recent work summarized below.

## Lessons

- Preserve concrete constraints from the user's request before acting.
- Reuse project-local conventions and APIs.
- Verify changes with the narrowest meaningful test.
- Record durable decisions in memory when they affect future work.

## Source Notes

${text || 'No recent session content was available. Fill in task-specific notes before publishing.'}
`;

  return createSkillDraft({
    agent,
    name: title,
    description: `Reusable lessons extracted from ${agent}'s recent work.`,
    triggers: [title, agent, 'review', 'repeat task'],
    content,
    source: 'agent_analysis',
  });
}

export function publishSkillDraft(id: string, opts?: { enableForAgent?: string }): SkillDraft | null {
  ensureDirs();
  if (!fs.existsSync(draftPath(id))) return null;
  const draft = JSON.parse(fs.readFileSync(draftPath(id), 'utf-8')) as SkillDraft;
  const skillDir = path.join(GLOBAL_SKILLS_DIR, draft.name);
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
  atomicWrite(path.join(skillDir, 'SKILL.md'), draft.content);
  atomicWrite(path.join(skillDir, 'skill.json'), JSON.stringify({
    name: draft.name,
    description: draft.description,
    entry: 'SKILL.md',
    triggers: draft.triggers,
  }, null, 2));
  registerLocalSkill(draft.name);
  draft.status = 'published';
  draft.publishedAt = Date.now();
  atomicWrite(draftPath(id), JSON.stringify(draft, null, 2));
  if (opts?.enableForAgent) enableSkill(opts.enableForAgent, draft.name);
  return draft;
}
