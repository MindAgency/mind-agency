/**
 * eval/lib/graders.ts — 短答案判分(MuSiQue 风格)
 *
 * 规范化后按 3 档匹配:
 *   exact            — 完全一致
 *   contains         — 候选答案包含金标(且长度差 ≤ 40,防长文本碰瓷)
 *   contained-by-gold — 金标包含候选(候选 ≥ 4 字符)
 */

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^thes+/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface GradeResult {
  correct: boolean;
  matched: 'exact' | 'contains' | 'contained-by-gold' | 'none';
}

export function gradeAnswer(candidate: string, gold: string, aliases: string[] = []): GradeResult {
  const c0 = normalize(candidate)
    .replace(/^(final answer|the answer is|answer is|answer)[:：\s]*/, '')
    .trim();
  const targets = [normalize(gold), ...aliases.map(normalize)].filter(Boolean);
  for (const t of targets) {
    if (c0 === t) return { correct: true, matched: 'exact' };
    if (c0.includes(t) && c0.length <= t.length + 40) return { correct: true, matched: 'contains' };
    if (c0.length >= 4 && t.includes(c0) && t.length <= c0.length + 40) return { correct: true, matched: 'contained-by-gold' };
  }
  return { correct: false, matched: 'none' };
}
