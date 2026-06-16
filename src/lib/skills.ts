/**
 * Skills System — Package manager for AI skills from GitHub repos.
 *
 * Inspired by CC Switch:
 * - Install from GitHub repos
 * - SHA-256 hash for update detection
 * - Backup before uninstall
 * - Symlink or copy to agent directories
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MIND_DIR, AGENTS_DIR } from './data-dir';
import { randomUUID } from 'crypto';
import { atomicWrite } from './atomic';

// ── Types ────────────────────────────────────────────────

export interface Skill {
  id: string;
  name: string;
  description: string;
  repo: string;           // "owner/repo"
  repoPath?: string;      // subdirectory in repo
  installedAt: number;
  version: string;        // SHA-256 hash of content
  status: 'installed' | 'update_available';
  prompt?: string;        // cached prompt.md content
  entryFile?: string;     // SKILL.md or prompt.md
  triggers?: string[];    // routing hints from manifest / headings
  files?: string[];       // supporting files available for progressive disclosure
}

export interface SkillSearchResult {
  name: string;
  repo: string;
  description: string;
  stars: number;
  path: string;
}

// ── Storage ──────────────────────────────────────────────

const SKILLS_FILE = path.join(MIND_DIR, 'skills.json');
const SKILLS_DIR = path.join(MIND_DIR, 'skills');
const BACKUPS_DIR = path.join(MIND_DIR, 'skill-backups');
const MAX_BACKUPS = 20;

function ensureDirs(): void {
  for (const dir of [MIND_DIR, SKILLS_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function loadSkills(): Skill[] {
  ensureDirs();
  try {
    if (fs.existsSync(SKILLS_FILE)) {
      return JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf-8'));
    }
  } catch (e) { console.error('[lib:skills]', e); }
  return [];
}

function saveSkills(skills: Skill[]): void {
  ensureDirs();
  
  atomicWrite(SKILLS_FILE, JSON.stringify(skills, null, 2));
}

interface SkillMetadata {
  prompt?: string;
  description: string;
  entryFile?: string;
  triggers: string[];
  files: string[];
}

function walkFiles(root: string, current = ''): string[] {
  const dir = path.join(root, current);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = current ? path.join(current, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else out.push(rel.replace(/\\/g, '/'));
  }
  return out;
}

function parseFrontmatter(raw: string): { data: Record<string, any>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[kv[1]] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      data[kv[1]] = value.replace(/^['"]|['"]$/g, '');
    }
  }
  return { data, body: raw.slice(m[0].length) };
}

function readSkillMetadata(skillDir: string, skillName: string): SkillMetadata {
  const files = walkFiles(skillDir);
  const manifestPath = ['skill.json', '.skill.json', 'manifest.json']
    .map(f => path.join(skillDir, f))
    .find(fs.existsSync);
  let manifest: Record<string, any> = {};
  if (manifestPath) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch (e) { console.error('[lib:skills]', e); }
  }

  const entryFile =
    manifest.entry ||
    (fs.existsSync(path.join(skillDir, 'SKILL.md')) ? 'SKILL.md' :
     fs.existsSync(path.join(skillDir, 'prompt.md')) ? 'prompt.md' :
     fs.existsSync(path.join(skillDir, 'README.md')) ? 'README.md' : undefined);

  let prompt = '';
  let frontmatter: Record<string, any> = {};
  if (entryFile) {
    try {
      const parsed = parseFrontmatter(fs.readFileSync(path.join(skillDir, entryFile), 'utf-8').trim());
      frontmatter = parsed.data;
      prompt = parsed.body.trim();
    } catch (e) { console.error('[lib:skills]', e); }
  }

  const readmePath = path.join(skillDir, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8').trim() : '';
  const description =
    manifest.description ||
    frontmatter.description ||
    prompt.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    readme.replace(/^#.*\r?\n/, '').split(/\r?\n\r?\n/)[0]?.trim() ||
    skillName;

  const triggerSource = manifest.triggers || manifest.when_to_use || frontmatter.triggers || frontmatter.when_to_use || [];
  const triggers = Array.isArray(triggerSource)
    ? triggerSource.map(String).filter(Boolean)
    : String(triggerSource).split(/[,;，；]/).map(s => s.trim()).filter(Boolean);

  return {
    prompt,
    description: description.slice(0, 400),
    entryFile,
    triggers,
    files: files.filter(f => !/^(\.git|node_modules)\//.test(f)),
  };
}

// ── GitHub API ───────────────────────────────────────────

async function githubGet(url: string): Promise<any> {
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `token ${token}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

async function githubGetContent(repo: string, path: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const data = await githubGet(url);
  if (data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  // If content is a URL, fetch it
  if (data.download_url) {
    const res = await fetch(data.download_url, { signal: AbortSignal.timeout(10000) });
    return res.text();
  }
  throw new Error('Unexpected content format');
}

async function githubGetTree(repo: string, path?: string): Promise<any[]> {
  const url = `https://api.github.com/repos/${repo}/contents/${path || ''}`;
  const data = await githubGet(url);
  return Array.isArray(data) ? data : [];
}

// ── Search ───────────────────────────────────────────────

export async function searchSkills(query: string): Promise<SkillSearchResult[]> {
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+skill+claude&sort=stars&per_page=10`;
    const data = await githubGet(url);
    return (data.items || []).map((r: any) => ({
      name: r.name,
      repo: r.full_name,
      description: r.description || '',
      stars: r.stargazers_count,
      path: '',
    }));
  } catch {
    return [];
  }
}

// ── Install ──────────────────────────────────────────────

async function downloadRepo(repo: string, repoPath?: string): Promise<{ files: Map<string, string>; version: string }> {
  const files = new Map<string, string>();

  async function downloadDir(dirPath: string) {
    const items = await githubGetTree(repo, dirPath);
    for (const item of items) {
      if (item.type === 'file') {
        const content = await githubGetContent(repo, item.path);
        files.set(item.path, content);
      } else if (item.type === 'dir') {
        await downloadDir(item.path);
      }
    }
  }

  await downloadDir(repoPath || '');

  // Compute SHA-256 hash of all content
  const hash = crypto.createHash('sha256');
  for (const [path, content] of [...files.entries()].sort()) {
    hash.update(path);
    hash.update(content);
  }
  const version = hash.digest('hex').slice(0, 16);

  return { files, version };
}

export async function installSkill(repo: string, repoPath?: string): Promise<Skill> {
  ensureDirs();

  // Check if already installed
  const existing = loadSkills().find(s => s.repo === repo && s.repoPath === (repoPath || ''));
  if (existing) throw new Error(`Skill from ${repo} already installed`);

  // Download from GitHub
  const { files, version } = await downloadRepo(repo, repoPath);

  // Extract skill name from repo or path
  const skillName = repoPath?.split('/').pop() || repo.split('/').pop() || 'unknown';

  // Write files to skills directory
  const skillDir = path.join(SKILLS_DIR, skillName);
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });

  for (const [filePath, content] of files) {
    // Strip repoPath prefix if present
    const relativePath = repoPath ? filePath.replace(repoPath + '/', '') : filePath;
    const fullPath = path.join(skillDir, relativePath);
    
    atomicWrite(fullPath, content);
  }

  const metadata = readSkillMetadata(skillDir, skillName);

  // Create skill record
  const skill: Skill = {
    id: randomUUID().slice(0, 8),
    name: skillName,
    repo,
    repoPath,
    installedAt: Date.now(),
    version,
    status: 'installed',
    prompt: metadata.prompt,
    description: metadata.description,
    entryFile: metadata.entryFile,
    triggers: metadata.triggers,
    files: metadata.files,
  };

  const skills = loadSkills();
  skills.push(skill);
  saveSkills(skills);

  // Distribute to agent directories
  distributeToAgents(skillName);

  return skill;
}

// ── Uninstall ────────────────────────────────────────────

export function uninstallSkill(id: string): boolean {
  const skills = loadSkills();
  const idx = skills.findIndex(s => s.id === id);
  if (idx === -1) return false;

  const skill = skills[idx];
  const skillDir = path.join(SKILLS_DIR, skill.name);

  // Backup before removal
  if (fs.existsSync(skillDir)) {
    const backupDir = path.join(BACKUPS_DIR, `${skill.name}_${Date.now()}`);
    fs.cpSync(skillDir, backupDir);

    // Cleanup old backups (keep MAX_BACKUPS)
    const backups = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith(skill.name + '_'))
      .sort();
    while (backups.length > MAX_BACKUPS) {
      fs.rmSync(path.join(BACKUPS_DIR, backups.shift()!), { recursive: true });
    }
  }

  // Remove from skills directory
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true });

  // Remove from agent directories
  removeFromAgents(skill.name);

  // Remove from skills list
  skills.splice(idx, 1);
  saveSkills(skills);

  // Rebuild embedding index
  buildSkillIndex();

  return true;
}

// ── Update check ─────────────────────────────────────────

export async function checkSkillUpdates(): Promise<string[]> {
  const skills = loadSkills();
  const updated: string[] = [];

  for (const skill of skills) {
    try {
      const { version } = await downloadRepo(skill.repo, skill.repoPath);
      if (version !== skill.version) {
        skill.status = 'update_available';
        updated.push(skill.id);
      } else {
        skill.status = 'installed';
      }
    } catch (e) { console.error('[lib:skills]', e); }
  }

  saveSkills(skills);
  return updated;
}

export async function updateSkill(id: string): Promise<Skill | null> {
  const skills = loadSkills();
  const skill = skills.find(s => s.id === id);
  if (!skill) return null;

  // Uninstall old version (with backup)
  const skillDir = path.join(SKILLS_DIR, skill.name);
  if (fs.existsSync(skillDir)) {
    const backupDir = path.join(BACKUPS_DIR, `${skill.name}_${Date.now()}`);
    fs.cpSync(skillDir, backupDir);
  }
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true });

  // Reinstall
  const { files, version } = await downloadRepo(skill.repo, skill.repoPath);

  fs.mkdirSync(skillDir, { recursive: true });
  for (const [filePath, content] of files) {
    const relativePath = skill.repoPath ? filePath.replace(skill.repoPath + '/', '') : filePath;
    const fullPath = path.join(skillDir, relativePath);
    
    atomicWrite(fullPath, content);
  }

  // Update record
  skill.version = version;
  skill.status = 'installed';
  skill.installedAt = Date.now();
  const metadata = readSkillMetadata(skillDir, skill.name);
  skill.prompt = metadata.prompt;
  skill.description = metadata.description;
  skill.entryFile = metadata.entryFile;
  skill.triggers = metadata.triggers;
  skill.files = metadata.files;

  saveSkills(skills);
  distributeToAgents(skill.name);

  // Rebuild embedding index
  buildSkillIndex();

  return skill;
}

// ── Distribution to agent directories ────────────────────

function distributeToAgent(skillName: string, agentName: string): void {
  const srcDir = path.join(SKILLS_DIR, skillName);
  if (!fs.existsSync(srcDir)) return;

  const destDir = path.join(AGENTS_DIR, agentName, 'skills', skillName);
  const destParent = path.dirname(destDir);
  if (!fs.existsSync(destParent)) fs.mkdirSync(destParent, { recursive: true });
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
}

function removeFromAgent(skillName: string, agentName: string): void {
  const skillDir = path.join(AGENTS_DIR, agentName, 'skills', skillName);
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true });
}

function distributeToAgents(skillName: string): void {
  // Distribute to all agents that have this skill enabled
  if (!fs.existsSync(AGENTS_DIR)) return;
  const agents = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);

  for (const agent of agents) {
    if (isSkillEnabled(agent, skillName)) {
      distributeToAgent(skillName, agent);
    }
  }
}

function removeFromAgents(skillName: string): void {
  // Remove from all agents
  if (!fs.existsSync(AGENTS_DIR)) return;
  const agents = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);

  for (const agent of agents) {
    removeFromAgent(skillName, agent);
  }
}

// ── Skill RAG — TF-IDF based retrieval ───────────────────

interface SkillEntry {
  skillId: string;
  skillName: string;
  content: string;
  tokens: string[];
  score?: number;
}

// In-memory index (rebuilt on startup)
let skillIndex: SkillEntry[] = [];

/** Tokenize text (Chinese bigrams + English words) */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.match(/[a-z0-9_]+/g) || []) tokens.push(m);
  const cn = lower.match(/[一-鿿]+/g) || [];
  for (const phrase of cn) {
    for (let i = 0; i < phrase.length; i++) tokens.push(phrase[i]);
    for (let i = 0; i < phrase.length - 1; i++) tokens.push(phrase.slice(i, i + 2));
  }
  return tokens;
}

/** TF-IDF score between query and skill */
function tfidfScore(queryTokens: string[], skillTokens: string[]): number {
  const skillSet = new Set(skillTokens);
  let score = 0;
  const unique = [...new Set(queryTokens)];
  for (const qt of unique) {
    const tf = queryTokens.filter(t => t === qt).length / queryTokens.length;
    const inSkill = skillSet.has(qt) ? 1 : 0;
    score += tf * inSkill;
  }
  // Exact substring bonus
  const queryStr = queryTokens.join(' ');
  const skillStr = skillTokens.join(' ');
  if (skillStr.includes(queryStr)) score += 5;
  return score;
}

/**
 * Build TF-IDF index for all installed skills.
 */
export function buildSkillIndex(): void {
  skillIndex = [];
  const skills = loadSkills();

  for (const skill of skills) {
    const skillDir = path.join(SKILLS_DIR, skill.name);
    if (!fs.existsSync(skillDir)) continue;

    try {
      const metadata = readSkillMetadata(skillDir, skill.name);
      const routingText = [
        metadata.description,
        ...(metadata.triggers || []),
        metadata.prompt || '',
      ].join('\n');
      if (routingText.trim()) {
        skillIndex.push({
          skillId: skill.id,
          skillName: skill.name,
          content: metadata.prompt || metadata.description,
          tokens: tokenize(routingText),
        });
      }
    } catch (e) {
      console.error('[lib:skills]', e);
    }
  }

  console.log(`[skills] Indexed ${skillIndex.length} skills`);
}

/**
 * Search relevant skills for a given task.
 * Returns top-K most relevant skills.
 */
export function searchRelevantSkills(task: string, topK = 3): SkillEntry[] {
  if (skillIndex.length === 0) buildSkillIndex();
  if (skillIndex.length === 0) return [];

  const queryTokens = tokenize(task);

  return skillIndex
    .map(s => ({ ...s, score: tfidfScore(queryTokens, s.tokens) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(s => s.score > 0);
}

function formatSkillContext(skillName: string, metadata: SkillMetadata, maxChars = 5000): string {
  const lines: string[] = [];
  lines.push(`### Skill: ${skillName}`);
  if (metadata.entryFile) lines.push(`Entry: ${metadata.entryFile}`);
  if (metadata.description) lines.push(`Use when: ${metadata.description}`);
  if (metadata.triggers.length > 0) lines.push(`Triggers: ${metadata.triggers.join(', ')}`);
  const supportingFiles = metadata.files.filter(f => f !== metadata.entryFile).slice(0, 12);
  if (supportingFiles.length > 0) lines.push(`Available supporting files: ${supportingFiles.join(', ')}`);
  if (metadata.prompt) {
    const prompt = metadata.prompt.length > maxChars ? metadata.prompt.slice(0, maxChars) + '\n...[truncated]' : metadata.prompt;
    lines.push('');
    lines.push(prompt);
  }
  return lines.join('\n');
}

// ── Load skills context (RAG version) ────────────────────

/**
 * Load skills context using RAG — only injects relevant skills.
 * Falls back to full injection if no task context available.
 */
export async function loadSkillsContext(agentName: string, taskContext?: string): Promise<string> {
  const agentDir = path.join(AGENTS_DIR, agentName, 'skills');
  try { await fs.promises.access(agentDir); } catch { return ''; }

  const entries = await fs.promises.readdir(agentDir, { withFileTypes: true });
  const installedSkills = entries.filter(e => e.isDirectory()).map(e => e.name);

  if (installedSkills.length === 0) return '';

  // No task context → inject all (fallback)
  if (!taskContext) {
    const parts: string[] = [];
    for (const skillName of installedSkills) {
      try {
        const metadata = readSkillMetadata(path.join(agentDir, skillName), skillName);
        if (metadata.prompt || metadata.description) parts.push(formatSkillContext(skillName, metadata, 2500));
      } catch (e) { console.error('[lib:skills]', e); }
    }
    return parts.length > 0 ? '\n\n[启用的 Skills]\n' + parts.join('\n\n') : '';
  }

  // RAG: search relevant skills
  const relevant = searchRelevantSkills(taskContext, 3);
  const agentRelevant = relevant.filter(r => installedSkills.includes(r.skillName));

  if (agentRelevant.length === 0) return '';

  const parts = agentRelevant.map(s => {
    const metadata = readSkillMetadata(path.join(agentDir, s.skillName), s.skillName);
    return formatSkillContext(s.skillName, metadata);
  });
  return '\n\n[相关 Skills]\n' + parts.join('\n\n');
}

// ── List ─────────────────────────────────────────────────

export function getInstalledSkills(): Skill[] {
  return loadSkills();
}

export function getSkill(id: string): Skill | undefined {
  return loadSkills().find(s => s.id === id);
}

export function registerLocalSkill(skillName: string): Skill | null {
  ensureDirs();
  const skillDir = path.join(SKILLS_DIR, skillName);
  if (!fs.existsSync(skillDir)) return null;
  const metadata = readSkillMetadata(skillDir, skillName);
  const hash = crypto.createHash('sha256');
  for (const file of metadata.files.sort()) {
    try {
      hash.update(file);
      hash.update(fs.readFileSync(path.join(skillDir, file), 'utf-8'));
    } catch (e) { console.error('[lib:skills]', e); }
  }
  const skills = loadSkills();
  let skill = skills.find(s => s.name === skillName);
  if (!skill) {
    skill = {
      id: randomUUID().slice(0, 8),
      name: skillName,
      description: metadata.description,
      repo: 'local',
      installedAt: Date.now(),
      version: hash.digest('hex').slice(0, 16),
      status: 'installed',
    };
    skills.push(skill);
  }
  skill.description = metadata.description;
  skill.prompt = metadata.prompt;
  skill.entryFile = metadata.entryFile;
  skill.triggers = metadata.triggers;
  skill.files = metadata.files;
  saveSkills(skills);
  buildSkillIndex();
  return skill;
}

// ── Skill Enable/Disable ─────────────────────────────────

function loadAgentConfigForSkill(agentName: string): any {
  const configPath = path.join(AGENTS_DIR, agentName, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) { console.error('[lib:skills]', e); }
  return {};
}

function saveAgentConfigForSkill(agentName: string, config: any): void {
  const configPath = path.join(AGENTS_DIR, agentName, 'config.json');
  
  atomicWrite(configPath, JSON.stringify(config, null, 2));
}

export function isSkillEnabled(agentName: string, skillName: string): boolean {
  const config = loadAgentConfigForSkill(agentName);
  const enabledSkills = config.enabledSkills || [];
  return enabledSkills.includes(skillName);
}

export function enableSkill(agentName: string, skillName: string): boolean {
  // Check if skill exists globally
  const skills = loadSkills();
  if (!skills.find(s => s.name === skillName)) {
    return false;
  }

  // Update agent config
  const config = loadAgentConfigForSkill(agentName);
  if (!config.enabledSkills) {
    config.enabledSkills = [];
  }
  if (!config.enabledSkills.includes(skillName)) {
    config.enabledSkills.push(skillName);
    saveAgentConfigForSkill(agentName, config);
  }

  // Distribute skill to agent
  distributeToAgent(skillName, agentName);

  console.log(`[skills] Enabled ${skillName} for ${agentName}`);
  return true;
}

export function disableSkill(agentName: string, skillName: string): boolean {
  // Update agent config
  const config = loadAgentConfigForSkill(agentName);
  if (config.enabledSkills) {
    config.enabledSkills = config.enabledSkills.filter((s: string) => s !== skillName);
    saveAgentConfigForSkill(agentName, config);
  }

  // Remove skill from agent
  removeFromAgent(skillName, agentName);

  console.log(`[skills] Disabled ${skillName} for ${agentName}`);
  return true;
}

export function getEnabledSkills(agentName: string): string[] {
  const config = loadAgentConfigForSkill(agentName);
  return config.enabledSkills || [];
}

export function setEnabledSkills(agentName: string, skillNames: string[]): void {
  const config = loadAgentConfigForSkill(agentName);
  config.enabledSkills = skillNames;
  saveAgentConfigForSkill(agentName, config);

  // Sync skills to agent directory
  const skills = loadSkills();
  const skillNames_set = new Set(skillNames);

  for (const skill of skills) {
    if (skillNames_set.has(skill.name)) {
      distributeToAgent(skill.name, agentName);
    } else {
      removeFromAgent(skill.name, agentName);
    }
  }

  console.log(`[skills] Set enabled skills for ${agentName}:`, skillNames);
}
