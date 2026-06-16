/**
 * Background scheduler — event-driven.
 *
 * Subscribes to EventBus events and triggers agent responses.
 * No file watching needed — all operations go through Proxy.
 */

import { getAgency } from './agency';
import { EventType } from './event-bus';
import { broadcastWs } from './ws-embedded';

let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
const DEFAULT_HEARTBEAT_MS = 120_000; // 2 minutes default

// --- Adaptive heartbeat ---
const HEARTBEAT_ACTIVE_MS = 120_000;  // 2 min — when there's recent activity
const HEARTBEAT_IDLE_MS = 300_000;    // 5 min — when system is idle
const IDLE_THRESHOLD_MS = 300_000;    // 5 min no activity → switch to idle mode
let lastActivityTime = Date.now();

const stats = { triggered: 0, dispatched: 0 };

export function startScheduler(): void {
  console.log(`[scheduler] starting event-driven scheduler`);

  // Subscribe to EventBus events
  import('./event-bus').then(({ getEventBus, EventType }) => {
    const bus = getEventBus();
    const agency = getAgency();

    // Subscribe to TASK_ASSIGNED events
    bus.subscribe(
      { event: EventType.TASK_ASSIGNED },
      { scope: 'events' },
      'scheduler:task-assigned',
      async (msg) => {
        const agent = msg.payload?.agent as string;
        const prompt = msg.payload?.prompt as string;
        if (agent && prompt) {
          console.log(`[scheduler] EventBus: task assigned to ${agent}`);
          const proxy = agency.getAgent(agent);
          // Send the actual task prompt to the agent
          await proxy.chat(prompt);
          stats.triggered++;
        }
      }
    );
    console.log(`[scheduler] subscribed to TASK_ASSIGNED events`);

    // Subscribe to MESSAGE_MENTION events
    bus.subscribe(
      { event: EventType.MESSAGE_MENTION },
      { scope: 'events' },
      'scheduler:message-mention',
      async (msg) => {
        const mentioned = msg.payload?.mentioned as string[];
        const group = msg.payload?.group as string;
        if (mentioned && mentioned.length > 0) {
          console.log(`[scheduler] EventBus: message.mention in ${group}, triggering ${mentioned.join(', ')}`);
          for (const agent of mentioned) {
            const proxy = agency.getAgent(agent);
            await proxy.chat(`[Group Message] 在 ${group} 群组中有新消息，请检查并回复。`);
            stats.triggered++;
          }
        }
      }
    );
    console.log(`[scheduler] subscribed to MESSAGE_MENTION events`);

  }).catch(e => console.log(`[scheduler] failed to subscribe to EventBus: ${e}`));

  // Start heartbeat
  startHeartbeat();

  console.log(`[scheduler] started`);
}

export function stopScheduler(): void {
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  console.log('[scheduler] stopped');
}

export function getSchedulerStats() {
  return { ...stats };
}

// ── Heartbeat ─────────────────────────────────────────────

function startHeartbeat(): void {
  const tickHeartbeat = async () => {
    const agency = getAgency();
    for (const proxy of agency.getAgents()) {
      try {
        await proxy.chat('[Heartbeat] 你被唤醒了。请自主检查是否有需要处理的事项。如果有，在群里同步进展。如果没有，忽略这条消息即可。用中文。');
      } catch (err) {
        console.error(`[scheduler] heartbeat(${proxy.name}):`, err);
      }
    }
  };

  const scheduleNext = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    const isActive = (Date.now() - lastActivityTime) < IDLE_THRESHOLD_MS;
    const interval = isActive ? HEARTBEAT_ACTIVE_MS : HEARTBEAT_IDLE_MS;
    heartbeatTimer = setTimeout(() => {
      tickHeartbeat();
      scheduleNext();
    }, interval);
  };

  scheduleNext();
}

export function markAgentActive(agentName: string): void {
  lastActivityTime = Date.now();
}
