'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from '@/components/sidebar';
import { useT } from '@/components/i18n';
import {
  Users, Hash, Play, CheckCircle, XCircle, Clock, Loader2,
  Plus, X, ChevronDown, ChevronRight, Zap, Activity, AlertCircle,
} from 'lucide-react';

/* ─── Types ─────────────────────────────────────────────── */

interface AgentInfo {
  name: string;
  emailCount: number;
  config?: { roles?: string[]; autoRespondToEmail?: boolean };
  activity?: { active: boolean; status: string; detail: string };
}

interface GroupInfo {
  name: string;
  members?: string[];
  owner?: string;
  admins?: string[];
}

interface WorkflowDef {
  group: string;
  name: string;
  description?: string;
  steps: any[];
}

interface RunInfo {
  runId: string;
  group: string;
  workflowName: string;
  status: string;
  stepsTotal: number;
  stepsDone: number;
  startedAt: number;
  steps: Record<string, string>;
}

/* ─── Helpers ───────────────────────────────────────────── */

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function statusColor(s: string) {
  if (s === 'running') return 'bg-info-muted text-info';
  if (s === 'completed') return 'bg-success-muted text-success';
  if (s === 'failed') return 'bg-destructive-muted text-destructive';
  return 'bg-surface text-muted-foreground';
}

function statusIcon(s: string) {
  if (s === 'running') return <Loader2 size={12} className="animate-spin" />;
  if (s === 'completed') return <CheckCircle size={12} />;
  if (s === 'failed') return <XCircle size={12} />;
  return <Clock size={12} />;
}

/* ─── Component ─────────────────────────────────────────── */

export default function DashboardPage() {
  const { t } = useT();

  // Data
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);

  // UI state
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'error' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Modal state
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newAgentName, setNewAgentName] = useState('');
  const [creating, setCreating] = useState(false);

  // Expanded sections
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());

  const showToast = useCallback((msg: string, type: 'ok' | 'error' = 'ok') => {
    clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  /* ─── Data loading ─────────────────────────────────────── */

  const load = useCallback(async () => {
    try {
      const [agentsRes, groupsRes, workflowsRes, runsRes, settingsRes] = await Promise.allSettled([
        fetch('/api/agents').then(r => r.json()),
        fetch('/api/groups/scan').then(r => r.json()),
        loadWorkflows(),
        fetch('/api/workflows/run').then(r => r.json()),
        fetch('/api/system/settings').then(r => r.json()),
      ]);

      if (agentsRes.status === 'fulfilled') {
        const list = (agentsRes.value.agents || []) as AgentInfo[];
        setAgents(list);
      }
      if (groupsRes.status === 'fulfilled') {
        const names: string[] = groupsRes.value.groups || [];
        // Enrich each group with member info
        const enriched = await Promise.all(
          names.map(async (n) => {
            try {
              const r = await fetch(`/api/groups/${encodeURIComponent(n)}/members`);
              const d = await r.json();
              return { name: n, members: d.members || [], owner: d.owner || '', admins: d.admins || [] } as GroupInfo;
            } catch {
              return { name: n, members: [] } as GroupInfo;
            }
          })
        );
        setGroups(enriched);
      }
      if (workflowsRes.status === 'fulfilled') {
        setWorkflows(workflowsRes.value);
      }
      if (runsRes.status === 'fulfilled') {
        setRuns(runsRes.value.runs || []);
      }
      if (settingsRes.status === 'fulfilled') {
        setApiKeyConfigured(!!settingsRes.value.apiKey);
      } else {
        setApiKeyConfigured(false);
      }
    } catch (e) {
      console.error('[dashboard]', e);
    }
    setLoading(false);
  }, []);

  async function loadWorkflows(): Promise<WorkflowDef[]> {
    try {
      const gr = await fetch('/api/groups/scan').then(r => r.json());
      const names: string[] = gr.groups || [];
      const results = await Promise.all(
        names.map(g =>
          fetch(`/api/groups/${encodeURIComponent(g)}/workflow`).then(r => r.json()).catch(() => null)
        )
      );
      const wfs: WorkflowDef[] = [];
      for (let i = 0; i < names.length; i++) {
        const wr = results[i];
        if (wr && wr.name && Array.isArray(wr.stepsList) && wr.stepsList.length > 0) {
          wfs.push({ group: names[i], name: wr.name, description: wr.description, steps: wr.stepsList });
        }
      }
      return wfs;
    } catch {
      return [];
    }
  }

  /* ─── Polling (every 3s) ──────────────────────────────── */

  useEffect(() => {
    load();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active) return;
      try {
        const [runsRes, agentsRes] = await Promise.allSettled([
          fetch('/api/workflows/run').then(r => r.json()),
          fetch('/api/agents').then(r => r.json()),
        ]);
        if (!active) return;
        if (runsRes.status === 'fulfilled') setRuns(runsRes.value.runs || []);
        if (agentsRes.status === 'fulfilled') setAgents((agentsRes.value.agents || []) as AgentInfo[]);
      } catch { /* ignore */ }
      timer = setTimeout(poll, 3000);
    };
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [load]);

  /* ─── Actions ──────────────────────────────────────────── */

  const createGroup = async () => {
    if (!newGroupName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown' }));
        showToast(err.error || 'Failed to create group', 'error');
        return;
      }
      showToast(`Group "${newGroupName.trim()}" created`, 'ok');
      setNewGroupName('');
      setShowCreateGroup(false);
      load();
    } catch (e) {
      showToast('Network error', 'error');
    }
    setCreating(false);
  };

  const createAgent = async () => {
    if (!newAgentName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newAgentName.trim(),
          roles: ['member'],
          autoRespondToEmail: true,
          permissions: { canCreateGroup: true, canDeleteGroup: false, canDeploy: false },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown' }));
        showToast(err.error || 'Failed to create agent', 'error');
        return;
      }
      showToast(`Agent "${newAgentName.trim()}" created`, 'ok');
      setNewAgentName('');
      setShowCreateAgent(false);
      load();
    } catch (e) {
      showToast('Network error', 'error');
    }
    setCreating(false);
  };

  const triggerWorkflow = async (group: string) => {
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group)}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown' }));
        showToast(`Trigger failed: ${err.error}`, 'error');
        return;
      }
      showToast(`Workflow triggered for "${group}"`, 'ok');
      setTimeout(load, 1500);
    } catch (e) {
      showToast('Network error', 'error');
    }
  };

  const toggleRunExpand = (runId: string) => {
    setExpandedRuns(prev => {
      const n = new Set(prev);
      n.has(runId) ? n.delete(runId) : n.add(runId);
      return n;
    });
  };

  /* ─── Render ───────────────────────────────────────────── */

  const nonMe = agents.filter(a => a.name !== 'me');
  const activeCount = nonMe.filter(a => a.activity?.active || a.activity?.status === 'active').length;
  const runningRuns = runs.filter(r => r.status === 'running');

  return (
    <div className="flex h-full bg-canvas">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 md:px-8 py-8">

          {/* ── Header ── */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-[18px] font-semibold text-foreground" style={{ fontFamily: 'Georgia, serif' }}>
                {t('dashboard')}
              </h1>
              <p className="text-[12px] text-muted-foreground mt-1">
                {nonMe.length} {t('agents').toLowerCase()} &middot; {groups.length} {t('groups').toLowerCase()}
                {runningRuns.length > 0 && (
                  <span className="ml-2 text-info">
                    &middot; {runningRuns.length} {t('running').toLowerCase()}
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowCreateAgent(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg bg-surface border border-border text-foreground hover:bg-canvas transition-colors"
              >
                <Plus size={13} />
                {t('new_agent')}
              </button>
              <button
                onClick={() => setShowCreateGroup(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg bg-foreground text-canvas hover:opacity-90 transition-opacity"
              >
                <Plus size={13} />
                {t('new_group')}
              </button>
            </div>
          </div>

          {/* ── API Provider Warning Banner ── */}
          {apiKeyConfigured === false && (
            <div className="mb-6 flex items-center gap-3 bg-warning/10 border border-warning/30 rounded-xl px-4 py-3">
              <AlertCircle size={16} className="text-warning shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-foreground">请先配置 AI Provider</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  未检测到已配置的 API Key，AI 功能（自动回复、任务处理等）将无法使用。
                </p>
              </div>
              <a
                href="/setup"
                className="shrink-0 px-3 py-1.5 text-[12px] font-medium rounded-lg bg-warning text-canvas hover:opacity-90 transition-opacity"
              >
                前往配置
              </a>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20 text-muted-foreground text-[13px] gap-2">
              <Loader2 size={14} className="animate-spin" />
              {t('loading')}
            </div>
          ) : (
            <div className="space-y-8">

              {/* ── Agent Cards ── */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Users size={14} className="text-muted-foreground" />
                  <h2 className="text-[13px] font-medium text-foreground">{t('agents')}</h2>
                  <span className="text-[11px] text-muted-foreground bg-surface px-1.5 py-0.5 rounded">
                    {activeCount} {t('active').toLowerCase()}
                  </span>
                </div>
                {nonMe.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground py-8 text-center">{t('create_first_agent')}</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {nonMe.map(a => {
                      const isActive = a.activity?.active || a.activity?.status === 'active';
                      return (
                        <a
                          key={a.name}
                          href={`/agents/${a.name}`}
                          className="flex items-center gap-3 p-4 rounded-xl border border-border bg-surface hover:bg-canvas transition-colors group"
                        >
                          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isActive ? 'bg-success' : 'bg-muted'}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-medium text-foreground truncate">{a.name}</div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {a.config?.roles?.join(', ') || t('member')}
                              {a.activity?.detail ? ` · ${a.activity.detail}` : ''}
                            </div>
                          </div>
                          <div className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                            {t('agent_status')}
                          </div>
                        </a>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* ── Group Cards ── */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Hash size={14} className="text-muted-foreground" />
                  <h2 className="text-[13px] font-medium text-foreground">{t('groups')}</h2>
                  <span className="text-[11px] text-muted-foreground bg-surface px-1.5 py-0.5 rounded">
                    {groups.length}
                  </span>
                </div>
                {groups.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground py-8 text-center">{t('create_first_group')}</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {groups.map(g => {
                      const hasWorkflow = workflows.some(w => w.group === g.name);
                      return (
                        <div key={g.name} className="p-4 rounded-xl border border-border bg-surface">
                          <div className="flex items-start justify-between mb-2">
                            <a href={`/groups/${g.name}`} className="text-[13px] font-medium text-foreground hover:underline truncate">
                              {g.name}
                            </a>
                            {hasWorkflow && (
                              <button
                                onClick={() => triggerWorkflow(g.name)}
                                title={t('run')}
                                className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center bg-success-muted text-success hover:bg-success hover:text-canvas transition-colors"
                              >
                                <Play size={11} fill="currentColor" />
                              </button>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground space-y-0.5">
                            <div>
                              {(g.members?.length || 0)} {t('members').toLowerCase()}
                              {g.owner ? ` · owner: ${g.owner}` : ''}
                            </div>
                            {g.admins && g.admins.length > 0 && (
                              <div>admins: {g.admins.join(', ')}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* ── Workflow Executions ── */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={14} className="text-muted-foreground" />
                  <h2 className="text-[13px] font-medium text-foreground">Workflow Runs</h2>
                  <span className="text-[11px] text-muted-foreground bg-surface px-1.5 py-0.5 rounded">
                    {runs.length}
                  </span>
                  {runningRuns.length > 0 && (
                    <span className="text-[11px] text-info flex items-center gap-1">
                      <Loader2 size={10} className="animate-spin" />
                      {runningRuns.length} {t('running').toLowerCase()}
                    </span>
                  )}
                </div>
                {runs.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground py-8 text-center">
                    {workflows.length === 0 ? t('no_workflows') : 'No runs yet. Trigger a workflow to start.'}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {runs.map(run => {
                      const isExpanded = expandedRuns.has(run.runId);
                      const pct = run.stepsTotal > 0 ? Math.round((run.stepsDone / run.stepsTotal) * 100) : 0;
                      return (
                        <div key={run.runId} className="rounded-xl border border-border bg-surface overflow-hidden">
                          {/* Run header */}
                          <button
                            onClick={() => toggleRunExpand(run.runId)}
                            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas transition-colors"
                          >
                            <span className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium ${statusColor(run.status)}`}>
                              {statusIcon(run.status)}
                              {run.status}
                            </span>
                            <span className="text-[12px] font-medium text-foreground truncate">{run.workflowName || run.group}</span>
                            <span className="text-[11px] text-muted-foreground shrink-0">
                              {run.stepsDone}/{run.stepsTotal} steps
                            </span>
                            <span className="text-[11px] text-muted-foreground shrink-0">{pct}%</span>
                            <span className="text-[10px] text-muted-foreground shrink-0 ml-auto">{timeAgo(run.startedAt)} ago</span>
                            <span className="shrink-0 text-muted-foreground">
                              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </span>
                          </button>

                          {/* Progress bar */}
                          {run.stepsTotal > 0 && (
                            <div className="h-0.5 bg-surface mx-4">
                              <div
                                className={`h-full transition-all duration-500 ${
                                  run.status === 'running' ? 'bg-info' :
                                  run.status === 'completed' ? 'bg-success' :
                                  run.status === 'failed' ? 'bg-destructive' : 'bg-muted'
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}

                          {/* Expanded: step details */}
                          {isExpanded && run.steps && (
                            <div className="px-4 py-3 border-t border-border space-y-1.5">
                              {Object.entries(run.steps).map(([stepId, stepStatus]) => (
                                <div key={stepId} className="flex items-center gap-2 text-[11px]">
                                  <span className={`flex items-center gap-1 ${stepStatus === 'completed' ? 'text-success' : stepStatus === 'failed' ? 'text-destructive' : stepStatus === 'running' ? 'text-info' : 'text-muted-foreground'}`}>
                                    {stepStatus === 'completed' ? <CheckCircle size={10} /> :
                                     stepStatus === 'failed' ? <XCircle size={10} /> :
                                     stepStatus === 'running' ? <Loader2 size={10} className="animate-spin" /> :
                                     <Clock size={10} />}
                                    <span className="font-mono">{stepId}</span>
                                  </span>
                                  <span className="text-muted-foreground">{stepStatus}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Workflow definitions (if no runs) */}
                {runs.length === 0 && workflows.length > 0 && (
                  <div className="mt-4">
                    <p className="text-[11px] text-muted-foreground mb-2">Available workflows:</p>
                    <div className="space-y-1.5">
                      {workflows.map(wf => (
                        <div key={wf.group} className="flex items-center justify-between p-3 rounded-lg border border-border bg-surface">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground bg-canvas px-1.5 py-0.5 rounded">{wf.group}</span>
                              <span className="text-[12px] font-medium text-foreground truncate">{wf.name}</span>
                            </div>
                            {wf.description && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{wf.description}</p>}
                          </div>
                          <button
                            onClick={() => triggerWorkflow(wf.group)}
                            className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md bg-success-muted text-success hover:bg-success hover:text-canvas transition-colors"
                          >
                            <Play size={10} fill="currentColor" />
                            {t('run')}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

            </div>
          )}
        </div>
      </main>

      {/* ── Create Group Modal ── */}
      {showCreateGroup && (
        <Modal onClose={() => setShowCreateGroup(false)}>
          <h3 className="text-[14px] font-semibold text-foreground mb-4">{t('new_group')}</h3>
          <input
            autoFocus
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createGroup()}
            placeholder="group-name"
            className="w-full px-3 py-2 text-[13px] bg-surface border border-border rounded-lg text-foreground placeholder:text-muted focus:outline-none focus:border-foreground/30 mb-4"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowCreateGroup(false)} className="px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-surface rounded-lg transition-colors">
              {t('cancel')}
            </button>
            <button
              onClick={createGroup}
              disabled={!newGroupName.trim() || creating}
              className="px-4 py-1.5 text-[12px] font-medium rounded-lg bg-foreground text-canvas disabled:opacity-50 transition-opacity"
            >
              {creating ? t('creating') : t('create')}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Create Agent Modal ── */}
      {showCreateAgent && (
        <Modal onClose={() => setShowCreateAgent(false)}>
          <h3 className="text-[14px] font-semibold text-foreground mb-4">{t('new_agent')}</h3>
          <input
            autoFocus
            value={newAgentName}
            onChange={e => setNewAgentName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createAgent()}
            placeholder="agent-name"
            className="w-full px-3 py-2 text-[13px] bg-surface border border-border rounded-lg text-foreground placeholder:text-muted focus:outline-none focus:border-foreground/30 mb-4"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowCreateAgent(false)} className="px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-surface rounded-lg transition-colors">
              {t('cancel')}
            </button>
            <button
              onClick={createAgent}
              disabled={!newAgentName.trim() || creating}
              className="px-4 py-1.5 text-[12px] font-medium rounded-lg bg-foreground text-canvas disabled:opacity-50 transition-opacity"
            >
              {creating ? t('creating') : t('create')}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-[100] px-4 py-2.5 rounded-xl text-[12px] font-medium shadow-xl backdrop-blur-md transition-all duration-300 ${
          toast.type === 'ok' ? 'bg-success/90 text-canvas' : 'bg-destructive/90 text-canvas'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* ─── Modal wrapper ─────────────────────────────────────── */

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/20 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-canvas rounded-2xl p-6 shadow-xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div />
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
