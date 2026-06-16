/**
 * ipc.ts — Inter-Process Communication for Next.js and WebSocket servers
 *
 * Uses a local SQLite database for true IPC consistency.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { MIND_DIR } from './data-dir';

const DB_PATH = path.join(MIND_DIR, 'ipc.db');

// Ensure directory exists
if (!fs.existsSync(MIND_DIR)) {
  fs.mkdirSync(MIND_DIR, { recursive: true });
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS locks (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      acquired_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);
  `);

  return db;
}

/**
 * Key-Value Store for cross-process state
 */
export class IPCStore {
  /**
   * Get value
   */
  get<T>(key: string): T | null {
    const database = getDb();
    const row = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  /**
   * Set value
   */
  set<T>(key: string, value: T): void {
    const database = getDb();
    const json = JSON.stringify(value);
    database.prepare(`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (?, ?, strftime('%s', 'now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, json);
  }

  /**
   * Delete value
   */
  delete(key: string): void {
    const database = getDb();
    database.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
  }

  /**
   * Get all keys matching prefix
   */
  keys(prefix: string): string[] {
    const database = getDb();
    const rows = database.prepare('SELECT key FROM kv_store WHERE key LIKE ?').all(`${prefix}%`) as { key: string }[];
    return rows.map(r => r.key);
  }

  /**
   * Atomic increment
   */
  increment(key: string, amount: number = 1): number {
    const database = getDb();
    const row = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined;
    let current = 0;
    if (row) {
      try {
        const parsed = JSON.parse(row.value);
        current = typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
      } catch {
        const legacy = parseInt(row.value, 10);
        current = Number.isFinite(legacy) ? legacy : 0;
      }
    }
    const newValue = current + amount;
    this.set(key, newValue);
    return newValue;
  }
}

/**
 * Distributed Lock using SQLite
 */
export class IPCLock {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Try to acquire lock
   */
  acquire(timeoutMs: number = 5000, owner: string = process.pid.toString()): boolean {
    const database = getDb();
    const expiresAt = Date.now() + timeoutMs;

    // Clean expired locks
    database.prepare('DELETE FROM locks WHERE expires_at < ?').run(Date.now());

    // Check if lock exists
    const existing = database.prepare('SELECT owner, expires_at FROM locks WHERE name = ?').get(this.name) as { owner: string; expires_at: number } | undefined;

    if (existing) {
      // Lock exists, check if we own it
      if (existing.owner === owner) {
        // We own it, extend expiry
        database.prepare('UPDATE locks SET expires_at = ? WHERE name = ?').run(expiresAt, this.name);
        return true;
      }
      return false;
    }

    // Lock doesn't exist, acquire it
    try {
      database.prepare(`
        INSERT INTO locks (name, owner, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(this.name, owner, Date.now(), expiresAt);
      return true;
    } catch {
      // May have been inserted by another process
      return false;
    }
  }

  /**
   * Release lock
   */
  release(owner: string = process.pid.toString()): void {
    const database = getDb();
    database.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').run(this.name, owner);
  }

  /**
   * Check if lock is held
   */
  isLocked(): boolean {
    const database = getDb();
    database.prepare('DELETE FROM locks WHERE expires_at < ?').run(Date.now());
    const row = database.prepare('SELECT 1 FROM locks WHERE name = ?').get(this.name);
    return !!row;
  }

  /**
   * Get lock owner
   */
  getOwner(): string | null {
    const database = getDb();
    database.prepare('DELETE FROM locks WHERE expires_at < ?').run(Date.now());
    const row = database.prepare('SELECT owner FROM locks WHERE name = ?').get(this.name) as { owner: string } | undefined;
    return row?.owner || null;
  }
}

// Singleton instances
export const ipcStore = new IPCStore();

export function getIPCLock(name: string): IPCLock {
  return new IPCLock(name);
}

// Cleanup on exit
process.on('exit', () => {
  if (db) {
    db.close();
    db = null;
  }
});
