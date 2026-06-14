'use client';

import { useMemo, useRef, useState, useCallback, useEffect } from 'react';

// ═══════ Types ═══════
interface Step {
  id: string;
  agent?: string;
  action?: string;
  prompt?: string;
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
  onTrigger?: () => void;
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
const GAP_X = 16;
const GAP_Y = 80;
const PAD = 40;
const SVG_W = 480;
const ARROW_R = 12; // corner radius

// ═══════ Helpers ═══════
function getColor(action: string) {
  const k = action?.toLowerCase() || '';
  for (const [key, c] of Object.entries(COLORS)) if (k.includes(key)) return c;
  return COLORS.execute;
}

function buildLayers(steps: Step[]): Step[][] {
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
  const layers = new Map<number, Step[]>();
  for (const s of steps) {
    const k = memo.get(s.id) || 0;
    if (!layers.has(k)) layers.set(k, []);
    layers.get(k)!.push(s);
  }
  return [...layers.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

// ═══════ Arrow Path ═══════
// L-shape with rounded corners: horizontal → vertical → horizontal
// bendX = where the vertical segment runs
function arrowPath(x1: number, y1: number, x2: number, y2: number, bendX: number): string {
  const r = ARROW_R;
  const vDir = y2 > y1 ? 1 : -1;

  // Clamp radius to fit available space
  const vSpace = Math.abs(y2 - y1) / 2;
  const hSpace = Math.abs(bendX - x1) / 2;
  const rc = Math.min(r, vSpace, hSpace);

  // Too small for rounding — straight lines
  if (rc < 1) {
    return `M ${x1} ${y1} L ${bendX} ${y1} L ${bendX} ${y2} L ${x2} ${y2}`;
  }

  // Direction toward target for second corner
  const hDir2 = x2 > bendX ? 1 : -1;

  return [
    `M ${x1} ${y1}`,
    `L ${bendX - rc} ${y1}`,                              // horizontal to before corner 1
    `Q ${bendX} ${y1} ${bendX} ${y1 + vDir * rc}`,       // corner 1: horizontal → vertical
    `L ${bendX} ${y2 - vDir * rc}`,                       // vertical to before corner 2
    `Q ${bendX} ${y2} ${bendX + hDir2 * rc} ${y2}`,      // corner 2: vertical → horizontal
    `L ${x2} ${y2}`,                                       // horizontal to end
  ].join(' ');
}

// ═══════ Collision-free bendX ═══════
// Find a bendX that doesn't pass through any block in intermediate layers
function findSafeBendX(
  srcX: number, srcW: number, tgtX: number, tgtW: number,
  srcLayer: number, tgtLayer: number,
  positions: Map<string, { x: number; y: number; w: number; h: number }>,
  layers: Step[][],
): number {
  // Start with midpoint
  const defaultBendX = (srcX + srcW / 2 + tgtX + tgtW / 2) / 2;

  // Collect all blocks in layers between source and target
  const obstacles: Array<{ left: number; right: number; cx: number }> = [];
  for (let li = srcLayer + 1; li < tgtLayer; li++) {
    for (const step of layers[li]) {
      const p = positions.get(step.id);
      if (p) {
        obstacles.push({ left: p.x - 10, right: p.x + p.w + 10, cx: p.x + p.w / 2 });
      }
    }
  }

  // If no obstacles, use default
  if (obstacles.length === 0) return defaultBendX;

  // Check if default bendX collides with any obstacle
  const srcCx = srcX + srcW / 2;
  const intersects = obstacles.some(o => defaultBendX >= o.left && defaultBendX <= o.right);
  if (!intersects) return defaultBendX;

  // Find a safe position: try gaps between obstacles, then outside all obstacles
  const sorted = obstacles.sort((a, b) => a.cx - b.cx);

  // Try gaps between obstacles
  for (let i = 0; i < sorted.length - 1; i++) {
    const gapLeft = sorted[i].right;
    const gapRight = sorted[i + 1].left;
    if (gapRight - gapLeft >= 20) {
      // Gap is big enough — use the side closer to srcCx
      return srcCx < defaultBendX ? gapLeft + 10 : gapRight - 10;
    }
  }

  // No gap — go outside all obstacles
  const minLeft = Math.min(...sorted.map(o => o.left));
  const maxRight = Math.max(...sorted.map(o => o.right));

  // Try left side
  const leftSpace = minLeft - PAD;
  // Try right side
  const rightSpace = SVG_W - maxRight - PAD;

  // Pick the side with more space, closer to srcCx
  if (leftSpace >= rightSpace && leftSpace >= 30) {
    return minLeft - 20;
  } else if (rightSpace >= 30) {
    return maxRight + 20;
  }

  // Fallback: use minimum left with some margin
  return Math.max(PAD + 10, minLeft - 20);
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
  if (!positions.size) { mnX = 0; mnY = 0; mxX = SVG_W; mxY = 400; }
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

// ═══════ ContextMenu Component ═══════
function ContextMenu({ x, y, onClose, onEdit, onAdd, onDelete, onUp, onDown }: {
  x: number; y: number; onClose: () => void;
  onEdit: () => void; onAdd: () => void; onDelete: () => void;
  onUp: () => void; onDown: () => void;
}) {
  const items = [
    { icon: '✏️', label: '编辑', action: onEdit },
    { icon: '➕', label: '添加下一步', action: onAdd },
    { icon: '↑', label: '上移', action: onUp },
    { icon: '↓', label: '下移', action: onDown },
    { icon: '🗑️', label: '删除', action: onDelete, danger: true },
  ];

  return (
    <foreignObject x={x} y={y} width={150} height={200} style={{ overflow: 'visible' } as any}>
      <div style={{
        background: '#fff', border: '1px solid #e4e4e7', borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,.12)', padding: '4px 0', fontSize: 12,
        animation: 'wf-fade-in .15s ease-out', minWidth: 130,
      }} onClick={e => e.stopPropagation()}>
        {items.map(it => (
          <div key={it.label}
            style={{
              padding: '7px 12px', cursor: 'pointer',
              color: it.danger ? '#ef4444' : undefined,
              display: 'flex', alignItems: 'center', gap: 8,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f4f4f5')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={() => { it.action(); onClose(); }}
          >
            <span style={{ width: 16, textAlign: 'center' }}>{it.icon}</span>
            {it.label}
          </div>
        ))}
      </div>
    </foreignObject>
  );
}

// ═══════ Block Component ═══════
// Uses transparent overlay rect for reliable hover detection
function Block({ step, x, y, w, h, run, onClick, onCtx, sel }: {
  step: Step;
  x: number; y: number; w: number; h: number;
  run: Run | null;
  onClick?: () => void;
  onCtx?: (e: React.MouseEvent) => void;
  sel?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const st = run?.steps[step.id] || step.status || 'pending';
  const isRun = st === 'in_progress' || st === 'running';
  const isFail = st === 'failed';
  const isDone = st === 'completed';
  const c = getColor(step.action || 'execute');
  const sc = STATUS_COLORS[st] || c.stroke;

  let anim = 'none';
  if (isRun) anim = 'wf-pulse 2s ease-in-out infinite';
  else if (isFail) anim = 'wf-shake .4s ease-in-out';
  else if (st === 'waiting') anim = 'wf-blink 2s ease-in-out infinite';

  return (
    <g>
      {/* Transparent overlay for mouse events — this is the key fix for hover */}
      <rect
        x={x - 4} y={y - 4} width={w + 8} height={h + 8}
        fill="transparent"
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={e => { e.stopPropagation(); onClick?.(); }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onCtx?.(e); }}
      />
      {/* Shadow on hover */}
      {hovered && (
        <rect x={x + 2} y={y + 3} width={w} height={h}
          fill="rgba(0,0,0,0.08)" rx={6} />
      )}
      {/* Main rect */}
      <rect x={x} y={y} width={w} height={h}
        fill={isDone ? '#f0fdf4' : isFail ? '#fef2f2' : c.fill}
        stroke={sel ? '#3b82f6' : hovered ? '#3b82f6' : sc}
        strokeWidth={sel ? 2.5 : hovered ? 2 : 1.5}
        rx={6}
        style={{ animation: anim, pointerEvents: 'none' }}
      />
      {/* Step ID */}
      <text x={x + w / 2} y={y + h / 2 - (isRun && step.agent ? 4 : 0)}
        fontSize={13} fontWeight={700} fill={c.text}
        textAnchor="middle" dominantBaseline="middle"
        fontFamily='"JetBrains Mono",monospace'
        style={{ pointerEvents: 'none' }}>
        {step.id}
      </text>
      {/* Agent name — only when running */}
      {isRun && step.agent && (
        <text x={x + w / 2} y={y + h / 2 + 10}
          fontSize={9} fontWeight={500} fill={c.text} opacity={0.7}
          textAnchor="middle" dominantBaseline="middle"
          style={{ pointerEvents: 'none' }}>
          {step.agent}
        </text>
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

// ═══════ Sidebar Component ═══════
function Sidebar({ step, mode, onClose, onSave, onDelete }: {
  step: Step | null;
  mode: 'edit' | 'add';
  onClose: () => void;
  onSave: (d: any) => void;
  onDelete?: () => void;
}) {
  const [id, setId] = useState('');
  const [ag, setAg] = useState('');
  const [act, setAct] = useState('execute');
  const [pr, setPr] = useState('');
  const [dep, setDep] = useState('');

  useEffect(() => {
    if (step && mode === 'edit') {
      setId(step.id);
      setAg(step.agent || '');
      setAct(step.action || 'execute');
      setPr(step.prompt || '');
      setDep((step.dependsOn || []).join(', '));
    } else if (mode === 'add') {
      setId('');
      setAg('');
      setAct('execute');
      setPr('');
      setDep(step ? step.id : '');
    }
  }, [step, mode]);

  if (!step && mode === 'edit') return null;

  const I: React.CSSProperties = {
    width: '100%', padding: '8px 10px', fontSize: 12,
    border: '1px solid #e4e4e7', borderRadius: 6, outline: 'none',
    boxSizing: 'border-box' as any, background: '#fff', color: '#18181b',
  };
  const B: React.CSSProperties = {
    padding: '8px 16px', fontSize: 12, fontWeight: 500,
    border: '1px solid #e4e4e7', borderRadius: 6, cursor: 'pointer',
  };
  const L: React.CSSProperties = {
    fontSize: 11, fontWeight: 500, color: '#71717a',
    marginBottom: 4, display: 'block',
  };

  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 320,
      background: '#fff', borderLeft: '1px solid #e4e4e7',
      boxShadow: '-4px 0 16px rgba(0,0,0,.08)',
      display: 'flex', flexDirection: 'column', zIndex: 20,
      animation: 'wf-slide-in .2s ease-out',
    }}>
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid #e4e4e7',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          {mode === 'edit' ? `编辑 · ${step?.id}` : '添加步骤'}
        </span>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 18, color: '#71717a',
        }}>×</button>
      </div>
      <div style={{
        flex: 1, padding: 20, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {mode === 'add' && (
          <div>
            <label style={L}>步骤 ID</label>
            <input value={id} onChange={e => setId(e.target.value)} placeholder="step_id" style={I} />
          </div>
        )}
        <div>
          <label style={L}>Agent</label>
          <input value={ag} onChange={e => setAg(e.target.value)} placeholder="Alice / Bob" style={I} />
        </div>
        <div>
          <label style={L}>Action</label>
          <select value={act} onChange={e => setAct(e.target.value)} style={I}>
            {['create', 'review', 'fix', 'verify', 'deploy', 'research', 'execute'].map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={L}>Prompt</label>
          <textarea value={pr} onChange={e => setPr(e.target.value)}
            placeholder="任务描述..." rows={4}
            style={{ ...I, resize: 'vertical' }} />
        </div>
        <div>
          <label style={L}>Depends On</label>
          <input value={dep} onChange={e => setDep(e.target.value)}
            placeholder="step1, step2" style={I} />
        </div>
      </div>
      <div style={{
        padding: '16px 20px', borderTop: '1px solid #e4e4e7',
        display: 'flex', gap: 8,
      }}>
        {mode === 'edit' && onDelete && (
          <button onClick={() => { onDelete(); onClose(); }}
            style={{ ...B, background: '#fef2f2', color: '#ef4444', border: '1px solid #fecaca' }}>
            删除
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{ ...B, background: '#f4f4f5' }}>取消</button>
        <button onClick={() => onSave({
          id, agent: ag, action: act, prompt: pr,
          dependsOn: dep.split(',').map(s => s.trim()).filter(Boolean),
        })}
          style={{ ...B, background: '#18181b', color: '#fff' }}>
          {mode === 'edit' ? '保存' : '添加'}
        </button>
      </div>
    </div>
  );
}

// ═══════ Main Component ═══════
export default function WorkflowArch({
  steps, run, onStepClick, onStepAdd, onStepDelete, onEdgeClick,
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

  const layers = useMemo(() => buildLayers(steps), [steps]);
  const n = layers.length;
  const svgH = n * (BLOCK_H + GAP_Y) + PAD * 2;

  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (let i = 0; i < n; i++) {
      const layer = layers[i];
      const y = PAD + (n - 1 - i) * (BLOCK_H + GAP_Y);
      if (layer.length === 1) {
        pos.set(layer[0].id, {
          x: (SVG_W - BLOCK_W) / 2, y, w: BLOCK_W, h: BLOCK_H,
        });
      } else {
        const tw = layer.length * BLOCK_W + (layer.length - 1) * GAP_X;
        const ox = (SVG_W - tw) / 2;
        layer.forEach((s, j) => {
          pos.set(s.id, {
            x: ox + j * (BLOCK_W + GAP_X), y, w: BLOCK_W, h: BLOCK_H,
          });
        });
      }
    }
    return pos;
  }, [layers, n]);

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
  const [ctx, setCtx] = useState<{ x: number; y: number; step: Step } | null>(null);
  const [sb, setSb] = useState<{ mode: 'edit' | 'add'; step: Step | null } | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  const gp = useCallback((id: string) => positions.get(id) || null, [positions]);

  return (
    <div ref={cRef}
      style={{ width: '100%', height: '100%', position: 'relative', background: '#fafafa' }}
      onPointerDown={onPD} onPointerMove={onPM} onPointerUp={onPU} onPointerLeave={onPU}
      onWheel={onWh} onDoubleClick={reset}
      onClick={() => { setCtx(null); setSel(null); }}
    >
      <svg width="100%" viewBox={`0 0 ${SVG_W} ${svgH}`}
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

        {/* DependsOn arrows — rounded-corner L-shape */}
        {layers.flatMap((layer, li) => {
          if (li >= n - 1) return [];
          return layer.flatMap(step => {
            const f = gp(step.id);
            if (!f) return [];
            return layers[li + 1]
              .filter(t => t.dependsOn?.includes(step.id))
              .map(t => {
                const to = gp(t.id);
                if (!to) return null;
                const bendX = findSafeBendX(f.x, f.w, to.x, to.w, li, li + 1, positions, layers);
                return (
                  <path
                    key={`${step.id}-${t.id}`}
                    d={arrowPath(f.x + f.w / 2, f.y, to.x + to.w / 2, to.y + to.h, bendX)}
                    fill="none" stroke="#52525b" strokeWidth={1.5}
                    markerEnd="url(#arrow)"
                    style={{ cursor: 'pointer' }}
                    onClick={e => { e.stopPropagation(); onEdgeClick?.(step.id, t.id); }}
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
          });
        })}

        {/* Route arrows — same rounded-corner L-shape, bendX = right of all blocks */}
        {(() => {
          let maxRight = 0;
          positions.forEach(p => { maxRight = Math.max(maxRight, p.x + p.w); });
          const outsideX = maxRight + 50;
          return steps.flatMap(step => {
            if (!step.routes?.length) return [];
            const fr = gp(step.id);
            if (!fr) return [];
            return step.routes.map(rt => {
              const to = gp(rt.step);
              if (!to) return null;
              const x1 = fr.x + fr.w, y1 = fr.y + fr.h / 2;
              const x2 = to.x + to.w, y2 = to.y + to.h / 2;
              return (
                <g key={`r-${step.id}-${rt.step}`} style={{ pointerEvents: 'none' }}>
                  <path
                    d={arrowPath(x1, y1, x2, y2, outsideX)}
                    fill="none" stroke="#f59e0b" strokeWidth={1.5}
                    strokeDasharray="6,3"
                    style={{ animation: 'wf-dash 1s linear infinite' }}
                    markerEnd="url(#route-arrow)"
                  />
                  <text x={outsideX + 8} y={(y1 + y2) / 2}
                    fontSize={9} fill="#f59e0b"
                    fontFamily='"JetBrains Mono",monospace'
                    dominantBaseline="middle">
                    {rt.when}
                  </text>
                </g>
              );
            });
          });
        })()}

        {/* Blocks */}
        {[...positions.entries()].map(([sid, p]) => {
          const step = steps.find(s => s.id === sid);
          if (!step) return null;
          return (
            <Block key={sid} step={step} x={p.x} y={p.y} w={p.w} h={p.h}
              run={run} sel={sel === sid}
              onClick={() => { setSel(sid); setSb({ mode: 'edit', step }); }}
              onCtx={e => {
                const c = cRef.current;
                if (c) {
                  const r = c.getBoundingClientRect();
                  setCtx({ x: e.clientX - r.left, y: e.clientY - r.top, step });
                }
              }}
            />
          );
        })}

        {/* Context menu */}
        {ctx && (
          <foreignObject x={ctx.x} y={ctx.y} width={150} height={200}
            style={{ overflow: 'visible' } as any}>
            <ContextMenu x={0} y={0} onClose={() => setCtx(null)}
              onEdit={() => { setSb({ mode: 'edit', step: ctx.step }); setCtx(null); }}
              onAdd={() => { setSb({ mode: 'add', step: ctx.step }); setCtx(null); }}
              onDelete={() => { onStepDelete?.(ctx.step.id); setCtx(null); }}
              onUp={() => setCtx(null)}
              onDown={() => setCtx(null)}
            />
          </foreignObject>
        )}
      </svg>

      <MiniMap steps={steps} positions={positions} zoom={zoom} pan={pan} cs={cs} />

      {sb && (
        <Sidebar step={sb.step} mode={sb.mode} onClose={() => setSb(null)}
          onSave={d => {
            if (sb.mode === 'edit') onStepClick?.({ ...sb.step!, ...d });
            else onStepAdd?.(sb.step?.id);
            setSb(null);
          }}
          onDelete={sb.mode === 'edit' ? () => onStepDelete?.(sb.step!.id) : undefined}
        />
      )}
    </div>
  );
}
