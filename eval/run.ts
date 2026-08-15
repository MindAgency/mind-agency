#!/usr/bin/env npx tsx
/**
 * eval/run.ts — Mind Agency LLM 评测 harness
 *
 * 在 matched output-token budget(equal-budget 配对)下,把同一批题跑过三种配置:
 *   sas    — 单 agent,1 次调用,拿全部预算
 *   debate — 3 agent(提出/批判/综合),预算 40/30/30 拆分
 *   group  — 3 agent(研究员/事实核查/综合),镜像 Groups/default 真实团队模式(alice/bob/charlie 的 研究→审查→产出 流水线),40/30/30
 *
 * 用法:
 *   npx tsx eval/run.ts --config all --limit 30 --budget 1000          # 真实运行
 *   npx tsx eval/run.ts --config all --limit 5 --mock                   # 离线冒烟(mock 应答)
 *   EVAL_MODEL=deepseek-v4-pro npx tsx eval/run.ts --config sas --limit 10
 */

import fs from 'fs';
import path from 'path';
import { loadEvalSettings } from './lib/settings';
import { callProviderWithRetry, estimateCost, ProviderCall } from './lib/provider';
import { gradeAnswer } from './lib/graders';

// ── 参数解析 ──────────────────────────────────────────────
function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasFlag(name: string): boolean {
  return process.argv.includes('--' + name);
}

// ── 类型 ──────────────────────────────────────────────────
interface DatasetItem { id: string; question: string; answer: string; aliases?: string[]; hops?: number; }
interface Dataset { meta: Record<string, unknown>; items: DatasetItem[]; }
type ConfigName = 'sas' | 'debate' | 'group';

interface StepRecord { label: string; tokensIn: number; tokensOut: number; cost: number; latencyMs: number; content: string; }
interface QuestionResult {
  itemId: string; question: string; gold: string; config: ConfigName;
  final: string; correct: boolean; matched: string;
  tokensIn: number; tokensOut: number; cost: number; latencyMs: number;
  steps: StepRecord[]; error?: string;
}

// ── 全局 ──────────────────────────────────────────────────
const settings = loadEvalSettings(path.resolve(process.cwd(), 'eval/.data'));
const model = process.env.EVAL_MODEL || settings.model;
const GROUP_NAME = arg('group', 'default');

const QA_SYSTEM = 'You are a precise multi-hop question-answering assistant. Answer with only the final answer: a short phrase or name. No explanation, no reasoning.';

async function realCall(messages: Array<{ role: string; content: string }>, systemPrompt: string | undefined, maxTokens: number): Promise<ProviderCall> {
  const t0 = Date.now();
  const r = await callProviderWithRetry({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model,
    messages,
    maxTokens,
    temperature: 0,
    systemPrompt,
  });
  return { ...r, latencyMs: Date.now() - t0 };
}

function mockCall(gold: string, idx: number, maxTokens: number): ProviderCall {
  const wrong = idx % 4 === 0; // 1/4 的题返回错误答案,让 mock 链路覆盖错误分桶
  return { content: wrong ? 'Mock Wrong Answer' : gold, tokensIn: 42, tokensOut: Math.min(maxTokens, 8), latencyMs: 1 };
}

async function runStrategy(config: ConfigName, item: DatasetItem, idx: number, budget: number, useMock: boolean): Promise<QuestionResult> {
  const steps: StepRecord[] = [];
  const call = async (label: string, messages: Array<{ role: string; content: string }>, systemPrompt: string | undefined, maxTokens: number) => {
    const r = useMock ? mockCall(item.answer, idx, maxTokens) : await realCall(messages, systemPrompt, maxTokens);
    const cost = estimateCost(model, r.tokensIn, r.tokensOut);
    steps.push({ label, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost, latencyMs: r.latencyMs ?? 0, content: r.content });
    return r;
  };

  const result: QuestionResult = {
    itemId: item.id, question: item.question, gold: item.answer, config,
    final: '', correct: false, matched: 'none', tokensIn: 0, tokensOut: 0, cost: 0, latencyMs: 0, steps: [],
  };
  try {
    let final = '';
    if (config === 'sas') {
      const r = await call('answer', [{ role: 'user', content: `Question: ${item.question}` }], QA_SYSTEM, budget);
      final = r.content;
    } else if (config === 'debate') {
      const a = Math.round(budget * 0.4), b = Math.round(budget * 0.3), c = budget - a - b;
      const A = await call('propose', [{ role: 'user', content: `Question: ${item.question}` }], QA_SYSTEM, a);
      const B = await call('critique', [{ role: 'user', content: `Question: ${item.question}

Another agent proposed this answer:
"""
${A.content}
"""

Critique it. If it is wrong, give the correct final answer. Output the final answer only.` }], QA_SYSTEM, b);
      const C = await call('synthesize', [{ role: 'user', content: `Question: ${item.question}

Agent A proposed: """${A.content}"""

Agent B responded: """${B.content}"""

Considering both, give the final answer only.` }], QA_SYSTEM, c);
      final = C.content;
    } else {
      const a = Math.round(budget * 0.4), b = Math.round(budget * 0.3), c = budget - a - b;
      const R = await call('researcher', [{ role: 'user', content: `Question: ${item.question}` }],
        `You are the Researcher in Mind Agency group "${GROUP_NAME}" (team: alice, bob, charlie). Gather the facts needed and propose a candidate final answer (short phrase only).`, a);
      const F = await call('fact-checker', [{ role: 'user', content: `Question: ${item.question}

Researcher's candidate answer: """${R.content}"""

Verify it. If it is wrong, correct it. Output the final answer only.` }],
        `You are the Fact-Checker in Mind Agency group "${GROUP_NAME}". You check teammates' answers for factual errors.`, b);
      const S = await call('synthesizer', [{ role: 'user', content: `Question: ${item.question}

Researcher: """${R.content}"""

Fact-Checker: """${F.content}"""

Produce the team's final answer only.` }],
        `You are the Synthesizer in Mind Agency group "${GROUP_NAME}". You turn teammates' outputs into one final answer.`, c);
      final = S.content;
    }
    result.final = final;
    const g = gradeAnswer(final, item.answer, item.aliases || []);
    result.correct = g.correct;
    result.matched = g.matched;
  } catch (e: any) {
    result.error = e.message || String(e);
  }
  result.steps = steps;
  result.tokensIn = steps.reduce((s, x) => s + x.tokensIn, 0);
  result.tokensOut = steps.reduce((s, x) => s + x.tokensOut, 0);
  result.cost = steps.reduce((s, x) => s + x.cost, 0);
  result.latencyMs = steps.reduce((s, x) => s + x.latencyMs, 0);
  return result;
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const configArg = arg('config', 'all');
  const limit = Number(arg('limit', '30'));
  const budget = Number(arg('budget', '1000'));
  const useMock = hasFlag('mock');
  const datasetPath = arg('dataset', 'eval/datasets/musique-4hop-sample.json');

  const ds: Dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  const items = ds.items.slice(0, limit);
  const configs: ConfigName[] = configArg === 'all' ? ['sas', 'debate', 'group'] : (configArg.split(',') as ConfigName[]);

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join('eval', 'results', ts);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[eval] dataset=${datasetPath} items=${items.length} budget=${budget} model=${model} mock=${useMock} configs=${configs.join(',')}`);
  console.log(`[eval] baseUrl=${settings.baseUrl}`);

  const all: QuestionResult[] = [];
  for (const cfg of configs) {
    console.log(`[eval] running config: ${cfg}`);
    for (let i = 0; i < items.length; i++) {
      const r = await runStrategy(cfg, items[i], i, budget, useMock);
      all.push(r);
      console.log(`[${cfg}] ${i + 1}/${items.length} ${r.itemId} correct=${r.correct} tokIn=${r.tokensIn} tokOut=${r.tokensOut} cost=${r.cost.toFixed(5)} lat=${r.latencyMs}ms${r.error ? ' ERR=' + r.error.slice(0, 120) : ''}`);
    }
  }

  // 聚合
  const agg = {} as Record<string, { n: number; correct: number; acc: number; tin: number; tout: number; cost: number; lat: number }>;
  for (const cfg of configs) {
    const rs = all.filter(r => r.config === cfg);
    const n = rs.length, correct = rs.filter(r => r.correct).length;
    agg[cfg] = {
      n, correct, acc: n ? correct / n : 0,
      tin: rs.reduce((s, r) => s + r.tokensIn, 0) / Math.max(1, n),
      tout: rs.reduce((s, r) => s + r.tokensOut, 0) / Math.max(1, n),
      cost: rs.reduce((s, r) => s + r.cost, 0),
      lat: rs.reduce((s, r) => s + r.latencyMs, 0) / Math.max(1, n),
    };
  }

  // 错误交叉桶(vs SAS)
  const buckets: Record<string, { both: number; sasOnly: number; masOnly: number; neither: number }> = {};
  const sasBy = new Map(all.filter(r => r.config === 'sas').map(r => [r.itemId, r]));
  for (const cfg of configs) {
    if (cfg === 'sas') continue;
    const b = { both: 0, sasOnly: 0, masOnly: 0, neither: 0 };
    for (const r of all.filter(x => x.config === cfg)) {
      const s = sasBy.get(r.itemId);
      if (!s) continue;
      if (s.correct && r.correct) b.both++;
      else if (s.correct && !r.correct) b.sasOnly++;
      else if (!s.correct && r.correct) b.masOnly++;
      else b.neither++;
    }
    buckets[cfg] = b;
  }

  // 输出
  fs.writeFileSync(path.join(outDir, 'results.jsonl'), all.map(r => JSON.stringify(r)).join('\n'));

  const gamma = (c: string) => (agg.sas.acc > 0 ? agg[c].acc / agg.sas.acc : null);
  const L: string[] = [];
  L.push(`# Mind Agency 评测报告 — ${ts}`);
  L.push('');
  L.push(`- 模型: \`${model}\` (base: \`${settings.baseUrl}\`)`);
  L.push(`- 数据集: ${ds.meta.source || datasetPath}, N=${items.length}`);
  L.push(`- 预算: 每题输出总预算 ${budget} tokens(equal-budget 配对, temperature=0)`);
  L.push(`- 配置: ${configs.join(' / ')}`);
  L.push('');
  L.push('## 汇总');
  L.push('');
  L.push('| 配置 | 正确/总数 | 准确率 | Γ=acc/acc_sas | 平均输入tok | 平均输出tok | 总成本(¥) | 平均延迟(s) |');
  L.push('|------|----------|--------|--------------|------------|------------|----------|------------|');
  for (const cfg of configs) {
    const a = agg[cfg];
    L.push(`| ${cfg} | ${a.correct}/${a.n} | ${(a.acc * 100).toFixed(1)}% | ${cfg === 'sas' ? '1.00' : gamma(cfg)!.toFixed(3)} | ${a.tin.toFixed(0)} | ${a.tout.toFixed(0)} | ${a.cost.toFixed(4)} | ${(a.lat / 1000).toFixed(1)} |`);
  }
  L.push('');
  L.push('## 错误交叉桶(vs SAS)');
  L.push('');
  L.push('| 配置 | 都对 | 仅SAS对 | 仅MAS对(MAS挽回) | 都错 |');
  L.push('|------|------|---------|-------------------|------|');
  for (const cfg of Object.keys(buckets)) {
    const b = buckets[cfg];
    L.push(`| ${cfg} | ${b.both} | ${b.sasOnly} | ${b.masOnly} | ${b.neither} |`);
  }
  L.push('');
  L.push('## 逐题明细');
  L.push('');
  L.push('| id | 问题 | 金标 | sas | debate | group |');
  L.push('|----|------|------|-----|--------|-------|');
  for (const item of items) {
    const cell = (cfg: string) => {
      const r = all.find(x => x.config === cfg && x.itemId === item.id);
      if (!r) return '—';
      if (r.error) return '⏭️ error';
      return `${r.correct ? '✅' : '❌'} ${(r.final || '').replace(/[|\r\n]+/g, ' ').slice(0, 40)}`;
    };
    L.push(`| ${item.id.slice(0, 18)} | ${item.question.slice(0, 60)} | ${item.answer.slice(0, 30)} | ${cell('sas')} | ${cell('debate')} | ${cell('group')} |`);
  }
  L.push('');
  L.push('## 说明');
  L.push('');
  L.push('- Γ = 该配置准确率 / SAS 准确率。Γ > 1 = 同预算下多 agent 超过单 agent。');
  L.push('- SAS = 单 agent 1 次调用拿全预算;debate/group = 3 次调用,预算按 40/30/30 拆分,总预算相同。');
  L.push('- 判分:规范化包含匹配(含答案别名);temperature=0。');
  L.push('- 评测纪律参照:Equal-Token SAS vs MAS (arXiv:2604.02460) 与 Scaling Agent Systems (arXiv:2512.08296)。');
  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n'));

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ ts, model, budget, limit, agg, buckets, datasetMeta: ds.meta }, null, 2));

  console.log('\n[eval] done. outputs:');
  console.log('  ' + path.join(outDir, 'report.md'));
  console.log('  ' + path.join(outDir, 'results.jsonl'));
  console.log('  ' + path.join(outDir, 'summary.json'));
  const gd = gamma('debate'), gg = gamma('group');
  console.log(`\n[sas] acc=${(agg.sas?.acc ?? 0 * 100).toFixed(1)}%`);
  if (gd !== null) console.log(`[debate] acc=${(agg.debate.acc * 100).toFixed(1)}% Γ=${gd.toFixed(3)}`);
  if (gg !== null) console.log(`[group] acc=${(agg.group.acc * 100).toFixed(1)}% Γ=${gg.toFixed(3)}`);
}

main().catch(e => { console.error('[eval] fatal:', e); process.exit(1); });
