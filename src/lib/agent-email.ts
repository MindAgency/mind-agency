/**
 * agent-email.ts — Email management for AgentProxy.
 */

import fs from 'fs';
import path from 'path';
import { AGENTS_DIR } from './data-dir';
import { Email } from './agent-types';

/**
 * Load all emails for an agent from disk.
 */
export async function loadAgentEmails(agentName: string): Promise<Email[]> {
  const emails: Email[] = [];
  try {
    const emailDir = path.join(AGENTS_DIR, agentName, 'email');
    if (fs.existsSync(emailDir)) {
      const files = fs.readdirSync(emailDir).filter(f => f.endsWith('.md')).sort();
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(emailDir, file), 'utf-8');
          const email = parseEmailFile(content, file);
          if (email) emails.push(email);
        } catch (e) { console.error('[lib:agent-email]', e); }
      }
    }
  } catch (e) { console.error('[lib:agent-email]', e); }
  return emails;
}

/**
 * Parse an email .md file with YAML frontmatter.
 */
export function parseEmailFile(content: string, filename: string): Email | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  const from = frontmatter.match(/from:\s*(.+)/)?.[1]?.trim() || '';
  const to = frontmatter.match(/to:\s*(.+)/)?.[1]?.trim() || '';
  const subject = frontmatter.match(/subject:\s*(.+)/)?.[1]?.trim() || '';
  const dateStr = frontmatter.match(/date:\s*(.+)/)?.[1]?.trim();
  const timestamp = dateStr ? new Date(dateStr).getTime() : 0;

  return { from, to, subject, body, filename, timestamp };
}

/**
 * Send an email from one agent to another.
 */
export async function sendAgentEmail(fromName: string, to: string, subject: string, body: string): Promise<boolean> {
  try {
    const emailDir = path.join(AGENTS_DIR, to, 'email');
    if (!fs.existsSync(emailDir)) fs.mkdirSync(emailDir, { recursive: true });

    const safeFrom = fromName.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_').slice(0, 30);
    const safeSubject = subject.replace(/[^a-zA-Z0-9_一-鿿-]/g, '_').slice(0, 50);
    const timestamp = Date.now();
    const filename = `${timestamp}_${safeFrom}_${safeSubject}.md`;

    const content = `---\nfrom: ${fromName}\nto: ${to}\nsubject: ${subject}\ndate: ${new Date().toISOString()}\n---\n\n${body}\n`;

    const filePath = path.join(emailDir, filename);
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);

    return true;
  } catch (err) {
    throw new Error(`Failed to send email: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Delete an email from an agent's inbox.
 */
export async function deleteAgentEmail(agentName: string, filename: string): Promise<boolean> {
  try {
    const emailPath = path.join(AGENTS_DIR, agentName, 'email', filename);
    if (!fs.existsSync(emailPath)) return false;

    fs.unlinkSync(emailPath);
    return true;
  } catch (err) {
    throw new Error(`Failed to delete email: ${err instanceof Error ? err.message : String(err)}`);
  }
}
