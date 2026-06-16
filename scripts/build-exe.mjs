import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, cpSync } from 'fs';
import path from 'path';
import esbuild from 'esbuild';

const distDir = path.resolve('.next-server-dist');

console.log('[build-exe] Starting preparation for electron-builder...');

// Clean
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(distDir, { recursive: true });

// Copy standalone Next.js build
console.log('[build-exe] Copying Next.js standalone build...');
const srcStandalone = path.resolve('.next/standalone');
if (existsSync(srcStandalone)) {
  cpSync(srcStandalone, distDir, { recursive: true });
} else {
  console.error('[build-exe] Next.js standalone build not found. Did you run `next build`?');
  process.exit(1);
}

// Copy static files and public directory
console.log('[build-exe] Copying static and public files...');
cpSync(path.resolve('.next/static'), path.join(distDir, '.next/static'), { recursive: true });
cpSync(path.resolve('public'), path.join(distDir, 'public'), { recursive: true });

// Compile server.ts to server.mjs using esbuild
console.log('[build-exe] Compiling WebSocket server (server.ts -> server.mjs)...');
esbuild.buildSync({
  entryPoints: ['server.ts'],
  outfile: path.join(distDir, 'server.mjs'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node18'
});

console.log('[build-exe] Copying native/external modules to .next-server-dist/node_modules...');
const depsToCopy = ['better-sqlite3', '@lancedb', '@xenova', 'onnxruntime-node', 'ws', 'bindings', 'node-gyp-build', '@anthropic-ai'];
for (const dep of depsToCopy) {
  const src = path.join(process.cwd(), 'node_modules', dep);
  const dest = path.join(distDir, 'node_modules', dep);
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
    console.log(`  -> Copied ${dep}`);
  }
}

const nmPath = path.join(distDir, 'node_modules');
if (existsSync(nmPath)) {
  const standalonePath = path.join(distDir, 'standalone_node_modules');
  if (existsSync(standalonePath)) {
    import('fs').then(fs => fs.rmSync(standalonePath, { recursive: true, force: true }));
  }
  import('fs').then(fs => fs.renameSync(nmPath, standalonePath));
  console.log('[build-exe] Renamed node_modules to standalone_node_modules to bypass electron-builder ignores');
}

console.log('[build-exe] Preparation done. Proceeding to electron-builder...');
