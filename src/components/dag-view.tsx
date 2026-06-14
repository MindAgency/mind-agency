'use client';

import React from 'react';

const DAG_COLORS = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6'];

export function DagViewSafe(props: any) {
  try { return <DagView {...props} />; }
  catch (e: any) {
    console.error('[DagView ERROR]', e?.message || e);
    return <div className="bg-surface rounded-xl p-4 text-[12px] text-destructive">DAG error: {e?.message || String(e)}</div>;
  }
}

export function DagView({ steps, hoveredStep, setHoveredStep }: { steps: any[]; hoveredStep: string | null; setHoveredStep: (id: string | null) => void }) {
  if (!steps || steps.length === 0) {
    return <div className="bg-surface rounded-xl p-8 text-center text-[12px] text-muted-foreground">暂无步骤</div>;
  }
  // Compute layers: topological sort into parallel lanes
  const layers: any[][] = [];
  const placed = new Set<string>();
  const stepMap = new Map(steps.map((s, i) => [s.id || `step_${i}`, { ...s, _idx: i }]));

  // Place steps with no unplaced deps into layers
  let remaining = [...stepMap.values()];
  while (remaining.length > 0) {
    const layer: any[] = [];
    const nextRemaining: any[] = [];
    for (const s of remaining) {
      const deps = s.dependsOn || s.depends_on || [];
      const depsArr = Array.isArray(deps) ? deps : [deps];
      const allDepsPlaced = depsArr.every((d: string) => placed.has(d));
      if (allDepsPlaced || depsArr.length === 0) {
        layer.push(s);
        placed.add(s.id || `step_${s._idx}`);
      } else {
        nextRemaining.push(s);
      }
    }
    if (layer.length === 0) break; // prevent infinite loop on circular deps
    layers.push(layer);
    remaining = nextRemaining;
  }

  const CARD_W = 176;
  const CARD_H = 80;
  const GAP_X = 48;
  const GAP_Y = 24;
  const PAD = 24;

  // Compute positions
  const positions = new Map<string, { x: number; y: number }>();
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    for (let ci = 0; ci < layer.length; ci++) {
      const s = layer[ci];
      const id = s.id || `step_${s._idx}`;
      positions.set(id, {
        x: PAD + li * (CARD_W + GAP_X),
        y: PAD + ci * (CARD_H + GAP_Y),
      });
    }
  }

  const svgW = Math.max(layers.length, 1) * (CARD_W + GAP_X) + PAD * 2;
  const svgH = Math.max(Math.max(...layers.map(l => l.length), 0), 1) * (CARD_H + GAP_Y) + PAD * 2;

  // Build edges
  const edges: Array<{ x1: number; y1: number; x2: number; y2: number; color: string }> = [];
  for (const s of steps) {
    const id = s.id || `step_${steps.indexOf(s)}`;
    const pos = positions.get(id);
    if (!pos) continue;
    const deps = s.dependsOn || s.depends_on || [];
    const depsArr = Array.isArray(deps) ? deps : [deps];
    for (const depId of depsArr) {
      const depPos = positions.get(depId);
      if (!depPos) continue;
      edges.push({
        x1: depPos.x + CARD_W, y1: depPos.y + CARD_H / 2,
        x2: pos.x, y2: pos.y + CARD_H / 2,
        color: 'var(--color-border-strong)',
      });
    }
  }

  return (
    <div className="bg-surface rounded-xl overflow-auto" style={{ maxHeight: '70vh' }}>
      <div className="relative" style={{ width: svgW, height: svgH, minWidth: svgW, minHeight: svgH }}>
        {/* SVG edges */}
        <svg className="absolute inset-0 pointer-events-none" width={svgW} height={svgH}>
          {edges.map((e, i) => (
            <g key={i}>
              <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={e.color} strokeWidth="1.5" strokeDasharray="4 2" />
              <circle cx={e.x2} cy={e.y2} r="3" fill={e.color} />
            </g>
          ))}
        </svg>
        {/* Step cards */}
        {steps.map((s: any, i: number) => {
          const id = s.id || `step_${i}`;
          const pos = positions.get(id);
          if (!pos) return null;
          const color = DAG_COLORS[i % DAG_COLORS.length];
          const isHovered = hoveredStep === id;
          return (
            <div key={i} className="absolute"
              style={{ left: pos.x, top: pos.y, width: CARD_W }}
              onMouseEnter={() => setHoveredStep(id)} onMouseLeave={() => setHoveredStep(null)}>
              <div className={`bg-canvas rounded-xl p-3 transition-all cursor-default ${isHovered ? 'shadow-lg scale-[1.02]' : 'shadow-sm'}`}
                style={{ border: `1.5px solid ${isHovered ? color : 'var(--color-border)'}` }}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-[9px] font-mono text-white px-1.5 py-0.5 rounded shrink-0" style={{ backgroundColor: color }}>
                    #{i + 1}
                  </span>
                  <span className="text-[11px] font-medium text-foreground truncate">{id}</span>
                </div>
                <div className="flex items-center gap-1 text-[10px] text-muted mb-1">
                  <span className="font-medium">{s.agent || '?'}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="truncate">{s.action}</span>
                </div>
                {s.reviewer && (
                  <div className="flex items-center gap-1 text-[9px] text-info">
                    <span>👁 {s.reviewer}</span>
                  </div>
                )}
                {s.priority && <span className="text-[9px] text-amber-500 mt-0.5 block">⚡ {s.priority}</span>}
                {s.condition && (
                  <div className="mt-1 pt-1 border-t border-border/50">
                    <span className="text-[8px] text-muted-foreground font-mono truncate block" title={s.condition}>{s.condition}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function timeFmt(d: string): string {
  if (!d) return '';
  try { return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return d.slice(11, 16); }
}
