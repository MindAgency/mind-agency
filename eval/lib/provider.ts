/**
 * eval/lib/provider.ts — 独立 LLM provider 调用器(评测专用)
 *
 * 镜像 src/lib/relay.ts 中 forwardToProvider 的请求/响应协议,
 * 但零 src/ 依赖:不经过 RAG / 记忆 / token 计费 / 限流,
 * 保证 SAS-vs-MAS 对比是受控的(同一 provider、同一协议、干净上下文)。
 * 支持 Anthropic 兼容路径(api.deepseek.com/anthropic)与 OpenAI 兼容路径。
 */

export interface ProviderCall {
  content: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs?: number;
}

export interface ProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  temperature?: number;
  systemPrompt?: string;
}

async function callAnthropic(opts: ProviderOptions): Promise<ProviderCall> {
  const body: Record<string, unknown> = { model: opts.model, messages: opts.messages, max_tokens: opts.maxTokens };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.systemPrompt) body.system = opts.systemPrompt;
  const res = await fetch(`${opts.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Provider error');
  // content 可能是 [{type:'thinking',...},{type:'text',text:'...'}] — 只取 text 块
  const blocks = Array.isArray(data.content) ? data.content : [];
  let text = blocks
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
  if (!text && typeof data.content === 'string') text = data.content;
  // 兜底:预算被 thinking 吃光、没有 text 块时,取最后一个 thinking 块
  if (!text) {
    const thinking = blocks
      .filter((b: any) => b && b.type === 'thinking' && typeof b.thinking === 'string')
      .map((b: any) => b.thinking);
    if (thinking.length > 0) text = '[thinking-only] ' + thinking[thinking.length - 1].slice(-500);
  }
  return {
    content: text,
    tokensIn: data.usage?.input_tokens || 0,
    tokensOut: data.usage?.output_tokens || 0,
  };
}

async function callOpenAI(opts: ProviderOptions): Promise<ProviderCall> {
  const messages = opts.systemPrompt
    ? [{ role: 'system', content: opts.systemPrompt }, ...opts.messages]
    : opts.messages;
  const body: Record<string, unknown> = { model: opts.model, messages, max_tokens: opts.maxTokens };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  const res = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Provider error');
  return {
    content: data.choices?.[0]?.message?.content || '',
    tokensIn: data.usage?.prompt_tokens || 0,
    tokensOut: data.usage?.completion_tokens || 0,
  };
}

export async function callProvider(opts: ProviderOptions): Promise<ProviderCall> {
  const isAnthropic = /anthropic|claude|mimo/i.test(opts.baseUrl);
  return isAnthropic ? callAnthropic(opts) : callOpenAI(opts);
}

export async function callProviderWithRetry(opts: ProviderOptions, retries = 2): Promise<ProviderCall> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callProvider(opts);
    } catch (err: any) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

// 价格表(CNY / 1M tokens),镜像 relay.ts PRICING 的 DeepSeek 部分
const PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-v4-pro': { input: 3.0, output: 6.0 },
  'deepseek-v4-chat': { input: 1.0, output: 2.0 },
  'deepseek-v4-flash': { input: 1.0, output: 2.0 },
  'deepseek-chat': { input: 1.0, output: 2.0 },
  'deepseek-reasoner': { input: 1.0, output: 2.0 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[model] || { input: 3.0, output: 6.0 };
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
}
