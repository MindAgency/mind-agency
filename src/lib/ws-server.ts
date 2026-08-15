/**
 * ws-server.ts — WebSocket server that can run inside Next.js process
 *
 * This eliminates the dual-process architecture by embedding the WebSocket
 * server directly into the Next.js application.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { EventBus, EventType, createEvent, setEventBus } from './event-bus';
import type { EventMessage } from './event-bus';
import { ipcStore } from './ipc';

export interface WSClient {
  clientId: string;
  ws: WebSocket;
  subscribed: boolean;
  scope?: 'events' | 'messages' | 'all';
  connectedAt: number;
}

export class EmbeddedWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, WSClient>();
  private bus: EventBus;
  private port: number;
  private statsTimer: NodeJS.Timeout | null = null;

  constructor(bus: EventBus, port: number = 3001) {
    this.bus = bus;
    this.port = port;
  }

  /**
   * Start the WebSocket server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port });

        this.wss.on('connection', (ws: WebSocket) => {
          this.handleConnection(ws);
        });

        this.wss.on('listening', () => {
          console.log(`[ws-server] WebSocket server listening on port ${this.port}`);

          // Store in IPC for cross-process access
          this.syncStats(true);

          resolve();
        });

        this.wss.on('error', (error) => {
          console.error('[ws-server] WebSocket server error:', error);
          reject(error);
        });

        // Periodically sync stats to IPC
        this.statsTimer = setInterval(() => {
          this.syncStats();
        }, 5000);

      } catch (error) {
        reject(error);
      }
    });
  }

  private syncStats(includeStartup = false): void {
    try {
      if (includeStartup) {
        ipcStore.set('ws:server:port', this.port);
        ipcStore.set('ws:server:startup', Date.now());
      }
      ipcStore.set('ws:server:clients', this.clients.size);
      ipcStore.set('ws:server:uptime', process.uptime());
    } catch (error: any) {
      console.warn(`[ws-server] Failed to sync IPC stats: ${error?.message || String(error)}`);
    }
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    const clientId = randomUUID();
    const remote = (ws as any)._socket?.remoteAddress || 'unknown';

    const client: WSClient = {
      clientId,
      ws,
      subscribed: false,
      connectedAt: Date.now(),
    };

    this.clients.set(ws, client);

    console.log(`[ws-server] Client ${clientId.slice(0, 8)}... connected (${remote}), total: ${this.clients.size}`);

    // Emit connect event
    this.bus.emit(createEvent(EventType.WS_CONNECT, { clientId, since: Date.now() }, 'system'));

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      clientId,
      timestamp: new Date().toISOString(),
    }));

    // Handle messages
    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data);
    });

    // Handle disconnect
    ws.on('close', () => {
      this.handleDisconnect(ws);
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error(`[ws-server] Client ${clientId.slice(0, 8)}... error:`, error);
    });
  }

  /**
   * Handle client message
   */
  private handleMessage(ws: WebSocket, data: Buffer): void {
    const client = this.clients.get(ws);
    if (!client) return;

    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'E_PARSE', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        this.handleSubscribe(client, msg);
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(client, msg);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', code: 'E_UNKNOWN', message: `Unknown message type: ${msg.type}` }));
    }
  }

  /**
   * Handle subscribe request
   */
  private handleSubscribe(client: WSClient, msg: any): void {
    try {
      const subId = this.bus.subscribe(
        msg.filter,
        msg.options,
        client.clientId,
        (event: EventMessage) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({
              type: 'event',
              ...event,
            }));
          }
        }
      );

      client.subscribed = true;
      client.scope = msg.options?.scope || 'events';

      client.ws.send(JSON.stringify({
        type: 'subscribed',
        subId,
        filter: msg.filter,
        options: msg.options,
      }));
    } catch (error: any) {
      client.ws.send(JSON.stringify({
        type: 'error',
        code: 'E_SUBSCRIBE',
        message: error.message,
      }));
    }
  }

  /**
   * Handle unsubscribe request
   */
  private handleUnsubscribe(client: WSClient, msg: any): void {
    try {
      this.bus.unsubscribe(msg.subId);
      client.ws.send(JSON.stringify({
        type: 'unsubscribed',
        subId: msg.subId,
      }));
    } catch (error: any) {
      client.ws.send(JSON.stringify({
        type: 'error',
        code: 'E_UNSUBSCRIBE',
        message: error.message,
      }));
    }
  }

  /**
   * Handle client disconnect
   */
  private handleDisconnect(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client) return;

    // Cleanup subscriptions
    this.bus.cleanupClient(client.clientId);

    // Remove client
    this.clients.delete(ws);

    console.log(`[ws-server] Client ${client.clientId.slice(0, 8)}... disconnected, total: ${this.clients.size}`);

    // Emit disconnect event
    this.bus.emit(createEvent(EventType.WS_DISCONNECT, { clientId: client.clientId }, 'system'));
  }

  /**
   * Broadcast message to all clients
   */
  broadcast(message: any, scope?: string): number {
    const payload = JSON.stringify(message);
    let sent = 0;

    for (const [ws, client] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (scope && client.scope && client.scope !== scope && client.scope !== 'all') continue;

      ws.send(payload);
      sent++;
    }

    return sent;
  }

  /**
   * Get connected clients count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get client info
   */
  getClients(): Array<{ clientId: string; subscribed: boolean; scope?: string; connectedAt: number }> {
    return Array.from(this.clients.values()).map(c => ({
      clientId: c.clientId.slice(0, 8),
      subscribed: c.subscribed,
      scope: c.scope,
      connectedAt: c.connectedAt,
    }));
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (this.wss) {
      if (this.statsTimer) {
        clearInterval(this.statsTimer);
        this.statsTimer = null;
      }

      // Close all connections
      for (const [ws] of this.clients) {
        ws.close();
      }
      this.clients.clear();

      // Close server
      await new Promise<void>((resolve) => {
        this.wss!.close(() => {
          console.log('[ws-server] WebSocket server stopped');
          resolve();
        });
      });

      this.wss = null;
    }
  }
}

// Singleton instance
let wsServer: EmbeddedWebSocketServer | null = null;

export function getWsServer(): EmbeddedWebSocketServer | null {
  return wsServer;
}

export async function startWsServer(bus: EventBus, port?: number): Promise<EmbeddedWebSocketServer> {
  if (wsServer) {
    await wsServer.stop();
  }

  wsServer = new EmbeddedWebSocketServer(bus, port);
  await wsServer.start();
  return wsServer;
}

export async function stopWsServer(): Promise<void> {
  if (wsServer) {
    await wsServer.stop();
    wsServer = null;
  }
}
