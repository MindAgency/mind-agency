/**
 * Centralized Configuration
 *
 * Single source of truth for all system configuration.
 * Combines static constants with environment-based overrides.
 */

// ═══════ Types ═══════

export interface AppConfig {
  server: { port: number; host: string; env: 'development' | 'production' | 'test' };
  ws: { port: number; host: string; reconnectInterval: number; maxReconnectAttempts: number };
  ai: { defaultModel: string; fallbackModels: string[]; timeout: number; maxRetries: number };
  rag: { embeddingModel: string; rerankerModel: string; chunkSize: number; chunkOverlap: number; topK: number };
  economy: { initialBalance: number; maxTransferAmount: number; decayRate: number };
  logging: { level: 'debug' | 'info' | 'warn' | 'error' };
  limits: { chatHistory: number; chatMerge: number; notifications: number; dashboardEvents: number };
}

// ═══════ Helpers ═══════

function env(key: string, fallback: string): string { return process.env[key] || fallback; }
function envInt(key: string, fallback: number): number { const v = process.env[key]; return v ? parseInt(v, 10) : fallback; }
function envFloat(key: string, fallback: number): number { const v = process.env[key]; return v ? parseFloat(v) : fallback; }
function envArray(key: string, fallback: string[]): string[] { const v = process.env[key]; return v ? v.split(',').map(s => s.trim()) : fallback; }

// ═══════ Configuration ═══════

export const config: AppConfig = {
  server: {
    port: envInt('PORT', 3000),
    host: env('HOST', '0.0.0.0'),
    env: env('NODE_ENV', 'development') as AppConfig['server']['env'],
  },
  ws: {
    port: envInt('WS_PORT', 3001),
    host: env('WS_HOST', '127.0.0.1'),
    reconnectInterval: envInt('WS_RECONNECT_INTERVAL', 3000),
    maxReconnectAttempts: envInt('WS_MAX_RECONNECT', 10),
  },
  ai: {
    defaultModel: env('AI_DEFAULT_MODEL', 'claude-sonnet-4-6'),
    fallbackModels: envArray('AI_FALLBACK_MODELS', ['deepseek-chat', 'gpt-4o']),
    timeout: envInt('AI_TIMEOUT', 120_000),
    maxRetries: envInt('AI_MAX_RETRIES', 3),
  },
  rag: {
    embeddingModel: env('RAG_EMBEDDING_MODEL', 'BAAI/bge-small-zh-v1.5'),
    rerankerModel: env('RAG_RERANKER_MODEL', 'BAAI/bge-reranker-base-zh-v1.5'),
    chunkSize: envInt('RAG_CHUNK_SIZE', 512),
    chunkOverlap: envInt('RAG_CHUNK_OVERLAP', 50),
    topK: envInt('RAG_TOP_K', 5),
  },
  economy: {
    initialBalance: envInt('ECONOMY_INITIAL_BALANCE', 1000),
    maxTransferAmount: envInt('ECONOMY_MAX_TRANSFER', 10000),
    decayRate: envFloat('ECONOMY_DECAY_RATE', 0.01),
  },
  logging: {
    level: env('LOG_LEVEL', 'info') as AppConfig['logging']['level'],
  },
  limits: {
    chatHistory: envInt('CHAT_HISTORY', 100),
    chatMerge: envInt('CHAT_MERGE', 50),
    notifications: envInt('NOTIFICATIONS', 10),
    dashboardEvents: envInt('DASHBOARD_EVENTS', 8),
  },
};

// ═══════ Legacy Constants (backward compatible) ═══════

export const POLL = {
  CHAT: 5_000,
  EMAIL: 10_000,
  DASHBOARD: 15_000,
  WORKFLOW: 3_000,
  SIDEBAR: 10_000,
  HEARTBEART: 5_000,
} as const;

export const WS = {
  RECONNECT_DELAY: config.ws.reconnectInterval,
  PORT: config.ws.port,
} as const;

export const TIMEOUT = {
  AI_REQUEST: config.ai.timeout,
  MCP_TOOL: 30_000,
  WORKFLOW_STEP: 300_000,
} as const;

export const LIMITS = {
  CHAT_HISTORY: config.limits.chatHistory,
  CHAT_MERGE: config.limits.chatMerge,
  NOTIFICATIONS: config.limits.notifications,
  DASHBOARD_EVENTS: config.limits.dashboardEvents,
} as const;

// ═══════ Validation ═══════

export function validateConfig(): void {
  const errors: string[] = [];
  if (config.server.port < 1 || config.server.port > 65535) errors.push(`Invalid port: ${config.server.port}`);
  if (config.ai.timeout < 1000) errors.push(`AI timeout too low: ${config.ai.timeout}ms`);
  if (config.rag.chunkSize < 64) errors.push(`RAG chunk size too small: ${config.rag.chunkSize}`);
  if (errors.length > 0) throw new Error(`Config validation failed:\n${errors.join('\n')}`);
}

export function getConfigSummary(): Record<string, unknown> {
  return { env: config.server.env, port: config.server.port, wsPort: config.ws.port, aiModel: config.ai.defaultModel, logLevel: config.logging.level };
}
