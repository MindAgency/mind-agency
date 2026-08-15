/**
 * dsh.ts — DeepSeek Harness agent backend for Mind Agency
 *
 * 每个 agent 轮次 = 一个子进程:
 *   dsh --profile headless <task>
 * headless profile:跑一个 task、打印最终 assistant 文本、退出。
 *
 * 设计要点:
 * - 多轮记忆:历史由 Mind Agency 注入 task 文本(与 relay 路径一致)
 * - 权限:DSH_PERMISSION_MODE=danger-full-access(approval: never,无人值守)
 * - cwd = DATA_DIR(项目根),agent 通过 DSH 原生 fs/pwsh 工具直接操作
 *   Agents/、Groups/ 文件系统(文件即协议)
 * - Windows 下 dsh 是 npm 全局的 .cmd shim:解析 shim 找到真实 bin.js,
 *   用 node 直接 spawn(避免 shell 引号吞换行问题)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './data-dir';

export interface DshRunOptions {
  task: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface DshRunResult {
  ok: boolean;
  reply: string;
  exitCode: number | null;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // reasoningEffort=max 时单轮可能很久

/** 解析 dsh 真实入口:DSH_BIN 环境变量 → PATH 上的 shim → null(回退 shell 模式) */
export function resolveDshEntry(): { js: string } | null {
  const override = process.env.DSH_BIN;
  if (override) {
    if (override.endsWith('.js')) return { js: override };
    if (override.endsWith('.cmd') || override.endsWith('.bat')) {
      const parsed = parseShim(override);
      if (parsed) return parsed;
    }
  }
  try {
    const where = spawnSync('where.exe', ['dsh'], { windowsHide: true, encoding: 'utf8' });
    if (where.status === 0) {
      const first = String(where.stdout).split(/\r?\n/).find(Boolean);
      if (first) {
        const parsed = parseShim(first.trim());
        if (parsed) return parsed;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/** 从 npm .cmd shim 中提取 "%dp0\node_modules\...\bin.js" 路径 */
function parseShim(shimPath: string): { js: string } | null {
  try {
    const content = fs.readFileSync(shimPath, 'utf-8');
    const m = content.match(/(["'][^"']*\.js["'])|([A-Za-z]:[^\s"']+\.js)/);
    if (m) {
      let js = (m[1] || m[2]).replace(/^["']|["']$/g, '');
      const base = path.dirname(shimPath);
      // npm 的 .cmd/.ps1 shim 两种常见变量:%~dp0 与 $basedir
      js = js.replace(/%~dp0/gi, base + path.sep).replace(/\$basedir/gi, base);
      return { js };
    }
  } catch {
    // fall through
  }
  return null;
}

function spawnSync(cmd: string, args: string[], opts: Record<string, unknown>) {
  const cp = require('child_process') as typeof import('child_process');
  return cp.spawnSync(cmd, args, opts);
}

export async function runDshAgent(opts: DshRunOptions): Promise<DshRunResult> {
  const cwd = opts.cwd || DATA_DIR;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_PERMISSION_MODE: 'danger-full-access',
    MIND_DATA_DIR: DATA_DIR,
    ...(opts.env || {}),
  };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    let child: import('child_process').ChildProcess;
    const entry = resolveDshEntry();
    if (entry) {
      child = spawn(process.execPath, [entry.js, '--profile', 'headless', opts.task], {
        cwd, env, windowsHide: true,
      });
    } else {
      // 回退:shell 模式(换行会被 cmd 引号规则吞掉,先压成空格)
      const safeTask = opts.task.replace(/\r?\n/g, ' ');
      child = spawn('dsh', ['--profile', 'headless', safeTask], {
        cwd, env, shell: true, windowsHide: true,
      });
    }

    const finish = (ok: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({
        ok,
        reply: stdout.trim(),
        exitCode: code,
        stderr: stderr.trim(),
        durationMs: Date.now() - t0,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { child.kill(); } catch { /* noop */ }
      stderr += '\n[dsh] timeout after ' + timeoutMs + 'ms';
      finish(false, null);
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      clearTimeout(timer);
      stderr += '\n[dsh] spawn error: ' + err.message;
      finish(false, null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0, code);
    });
  });
}
