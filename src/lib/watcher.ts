/**
 * File-system watcher — real-time trigger for agent notification.
 *
 * Two-layer strategy:
 *   1. fs.watch(recursive) — catches new files, renames, deletes in Groups/ + Agents/
 *   2. fs.watchFile — stat-polling on individual chat/*.md files, catches appends
 *
 * On any trigger: debounce 2s → emit EventBus 'file.changed' event.
 * File watch list refreshed on every scheduler tick (so newly created chat files
 * get watched immediately).
 *
 * v1.3: Uses EventBus instead of direct callback.
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR, AGENTS_DIR } from './data-dir';

let directoryWatchers: fs.FSWatcher[] = [];
let fileWatchers: { watcher: fs.StatWatcher; path: string }[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let dirtyDirs = new Set<string>();

function debouncedTrigger(dir: string) {
  dirtyDirs.add(dir);
  if (debounceTimer) return; // already pending, will fire with all dirty dirs
  debounceTimer = setTimeout(() => {
    const dirs = [...dirtyDirs];
    dirtyDirs.clear();
    debounceTimer = null;
    // Emit EventBus event instead of direct callback
    emitFileChanged(dirs);
  }, 500);
}

function emitFileChanged(dirs: string[]): void {
  try {
    const { getEventBus, EventType, createEvent } = require('./event-bus');
    const bus = getEventBus();
    // Emit event for each changed directory
    for (const dir of dirs) {
      bus.emit(createEvent(EventType.FILE_CHANGED, { path: dir }, 'watcher'));
    }
  } catch {
    // EventBus not ready yet, ignore
  }
}

// ── Public API ───────────────────────────────────────────

export function startWatcher(): void {

  // Layer 1 — directory watchers (new files / renames / deletes)
  for (const baseDir of [GROUPS_DIR, AGENTS_DIR]) {
    if (!fs.existsSync(baseDir)) continue;
    try {
      const w = fs.watch(baseDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        // Ignore .swp, .tmp, session.json, etc.
        if (filename.includes('.tmp') || filename.includes('.swp')) return;
        // v1.2: Pass full path for faster agent-specific scanning
        const fullPath = path.join(baseDir, filename);
        debouncedTrigger(fullPath);
      });
      directoryWatchers.push(w);
      console.log(`[watcher] watching ${path.basename(baseDir)}/ (directory)`);
    } catch (e: any) {
      console.log(`[watcher] failed to watch ${baseDir}: ${e.message}`);
    }
  }

  // Layer 2 — file-level stat watchers (appends to existing .md files)
  refreshFileWatchers();

  console.log(`[watcher] ${directoryWatchers.length} dir + ${fileWatchers.length} file watchers active`);
}

export function stopWatcher(): void {
  for (const w of directoryWatchers) { try { w.close(); } catch (e) { console.error('[lib:watcher]', e); } }
  for (const fw of fileWatchers) { try { fs.unwatchFile(fw.path); } catch (e) { console.error('[lib:watcher]', e); } }
  directoryWatchers = [];
  fileWatchers = [];
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  console.log('[watcher] stopped');
}

// ── Internal: refresh list of file watchers ──────────────

/**
 * Called on every scheduler tick. Tears down old file watchers and
 * re-creates them for all currently existing chat/*.md and email/*.md files.
 * This covers:
 *   - New chat files created since last refresh (group_send to new date)
 *   - Appends to existing chat files (group_send to today's file)
 *   - New email files
 */
export function refreshFileWatchers(): void {
  // Tear down old
  for (const fw of fileWatchers) { try { fs.unwatchFile(fw.path); } catch (e) { console.error('[lib:watcher]', e); } }
  fileWatchers = [];

  const filesToWatch: string[] = [];

  // Only watch files modified in the last 7 days (avoid stale files)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Groups/*/chat/*.md
  const groupsDir = GROUPS_DIR;
  if (fs.existsSync(groupsDir)) {
    for (const g of fs.readdirSync(groupsDir, { withFileTypes: true })) {
      if (!g.isDirectory() || g.name.startsWith('.')) continue;
      const chatDir = path.join(groupsDir, g.name, 'chat');
      if (!fs.existsSync(chatDir)) continue;
      for (const f of fs.readdirSync(chatDir)) {
        if (!f.endsWith('.md')) continue;
        const fp = path.join(chatDir, f);
        try { if (fs.statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
        filesToWatch.push(fp);
      }
    }
  }

  // Agents/*/email/*.md
  const agentsDir = AGENTS_DIR;
  if (fs.existsSync(agentsDir)) {
    for (const a of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!a.isDirectory() || a.name.startsWith('.')) continue;
      const emailDir = path.join(agentsDir, a.name, 'email');
      if (!fs.existsSync(emailDir)) continue;
      for (const f of fs.readdirSync(emailDir)) {
        if (!f.endsWith('.md')) continue;
        const fp = path.join(emailDir, f);
        try { if (fs.statSync(fp).mtimeMs < cutoff) continue; } catch { continue; }
        filesToWatch.push(fp);
      }
    }
  }

  // Create stat watchers (interval: 5s, reasonable balance of latency vs CPU)
  for (const fp of filesToWatch) {
    try {
      const w = fs.watchFile(fp, { interval: 5000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
          // Determine which base dir this belongs to
          const baseDir = fp.includes('Groups') ? GROUPS_DIR : AGENTS_DIR;
          debouncedTrigger(baseDir);
        }
      });
      fileWatchers.push({ watcher: w, path: fp });
    } catch (e) { console.error('[lib:watcher]', e); }
  }

  if (fileWatchers.length > 0) {
    // Only log if count changed significantly
    if (fileWatchers.length % 5 === 0) {
      console.log(`[watcher] watching ${fileWatchers.length} files`);
    }
  }
}
