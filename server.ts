/**
 * Unified server for Mind Agency — combines WebSocket and HTTP in single process.
 *
 * This replaces the dual-process architecture with a single unified server
 * that shares EventBus and IPC state.
 *
 * Start: npx tsx server.ts   (or via `npm run dev:ws`)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { EventBus, EventType, EventBusError, createEvent, WorkflowEngine, parseWorkflowYaml, setEventBus } from './src/lib/event-bus.js';
import type { EventMessage, WorkflowRunRecord } from './src/lib/event-bus.js';
import { startScheduler, stopScheduler } from './src/lib/scheduler.js';
import { startWatcher, stopWatcher } from './src/lib/watcher.js';
import { killAllClaudeProcesses } from './src/lib/chat.js';
import { closeDb } from './src/lib/workflow-checkpoint.js';
import { cancelAllWatchers } from './src/lib/workflow-bridge.js';
import { initConsensusHandlers } from './src/lib/consensus.js';
import { ipcStore, getIPCLock } from './src/lib/ipc.js';
import { EmbeddedWebSocketServer } from './src/lib/ws-server.js';
import {
  getAgentAccount, listAgentAccounts, deposit as econDeposit, transfer as econTransfer,
  getBalance, getLeaderboard, reward as econReward, withdraw as econWithdraw,
  getAgentPricing, setAgentPricing, getAgentTrust, recordTaskCompletion,
  checkTransferLimits, recordTransfer, saveMarketplaceTask, loadMarketplaceTask,
  listMarketplaceTasks, calculateReward, calculateTaskCost, getTrustTier,
} from './src/lib/token-economy.js';

const PORT = parseInt(process.env.WS_PORT || '3001', 10);
const APP_PORT = process.env.MIND_PORT || process.env.PORT || '3000';
const SERVER_SECRET = process.env.MIND_SERVER_SECRET || '';
const REQUIRE_AUTH = process.env.MIND_REQUIRE_AUTH === '1' || process.env.MIND_REQUIRE_AUTH === 'true';
const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit for request bodies
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  `http://127.0.0.1:${APP_PORT}`,
  `http://localhost:${APP_PORT}`,
]);

// ── Auth helper ──────────────────────────────────────────────────────────

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  // Skip auth if no secret configured (dev mode)
  if (!SERVER_SECRET && !REQUIRE_AUTH) return true;

  if (!SERVER_SECRET) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Authentication is required but MIND_SERVER_SECRET is not configured' }));
    return false;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${SERVER_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
        req.destroy();
        resolve(null);
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(null));
  });
}

// ── EventBus singleton ───────────────────────────────────────────────────

const bus = new EventBus();
setEventBus(bus); // v0.4: register singleton for in-process subscribers

// ── WorkflowEngine singleton ───────────────────────────────────────────────

import { ChatStepExecutor } from './src/lib/event-bus.js';
import { getEngine } from './src/lib/workflow-bridge.js';
const workflowEngine = getEngine(bus);
console.log('[server] WorkflowEngine using shared singleton from workflow-bridge');
initConsensusHandlers();

// v1.2: Timeout monitoring — check every 30s for stuck WAITING steps
setInterval(() => {
  try { workflowEngine.tick(); } catch (e) { console.error('[server] tick() error:', e); }
}, 30_000);

// ── Embedded WebSocket Server ─────────────────────────────────────────────

const wsServer = new EmbeddedWebSocketServer(bus, PORT);

// ── HTTP Server ──────────────────────────────────────────────────────────

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── CSRF: Origin header check for mutating requests ─────────────────
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    const origin = req.headers.origin;
    if (origin) {
      if (!ALLOWED_ORIGINS.has(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'CSRF: Origin not allowed' }));
        return;
      }
    }
    // Absent Origin is allowed (non-browser clients like curl, MCP)
  }

  // ── GET /health ─────────────────────────────────────────────────────

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      wsClients: wsServer.getClientCount(),
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // ── GET /events/stats ──────────────────────────────────────────────

  if (req.method === 'GET' && req.url === '/events/stats') {
    const stats = bus.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...stats, wsClients: wsServer.getClientCount() }, null, 2));
    return;
  }

  // ── POST /broadcast (legacy group chat) ────────────────────────────

  if (req.method === 'POST' && req.url === '/broadcast') {
    if (!checkAuth(req, res)) return;
    readBody(req, res).then(body => {
      if (body === null) return;
      try {
        const msg = JSON.parse(body);
        const sent = wsServer.broadcast(msg, 'messages');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, clients: sent }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      }
    });
    return;
  }

  // ── POST /events (EventBus emit) ───────────────────────────────────

  if (req.method === 'POST' && req.url === '/events') {
    if (!checkAuth(req, res)) return;
    readBody(req, res).then(body => {
      if (body === null) return;
      try {
        const eventInput = JSON.parse(body);

        // Normalize: accept string event type or enum value
        const event = {
          event: eventInput.event as EventType,
          payload: eventInput.payload || {},
          timestamp: eventInput.timestamp || Date.now(),
          source: eventInput.source || 'system',
          id: eventInput.id || randomUUID(),
        };

        bus.emit(event);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, eventId: event.id }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Economy API endpoints
  // ══════════════════════════════════════════════════════════════════════

  const urlObj = req.url ? new URL(req.url, `http://${req.headers.host || 'localhost'}`) : null;
  const pathname = urlObj?.pathname || '';

  // ── GET /api/economy/account?agent=xxx ──────────────────────────────
  if (req.method === 'GET' && pathname === '/api/economy/account') {
    if (!checkAuth(req, res)) return;
    const agent = urlObj?.searchParams.get('agent') || '';
    if (!agent) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'agent required' })); return; }
    const account = getAgentAccount(agent);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, account }));
    return;
  }

  // ── GET /api/economy/accounts ───────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/economy/accounts') {
    if (!checkAuth(req, res)) return;
    const accounts = listAgentAccounts();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, accounts }));
    return;
  }

  // ── POST /api/economy/deposit ───────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/economy/deposit') {
    if (!checkAuth(req, res)) return;
    readBody(req, res).then(body => {
      if (body === null) return;
      try {
        const { agent, amount, from, reason } = JSON.parse(body);
        if (!agent || !amount) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'agent and amount required' })); return; }
        const newBalance = econDeposit(agent, amount, reason || `deposited by ${from || 'system'}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, balance: newBalance }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /api/economy/transfer ──────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/economy/transfer') {
    if (!checkAuth(req, res)) return;
    readBody(req, res).then(body => {
      if (body === null) return;
      try {
        const { from, to, amount, reason } = JSON.parse(body);
        if (!from || !to || !amount) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'from, to, amount required' })); return; }
        // Anti-abuse check
        const limitError = checkTransferLimits(from, amount);
        if (limitError) { res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: limitError, balance: getBalance(from) })); return; }
        const ok = econTransfer(from, to, amount, reason);
        if (ok) {
          recordTransfer(amount);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, fromBalance: getBalance(from) }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, balance: getBalance(from) }));
        }
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/economy/leaderboard ────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/economy/leaderboard') {
    if (!checkAuth(req, res)) return;
    const leaderboard = getLeaderboard().map(a => ({
      agent: a.agent, balance: a.balance, tasks: a.transactions.filter(t => t.type === 'reward').length,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, leaderboard }));
    return;
  }

  // ── POST /api/economy/reward ────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/economy/reward') {
    if (!checkAuth(req, res)) return;
    readBody(req, res).then(body => {
      if (body === null) return;
      try {
        const { agent, task, amount, quality } = JSON.parse(body);
        if (!agent || amount === undefined) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'agent and amount required' })); return; }
        const account = econReward(agent, amount, task, quality || 'normal');
        // Also record trust
        recordTaskCompletion(agent, quality || 'normal', `task: ${task}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, balance: account.balance }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/economy/pricing?agent=xxx ──────────────────────────────
  if (req.method === 'GET' && pathname === '/api/economy/pricing') {
    if (!checkAuth(req, res)) return;
    const agent = urlObj?.searchParams.get('agent') || '';
    if (!agent) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'agent required' })); return; }
    const pricing = getAgentPricing(agent);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, pricing }));
    return;
  }

  // ── POST /api/economy/pricing ───────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/economy/pricing') {
    if (!checkAuth(req, res)) return;
    readBody(req, res).then(body => {
      if (body === null) return;
      try {
        const { agent, ...updates } = JSON.parse(body);
        if (!agent) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'agent required' })); return; }
        const pricing = setAgentPricing(agent, updates);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, pricing }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── GET /api/economy/trust?agent=xxx ────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/economy/trust') {
    if (!checkAuth(req, res)) return;
    const agent = urlObj?.searchParams.get('agent') || '';
    if (!agent) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'agent required' })); return; }
    const trust = getAgentTrust(agent);
    const tier = getTrustTier(trust.score);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, trust, tier }));
    return;
  }

  // ── GET/POST /api/economy/marketplace ───────────────────────────────
  if (req.method === 'GET' && pathname === '/api/economy/marketplace') {
    if (!checkAuth(req, res)) return;
    const action = urlObj?.searchParams.get('action') || 'list_tasks';

    if (action === 'list_tasks') {
      const group = urlObj?.searchParams.get('group') || '';
      const status = urlObj?.searchParams.get('status') || undefined;
      if (!group) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'group required' })); return; }
      const tasks = listMarketplaceTasks(group, status);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, tasks }));
      return;
    }

    if (action === 'task_detail') {
      const group = urlObj?.searchParams.get('group') || '';
      const task_id = urlObj?.searchParams.get('task_id') || '';
      const task = loadMarketplaceTask(group, task_id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, task }));
      return;
    }

    if (action === 'search_agents') {
      const query = urlObj?.searchParams.get('query') || '';
      const group = urlObj?.searchParams.get('group') || '';
      // Search agents by name, role, or skill
      const allAccounts = listAgentAccounts();
      const agents = allAccounts
        .filter(a => {
          const pricing = getAgentPricing(a.agent);
          const trust = getAgentTrust(a.agent);
          const skillsDir = require('path').join(process.cwd(), 'Agents', a.agent, 'skills');
          let skills: string[] = [];
          try { skills = require('fs').readdirSync(skillsDir, { withFileTypes: true }).filter((d: any) => d.isDirectory()).map((d: any) => d.name); } catch {}
          const q = query.toLowerCase();
          return a.agent.toLowerCase().includes(q)
            || pricing.role.toLowerCase().includes(q)
            || skills.some(s => s.toLowerCase().includes(q));
        })
        .map(a => {
          const pricing = getAgentPricing(a.agent);
          const trust = getAgentTrust(a.agent);
          const skillsDir = require('path').join(process.cwd(), 'Agents', a.agent, 'skills');
          let skills: string[] = [];
          try { skills = require('fs').readdirSync(skillsDir, { withFileTypes: true }).filter((d: any) => d.isDirectory()).map((d: any) => d.name); } catch {}
          return { agent: a.agent, role: pricing.role, trust: trust.score, balance: a.balance, skills };
        });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, agents }));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/economy/marketplace') {
    if (!checkAuth(req, res)) return;
    readBody(req, res).then(body => {
      if (body === null) return;
      try {
        const data = JSON.parse(body);
        const { action, group, task_id, agent, quality, rating, comment, reason, title, description, reward, required_skills, difficulty, max_claims } = data;

        if (action === 'complete_task') {
          const task = loadMarketplaceTask(group, task_id);
          if (!task) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'task not found' })); return; }
          if (task.status !== 'in_progress' && task.status !== 'assigned') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: `task is ${task.status}, cannot complete` })); return;
          }
          task.status = 'completed';
          task.completedAt = Date.now();
          task.quality = quality || 'normal';
          saveMarketplaceTask(task);

          // Calculate and发放 reward
          const rewardAmount = calculateReward(agent || task.assignedTo || '', task.reward, task.difficulty || 'medium');
          const qualityMult = quality === 'bonus' ? 1.5 : 1;
          const finalReward = Math.ceil(rewardAmount * qualityMult);
          econReward(agent || task.assignedTo || '', finalReward, task_id, quality || 'normal');

          // Record trust
          const trustResult = recordTaskCompletion(agent || task.assignedTo || '', quality || 'normal', `task: ${task_id}`);

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, reward: finalReward, trustDelta: trustResult.history[trustResult.history.length - 1]?.delta || 0 }));
          return;
        }

        if (action === 'create_task') {
          const { title, description, reward, difficulty, required_skills, max_claims, posted_by } = data;
          if (!group || !task_id || !title || !description) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'group, task_id, title, description required' })); return;
          }
          const task = {
            id: task_id, group, title, description,
            reward: reward || 0,
            difficulty: difficulty || 'medium',
            requiredSkills: required_skills ? (typeof required_skills === 'string' ? required_skills.split(',').map((s: string) => s.trim()) : required_skills) : [],
            maxClaims: max_claims || 1,
            postedBy: posted_by || agent || 'system',
            assignedTo: undefined,
            claims: [],
            status: 'open' as const,
            createdAt: Date.now(),
          };
          saveMarketplaceTask(task);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, task }));
          return;
        }

        if (action === 'cancel_task') {
          const task = loadMarketplaceTask(group, task_id);
          if (!task) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'task not found' })); return; }
          task.status = 'cancelled';
          saveMarketplaceTask(task);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (action === 'rate_task') {
          const task = loadMarketplaceTask(group, task_id);
          if (!task) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'task not found' })); return; }
          if (task.status !== 'completed') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'can only rate completed tasks' })); return; }
          task.rating = rating;
          saveMarketplaceTask(task);
          // Bonus trust for high ratings
          if (rating >= 4 && task.assignedTo) {
            recordTaskCompletion(task.assignedTo, 'bonus', `high rating on ${task_id}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'unknown action' }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── POST /workflows/run — Trigger workflow ─────────────────────────────
  if (req.method === 'POST' && pathname === '/workflows/run') {
    readBody(req, res).then(async body => {
      if (body === null) return;
      try {
        const { group, workflow, triggerStepId } = JSON.parse(body);
        if (!group || !workflow) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'group and workflow required' }));
          return;
        }
        const { triggerWorkflow } = await import('./src/lib/workflow-bridge.js');
        const result = await triggerWorkflow(group, triggerStepId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── GET /workflows/runs — List workflow runs ──────────────────────────
  if (req.method === 'GET' && pathname === '/workflows/runs') {
    import('./src/lib/workflow-bridge.js')
      .then(({ getRuns }) => {
        const runs = getRuns();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, runs }));
      })
      .catch((e: any) => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }

  // ── POST /workflows/approve — Approve human_approval step ─────────────
  if (req.method === 'POST' && pathname === '/workflows/approve') {
    readBody(req, res).then(async body => {
      if (body === null) return;
      try {
        const { approvalId, decision, comment } = JSON.parse(body);
        const { approveWorkflow } = await import('./src/lib/workflow-bridge.js');
        const result = approveWorkflow(approvalId, decision === 'REJECTED' ? 'REJECTED' : 'APPROVED', comment);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── Everything else ────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not Found', path: req.url, method: req.method }));
});

// ── Start Server ─────────────────────────────────────────────────────────

async function start() {
  // Start HTTP server
  server.listen(PORT + 1, () => {
    console.log(`[server] HTTP server listening on port ${PORT + 1}`);
  });

  // Start WebSocket server
  await wsServer.start();

  // Store server info in IPC
  ipcStore.set('server:startup', Date.now());
  ipcStore.set('server:pid', process.pid);
  ipcStore.set('server:httpPort', PORT + 1);
  ipcStore.set('server:wsPort', PORT);

  // Start scheduler
  startScheduler();

  // Start file system watcher (real-time trigger for auto-respond)
  startWatcher();

  console.log(`[server] Unified server started (HTTP: ${PORT + 1}, WS: ${PORT})`);
}

// ── Graceful Shutdown ────────────────────────────────────────────────────

async function shutdown() {
  console.log('[server] Shutting down...');

  // Stop scheduler
  stopScheduler();

  // Stop file watcher
  try { stopWatcher(); } catch {}

  // Kill all claude processes
  try { killAllClaudeProcesses(); } catch {}

  // Cancel all watchers
  try { cancelAllWatchers(); } catch {}

  // Close checkpoint DB
  try { closeDb(); } catch {}

  // Stop WebSocket server
  await wsServer.stop();

  // Close HTTP server
  await new Promise<void>((resolve) => {
    server.close(() => {
      console.log('[server] HTTP server closed');
      resolve();
    });
  });

  // Clear IPC state
  ipcStore.delete('server:startup');
  ipcStore.delete('server:pid');

  console.log('[server] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ────────────────────────────────────────────────────────────────

start().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exit(1);
});
