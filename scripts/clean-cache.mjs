/**
 * Clean .next/cache directory to recover from webpack cache corruption.
 *
 * Webpack filesystem cache can become corrupted when builds crash mid-write
 * (e.g., OOM, power loss, Ctrl+C during compilation). This script detects
 * and removes the corrupted cache so webpack rebuilds from scratch.
 *
 * Usage: node scripts/clean-cache.mjs
 * Hooked into: npm run prebuild
 */

import { rmSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const CACHE_DIR = join(process.cwd(), '.next', 'cache');

function isCacheCorrupted(dir) {
  try {
    if (!existsSync(dir)) return false;
    const entries = readdirSync(dir);
    // If cache dir is empty or contains only lock files, it's fine
    const webpackDir = join(dir, 'webpack');
    if (!existsSync(webpackDir)) return false;
    const webpackEntries = readdirSync(webpackDir);
    // Check for lock files left behind by crashed builds
    const lockFiles = webpackEntries.filter(f => f.endsWith('.lock'));
    if (lockFiles.length > 0) {
      console.log(`[clean-cache] Found ${lockFiles.length} stale lock file(s): ${lockFiles.join(', ')}`);
      return true;
    }
    // Check for zero-byte cache index files (sign of corruption)
    const suspiciousFiles = webpackEntries.filter(f => {
      try {
        const stat = statSync(join(webpackDir, f));
        return stat.size === 0 && f.endsWith('.json');
      } catch {
        return false;
      }
    });
    if (suspiciousFiles.length > 0) {
      console.log(`[clean-cache] Found ${suspiciousFiles.length} empty cache file(s): ${suspiciousFiles.join(', ')}`);
      return true;
    }
    return false;
  } catch {
    return true; // If we can't read the dir, it's likely corrupted
  }
}

if (isCacheCorrupted(CACHE_DIR)) {
  console.log('[clean-cache] Removing corrupted .next/cache directory...');
  try {
    rmSync(CACHE_DIR, { recursive: true, force: true });
    console.log('[clean-cache] Cache cleared successfully. Webpack will rebuild on next build.');
  } catch (err) {
    console.error('[clean-cache] Failed to remove cache:', err.message);
    console.error('[clean-cache] You may need to manually delete .next/cache');
  }
} else {
  console.log('[clean-cache] Cache looks healthy, no cleanup needed.');
}
