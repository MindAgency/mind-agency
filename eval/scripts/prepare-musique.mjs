// eval/scripts/prepare-musique.mjs
// 从 musique_ans_dev.jsonl 流式提取 4-hop 可回答题,确定性采样 N 题
// 用法: node eval/scripts/prepare-musique.mjs [N=30]
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(__dirname, '..', 'datasets', 'musique_ans_dev.jsonl');
const OUT = path.join(__dirname, '..', 'datasets', 'musique-4hop-sample.json');
const SAMPLE_N = Number(process.argv[2] || 30);

// mulberry32 确定性 PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42);

const pool = [];
const byHops = {};
let total = 0;

const rl = readline.createInterface({ input: fs.createReadStream(RAW), crlfDelay: Infinity });
for await (const line of rl) {
  total++;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const hops = (o.decomposed_instances || []).length;
  byHops[hops] = (byHops[hops] || 0) + 1;
  if (hops === 4 && o.answerable && o.composed_question_text && o.answer_text) {
    pool.push({
      id: o.id,
      question: o.composed_question_text,
      answer: o.answer_text,
      aliases: Array.isArray(o.answer_aliases) ? o.answer_aliases : [],
      hops,
    });
  }
}

// 确定性洗牌
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const items = pool.slice(0, SAMPLE_N);

const out = {
  meta: {
    source: 'MuSiQue (StonyBrookNLP, CC BY-SA 4.0) — musique_ans_dev.jsonl',
    preparedAt: new Date().toISOString(),
    filter: '4-hop (decomposed_instances.length === 4) && answerable',
    sampleSize: items.length,
    poolSize: pool.length,
    totalLines: total,
    hopDistribution: byHops,
    seed: 42,
  },
  items,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.meta, null, 2));
