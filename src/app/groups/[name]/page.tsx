'use client';

import React, { useState, useEffect, useCallback, useRef, Component } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { Send, Loader2, MessageCircle, GitBranch, Settings, X, RefreshCw, Pin, PinOff, Bell, Search, Paperclip } from 'lucide-react';
import { useT } from '@/components/i18n';
import WorkflowGantt from '@/components/workflow-gantt';
import WorkflowArch from '@/components/workflow-arch';
import { WorkflowEditor } from '@/components/workflow-editor';
import { MemberList } from '@/components/member-list';
import { DagViewSafe, timeFmt } from '@/components/dag-view';
import { OrchestrateButton } from '@/components/orchestrate-button';
import { GroupSidebar } from '@/components/group-sidebar';
import { KanbanTab } from '@/components/kanban-tab';
import { createLogger } from '@/lib/logger';

const log = createLogger('group-page');

interface ChatMsg { from: string; date: string; body: string; file: string; }
interface WorkflowStep { id: string; agent: string; action: string; prompt?: string; condition?: string; dependsOn?: string[]; status?: string; reviewer?: string; priority?: string; }
interface WorkflowDef { name: string; description?: string; steps: number; stepsList: WorkflowStep[]; runs?: WorkflowRun[]; pendingApprovals?: WorkflowRun['pendingApprovals']; }
interface WorkflowResult { step: string; agent: string; decision: string; reply: string; success: boolean; }
interface GroupConfig {
  owner: string; admins: string[]; createdAt: number;
  name?: string; description?: string;
  announcement?: { title: string; content: string; pinnedBy: string; pinnedAt: number };
  members?: string[];
}
interface WorkflowRun {
  runId: string; group: string; workflowName: string; status: string;
  stepsTotal: number; stepsDone: number; startedAt: number;
  steps: Record<string, string>;
  pendingApprovals: Array<{ approvalId: string; stepId: string; agent: string; prompt: string }>;
}
interface SearchResult { from: string; date: string; matchAround: string; }
interface FileEntry { name: string; size: number; }
interface WorkflowRunResult { stepId: string; status: string; summary?: string; details?: string; }
interface NormalizedStep { id: string; agent: string; action: string; prompt: string; dependsOn: string[]; reviewer: string; priority: string; }

const normalizeStep = (s: WorkflowStep): NormalizedStep => ({
  id: s.id, agent: s.agent || '', action: s.action || 'execute',
  prompt: s.prompt || '', dependsOn: s.dependsOn || [],
  reviewer: s.reviewer || '', priority: s.priority || '',
});

function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const [error, setError] = useState<Error | null>(null);
  if (error) return <div className="flex-1 flex items-center justify-center p-8"><div className="text-center"><p className="text-[14px] text-destructive font-medium mb-2">页面出错了</p><p className="text-[12px] text-muted-foreground">{error.message}</p><button onClick={() => setError(null)} className="mt-3 px-3 py-1.5 text-[12px] bg-surface-alt rounded-lg hover:bg-surface-hover">重试</button></div></div>;
  return <ErrorCatcher onError={setError}>{children}</ErrorCatcher>;
}

class ErrorCatcher extends React.Component<{ children: React.ReactNode; onError: (e: Error) => void }, {}> {
  componentDidCatch(e: Error) { log.error('GroupPage ERROR', e); this.props.onError(e); }
  render() { return this.props.children; }
}

export default function GroupPage() {
  const { name } = useParams<{ name: string }>();
  const { t } = useT();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<'chat' | 'workflow' | 'kanban'>(searchParams.get('tab') === 'workflow' ? 'workflow' : searchParams.get('tab') === 'kanban' ? 'kanban' : 'chat');
  const [members, setMembers] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pickAgent, setPickAgent] = useState('');
  const [showGroupSidebar, setShowGroupSidebar] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowDef | null>(null);
  const [wfRunning, setWfRunning] = useState(false);
  const [wfMessage, setWfMessage] = useState('');
  const [wfResults, setWfResults] = useState<WorkflowResult[]>([]);
  const [currentRun, setCurrentRun] = useState<{ runId: string; status: string; steps: Record<string, string> } | null>(null);
  const [groupConfig, setGroupConfig] = useState<GroupConfig | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentUser, setCurrentUser] = useState('');
  const [allAgents, setAllAgents] = useState<string[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [hoveredStep, setHoveredStep] = useState<string | null>(null);
  const [showWfEditor, setShowWfEditor] = useState(false);
  const [editSteps, setEditSteps] = useState<NormalizedStep[]>([]);
  const [wfRuns, setWfRuns] = useState<WorkflowRun[]>([]);
  const [showRunHistory, setShowRunHistory] = useState(false);
  const [loadError, setLoadError] = useState('');

  const fetchGroup = useCallback(() => {
    setLoading(true);
    setLoadError('');
    fetch(`/api/groups/${name}`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then(d => {
      setMembers(d.members || []);
      setMessages(d.messages || []);
      if (!pickAgent && d.members?.length > 0) setPickAgent(d.members[0]);
    }).catch(e => {
      log.error('fetchGroup failed', e);
      setLoadError('无法加载群组数据，请检查群组是否存在');
    }).finally(() => setLoading(false));
  }, [name]);

  const fetchConfig = useCallback(() => {
    fetch(`/api/groups/${name}/config`).then(r => {
      if (!r.ok) return null;
      return r.json();
    }).then(d => {
      if (d && !d.error) {
        // Unwrap apiOk envelope: { ok: true, ...config }
        const { ok: _ok, ...config } = d;
        setGroupConfig(config as GroupConfig);
        if (!currentUser && config.owner) setCurrentUser(config.owner);
      }
    }).catch(e => log.error('fetchConfig failed', e));
  }, [name]);

  const fetchAgents = useCallback(() => {
    fetch('/api/agents').then(r => {
      if (!r.ok) return { agents: [] };
      return r.json();
    }).then(d => {
      if (d?.agents) setAllAgents(d.agents.map((a: { name: string }) => a.name));
    }).catch(e => log.error('fetchAgents failed', e));
  }, []);

  const fetchWorkflow = useCallback(() => {
    fetch(`/api/groups/${name}/workflow`).then(r => {
      if (!r.ok) return null;
      return r.json();
    }).then(d => {
      if (d && !d.error) setWorkflow(d);
    }).catch(e => log.error('fetchWorkflow failed', e));
  }, [name]);

  useEffect(() => { fetchGroup(); fetchWorkflow(); fetchConfig(); fetchAgents(); }, [fetchGroup, fetchWorkflow, fetchConfig, fetchAgents]);

  // Real-time workflow polling
  useEffect(() => {
    if (!wfRunning) return;
    const t = setInterval(() => {
      fetchWorkflow();
      // Also check if workflow completed
      fetch(`/api/workflows/run`).then(r => r.json()).then(d => {
        const runs = d.runs || [];
        const current = runs.find((r: WorkflowRun) => r.workflowName === workflow?.name);
        if (current && (current.status === 'completed' || current.status === 'failed')) {
          setWfRunning(false);
          fetchWorkflow();
        }
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [wfRunning, workflow?.name, fetchWorkflow]);

  const send = async () => {
    const t = input.trim();
    if (!t || sending || !pickAgent) return;
    setInput(''); setSending(true);
    try {
      await fetch(`/api/agents/${pickAgent}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `用 group_send 向 ${name} 群发送消息: ${t}`, group: name }),
      });
      setTimeout(fetchGroup, 1000);
    } catch (e) { log.error('send failed', e); }
    setSending(false);
  };

  const runWorkflow = async (stepId?: string) => {
    if (!workflow || wfRunning) return;
    setWfRunning(true); setWfResults([]); setWfMessage('触发中...');
    try {
      const r = await fetch(`/api/groups/${name}/workflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggerStepId: stepId }),
      });
      const d = await r.json();
      if (d.error) {
        const msg = typeof d.error === 'string' ? d.error : d.error.message || '触发失败';
        log.error('wf trigger error:', d.error);
        setWfMessage(`失败: ${msg}`);
        setWfRunning(false);
        setTimeout(() => setWfMessage(''), 3000);
        return;
      }
      if (d.ok && d.runId) {
        setCurrentRun({ runId: d.runId, status: 'running', steps: {} });
        setWfMessage(`已触发 runId: ${d.runId.slice(0, 8)}`);
        setTimeout(() => setWfMessage(''), 3000);
        pollRunStatus();
      }
      fetchGroup();
    } catch (e: unknown) {
      log.error('wf trigger failed:', e);
      setWfMessage(`请求失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    setWfRunning(false);
  };

  // Poll run status to get current step states
  const pollRunStatus = useCallback(() => {
    fetch(`/api/groups/${name}/workflow?action=runs`).then(r => r.json()).then(d => {
      const runs = d.runs || [];
      if (runs.length > 0) {
        const latest = runs[0];
        setCurrentRun({ runId: latest.runId, status: latest.status, steps: latest.steps || {} });
      }
    }).catch(() => {});
  }, [name]);

  // Poll every 3 seconds when a run is active
  useEffect(() => {
    if (!currentRun || currentRun.status === 'completed' || currentRun.status === 'failed') return;
    const t = setInterval(pollRunStatus, 3000);
    return () => clearInterval(t);
  }, [currentRun?.runId, currentRun?.status, pollRunStatus]);

  // Real-time WebSocket updates for step status
  useEffect(() => {
    const handler = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (data.group === name && data.runId) {
        setCurrentRun(prev => {
          if (!prev || prev.runId !== data.runId) return prev;
          return { ...prev, steps: { ...prev.steps, [data.stepId]: data.status } };
        });
      }
    };
    window.addEventListener('wf_step_status', handler);
    return () => window.removeEventListener('wf_step_status', handler);
  }, [name]);

  // ── Step editing from architecture diagram ──
  const openWfEditor = (initialStep?: NormalizedStep) => {
    const steps = (workflow?.stepsList || []).map(normalizeStep);
    if (initialStep) {
      // Pre-fill with clicked step
      setEditSteps([initialStep]);
    } else {
      setEditSteps(steps);
    }
    setShowWfEditor(true);
  };

  const addStep = async (afterStepId?: string) => {
    const currentSteps = (workflow?.stepsList || []).map(normalizeStep);
    const newStep: NormalizedStep = {
      id: `step_${currentSteps.length + 1}`,
      agent: '', action: 'execute', prompt: '',
      dependsOn: afterStepId ? [afterStepId] : [],
      reviewer: '', priority: '',
    };
    const updated = [...currentSteps, newStep];
    setEditSteps(updated);
    setShowWfEditor(true);
  };

  const deleteStep = async (stepId: string) => {
    if (!confirm(`删除步骤 ${stepId}？`)) return;
    const currentSteps = (workflow?.stepsList || [])
      .filter((s: WorkflowStep) => s.id !== stepId)
      .map(s => ({
        ...normalizeStep(s),
        dependsOn: (s.dependsOn || []).filter((d: string) => d !== stepId),
      }));
    await fetch(`/api/groups/${name}/workflow`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: currentSteps }),
    });
    fetchWorkflow();
  };

  const saveWfSteps = async () => {
    await fetch(`/api/groups/${name}/workflow`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: editSteps }),
    });
    setShowWfEditor(false);
    fetchWorkflow();
  };

  // ── Edge (line) editing ──
  const editEdge = (fromId: string, toId: string) => {
    // Open editor with the target step's dependsOn highlighted
    const targetStep = (workflow?.stepsList || []).find((s: WorkflowStep) => s.id === toId);
    if (targetStep) {
      openWfEditor(normalizeStep(targetStep));
    }
  };

  const deleteEdge = async (fromId: string, toId: string) => {
    if (!confirm(`删除依赖 ${fromId} → ${toId}？`)) return;
    const currentSteps = (workflow?.stepsList || []).map(s => {
      if (s.id === toId) {
        return { ...normalizeStep(s), dependsOn: (s.dependsOn || []).filter((d: string) => d !== fromId) };
      }
      return normalizeStep(s);
    });
    await fetch(`/api/groups/${name}/workflow`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: currentSteps }),
    });
    fetchWorkflow();
  };

  const addEdge = async (fromId: string, toId: string) => {
    // Add fromId as a dependency of toId
    const currentSteps = (workflow?.stepsList || []).map(s => {
      if (s.id === toId && !(s.dependsOn || []).includes(fromId)) {
        return { ...normalizeStep(s), dependsOn: [...(s.dependsOn || []), fromId] };
      }
      return normalizeStep(s);
    });
    await fetch(`/api/groups/${name}/workflow`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: currentSteps }),
    });
    fetchWorkflow();
  };

  const isOwner = !!groupConfig?.owner && groupConfig.owner === currentUser;
  const isAdmin = isOwner || !!(groupConfig?.admins?.includes(currentUser));

  const manageGroup = async (action: string, agent?: string, extra?: Record<string, unknown>) => {
    await fetch(`/api/groups/${name}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, by: currentUser, agent, ...extra }),
    });
    fetchConfig();
    fetchGroup();
  };

  const saveDescription = async () => {
    await fetch(`/api/groups/${name}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: currentUser, description: '' }),
    });
    fetchConfig();
  };

  const inviteAgent = async (agent: string) => {
    await manageGroup('invite', agent);
    setShowInvite(false);
  };

  const transferOwnership = async (target: string) => {
    await manageGroup('transfer', target);
    setCurrentUser(target);
  };

  const doSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    const r = await fetch(`/api/groups/${name}/search?q=${encodeURIComponent(searchQuery)}`);
    setSearchResults((await r.json()).results || []);
    setSearching(false);
  };

  const fetchFiles = async () => {
    try {
      const r = await fetch(`/api/groups/${name}/files`);
      setFiles((await r.json()).files || []);
      setShowFiles(true);
    } catch (e) { log.error('send failed', e); }
  };

  const uploadFile = async () => {
    if (!fileInputRef.current?.files?.[0]) return;
    const formData = new FormData();
    formData.append('file', fileInputRef.current.files[0]);
    await fetch(`/api/groups/${name}/files`, { method: 'POST', body: formData });
    fileInputRef.current.value = '';
    fetchFiles();
  };

  return (
    <ErrorBoundary>
    <div className="flex h-full bg-canvas">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">

          {/* Header */}
          <div className="px-5 py-3 border-b border-border flex items-center justify-between shrink-0 bg-canvas">
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-xl bg-surface-alt flex items-center justify-center text-[12px] font-bold text-muted">#</span>
              <div>
                <h2 className="text-[14px] font-semibold text-foreground">{name}</h2>
                <p className="text-[11px] text-muted-foreground">{members.length} 成员</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={fetchGroup} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-muted px-2 py-1">
                <RefreshCw size={12} />
              </button>
              <button onClick={() => { setShowGroupSidebar(!showGroupSidebar); if (!showGroupSidebar) { fetchWorkflow(); fetchConfig(); } }}
                className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-colors ${showGroupSidebar ? 'bg-surface-alt text-foreground' : 'text-muted-foreground hover:text-muted'}`}
                title="群资料">
                <Settings size={12} /> 群资料
              </button>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex items-center gap-1 px-5 py-2 border-b border-border shrink-0 bg-canvas">
            <button onClick={() => setTab('chat')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='chat'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
              <MessageCircle size={13}/> 聊天
            </button>
            <button onClick={() => { setTab('workflow'); fetchWorkflow(); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='workflow'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
              <GitBranch size={13}/> Workflow
            </button>
            <button onClick={() => { setTab('kanban'); fetchWorkflow(); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='kanban'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
              📋 看板
            </button>
          </div>
          <div className="flex-1 flex min-h-0">
            <div className="flex-1 flex flex-col min-h-0">

          {/* ── Tab content ── */}
          {tab === 'chat' && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Search + Files toolbar */}
              <div className="flex items-center gap-2 px-5 py-1.5 border-b border-border shrink-0 bg-canvas">
                {showSearch ? (
                  <div className="flex items-center gap-1 flex-1">
                    <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && doSearch()}
                      placeholder="搜索消息..." className="flex-1 text-[11px] px-2 py-1 bg-surface-alt border border-border rounded-lg outline-none" autoFocus />
                    <button onClick={doSearch} disabled={searching} className="text-[10px] px-2 py-1 bg-surface-alt rounded-lg text-muted hover:text-foreground">
                      {searching ? '...' : '搜索'}
                    </button>
                    <button onClick={() => { setShowSearch(false); setSearchResults([]); }} className="text-[10px] text-muted-foreground hover:text-muted">×</button>
                  </div>
                ) : (
                  <>
                    <button onClick={() => setShowSearch(true)} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-muted px-1.5 py-0.5">
                      <Search size={11} /> 搜索
                    </button>
                    <button onClick={fetchFiles} className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-muted px-1.5 py-0.5">
                      <Paperclip size={11} /> 文件
                    </button>
                  </>
                )}
                <input ref={fileInputRef} type="file" onChange={uploadFile} className="hidden" />
              </div>

              {/* Search results */}
              {searchResults.length > 0 && (
                <div className="px-5 py-2 bg-surface-alt border-b border-border space-y-1 max-h-[200px] overflow-y-auto shrink-0">
                  <p className="text-[10px] text-muted-foreground flex items-center justify-between">
                    <span>找到 {searchResults.length} 条</span>
                    <button onClick={() => setSearchResults([])} className="text-muted hover:text-foreground">×</button>
                  </p>
                  {searchResults.slice(0, 15).map((r: SearchResult, i: number) => (
                    <div key={i} className="text-[11px] py-1 border-b border-border/50 last:border-0">
                      <span className="text-muted font-medium mr-2">{r.from}</span>
                      <span className="text-muted-foreground/70 text-[10px] mr-2">{new Date(r.date).toLocaleDateString()}</span>
                      <span className="text-foreground/80">{r.matchAround}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Files panel */}
              {showFiles && (
                <div className="px-5 py-2 bg-surface-alt border-b border-border space-y-1 max-h-[200px] overflow-y-auto shrink-0">
                  <p className="text-[10px] text-muted-foreground flex items-center justify-between">
                    <span>群文件 ({files.length})</span>
                    <span className="flex items-center gap-2">
                      <button onClick={() => fileInputRef.current?.click()} className="text-muted hover:text-foreground">+ 上传</button>
                      <button onClick={() => setShowFiles(false)} className="text-muted hover:text-foreground">×</button>
                    </span>
                  </p>
                  {files.map((f: FileEntry, i: number) => (
                    <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-border/50 last:border-0">
                      <span className="text-foreground/80">{f.name}</span>
                      <span className="text-[9px] text-muted-foreground">{Math.round(f.size / 1024)}KB</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
                {loading ? (
                  <p className="text-[13px] text-muted-foreground text-center py-16">加载中...</p>
                ) : loadError ? (
                  <div className="text-center py-16">
                    <p className="text-[13px] text-destructive font-medium mb-2">{loadError}</p>
                    <button onClick={fetchGroup} className="text-[11px] px-3 py-1.5 bg-surface-alt rounded-lg hover:bg-surface-hover text-muted-foreground">重试</button>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="text-center py-16">
                    <p className="text-[14px] text-muted-foreground">暂无消息</p>
                    <p className="text-[12px] text-muted-foreground/60 mt-1">选择 Agent 在下方发言</p>
                  </div>
                ) : (
                  messages.map((msg, i) => {
                    const isSystem = msg.from === 'system';
                    return (
                      <div key={i} className={`flex ${isSystem ? 'justify-center' : 'items-start gap-3'}`}>
                        {!isSystem && (
                          <span className="w-7 h-7 rounded-full bg-surface-alt flex items-center justify-center text-[10px] font-medium text-muted shrink-0 mt-0.5">
                            {msg.from[0]}
                          </span>
                        )}
                        <div className={isSystem ? 'text-[11px] text-muted-foreground/50 italic text-center w-full' : 'flex-1 min-w-0'}>
                          {!isSystem && (
                            <div className="flex items-baseline gap-2 mb-0.5">
                              <span className="text-[12px] font-semibold text-foreground">{msg.from}</span>
                              <span className="text-[10px] text-muted-foreground/50">{timeFmt(msg.date)}</span>
                            </div>
                          )}
                          <div className={`text-[13px] leading-relaxed ${isSystem ? 'text-muted-foreground' : 'text-foreground'}`}>
                            {msg.body}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Input */}
              <div className="px-5 py-3 border-t border-border shrink-0">
                <div className="flex items-center gap-2">
                  <select value={pickAgent} onChange={e => setPickAgent(e.target.value)}
                    className="shrink-0 text-[12px] bg-surface-alt border border-border rounded-xl pl-3 pr-2 py-2.5 text-muted outline-none focus:border-border-strong">
                    {members.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <div className="flex-1 flex items-center gap-2 bg-surface-alt rounded-xl px-4 py-2.5 focus-within:bg-canvas focus-within:ring-2 focus-within:ring-border/50 transition-all">
                    <input value={input} onChange={e => setInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                      placeholder={`以 ${pickAgent || '...'} 发言...`} disabled={!pickAgent || sending}
                      className="flex-1 bg-transparent border-0 outline-none text-[13px] text-foreground placeholder:text-muted-foreground/40 disabled:opacity-50" />
                    <button onClick={send} disabled={!input.trim() || sending || !pickAgent}
                      className="w-8 h-8 flex items-center justify-center rounded-lg bg-foreground text-canvas hover:opacity-90 disabled:opacity-20 transition-opacity shrink-0">
                      {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'workflow' && (
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Trigger feedback message */}
              {wfMessage && (
                <div className="px-4 py-2 text-[12px] bg-surface-alt border-b border-border text-muted-foreground shrink-0">
                  {wfMessage}
                </div>
              )}
              {!workflow ? (
                <p className="text-[13px] text-muted-foreground text-center py-16">暂无 workflow</p>
              ) : (
                <div className="h-full">
                  <WorkflowArch
                    steps={(workflow.stepsList || [])}
                    run={currentRun ? { ...currentRun, startedAt: Date.now() } : null}
                    allAgents={allAgents}
                    onTrigger={(stepId) => runWorkflow(stepId)}
                    running={wfRunning}
                    onStepClick={async (step) => {
                      // Save inline edit directly to API (no modal popup)
                      const steps = (workflow?.stepsList || []).map(s =>
                        s.id === step.id ? { ...s, agent: step.agent, action: step.action, prompt: step.prompt, dependsOn: step.dependsOn } : normalizeStep(s)
                      );
                      await fetch(`/api/groups/${name}/workflow`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ steps }),
                      });
                      fetchWorkflow();
                    }}
                    onStepAdd={(afterId) => addStep(afterId)}
                    onStepDelete={(stepId) => deleteStep(stepId)}
                    onEdgeClick={(from, to) => editEdge(from, to)}
                    onEdgeDelete={(from, to) => deleteEdge(from, to)}
                    onEdgeAdd={(from, to) => addEdge(from, to)}
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Kanban Tab ── */}
          {tab === 'kanban' && (
            <div className="flex-1 overflow-hidden">
              {!workflow ? (
                <p className="text-[13px] text-muted-foreground text-center py-16">暂无 workflow</p>
              ) : (
                <KanbanTab
                  steps={(workflow.stepsList || [])}
                  run={currentRun}
                  onTrigger={(stepId) => runWorkflow(stepId)}
                />
              )}
            </div>
          )}

            </div>

        {/* ── Right sidebar: 群资料 ── */}
        {showGroupSidebar && (
          <GroupSidebar
            groupConfig={groupConfig} name={name!} members={members}
            currentUser={currentUser} setCurrentUser={setCurrentUser}
            isAdmin={!!isAdmin} isOwner={!!isOwner} allAgents={allAgents}
            workflow={workflow} onSetTab={setTab} onFetchWorkflow={fetchWorkflow}
            onClose={() => setShowGroupSidebar(false)}
            onManageGroup={manageGroup} onTransferOwnership={transferOwnership}
            onInviteAgent={inviteAgent} setConfirmAction={() => {}}
          />
        )}

        {/* ── Workflow Editor Modal ── */}
        <WorkflowEditor
          workflow={workflow}
          editSteps={editSteps}
          setEditSteps={setEditSteps}
          show={showWfEditor}
          onClose={() => setShowWfEditor(false)}
          onSave={saveWfSteps}
          wfRuns={wfRuns}
          showRunHistory={showRunHistory}
          setShowRunHistory={setShowRunHistory}
        />
          </div>
      </div>
    </div>
    </ErrorBoundary>
  );
}

// Components imported from: dag-view.tsx, orchestrate-button.tsx, tasks-tab.tsx
