'use client';

import { useState } from 'react';

// ── v1.2: Orchestrate Button ──────────────────────────────────────
export function OrchestrateButton({ group, onDone }: { group: string; onDone: () => void }) {
  const [show, setShow] = useState(false);
  const [goal, setGoal] = useState('');
  const [plan, setPlan] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const preview = async () => {
    if (!goal) return;
    setLoading(true);
    try {
      const res = await fetch('/api/orchestrate', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ goal, group, coordinator:'user', confirm:false }) });
      const data = await res.json();
      setPlan(data);
    } catch (e) { console.error('[components:orchestrate-button]', e); }
    setLoading(false);
  };

  const confirm = async () => {
    setLoading(true);
    try {
      await fetch('/api/orchestrate', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ goal, group, coordinator:'user', confirm:true }) });
      setShow(false); setGoal(''); setPlan(null);
      onDone();
    } catch (e) { console.error('[components:orchestrate-button]', e); }
    setLoading(false);
  };

  return (
    <>
      <button onClick={()=>setShow(!show)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-info-muted text-info hover:opacity-90 transition-colors">
        🎯 编排
      </button>
      {show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={()=>setShow(false)}>
          <div className="bg-canvas border border-border rounded-2xl p-6 w-[520px] max-h-[80vh] overflow-y-auto shadow-xl" onClick={e=>e.stopPropagation()}>
            <h3 className="text-[14px] font-medium text-foreground mb-3">🎯 AI 编排工作流</h3>
            <textarea value={goal} onChange={e=>{setGoal(e.target.value);setPlan(null);}}
              placeholder="描述你想让团队完成的目标..." rows={3}
              className="w-full px-3 py-2 text-[12px] bg-surface border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-ring resize-none mb-3"/>
            {!plan ? (
              <div className="flex justify-end gap-2">
                <button onClick={()=>setShow(false)} className="px-3 py-1.5 text-[11px] text-muted hover:text-foreground">取消</button>
                <button onClick={preview} disabled={loading||!goal}
                  className="px-3 py-1.5 text-[11px] font-medium bg-foreground text-canvas rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors">
                  {loading?'分析中...':'生成计划'}
                </button>
              </div>
            ) : (
              <>
                <div className="bg-surface rounded-xl p-4 mb-3">
                  <p className="text-[12px] font-medium text-foreground mb-2">{plan.workflowName}</p>
                  <p className="text-[11px] text-muted-foreground mb-3">{plan.description}</p>
                  <div className="space-y-2">
                    {(plan.steps||[]).map((s:any,i:number)=>(
                      <div key={i} className="flex items-start gap-2 text-[11px]">
                        <span className="w-5 h-5 rounded-full bg-surface-alt flex items-center justify-center text-[9px] font-medium text-muted shrink-0 mt-0.5">{i+1}</span>
                        <div className="flex-1">
                          <span className="font-medium text-foreground">{s.agent}</span>
                          <span className="text-muted-foreground"> ({s.action})</span>
                          {s.reviewer && <span className="text-muted-foreground"> → 审查: {s.reviewer}</span>}
                          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{s.prompt}</p>
                          {s.dependsOn?.length > 0 && <p className="text-[9px] text-muted-foreground">依赖: {s.dependsOn.join(', ')}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={()=>{setPlan(null);setGoal('');}} className="px-3 py-1.5 text-[11px] text-muted hover:text-foreground">重新生成</button>
                  <button onClick={confirm} disabled={loading}
                    className="px-3 py-1.5 text-[11px] font-medium bg-success text-canvas rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors">
                    {loading?'触发中...':'确认触发'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
