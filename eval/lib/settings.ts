/**
 * eval/lib/settings.ts — 评测专用 key 配置加载
 *
 * 优先级:
 *   1. eval/.data/.mind/settings.json(评测沙箱,gitignored,明文 key)
 *   2. 环境变量 DEEPSEEK_API_KEY
 *
 * 与 src/lib/relay.ts 的 loadSettings 对齐字段名(apiKey/baseUrl/model),
 * 但只接受明文 sk- key(评测沙箱内无应用加密上下文)。
 */

import fs from 'fs';
import path from 'path';

export interface EvalSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function loadEvalSettings(dataDir: string): EvalSettings {
  const p = path.join(dataDir, '.mind', 'settings.json');
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, ''));
      if (raw.apiKey && typeof raw.apiKey === 'string' && raw.apiKey.length > 8) {
        return {
          apiKey: raw.apiKey,
          baseUrl: raw.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic',
          model: raw.model || process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash',
        };
      }
    } catch {
      // fall through to env
    }
  }
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error(
      'No API key found. Either write {"apiKey":"sk-...","baseUrl":"https://api.deepseek.com/anthropic","model":"deepseek-v4-flash"} ' +
      'to eval/.data/.mind/settings.json, or set DEEPSEEK_API_KEY.'
    );
  }
  return {
    apiKey: key,
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic',
    model: process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash',
  };
}
