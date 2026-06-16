'use client';

import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { createLogger } from '@/lib/logger';
import type dagre from '@dagrejs/dagre';

const logger = createLogger('workflow-arch');

// ═══════ Types ═══════
interface Step {
  id: string;
  type?: string;
  agent?: string;
  action?: string;
  prompt?: string;
  trigger?: Record<string, unknown>;
  dependsOn?: string[];
  routes?: { step: string; when: string }[];
  status?: string;
}

interface Run {
  runId: string;
  status: string;
  steps: Record<string, string>;
  startedAt: number;
  completedAt?: number;
}

interface Props {
  steps: Step[];
  run: Run | null;
  allAgents?: string[];
  onTrigger?: (stepId?: string) => void;
  running?: boolean;
  onStepClick?: (step: Step) => void;
  onStepAdd?: (afterStepId?: string) => void;
  onStepDelete?: (stepId: string) => void;
  onEdgeClick?: (fromId: string, toId: string) => void;
  onEdgeDelete?: (fromId: string, toId: string) => void;
  onEdgeAdd?: (fromId: string, toId: string) => void;
}

// ═══════ Config ═══════
const COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  create: { fill: '#dcfce7', stroke: '#16a34a', text: '#14532d' },
  review: { fill: '#ffedd5', stroke: '#ea580c', text: '#7c2d12' },
  fix: { fill: '#dbeafe', stroke: '#2563eb', text: '#1e3a5f' },
  verify: { fill: '#f3e8ff', stroke: '#9333ea', text: '#581c87' },
  deploy: { fill: '#fce7f3', stroke: '#db2777', text: '#831843' },
  research: { fill: '#ccfbf1', stroke: '#0d9488', text: '#134e4a' },
  execute: { fill: '#f4f4f5', stroke: '#71717a', text: '#27272a' },
};

const STATUS_COLORS: Record<string, string> = {
  pending: '#a1a1aa',
  waiting: '#f59e0b',
  running: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
  blocked: '#9e9e9e',
  skipped: '#d4d4d4',
};

const BLOCK_W = 180;
const BLOCK_H = 48;
const PAD = 40;

// ═══════ Helpers ═══════
function getColor(action: string) {
  const k = action?.toLowerCase() || '';
  for (const [key, c] of Object.entries(COLORS)) if (k.includes(key)) return c;
  return COLORS.execute;
}

// ═══════ Orthogonal Path ═══════
// Convert dagre waypoints to orthogonal (horizontal/vertical) path with rounded corners
// 3-step pipeline: insert corners → simplify collinear → build SVG path
const CORNER_R = 10;

function orthogonalPath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return '';

  // Step 1: Insert corner points for diagonal segments
  // Horizontal-first convention: go H to align x, then V to reach target
  const ortho: Array<{ x: number; y: number }> = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dx = Math.abs(curr.x - prev.x);
    const dy = Math.abs(curr.y - prev.y);
    if (dx > 0.5 && dy > 0.5) {
      ortho.push({ x: curr.x, y: prev.y }); // corner point
    }
    ortho.push(curr);
  }

  // Step 2: Remove collinear points
  const simplified: Array<{ x: number; y: number }> = [ortho[0]];
  for (let i = 1; i < ortho.length - 1; i++) {
    const a = simplified[simplified.length - 1];
    const b = ortho[i];
    const c = ortho[i + 1];
    const sameH = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
    const sameV = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
    if (!sameH && !sameV) simplified.push(b);
  }
  simplified.push(ortho[ortho.length - 1]);

  // Step 3: Build SVG path with rounded corners
  if (simplified.length < 2) return '';
  const parts: string[] = [`M ${simplified[0].x} ${simplified[0].y}`];

  for (let i = 0; i < simplified.length - 1; i++) {
    const p1 = simplified[i];
    const p2 = simplified[i + 1];
    const isH = Math.abs(p1.y - p2.y) < 0.5;

    if (i === simplified.length - 2) {
      parts.push(`L ${p2.x} ${p2.y}`);
      continue;
    }

    const np2 = simplified[i + 2];
    const nextIsH = Math.abs(p2.y - np2.y) < 0.5;
    const isCorner = isH !== nextIsH;

    if (!isCorner) continue;

    const r = CORNER_R;
    const segLen = isH ? Math.abs(p2.x - p1.x) : Math.abs(p2.y - p1.y);
    const nextLen = nextIsH ? Math.abs(np2.x - p2.x) : Math.abs(np2.y - p2.y);
    const rc = Math.min(r, segLen / 2, nextLen / 2);

    if (rc < 1) {
      parts.push(`L ${p2.x} ${p2.y}`);
    } else if (isH) {
      const dH = p2.x > p1.x ? 1 : -1;
      const dV = np2.y > p2.y ? 1 : -1;
      parts.push(`L ${p2.x - dH * rc} ${p1.y}`);
      parts.push(`Q ${p2.x} ${p1.y} ${p2.x} ${p1.y + dV * rc}`);
    } else {
      const dV = p2.y > p1.y ? 1 : -1;
      const dH = np2.x > p2.x ? 1 : -1;
      parts.push(`L ${p1.x} ${p2.y - dV * rc}`);
      parts.push(`Q ${p1.x} ${p2.y} ${p1.x + dH * rc} ${p2.y}`);
    }
  }

  return parts.join(' ');
}

// ═══════ Dagre Layout ═══════
// Uses @dagrejs/dagre for production-quality Sugiyama layout:
// crossing reduction + Brandes-Köpf coordinate assignment
interface LayoutResult {
  positions: Map<string, { x: number; y: number; w: number; h: number }>;
  edges: Map<string, Array<{ x: number; y: number }>>;
  width: number;
  height: number;
  layers: Step[][];
}

function computeLayout(steps: Step[], editingBlocks?: Set<string>, dagreLib?: typeof dagre): LayoutResult {
  // Build layers for reference (used by rendering)
  const map = new Map(steps.map(s => [s.id, s]));
  const memo = new Map<string, number>();
  const d = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    const s = map.get(id);
    if (!s?.dependsOn?.length) { memo.set(id, 0); return 0; }
    memo.set(id, Math.max(...s.dependsOn.map(d)) + 1);
    return memo.get(id)!;
  };
  steps.forEach(s => d(s.id));
  const layerMap = new Map<number, Step[]>();
  for (const s of steps) {
    const k = memo.get(s.id) || 0;
    if (!layerMap.has(k)) layerMap.set(k, []);
    layerMap.get(k)!.push(s);
  }
  const layers = [...layerMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

  // Use dagre for layout — full Sugiyama pipeline
  if (!dagreLib) {
    // Fallback: simple centered layout without dagre
    const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
    let maxY = PAD;
    for (const layer of layers) {
      const tw = layer.length * BLOCK_W + (layer.length - 1) * 16;
      const ox = Math.max(PAD, (tw + PAD * 2) / 2 - tw / 2);
      layer.forEach((s: Step, j: number) => {
        positions.set(s.id, { x: ox + j * (BLOCK_W + 16), y: maxY, w: BLOCK_W, h: BLOCK_H });
      });
      maxY += BLOCK_H + 80;
    }
    return { positions, edges: new Map(), width: 500, height: maxY, layers };
  }
  const g = new dagreLib.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: 50,   // horizontal spacing between nodes in same rank
    ranksep: 80,   // vertical spacing between ranks
    edgesep: 20,   // edge spacing
    marginx: PAD,
    marginy: PAD,
    acyclicer: 'greedy',
    ranker: 'network-simplex',  // best quality layering
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Add nodes with dimensions (expanded height for editing blocks)
  const BLOCK_H_EDIT = 180;
  for (const s of steps) {
    const isEditing = editingBlocks?.has(s.id);
    const h = isEditing ? BLOCK_H_EDIT : BLOCK_H;
    g.setNode(s.id, { width: BLOCK_W, height: h });
  }

  // Add edges (dependsOn)
  for (const s of steps) {
    if (s.dependsOn) {
      for (const depId of s.dependsOn) {
        if (map.has(depId)) {
          g.setEdge(depId, s.id);
        }
      }
    }
  }

  // Add route edges (conditional, dashed) — dagre routes them too
  for (const s of steps) {
    if (s.routes) {
      for (const rt of s.routes) {
        if (map.has(rt.step) && !g.hasEdge(rt.step, s.id)) {
          g.setEdge(rt.step, s.id, { label: `route:${rt.when}` });
        }
      }
    }
  }

  // Compute layout
  dagreLib.layout(g);

  // Extract positions (dagre returns center coordinates)
  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of steps) {
    const n = g.node(s.id);
    if (n) {
      const isEditing = editingBlocks?.has(s.id);
      const h = isEditing ? BLOCK_H_EDIT : BLOCK_H;
      // dagre returns center; convert to top-left
      const x = n.x - BLOCK_W / 2;
      const y = n.y - h / 2;
      positions.set(s.id, { x, y, w: BLOCK_W, h });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + BLOCK_W);
      maxY = Math.max(maxY, y + h);
    }
  }

  // Extract edge waypoints and post-process for perpendicular entry/exit
  const edges = new Map<string, Array<{ x: number; y: number }>>();

  // Process dependsOn edges: perpendicular exit/exit + merge at midpoint
  for (const s of steps) {
    if (!s.dependsOn) continue;
    const tgtP = positions.get(s.id);
    if (!tgtP) continue;
    // All dependsOn arrows to this block merge at top-center (midpoint)
    const entryX = tgtP.x + tgtP.w / 2;

    for (const depId of s.dependsOn) {
      if (!map.has(depId)) continue;
      const srcP = positions.get(depId);
      if (!srcP) continue;

      // Start: source bottom-center, End: target top-center (merged midpoint)
      const start = { x: srcP.x + srcP.w / 2, y: srcP.y + srcP.h };
      const end = { x: entryX, y: tgtP.y };

      // Build orthogonal path directly (skip dagre waypoints)
      // Simple L-shape: vertical down, then horizontal, then vertical down
      const midY = (start.y + end.y) / 2;
      const pts = [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];

      edges.set(`${depId}->${s.id}`, pts);
    }
  }

  // Process route edges: exit right side, enter right side, offset to avoid overlap
  for (const s of steps) {
    if (!s.routes) continue;
    const tgtP = positions.get(s.id);
    if (!tgtP) continue;

    for (const rt of s.routes) {
      if (!map.has(rt.step)) continue;
      const srcP = positions.get(rt.step);
      if (!srcP) continue;

      // Start: source right-center, End: target right-center
      const startX = srcP.x + srcP.w;
      const startY = srcP.y + srcP.h / 2;
      const endX = tgtP.x + tgtP.w;
      const endY = tgtP.y + tgtP.h / 2;

      // Route: right → down → left → down → left (avoid dependsOn arrows)
      const offset = 30;
      const pts = [
        { x: startX, y: startY },
        { x: startX + offset, y: startY },
        { x: startX + offset, y: endY },
        { x: endX, y: endY },
      ];

      edges.set(`route:${rt.step}->${s.id}`, pts);
    }
  }

  return {
    positions,
    edges,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
    layers,
  };
}

// ═══════ CSS ═══════
const CSS = `
@keyframes wf-pulse { 0%,100%{opacity:1} 50%{opacity:.6} }
@keyframes wf-blink { 0%,100%{opacity:1} 50%{opacity:.4} }
@keyframes wf-shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-3px)} 40%,80%{transform:translateX(3px)} }
@keyframes wf-check { 0%{stroke-dashoffset:20} 100%{stroke-dashoffset:0} }
@keyframes wf-dash { to{stroke-dashoffset:-20} }
@keyframes wf-slide-in { from{transform:translateX(100%);opacity:0} to{transform:translateX(0);opacity:1} }
@keyframes wf-fade-in { from{opacity:0;transform:scale(.95)} to{opacity:1;transform:scale(1)} }
`;

// ═══════ MiniMap Component ═══════
function MiniMap({ steps, positions, zoom, pan, cs }: {
  steps: Step[];
  positions: Map<string, { x: number; y: number; w: number; h: number }>;
  zoom: number;
  pan: { x: number; y: number };
  cs: { w: number; h: number };
}) {
  const W = 140, H = 100;
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  positions.forEach(p => {
    mnX = Math.min(mnX, p.x);
    mnY = Math.min(mnY, p.y);
    mxX = Math.max(mxX, p.x + p.w);
    mxY = Math.max(mxY, p.y + p.h);
  });
  if (!positions.size) { mnX = 0; mnY = 0; mxX = 500; mxY = 400; }
  const cw = mxX - mnX + 40, ch = mxY - mnY + 40;
  const sc = Math.min((W - 10) / cw, (H - 10) / ch);

  return (
    <div style={{
      position: 'absolute', bottom: 12, right: 12, width: W, height: H,
      background: 'rgba(255,255,255,.92)', border: '1px solid #e4e4e7',
      borderRadius: 6, overflow: 'hidden', zIndex: 10,
    }}>
      <svg width={W} height={H}>
        {[...positions.entries()].map(([id, p]) => {
          const s = steps.find(s => s.id === id);
          const c = s ? getColor(s.action || 'execute') : COLORS.execute;
          return (
            <rect key={id}
              x={(p.x - mnX + 20) * sc + 5}
              y={(p.y - mnY + 20) * sc + 5}
              width={p.w * sc} height={p.h * sc}
              fill={c.fill} stroke={c.stroke} strokeWidth={0.5} rx={1}
            />
          );
        })}
        <rect
          x={(-pan.x / zoom - mnX + 20) * sc + 5}
          y={(-pan.y / zoom - mnY + 20) * sc + 5}
          width={(cs.w / zoom) * sc}
          height={(cs.h / zoom) * sc}
          fill="none" stroke="#3b82f6" strokeWidth={1.5} rx={1}
        />
      </svg>
    </div>
  );
}

// ═══════ Block Component ═══════
// Uses transparent overlay rect for reliable hover detection
function Block({ step, x, y, w, h, run, editing, allAgents, onToggleEdit, onEditSave, onAdd, onDelete, onTrigger, onCtx, onClick, sel }: {
  step: Step;
  x: number; y: number; w: number; h: number;
  run: Run | null;
  editing?: boolean;
  allAgents?: string[];
  onToggleEdit?: () => void;
  onEditSave?: (d: Partial<Step>) => void;
  onAdd?: (afterId?: string) => void;
  onDelete?: (stepId: string) => void;
  onTrigger?: (stepId?: string) => void;
  onCtx?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  sel?: boolean;
}) {
  const [ag, setAg] = useState(step.agent || '');
  const [act, setAct] = useState(step.action || 'execute');
  const [pr, setPr] = useState(step.prompt || '');
  const [dep, setDep] = useState((step.dependsOn || []).join(', '));
  const [saveErr, setSaveErr] = useState('');

  // Sync when step changes
  useEffect(() => {
    setAg(step.agent || '');
    setAct(step.action || 'execute');
    setPr(step.prompt || '');
    setDep((step.dependsOn || []).join(', '));
  }, [step.id, step.agent, step.action, step.prompt, step.dependsOn]);

  // Auto-save with debounce
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  const doSave = (updates: Partial<Step>) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        onEditSave?.(updates);
        setSaveErr('');
      } catch (e: unknown) {
        setSaveErr(e instanceof Error ? e.message : '保存失败');
      }
    }, 300);
  };
  const [hovered, setHovered] = useState(false);
  // Only show status if step is instantiated in run (has status entry)
  const instantiated = run ? (step.id in run.steps) : false;
  const st = instantiated ? run!.steps[step.id] : (step.status || '');
  const isRun = st === 'in_progress' || st === 'running';
  const isFail = st === 'failed';
  const isDone = st === 'completed';
  const isWaiting = st === 'waiting';
  const c = getColor(step.action || 'execute');
  const sc = isDone ? '#22c55e' : isFail ? '#ef4444' : isRun || isWaiting ? '#3b82f6' : c.stroke;

  let anim = 'none';
  if (isRun) anim = 'wf-pulse 2s ease-in-out infinite';
  else if (isFail) anim = 'wf-shake .4s ease-in-out';
  else if (st === 'waiting') anim = 'wf-blink 2s ease-in-out infinite';

  // Gradient ID unique per block
  const gradId = `grad-${step.id}`;

  return (
    <g>
      {/* Gradient definition for 3D effect */}
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity="0.4" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <filter id={`shadow-${step.id}`} x="-20%" y="-20%" width="150%" height="160%">
          <feGaussianBlur in="SourceAlpha" stdDeviation={hovered ? "4" : "2"} />
          <feOffset dx="0" dy={hovered ? "4" : "2"} result="offsetblur" />
          <feFlood floodColor="#000" floodOpacity={hovered ? "0.2" : "0.1"} />
          <feComposite in2="offsetblur" operator="in" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Transparent overlay for mouse events */}
      <rect
        x={x - 4} y={y - 4} width={w + 8} height={h + 8}
        fill="transparent"
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={e => { e.stopPropagation(); onClick?.(); }}
        onContextMenu={e => {
          e.preventDefault(); e.stopPropagation();
          onCtx?.(e);
        }}
      />

      {/* Main rect with shadow filter */}
      <rect x={x} y={y} width={w} height={h}
        fill={isDone ? '#f0fdf4' : isFail ? '#fef2f2' : c.fill}
        stroke={sel ? '#3b82f6' : hovered ? '#3b82f6' : sc}
        strokeWidth={sel ? 2.5 : hovered ? 2 : 1.5}
        rx={6}
        filter={`url(#shadow-${step.id})`}
        style={{ animation: anim, pointerEvents: 'none', transition: 'all 0.15s ease' }}
      />

      {/* Top highlight gradient overlay */}
      <rect x={x} y={y + 1} width={w - 2} height={h / 2}
        fill={`url(#${gradId})`}
        rx={5}
        style={{ pointerEvents: 'none' }}
      />
      {/* Step ID */}
      <text x={x + w / 2} y={editing ? y + 16 : y + h / 2 - (isRun && step.agent ? 4 : 0)}
        fontSize={13} fontWeight={700} fill={c.text}
        textAnchor="middle" dominantBaseline="middle"
        fontFamily='"JetBrains Mono",monospace'
        style={{ pointerEvents: 'none' }}>
        {step.id}
      </text>
      {/* Agent name — when running or waiting */}
      {(isRun || isWaiting) && step.agent && (
        <text x={x + w / 2} y={y + h / 2 + 10}
          fontSize={9} fontWeight={500} fill="#3b82f6"
          textAnchor="middle" dominantBaseline="middle"
          style={{ pointerEvents: 'none' }}>
          {Array.isArray(step.agent) ? step.agent.join(', ') : step.agent}
        </text>
      )}
      {/* Status indicator dot */}
      {instantiated && (
        <circle cx={x + 10} cy={y + 10} r={4}
          fill={isDone ? '#22c55e' : isFail ? '#ef4444' : isRun ? '#3b82f6' : isWaiting ? '#f59e0b' : '#a1a1aa'}
          style={{ pointerEvents: 'none' }} />
      )}

      {/* Collapse/Expand chevron — always visible */}
      <foreignObject x={x + w - 22} y={y + (editing ? 4 : h/2 - 10)} width={20} height={20}>
        <div onClick={e => { e.stopPropagation(); onToggleEdit?.(); }}
          style={{ cursor: 'pointer', fontSize: 12, color: '#71717a', textAlign: 'center', lineHeight: '20px',
            transform: editing ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
          ▾
        </div>
      </foreignObject>


      {/* Edit mode: form fields */}
      {editing && (
        <foreignObject x={x + 8} y={y + 28} width={w - 16} height={h - 36}>
          <div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            {/* Agent multi-select */}
            <div>
              <label style={{ color: '#71717a', fontSize: 9, fontWeight: 600, display: 'block', marginBottom: 1 }}>Agent</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {(allAgents || []).map(a => (
                  <button key={a}
                    onClick={() => {
                      const agents = ag ? ag.split(',').map(s => s.trim()).filter(Boolean) : [];
                      const next = agents.includes(a) ? agents.filter(x => x !== a) : [...agents, a];
                      const v = next.join(', ');
                      setAg(v);
                      doSave({ agent: v });
                    }}
                    style={{
                      padding: '1px 5px', fontSize: 9, borderRadius: 4, border: '1px solid',
                      borderColor: ag.split(',').map(s => s.trim()).includes(a) ? c.stroke : '#e4e4e7',
                      background: ag.split(',').map(s => s.trim()).includes(a) ? c.fill : '#fff',
                      color: c.text, cursor: 'pointer',
                    }}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
            {/* Prompt — auto-height textarea */}
            <div>
              <label style={{ color: '#71717a', fontSize: 9, fontWeight: 600 }}>Prompt</label>
              <textarea value={pr}
                onChange={e => {
                  setPr(e.target.value);
                  doSave({ prompt: e.target.value });
                }}
                onInput={e => {
                  const t = e.target as HTMLTextAreaElement;
                  t.style.height = 'auto';
                  t.style.height = Math.min(t.scrollHeight, 80) + 'px';
                }}
                placeholder="任务描述..."
                rows={2}
                style={{
                  width: '100%', fontSize: 10, padding: '2px 4px',
                  border: '1px solid #e4e4e7', borderRadius: 4, outline: 'none',
                  resize: 'none', minHeight: 28, lineHeight: '14px',
                  fontFamily: 'inherit',
                }} />
            </div>
            {/* Action — dropdown list */}
            <div>
              <label style={{ color: '#71717a', fontSize: 9, fontWeight: 600, display: 'block', marginBottom: 1 }}>Action</label>
              <select value={act}
                onChange={e => { setAct(e.target.value); doSave({ action: e.target.value }); }}
                style={{
                  width: '100%', fontSize: 10, padding: '2px 4px',
                  border: '1px solid #e4e4e7', borderRadius: 4, outline: 'none',
                  background: '#fff', color: '#18181b',
                }}>
                {['create', 'review', 'fix', 'verify', 'deploy', 'research', 'execute'].map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            {/* Depends On */}
            <div>
              <label style={{ color: '#71717a', fontSize: 9, fontWeight: 600 }}>Deps</label>
              <input value={dep} onChange={e => { setDep(e.target.value); doSave({ dependsOn: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }); }}
                placeholder="step1, step2" style={{ width: '100%', fontSize: 10, padding: '1px 4px', border: '1px solid #e4e4e7', borderRadius: 4, outline: 'none' }} />
            </div>
            {saveErr && <span style={{ color: '#ef4444', fontSize: 9 }}>{saveErr}</span>}
          </div>
        </foreignObject>
      )}
      {/* Completed check */}
      {isDone && (
        <path d={`M ${x + w - 18} ${y + h - 10} l 4 4 l 8 -8`}
          fill="none" stroke="#22c55e" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round"
          style={{ strokeDasharray: 20, animation: 'wf-check .4s ease-out forwards', pointerEvents: 'none' }}
        />
      )}
      {/* Failed X */}
      {isFail && (
        <g style={{ pointerEvents: 'none' }}>
          <line x1={x + w - 18} y1={y + h - 12} x2={x + w - 10} y2={y + h - 4}
            stroke="#ef4444" strokeWidth={2} strokeLinecap="round" />
          <line x1={x + w - 10} y1={y + h - 12} x2={x + w - 18} y2={y + h - 4}
            stroke="#ef4444" strokeWidth={2} strokeLinecap="round" />
        </g>
      )}
    </g>
  );
}

// ═══════ Main Component ═══════
/**
 * Interactive workflow architecture diagram with pan/zoom, orthogonal edge routing,
 * inline block editing, and a minimap. Uses dagre for Sugiyama layout when available,
 * falling back to a simple centered layout.
 *
 * @param steps - Workflow step definitions with dependency information
 * @param run - Current run state containing per-step statuses (or null when idle)
 * @param allAgents - Available agent names for the agent multi-select in block editors
 * @param onTrigger - Callback when a step is triggered (e.g. from context menu)
 * @param running - Whether the workflow is currently executing
 * @param onStepClick - Callback when a step's data is edited inline
 * @param onStepAdd / onStepDelete - Callbacks for adding/removing steps
 * @param onEdgeClick / onEdgeDelete / onEdgeAdd - Callbacks for edge interactions
 */
export default function WorkflowArch({
  steps, run, allAgents, onTrigger, running, onStepClick, onStepAdd, onStepDelete, onEdgeClick,
}: Props) {
  // Inject CSS animations
  useEffect(() => {
    if (!document.getElementById('wf-css')) {
      const s = document.createElement('style');
      s.id = 'wf-css';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
  }, []);

  // Editing state — track which blocks are expanded
  const [editingBlocks, setEditingBlocks] = useState<Set<string>>(new Set());
  const toggleEdit = useCallback((id: string) => {
    setEditingBlocks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Load dagre once in browser, then compute layout
  const dagreRef = useRef<typeof dagre | null>(null);
  const [layoutReady, setLayoutReady] = useState(false);

  useEffect(() => {
    import('@dagrejs/dagre').then(mod => {
      dagreRef.current = mod.default || mod;
      setLayoutReady(true);
    }).catch(() => setLayoutReady(true)); // still render with fallback
  }, []);

  const layout = useMemo(() => computeLayout(steps, editingBlocks, dagreRef.current ?? undefined), [steps, editingBlocks, layoutReady]);
  const { positions, edges: edgeRoutes, layers } = layout;

  // Viewport
  const cRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cs, setCs] = useState({ w: 800, h: 600 });
  const panning = useRef(false);
  const panSt = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = cRef.current;
    if (!el) return;
    const obs = new ResizeObserver(e => {
      const { width: w, height: h } = e[0].contentRect;
      setCs({ w, h });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Pan
  const onPD = useCallback((e: React.PointerEvent) => {
    setCtx(null); // Close context menu on any pointer down
    panning.current = true;
    panSt.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [pan]);
  const onPM = useCallback((e: React.PointerEvent) => {
    if (!panning.current) return;
    setPan({
      x: e.clientX - panSt.current.x,
      y: e.clientY - panSt.current.y,
    });
  }, []);
  const onPU = useCallback(() => { panning.current = false; }, []);

  // Zoom (viewport center)
  const onWh = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2;
    setZoom(p => {
      const nz = Math.min(3, Math.max(0.3, p + (e.deltaY > 0 ? -0.1 : 0.1)));
      const s = nz / p;
      setPan(q => ({ x: cx - (cx - q.x) * s, y: cy - (cy - q.y) * s }));
      return nz;
    });
  }, []);
  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  // UI state
  const [ctx, setCtx] = useState<{ x: number; y: number; step?: Step } | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  const gp = useCallback((id: string) => positions.get(id) || null, [positions]);

  return (
    <div ref={cRef}
      style={{ width: '100%', height: '100%', position: 'relative', background: '#fafafa' }}
      onPointerDown={onPD} onPointerMove={onPM} onPointerUp={onPU} onPointerLeave={onPU}
      onWheel={onWh} onDoubleClick={reset}
      onClick={() => { setCtx(null); setSel(null); }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Only show if not on a block (blocks handle their own)
        if ((e.target as HTMLElement).closest('[data-block]')) return;
        setCtx({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Toolbar */}
      <div style={{
        position: 'absolute', top: 8, left: 8, zIndex: 15,
        display: 'flex', gap: 6,
      }}>
        <button onClick={(e) => { e.stopPropagation(); reset(); }}
          style={{
            padding: '5px 10px', fontSize: 11, fontWeight: 500,
            background: '#fff', color: '#71717a', border: '1px solid #e4e4e7',
            borderRadius: 6, cursor: 'pointer',
          }}>
          重置视图
        </button>
      </div>
      <svg width="100%" viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{
          display: 'block', overflow: 'visible',
          transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}>
        <defs>
          <marker id="arrow" markerWidth={10} markerHeight={7} refX={10} refY={3.5} orient="auto">
            <polygon points="0 0,10 3.5,0 7" fill="#52525b" />
          </marker>
          <marker id="route-arrow" markerWidth={10} markerHeight={7} refX={10} refY={3.5} orient="auto">
            <polygon points="0 0,10 3.5,0 7" fill="#f59e0b" />
          </marker>
        </defs>

        {/* DependsOn arrows — use dagre edge waypoints */}
        {steps.flatMap(step => {
          if (!step.dependsOn?.length) return [];
          return step.dependsOn
            .filter(depId => positions.has(depId))
            .map(depId => {
              const pts = edgeRoutes.get(`${depId}->${step.id}`);
              if (!pts || pts.length < 2) return null;
              const d = orthogonalPath(pts);
              return (
                <path
                  key={`${depId}-${step.id}`}
                  d={d}
                  fill="none" stroke="#52525b" strokeWidth={1.5}
                  markerEnd="url(#arrow)"
                  style={{ cursor: 'pointer' }}
                  onClick={e => { e.stopPropagation(); onEdgeClick?.(depId, step.id); }}
                  onMouseEnter={e => {
                    e.currentTarget.setAttribute('stroke', '#3b82f6');
                    e.currentTarget.setAttribute('stroke-width', '2.5');
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.setAttribute('stroke', '#52525b');
                    e.currentTarget.setAttribute('stroke-width', '1.5');
                  }}
                />
              );
            });
        })}

        {/* Route arrows — use dagre edge waypoints */}
        {steps.flatMap(step => {
          if (!step.routes?.length) return [];
          const fr = gp(step.id);
          if (!fr) return [];
          return step.routes.map(rt => {
            const pts = edgeRoutes.get(`route:${rt.step}->${step.id}`);
            if (!pts || pts.length < 2) return null;
            const d = orthogonalPath(pts);
            // Find midpoint for label
            const mid = pts[Math.floor(pts.length / 2)];
            return (
              <g key={`r-${step.id}-${rt.step}`} style={{ pointerEvents: 'none' }}>
                <path
                  d={d}
                  fill="none" stroke="#f59e0b" strokeWidth={1.5}
                  strokeDasharray="6,3"
                  style={{ animation: 'wf-dash 1s linear infinite' }}
                  markerEnd="url(#route-arrow)"
                />
                <text x={mid.x + 6} y={mid.y - 6}
                  fontSize={9} fill="#f59e0b"
                  fontFamily='"JetBrains Mono",monospace'>
                  {rt.when}
                </text>
              </g>
            );
          });
        })}

        {/* Blocks */}
        {[...positions.entries()].map(([sid, p]) => {
          const step = steps.find(s => s.id === sid);
          if (!step) return null;
          return (
            <Block key={sid} step={step} x={p.x} y={p.y} w={p.w} h={p.h}
              run={run} sel={sel === sid}
              editing={editingBlocks.has(sid)}
              allAgents={allAgents}
              onToggleEdit={() => toggleEdit(sid)}
              onEditSave={(d) => onStepClick?.({ ...step, ...d })}
              onAdd={onStepAdd}
              onDelete={onStepDelete}
              onTrigger={(id) => onTrigger?.(id)}
              onCtx={(e) => {
                setCtx({ x: e.clientX, y: e.clientY, step });
              }}
              onClick={() => { setSel(sid); toggleEdit(sid); }}
            />
          );
        })}

        {/* Context menu renders inside SVG via foreignObject with fixed positioning */}

      </svg>

      {/* Context menu — HTML overlay outside SVG */}
      {ctx && (
        <div style={{
          position: 'fixed', left: ctx.x, top: ctx.y,
          background: 'var(--color-canvas)', border: '1px solid var(--color-border)',
          borderRadius: 8, boxShadow: '0 4px 16px var(--color-shadow)',
          padding: '4px 0', fontSize: 13, minWidth: 160, zIndex: 9999,
        }} onClick={e => e.stopPropagation()}>
          {ctx.step ? (
            <>
              {onTrigger && (
                <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-surface-alt text-success font-medium"
                  onClick={() => { onTrigger(ctx.step!.id); setCtx(null); }}>
                  触发
                </div>
              )}
              <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-surface-alt text-foreground"
                onClick={() => { toggleEdit(ctx.step!.id); setCtx(null); }}>
                编辑
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-surface-alt text-foreground"
                onClick={() => { onStepAdd?.(ctx.step!.id); setCtx(null); }}>
                添加步骤
              </div>
              <div className="h-px bg-border my-1" />
              <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-red-50 dark:hover:bg-red-900/20 text-destructive"
                onClick={() => { onStepDelete?.(ctx.step!.id); setCtx(null); }}>
                删除
              </div>
            </>
          ) : (
            <>
              <div className="px-3 py-1.5 text-xs text-muted-foreground">空白区域</div>
            </>
          )}
        </div>
      )}

      <MiniMap steps={steps} positions={positions} zoom={zoom} pan={pan} cs={cs} />
    </div>
  );
}