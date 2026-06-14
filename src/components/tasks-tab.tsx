'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';

// ── v1.2: Tasks Tab ──────────────────────────────────────────────
export function TasksTab({ group }: { group: string }) {
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPost, setShowPost] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', description: '', reward: 0 });
  const [agents, setAgents] = useState<{name:string}[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/tasks?group=${group}`).then(r=>r.json()).then(d=>{ setTasks(d.tasks||[]); setLoading(false); }).catch(()=>setLoading(false));
    fetch('/api/agents').then(r=>r.json()).then(d=>setAgents((d.agents||[]).filter((a:any)=>a.name!=='me'))).catch(()=>{});
  }, [group]);
  useEffect(()=>{load()},[load]);

  const postTask = async () => {
    if (!newTask.title || !newTask.description) return;
    await fetch('/api/tasks', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ group, id: `task-${Date.now().toString(36)}`, ...newTask, postedBy: 'user' }) });
    setNewTask({ title:'', description:'', reward:0 });
    setShowPost(false);
    load();
  };

  const claimTask = async (taskId: string) => {
    await fetch('/api/tasks', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ group, taskId, action:'claim', agent:'me', message:'我来认领' }) });
    load();
  };

  const selectAgent = async (taskId: string, agent: string) => {
    await fetch('/api/tasks', { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ group, taskId, action:'select', agent }) });
    load();
  };

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[14px] font-medium text-foreground">📋 任务看板</h3>
        <button onClick={()=>setShowPost(!showPost)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-foreground text-canvas hover:opacity-90 transition-colors">
          <Plus size={12}/> 发布任务
        </button>
      </div>

      {showPost && (
        <div className="bg-surface border border-border rounded-xl p-4 mb-4 space-y-3">
          <input value={newTask.title} onChange={e=>setNewTask({...newTask, title:e.target.value})}
            placeholder="任务标题" className="w-full px-3 py-2 text-[12px] bg-canvas border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-ring"/>
          <textarea value={newTask.description} onChange={e=>setNewTask({...newTask, description:e.target.value})}
            placeholder="任务描述" rows={3} className="w-full px-3 py-2 text-[12px] bg-canvas border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-ring resize-none"/>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">奖励:</span>
              <input type="number" value={newTask.reward} onChange={e=>setNewTask({...newTask, reward:Number(e.target.value)})}
                className="w-20 px-2 py-1 text-[11px] bg-canvas border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-ring"/>
              <span className="text-[10px] text-muted-foreground">tokens</span>
            </div>
            <div className="flex-1"/>
            <button onClick={()=>setShowPost(false)} className="px-3 py-1.5 text-[11px] text-muted hover:text-foreground transition-colors">取消</button>
            <button onClick={postTask} className="px-3 py-1.5 text-[11px] font-medium bg-foreground text-canvas rounded-lg hover:opacity-90 transition-colors">发布</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-[12px] text-muted-foreground text-center py-8">加载中...</p>
      ) : tasks.length === 0 ? (
        <p className="text-[12px] text-muted-foreground text-center py-8">暂无开放任务</p>
      ) : (
        <div className="space-y-3">
          {tasks.map(task => (
            <div key={task.id} className="bg-canvas border border-border rounded-xl p-4">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h4 className="text-[13px] font-medium text-foreground">{task.title}</h4>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{task.description}</p>
                </div>
                {task.reward > 0 && (
                  <span className="text-[11px] font-mono text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full shrink-0 ml-2">{task.reward} tokens</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-3">
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                  task.status==='open' ? 'bg-success-muted text-success' : task.status==='assigned' ? 'bg-info-muted text-info' : 'bg-surface-alt text-muted'
                }`}>{task.status === 'open' ? '开放' : task.status === 'assigned' ? '已分配' : task.status}</span>
                <span className="text-[10px] text-muted-foreground">发布者: {task.postedBy}</span>
                {task.claims?.length > 0 && <span className="text-[10px] text-muted-foreground">· {task.claims.length} 个认领</span>}
              </div>
              {task.status === 'open' && task.claims?.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <p className="text-[10px] text-muted-foreground font-medium">认领者:</p>
                  {task.claims.map((c:any) => (
                    <div key={c.agent} className="flex items-center gap-2 pl-2">
                      <span className="text-[11px] font-medium text-foreground">{c.agent}</span>
                      {c.message && <span className="text-[10px] text-muted-foreground truncate flex-1">{c.message}</span>}
                      <button onClick={()=>selectAgent(task.id, c.agent)}
                        className="px-2 py-0.5 text-[10px] font-medium bg-success-muted text-success rounded hover:opacity-80 transition-colors">选择</button>
                    </div>
                  ))}
                </div>
              )}
              {task.status === 'open' && (
                <div className="mt-3">
                  <button onClick={()=>claimTask(task.id)}
                    className="px-3 py-1.5 text-[11px] font-medium bg-surface-alt text-foreground rounded-lg hover:bg-surface-hover transition-colors">认领任务</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
