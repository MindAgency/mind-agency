/**
 * Mind Agency — Electron Desktop App
 *
 * Architecture:
 *   App code (.next/, node_modules/) → EXE directory (read-only)
 *   User data  (Agents/, Groups/)    → %APPDATA%/MindAgency/ (writable)
 *
 * On first launch, seed data is copied from the bundled app to AppData.
 * Agents can then freely create groups, send emails, etc. at runtime.
 */

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// ── Config ───────────────────────────────────────────────

const isDev = !app.isPackaged;
const APP_ROOT = isDev ? path.resolve(__dirname, '..') : app.getAppPath();

// Mutable data goes alongside the EXE, not in %APPDATA%
// v0.4: Use user's home directory if exe dir is not writable
const DATA_DIR = isDev
  ? APP_ROOT
  : (() => {
      const exeDir = path.join(path.dirname(app.getPath('exe')), 'mind-data');
      try { fs.mkdirSync(exeDir, { recursive: true }); return exeDir; }
      catch { return path.join(app.getPath('home'), 'MindAgency-data'); }
    })();

const PORT = parseInt(process.env.MIND_PORT || '3000', 10);
const URL = `http://127.0.0.1:${PORT}`;

let win = null;

// ── Seed data on first run ───────────────────────────────

function seedDataDir() {
  if (isDev) return; // In dev, use project root directly

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Source: try asar first, then .next-server (where standalone puts them)
  const srcRoot = fs.existsSync(path.join(APP_ROOT, 'Agents')) ? APP_ROOT
    : fs.existsSync(path.join(DATA_DIR, '.next-server', 'Agents')) ? path.join(DATA_DIR, '.next-server')
    : APP_ROOT;

  // Seed Agents/ and Groups/ — only copy missing subdirectories
  for (const m of ['Agents', 'Groups']) {
    const src = path.join(srcRoot, m);
    const dest = path.join(DATA_DIR, m);

    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    if (fs.existsSync(src)) {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // Skip test/real-test directories
        if (entry.name.startsWith('real-test') || entry.name === 'test-agent') continue;
        const destSub = path.join(dest, entry.name);
        if (!fs.existsSync(destSub)) {
          try {
            copyDir(path.join(src, entry.name), destSub);
            console.log(`[mind]   ✓ ${m}/${entry.name} seeded`);
          } catch (e) {
            console.log(`[mind]   ⚠ Failed to copy ${m}/${entry.name}: ${e.message}`);
          }
        }
      }
    }
  }
  // Create .audit/.mind if absent (preserve agent memories between runs)
  for (const m of ['.audit', '.mind']) {
    const d = path.join(DATA_DIR, m);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  // Clean stale agent memories referencing agents no longer in the bundle
  const mindAgentsDir = path.join(DATA_DIR, '.mind', 'agents');
  if (fs.existsSync(mindAgentsDir)) {
    try {
      const known = new Set(fs.readdirSync(path.join(APP_ROOT, 'Agents')).filter(d => fs.statSync(path.join(APP_ROOT, 'Agents', d)).isDirectory()));
      for (const a of fs.readdirSync(mindAgentsDir)) {
        if (!known.has(a)) {
          try { fs.rmSync(path.join(mindAgentsDir, a), { recursive: true, force: true }); console.log(`[mind]   ✗ removed stale memory for ${a}`); } catch {}
        }
      }
    } catch {}
  }

}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, e.name);
    const dp = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

// ── Helpers ──────────────────────────────────────────────

function waitForServer(retries, delay) {
  return new Promise((resolve, reject) => {
    function tryConnect(n) {
      if (n <= 0) return reject(new Error('Server timeout'));
      http.get(URL, (res) => {
        if (res.statusCode < 500) resolve();
        else setTimeout(() => tryConnect(n - 1), delay);
      }).on('error', () => setTimeout(() => tryConnect(n - 1), delay));
    }
    tryConnect(retries);
  });
}

// ── Window ───────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900,
    minWidth: 960, minHeight: 640,
    title: 'Mind Agency',
    frame: false,
    icon: path.join(APP_ROOT, 'electron', 'icon.png'),
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    // v0.4: Check for updates after window is ready + periodic check
    setTimeout(checkForUpdates, 5000);
    setInterval(checkForUpdates, 3600_000); // check every hour
  });

  win.on('closed', () => { win = null; });

  win.loadURL(URL);
}

// ── IPC: Window controls ──────────────────────────────────

ipcMain.on('window:minimize', () => { win?.minimize(); });
ipcMain.on('window:maximize', () => {
  if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
});
ipcMain.on('window:close', () => { win?.close(); });
ipcMain.handle('window:isMaximized', () => win?.isMaximized() || false);
ipcMain.on('window:isMaximized', (event) => {
  event.returnValue = win?.isMaximized() || false;
});

// ── Start ────────────────────────────────────────────────

/** Child process handles — hoisted for will-quit cleanup */
let nextChild = null;
let wsChild = null;

// ── Auto-Update (v0.4) ──────────────────────────────────────────────

const CURRENT_VERSION = app.getVersion();
const GITHUB_REPO = 'MindAgency/mind-agency';
const UPDATE_CHECK_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

async function checkForUpdates() {
  if (isDev) return;
  try {
    const { default: https } = await import('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get(UPDATE_CHECK_URL, {
        headers: { 'User-Agent': 'Mind-Agency-Desktop' },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('parse error')); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });

    if (!data.tag_name) return;
    const latestVersion = data.tag_name.replace(/^v/, '');
    if (latestVersion === CURRENT_VERSION) {
      console.log(`[update] Current version ${CURRENT_VERSION} is up to date`);
      return;
    }

    console.log(`[update] New version available: ${latestVersion} (current: ${CURRENT_VERSION})`);

    // Find the exe asset
    const asset = (data.assets || []).find(a => a.name.endsWith('.exe') && (a.name.includes('Mind Agency') || a.name.includes('Mind-Agency')));
    if (!asset) {
      console.log('[update] No exe asset found in release');
      return;
    }

    // Notify renderer about available update
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('update-available', {
        currentVersion: CURRENT_VERSION,
        newVersion: latestVersion,
        downloadUrl: asset.browser_download_url,
        releaseNotes: data.body || '',
      });
    }
  } catch (err) {
    console.log(`[update] Check failed: ${err.message}`);
  }
}

/** Download update and replace current exe */
async function downloadUpdate(downloadUrl, newVersion) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('update-progress', { status: 'downloading', percent: 0 });
  }

  try {
    const { default: https } = await import('https');
    const { default: http } = await import('http');

    const exePath = app.getPath('exe');
    const tempPath = exePath + '.update';

    await new Promise((resolve, reject) => {
      const protocol = downloadUrl.startsWith('https') ? https : http;
      const req = protocol.get(downloadUrl, { timeout: 300000 }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // Follow redirect
          protocol.get(res.headers.location, { timeout: 300000 }, (res2) => {
            downloadStream(res2, tempPath, resolve, reject);
          }).on('error', reject);
          return;
        }
        downloadStream(res, tempPath, resolve, reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
    });

    function downloadStream(stream, dest, resolve, reject) {
      const total = parseInt(stream.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const ws = fs.createWriteStream(dest);
      stream.on('data', (chunk) => {
        downloaded += chunk.length;
        const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('update-progress', { status: 'downloading', percent });
        }
      });
      stream.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    }

    console.log(`[update] Download complete: ${tempPath}`);

    // Replace current exe with downloaded one
    // On Windows, we can't replace a running exe directly.
    // Instead, we write a batch script that waits for the process to exit, replaces the exe, then restarts.
    const batPath = exePath + '.update.bat';
    const batContent = `
@echo off
timeout /t 2 /nobreak > nul
move /y "${tempPath}" "${exePath}"
start "" "${exePath}"
del "%~f0"
`;
    fs.writeFileSync(batPath, batContent, 'utf-8');

    // Notify user
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update-progress', { status: 'ready', newVersion });
    }

    console.log(`[update] Update ready. Restart to apply v${newVersion}`);
  } catch (err) {
    console.error(`[update] Download failed: ${err.message}`);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update-progress', { status: 'error', error: err.message });
    }
  }
}

/** Restart app to apply update */
function restartForUpdate() {
  const exePath = app.getPath('exe');
  const batPath = exePath + '.update.bat';
  if (fs.existsSync(batPath)) {
    const { spawn } = require('child_process');
    spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }
}

// IPC handlers for renderer
ipcMain.handle('update:check', checkForUpdates);
ipcMain.handle('update:download', (event, downloadUrl, newVersion) => downloadUpdate(downloadUrl, newVersion));
ipcMain.handle('update:restart', restartForUpdate);
ipcMain.handle('update:version', () => CURRENT_VERSION);

app.whenReady().then(async () => {
  console.log(`[mind] v${app.getVersion()} — ${isDev ? 'DEV' : 'PROD'}`);
  console.log(`[mind] App:  ${APP_ROOT}`);
  console.log(`[mind] Data: ${DATA_DIR}`);

  // (1) Prepare writable data directory
  seedDataDir();

  // (2) Tell Next.js/MCP where data and app code live
  process.env.MIND_DATA_DIR = DATA_DIR;
  process.env.MIND_APP_DIR  = APP_ROOT;
  process.env.NODE_ENV = 'production';
  process.env.PORT = String(PORT);
  process.env.HOSTNAME = '127.0.0.1';

  // In packaged mode, claude.exe's MCP config needs to use Electron's
  // bundled Node.js (process.execPath) instead of system `node` / `npx tsx`.
  // chat.ts checks this env var to switch MCP command.
  if (!isDev) {
    process.env.MIND_ELECTRON_EXE = process.execPath;
  }

  // (3) Extract standalone to writable dir and start server
  console.log('[mind] Starting Next.js server...');
  try {
    // In packaged mode, find standalone server:
    // 1. DATA_DIR/.next-server (writable, for future updates)
    // 2. EXE旁边的/.next-server (build-exe.mjs copies here)
    // 3. APP_ROOT/.next/standalone (asar, fallback)
    let serverDir = isDev ? APP_ROOT : path.join(DATA_DIR, '.next-server');
    let serverJs = path.join(serverDir, 'server.js');

    if (!isDev) {
      // Try DATA_DIR first
      if (!fs.existsSync(serverJs)) {
        // Try resources path (electron-builder extraResources)
        const resourcesServer = path.join(process.resourcesPath, '.next-server');
        // Try EXE旁边的/.next-server (legacy packager)
        const exeDir = path.dirname(app.getPath('exe'));
        const exeNextServer = path.join(exeDir, '.next-server');
        
        if (fs.existsSync(path.join(resourcesServer, 'server.js'))) {
          serverDir = resourcesServer;
          serverJs = path.join(serverDir, 'server.js');
          console.log('[mind] Found standalone at resources:', serverDir);
        } else if (fs.existsSync(path.join(exeNextServer, 'server.js'))) {
          serverDir = exeNextServer;
          serverJs = path.join(serverDir, 'server.js');
          console.log('[mind] Found standalone at EXE dir:', serverDir);
        } else {
          // Try asar
          const srcStandalone = path.join(APP_ROOT, '.next', 'standalone');
          if (fs.existsSync(path.join(srcStandalone, 'server.js'))) {
            console.log('[mind] Extracting standalone server from asar...');
            copyDir(srcStandalone, serverDir);
            serverJs = path.join(serverDir, 'server.js');
          } else {
            console.error('[mind] No standalone server found!');
          }
        }
      }

      // Copy static files if needed
      const staticDest = path.join(serverDir, '.next', 'static');
      if (!fs.existsSync(staticDest)) {
        const srcStatic = fs.existsSync(path.join(APP_ROOT, '.next', 'static'))
          ? path.join(APP_ROOT, '.next', 'static')
          : path.join(path.dirname(app.getPath('exe')), '.next-server', '.next', 'static');
        if (fs.existsSync(srcStatic)) {
          copyDir(srcStatic, staticDest);
        }
      }

      // Copy public files if needed
      const publicDest = path.join(serverDir, 'public');
      const srcPublic = fs.existsSync(path.join(APP_ROOT, 'public'))
        ? path.join(APP_ROOT, 'public')
        : path.join(path.dirname(app.getPath('exe')), '.next-server', 'public');
      if (fs.existsSync(srcPublic)) {
        if (fs.existsSync(publicDest)) fs.rmSync(publicDest, { recursive: true, force: true });
        copyDir(srcPublic, publicDest);
      }

      // Rename standalone_node_modules back to node_modules
      const standaloneNM = path.join(serverDir, 'standalone_node_modules');
      const targetNM = path.join(serverDir, 'node_modules');
      if (fs.existsSync(standaloneNM) && !fs.existsSync(targetNM)) {
        fs.renameSync(standaloneNM, targetNM);
        console.log('[mind] Restored node_modules from standalone_node_modules');
      }

      console.log('[mind] Server dir:', serverDir);
    }

    // Use Electron's bundled Node.js to run Next.js
    let nodePath = isDev ? 'node' : process.execPath;
    let spawnOpts = {
      cwd: serverDir,
      env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', MIND_DATA_DIR: DATA_DIR, MIND_APP_DIR: APP_ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    
    if (!isDev) {
      spawnOpts.env.ELECTRON_RUN_AS_NODE = '1';
    }

    console.log('[mind] Node executable:', nodePath);
    const serverProc = spawn(nodePath, [serverJs], spawnOpts);
    serverProc.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`));
    serverProc.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`));
    serverProc.on('error', (e) => console.error('[mind] Server error:', e.message));
    // Track both processes — don't overwrite wsChild
    nextChild = serverProc;
  } catch (e) {
    console.error('[mind] Server start error:', e.message);
  }

  // (4) Wait for server ready
  console.log('[mind] Waiting for server...');
  try {
    await waitForServer(30, 400);
  } catch (e) {
    console.error('[mind] Server did not become ready:', e.message);
  }

  // (4b) Start WebSocket notification + Workflow server on :3001
  console.log('[mind] Starting WebSocket server...');
  try {
    // Packaged: use bundled server.mjs (no tsx needed)
    // Dev: use npx tsx server.ts
    const wsEntry = isDev
      ? path.join(APP_ROOT, 'server.ts')
      : path.join(APP_ROOT, 'server.mjs');
    if (fs.existsSync(wsEntry)) {
      const spawnOpts = {
        cwd: APP_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MIND_DATA_DIR: DATA_DIR,
          MIND_APP_DIR: APP_ROOT,
          PORT: String(PORT),
          WS_PORT: '3001',
        },
      };
      if (isDev) {
        wsChild = spawn('npx.cmd', ['tsx', wsEntry], spawnOpts);
      } else {
        // Packaged: run bundled server.mjs directly with Electron's Node
        wsChild = spawn(
          process.execPath,
          [wsEntry],
          { ...spawnOpts, env: { ...spawnOpts.env, ELECTRON_RUN_AS_NODE: '1' } }
        );
      }
      wsChild.stdout.on('data', (d) => process.stdout.write(`[ws] ${d}`));
      wsChild.stderr.on('data', (d) => process.stderr.write(`[ws] ${d}`));
      wsChild.on('error', (e) => console.error('[mind] WS server error:', e.message));
      wsChild.on('exit', (code) => console.log(`[mind] WS server exited (${code})`));
    }
  } catch (e) {
    console.error('[mind] Failed to start WS server:', e.message);
  }

  // (5) Show window
  console.log('[mind] Ready → opening window');
  createWindow();
});

app.on('window-all-closed', () => { app.quit(); });
app.on('will-quit', () => {
  // Kill Next.js child process
  if (nextChild) {
    try { nextChild.kill(); } catch {}
  }
  // Kill WS child process
  if (wsChild) {
    try { wsChild.kill(); } catch {}
  }
  // Only kill claude.exe processes that are direct children of this Electron process
  try {
    const { execSync } = require('child_process');
    const ourPid = process.pid;
    // Find child claude.exe processes via Windows WMIC, kill only those
    const out = execSync(
      `wmic process where "ParentProcessId=${ourPid} and Name='claude.exe'" get ProcessId /format:csv 2>nul`,
      { windowsHide: true, timeout: 5000, encoding: 'utf8' }
    );
    const pids = out.split('\n').filter(l => /\d+/.test(l)).map(l => l.split(',').pop()?.trim()).filter(Boolean);
    for (const pid of pids) {
      try { execSync(`taskkill /F /PID ${pid} /T 2>nul`, { windowsHide: true, timeout: 3000 }); } catch {}
    }
  } catch {}
});
app.on('activate', () => { if (!win) createWindow(); });
