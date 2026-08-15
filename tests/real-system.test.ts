/**
 * Real System Integration Test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventBus, EventType, createEvent } from '../src/lib/event-bus';
import { EmbeddedWebSocketServer } from '../src/lib/ws-server';
import { ipcStore, getIPCLock } from '../src/lib/ipc';
import { encrypt, decrypt, encryptApiKey, decryptApiKey } from '../src/lib/crypto';
import { validateAgentName, validateMessage, validateEmail } from '../src/lib/validation';
import { loadSession, saveSession, clearSession } from '../src/lib/session-manager';
import { createLogger, LogLevel } from '../src/lib/logger';
import WebSocket from 'ws';

describe('Real System: Component Integration', () => {
  let bus: EventBus;
  let wsServer: EmbeddedWebSocketServer;
  const TEST_PORT = 14001;

  beforeAll(async () => {
    bus = new EventBus();
    wsServer = new EmbeddedWebSocketServer(bus, TEST_PORT);
    await wsServer.start();
  });

  afterAll(async () => {
    await wsServer.stop();
  });

  describe('EventBus + IPC Integration', () => {
    it('should emit events and store in IPC', () => {
      ipcStore.delete('events:last');
      ipcStore.delete('events:recent');
      ipcStore.delete('events:count');

      const event = createEvent(EventType.TASK_COMPLETED, { taskId: 'test-ipc' }, 'test');
      bus.emit(event);

      const lastEvent = ipcStore.get<any>('events:last');
      expect(lastEvent).toBeDefined();

      const recentEvents = ipcStore.get<any[]>('events:recent') || [];
      expect(recentEvents.some(e => e.id === event.id && e.event === EventType.TASK_COMPLETED)).toBe(true);

      const count = ipcStore.get<number>('events:count');
      expect(count).toBeGreaterThan(0);
    });

    it('should receive events via WebSocket', async () => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Timeout'));
        }, 5000);

        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'connected') {
            ws.send(JSON.stringify({
              type: 'subscribe',
              filter: {},
              options: { scope: 'all' },
            }));
          } else if (msg.type === 'subscribed') {
            bus.emit(createEvent(EventType.TASK_CREATED, { taskId: 'test-1' }, 'test'));
          } else if (msg.type === 'event') {
            expect(msg.event).toBe(EventType.TASK_CREATED);
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        });

        ws.on('error', reject);
      });
    });
  });

  describe('Session + IPC Integration', () => {
    const agentName = `real-test-${Date.now()}`;

    afterAll(() => {
      clearSession(agentName);
    });

    it('should save session with IPC lock', () => {
      const session = {
        sessionId: 'real-session',
        messages: [
          { role: 'user' as const, content: 'Hello', timestamp: new Date().toISOString() },
          { role: 'assistant' as const, content: 'Hi!', timestamp: new Date().toISOString() },
        ],
        _version: 0,
      };

      saveSession(agentName, session);

      // Verify in IPC
      const ipcData = ipcStore.get<any>(`session:${agentName}`);
      expect(ipcData).toBeDefined();
      expect(ipcData.sessionId).toBe('real-session');
    });

    it('should load session from IPC', () => {
      const loaded = loadSession(agentName);
      expect(loaded.sessionId).toBe('real-session');
      expect(loaded.messages).toHaveLength(2);
    });
  });

  describe('Crypto + IPC Integration', () => {
    it('should encrypt, store in IPC, retrieve, and decrypt', () => {
      const apiKey = 'sk-test-api-key-12345';
      const encrypted = encryptApiKey(apiKey);

      // Store in IPC
      ipcStore.set('test:crypto:key', encrypted);

      // Retrieve and decrypt
      const stored = ipcStore.get<string>('test:crypto:key')!;
      const decrypted = decryptApiKey(stored);

      expect(decrypted).toBe(apiKey);

      // Cleanup
      ipcStore.delete('test:crypto:key');
    });
  });

  describe('Validation Pipeline', () => {
    it('should validate complete request', () => {
      const results = {
        agent: validateAgentName('alice'),
        message: validateMessage('Hello, how are you?'),
        email: validateEmail('alice@example.com'),
      };

      expect(results.agent.valid).toBe(true);
      expect(results.message.valid).toBe(true);
      expect(results.email.valid).toBe(true);
    });
  });

  describe('Logger Integration', () => {
    it('should create logger and log messages', () => {
      const logger = createLogger('test-module', LogLevel.DEBUG);

      // These should not throw
      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message', new Error('test error'));

      const child = logger.child('sub-module');
      child.info('child message');
    });
  });

  describe('Distributed Lock', () => {
    it('should handle concurrent lock acquisition', () => {
      const lock1 = getIPCLock('test:concurrent');
      const lock2 = getIPCLock('test:concurrent');

      expect(lock1.acquire(5000, 'process-1')).toBe(true);
      expect(lock2.acquire(1000, 'process-2')).toBe(false);

      lock1.release('process-1');
      expect(lock2.acquire(5000, 'process-2')).toBe(true);
      lock2.release('process-2');
    });
  });
});
