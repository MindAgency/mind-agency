import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';

const APP_PORT = process.env.SMOKE_APP_PORT || '3100';
const WS_PORT = process.env.SMOKE_WS_PORT || '3101';
const WS_HTTP_PORT = String(Number.parseInt(WS_PORT, 10) + 1);
const ROOT = process.cwd();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-smoke-'));
const STANDALONE_SERVER = path.join(ROOT, '.next', 'standalone', 'server.js');
const TSX_BIN = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const children = [];

function log(message) {
  console.log(`[smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MIND_DATA_DIR: DATA_DIR,
      MIND_PORT: APP_PORT,
      PORT: APP_PORT,
      WS_PORT,
      WS_HTTP_PORT,
      WS_HOST: '127.0.0.1',
      ...options.env,
    },
  });

  child.stdout.on('data', data => process.stdout.write(`[${options.name || command}] ${data}`));
  child.stderr.on('data', data => process.stderr.write(`[${options.name || command}] ${data}`));
  children.push(child);
  return child;
}

async function killChild(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
  } else {
    child.kill('SIGTERM');
  }
}

async function cleanup() {
  await Promise.allSettled(children.map(killChild));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

async function waitForUrl(url, { timeoutMs = 30000, accept = res => res.ok } = {}) {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (accept(res)) return res;
      lastError = `${res.status} ${res.statusText}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fail(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ''}`);
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    fail(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  }
  return { res, body };
}

async function checkWebSocketEvent() {
  const wsUrl = `ws://127.0.0.1:${WS_PORT}`;
  const emitUrl = `http://127.0.0.1:${WS_HTTP_PORT}/events`;

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for WebSocket event'));
    }, 10000);

    ws.on('message', async data => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connected') {
        ws.send(JSON.stringify({ type: 'subscribe', filter: {}, options: { scope: 'all' } }));
      } else if (msg.type === 'subscribed') {
        const { res, body } = await getJson(emitUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: `http://127.0.0.1:${APP_PORT}`,
          },
          body: JSON.stringify({
            event: 'task.created',
            payload: { taskId: 'smoke-runtime' },
            source: 'smoke',
          }),
        });
        if (!res.ok || !body?.ok) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`Failed to emit smoke event: ${res.status} ${JSON.stringify(body)}`));
        }
      } else if (msg.type === 'event' && msg.event === 'task.created') {
        clearTimeout(timeout);
        ws.close();
        resolve();
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`WebSocket error: ${msg.code} ${msg.message}`));
      }
    });

    ws.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID')) || !fs.existsSync(STANDALONE_SERVER)) {
    fail('Next.js build not found. Run `npm run build` before `npm run smoke:runtime`.');
  }

  fs.mkdirSync(path.join(DATA_DIR, 'Agents'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'Groups'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, '.mind'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, '.audit'), { recursive: true });

  log(`using temp data dir: ${DATA_DIR}`);
  log(`starting Next on :${APP_PORT}`);
  spawnManaged(process.execPath, [STANDALONE_SERVER], { name: 'next' });

  log(`starting WS server on :${WS_PORT} (HTTP control :${WS_HTTP_PORT})`);
  spawnManaged(process.execPath, [TSX_BIN, 'server.ts'], { name: 'ws' });

  log('waiting for WebSocket health');
  await waitForUrl(`http://127.0.0.1:${WS_HTTP_PORT}/health`);

  log('waiting for Next health');
  const healthRes = await waitForUrl(`http://127.0.0.1:${APP_PORT}/api/health`, {
    accept: res => res.status === 200,
  });
  const health = await healthRes.json();
  if (health.status !== 'healthy') fail(`Expected healthy status, got ${health.status}`);

  log('checking RAG stats endpoint');
  const { res: ragRes, body: ragStats } = await getJson(`http://127.0.0.1:${APP_PORT}/api/rag?action=stats`);
  if (!ragRes.ok || !ragStats?.ok) fail(`RAG stats failed: ${ragRes.status} ${JSON.stringify(ragStats)}`);

  log('checking WebSocket subscribe/event path');
  await checkWebSocketEvent();

  log('runtime smoke passed');
}

main()
  .catch(error => {
    console.error(`[smoke] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
