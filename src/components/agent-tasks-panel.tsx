'use client';

import { GitBranch, RefreshCw } from 'lucide-react';

export function TasksPanel({ agentName, tasks, onRefresh }: { agentName: string; tasks: any[]; onRefresh: () => void }) {
  const statusColors: Record<string, string> = {
    pending: 'bg-surface-alt text-muted',
    in_progress: 'bg-info-muted text-info',
    completed: 'bg-success-muted text-success',
    failed: 'bg-destructive-muted text-destructive',
    skipped: 'bg-surface-alt text-muted-foreground/50',
  };
  const statusLabels: Record<string, string> = {
    pending: '等待中', in_progress: '执行中', completed: '已完成', failed: '失败', skipped: '已跳过',
  };

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <GitBranch size={24} className="text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-[12px] text-muted-foreground">暂无分配的任务</p>
          <p className="text-[10px] text-muted-foreground/50 mt-1">工作流引擎会在执行时自动分配任务给 Agent</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <span className="text-[12px] font-medium text-foreground">任务 ({tasks.length})</span>
        <button onClick={onRefresh} className="text-[11px] text-muted-foreground hover:text-muted flex items-center gap-1">
          <RefreshCw size={11} /> 刷新
        </button>
      </div>
      {tasks.map((task, i) => (
        <div key={i} className="px-5 py-3 border-b border-border/50 hover:bg-surface/30">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusColors[task.status] || 'bg-surface-alt text-muted'}`}>
                {statusLabels[task.status] || task.status}
              </span>
              <span className="text-[12px] font-medium text-foreground">{task.stepId}</span>
              <span className="text-[10px] text-muted-foreground">· {task.action}</span>
            </div>
            <span className="text-[10px] text-muted-foreground/50">#{task.group}</span>
          </div>
          {task.prompt && (
            <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{task.prompt}</p>
          )}
          {task.report && (
            <div className="mt-2 p-2 bg-surface rounded-lg">
              <p className="text-[11px] text-foreground font-medium">{task.report.summary}</p>
              {task.report.details && <p className="text-[10px] text-muted-foreground mt-0.5">{task.report.details}</p>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
