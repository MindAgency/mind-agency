'use client';

import { useState, useEffect } from 'react';

function formatTime(ts: string): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

/** Operations log — shows file Write/Edit/Delete/Bash actions by this agent. */
export function OpsLog({ agentName }: { agentName: string }) {
  const [ops, setOps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    fetch(`/api/audit?agent=${agentName}&limit=100`)
      .then(r => r.json())
      .then(d => setOps((d.logs || []).filter((l: any) => l.action.startsWith('file.'))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentName]);

  if (loading) return <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">加载中...</div>;
  if (ops.length === 0) return <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">暂无操作记录</div>;

  return (
    <div className="flex-1 overflow-y-auto">
      {ops.map((op, i) => (
        <div key={i} className="px-5 py-2.5 border-b border-border/50 hover:bg-surface/30 flex items-start gap-3">
          <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${
            op.action === 'file.write' ? 'bg-success-muted text-success' :
            op.action === 'file.edit' ? 'bg-info-muted text-info' :
            op.action === 'file.delete' ? 'bg-destructive-muted text-destructive' :
            op.action === 'file.rename' ? 'bg-amber-50 text-amber-600' :
            'bg-surface-alt text-muted-foreground'
          }`}>{op.action.replace('file.', '')}</span>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] text-foreground font-mono truncate">{op.resource || op.details}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{formatTime(op.timestamp)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
