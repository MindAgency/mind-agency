'use client';

interface Step {
  id: string;
  type?: string;
  agent?: string | string[];
  action?: string;
  prompt?: string;
  trigger?: Record<string, unknown>;
  dependsOn?: string[];
}

interface Run {
  runId: string;
  status: string;
  steps: Record<string, string>;
}

interface Props {
  steps: Step[];
  run: Run | null;
  onTrigger?: (stepId: string) => void;
}

const ACTION_BADGE: Record<string, { label: string; cls: string }> = {
  create:  { label: 'Create',  cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  review:  { label: 'Review',  cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
  fix:     { label: 'Fix',     cls: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400' },
  verify:  { label: 'Verify',  cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  deploy:  { label: 'Deploy',  cls: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400' },
  research:{ label: 'Research',cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
  execute: { label: 'Execute', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
};

/** Kanban card representing a single workflow step. */
function Card({ step, onTrigger }: { step: Step; onTrigger?: (stepId: string) => void }) {
  const badge = ACTION_BADGE[step.action || 'execute'] || ACTION_BADGE.execute;
  const agentName = step.agent ? (Array.isArray(step.agent) ? step.agent[0] : step.agent) : null;
  return (
    <div
      className="bg-canvas border border-border rounded-lg p-3 cursor-pointer transition-all hover:shadow-md hover:border-border-strong"
      onClick={() => onTrigger?.(step.id)}
    >
      {/* Step ID */}
      <div className="text-[11px] font-mono text-muted-foreground mb-1">
        {step.id}
      </div>

      {/* Title */}
      <div className="text-sm font-medium text-foreground leading-snug mb-2 line-clamp-2">
        {step.prompt || step.id}
      </div>

      {/* Bottom: badge + agent */}
      <div className="flex items-center justify-between">
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${badge.cls}`}>
          {badge.label}
        </span>

        {agentName && (
          <div className="flex items-center gap-1.5">
            <div className="w-5 h-5 rounded-full bg-surface-alt flex items-center justify-center text-[10px] font-semibold text-muted-foreground">
              {agentName[0].toUpperCase()}
            </div>
            <span className="text-xs text-muted-foreground">{agentName}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Kanban column with a title, count badge, and a list of step cards. */
function Col({ title, items, onTrigger }: { title: string; items: Step[]; onTrigger?: (stepId: string) => void }) {
  return (
    <div className="flex-1 min-w-[220px] flex flex-col">
      {/* Column header */}
      <div className="flex items-center gap-2 mb-2 px-0.5">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground bg-surface-alt px-1.5 py-0.5 rounded-full">
          {items.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-1.5">
        {items.map(s => <Card key={s.id} step={s} onTrigger={onTrigger} />)}
        {items.length === 0 && (
          <div className="text-xs text-muted py-4 text-center">暂无</div>
        )}
      </div>
    </div>
  );
}

/**
 * Kanban board view for workflow steps. Categorises steps into Backlog, Ready,
 * In Progress, Done, and Failed columns based on the current run state.
 *
 * @param steps - Workflow step definitions
 * @param run - Current run state with per-step statuses (null when idle)
 * @param onTrigger - Callback when a step card is clicked
 */
export function KanbanTab({ steps, run, onTrigger }: Props) {
  const normalSteps = steps.filter(s => s.type !== 'trigger' && !s.trigger);
  const ready: Step[] = [], inProgress: Step[] = [], done: Step[] = [], failed: Step[] = [];

  for (const s of normalSteps) {
    if (!run || !(s.id in run.steps)) {
      const deps = s.dependsOn || [];
      if (deps.length > 0 && deps.every(d => run?.steps[d] === 'completed')) ready.push(s);
    } else {
      const st = run.steps[s.id];
      if (st === 'completed') done.push(s);
      else if (st === 'failed') failed.push(s);
      else inProgress.push(s);
    }
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-2.5 border-b border-border bg-canvas flex items-center gap-2 shrink-0">
        <span className="text-sm font-semibold text-foreground">看板</span>
        <span className="text-xs text-muted-foreground">{steps.length} 步骤</span>
      </div>

      {/* Columns */}
      <div className="flex-1 flex p-4 overflow-auto items-start bg-surface">
        <Col title="Backlog" items={[]} onTrigger={onTrigger} />
        <div className="w-px bg-border mx-3 self-stretch" />
        <Col title="Ready" items={ready} onTrigger={onTrigger} />
        <div className="w-px bg-border mx-3 self-stretch" />
        <Col title="In Progress" items={inProgress} onTrigger={onTrigger} />
        <div className="w-px bg-border mx-3 self-stretch" />
        <Col title="Done" items={done} onTrigger={onTrigger} />
        <div className="w-px bg-border mx-3 self-stretch" />
        <Col title="Failed" items={failed} onTrigger={onTrigger} />
      </div>
    </div>
  );
}
