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
import { TasksTab } from '@/components/tasks-tab';

interface ChatMsg { from: string; date: string; body: string; file: string; }
interface WorkflowStep { id: string; agent: string; action: string; prompt?: string; condition?: string; dependsOn?: string[]; status?: string; reviewer?: string; priority?: string; }
interface WorkflowDef { name: string; description?: string; steps: number; stepsList: WorkflowStep[]; runs?: any[]; pendingApprovals?: any[]; }
interface WorkflowResult { step: string; agent: string; decision: string; reply: string; success: boolean; }
interface GroupConfig {
  owner: string; admins: string[]; createdAt: number;
  name?: string; description?: string;
  announcement?: { title: string; content: string; pinnedBy: string; pinnedAt: number };
  members?: string[];
}

function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const [error, setError] = useState<Error | null>(null);
  if (error) return <div className="flex-1 flex items-center justify-center p-8"><div className="text-center"><p className="text-[14px] text-destructive font-medium mb-2">页面出错了</p><p className="text-[12px] text-muted-foreground">{error.message}</p><button onClick={() => setError(null)} className="mt-3 px-3 py-1.5 text-[12px] bg-surface-alt rounded-lg hover:bg-surface-hover">重试</button></div></div>;
  return <ErrorCatcher onError={setError}>{children}</ErrorCatcher>;
}

class ErrorCatcher extends React.Component<{ children: React.ReactNode; onError: (e: Error) => void }, {}> {
  componentDidCatch(e: Error) { console.error('[GroupPage ERROR]', e); this.props.onError(e); }
  render() { return this.props.children; }
}

export default function GroupPage() {
  const { name } = useParams<{ name: string }>();
  const { t } = useT();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<'chat' | 'workflow' | 'tasks'>(searchParams.get('tab') === 'workflow' ? 'workflow' : searchParams.get('tab') === 'tasks' ? 'tasks' : 'chat');
  const [members, setMembers] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pickAgent, setPickAgent] = useState('');
  const [showGroupSidebar, setShowGroupSidebar] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowDef | null>(null);
  const [wfRunning, setWfRunning] = useState(false);
  const [wfResults, setWfResults] = useState<WorkflowResult[]>([]);
  const [currentRun, setCurrentRun] = useState<{ runId: string; status: string; steps: Record<string, string> } | null>(null);
  const [groupConfig, setGroupConfig] = useState<GroupConfig | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [files, setFiles] = useState<any[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentUser, setCurrentUser] = useState('');
  const [allAgents, setAllAgents] = useState<string[]>([]);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [editingAnnouncement, setEditingAnnouncement] = useState(false);
  const [annTitle, setAnnTitle] = useState('');
  const [annContent, setAnnContent] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: string; target: string } | null>(null);
  const [showDag, setShowDag] = useState(true);
  const [hoveredStep, setHoveredStep] = useState<string | null>(null);
  const [showWfEditor, setShowWfEditor] = useState(false);
  const [editSteps, setEditSteps] = useState<any[]>([]);
  const [wfRuns, setWfRuns] = useState<any[]>([]);
  const [showRunHistory, setShowRunHistory] = useState(false);

  const fetchGroup = useCallback(() => {
    setLoading(true);
    fetch(`/api/groups/${name}`).then(r => r.json()).then(d => {
      setMembers(d.members || []);
      setMessages(d.messages || []);
      if (!pickAgent && d.members?.length > 0) setPickAgent(d.members[0]);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [name]);

  const fetchConfig = useCallback(() => {
    fetch(`/api/groups/${name}/config`).then(r => r.json()).then(d => {
      if (!d.error) {
        setGroupConfig(d);
        if (!currentUser && d.owner) setCurrentUser(d.owner);
      }
    }).catch(() => {});
  }, [name]);

  const fetchAgents = useCallback(() => {
    fetch('/api/agents').then(r => r.json()).then(d => {
      if (d?.agents) setAllAgents(d.agents.map((a: any) => a.name));
    }).catch(() => {});
  }, []);

  const fetchWorkflow = useCallback(() => {
    fetch(`/api/groups/${name}/workflow`).then(r => r.json())
      .then(d => { if (!d.error) setWorkflow(d); }).catch(() => {});
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
        const current = runs.find((r: any) => r.workflowName === workflow?.name);
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
    } catch (e) { console.error('[app:groups:[name]:page]', e); }
    setSending(false);
  };

  const runWorkflow = async () => {
    if (!workflow || wfRunning) return;
    setWfRunning(true); setWfResults([]); setCurrentRun(null);
    try {
      // Build initial run state from steps
      const stepStatuses: Record<string, string> = {};
      (workflow.stepsList || []).forEach((s: any) => { stepStatuses[s.id] = 'pending'; });
      setCurrentRun({ runId: `wf-${Date.now()}`, status: 'running', steps: stepStatuses });

      const r = await fetch(`/api/groups/${name}/workflow`, { method: 'POST' });
      const d = await r.json();
      if (d.results) {
        setWfResults(d.results);
        // Update run with actual results
        const stepSt: Record<string, string> = {};
        (d.results as any[]).forEach((r: any) => {
          stepSt[r.stepId] = r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : 'completed';
        });
        setCurrentRun(prev => prev ? { ...prev, status: 'completed', steps: { ...prev.steps, ...stepSt } } : null);
      }
      setTimeout(fetchGroup, 3000);
    } catch {
      setCurrentRun(prev => prev ? { ...prev, status: 'failed' } : null);
    }
    setWfRunning(false);
  };

  // ── Step editing from architecture diagram ──
  const openWfEditor = (initialStep?: any) => {
    const steps = (workflow?.stepsList || []).map((s: any) => ({
      id: s.id, agent: s.agent || '', action: s.action || 'execute',
      prompt: s.prompt || '', dependsOn: s.dependsOn || [],
      reviewer: s.reviewer || '', priority: s.priority || '',
    }));
    if (initialStep) {
      // Pre-fill with clicked step
      setEditSteps([initialStep]);
    } else {
      setEditSteps(steps);
    }
    setShowWfEditor(true);
  };

  const addStep = async (afterStepId?: string) => {
    const currentSteps = (workflow?.stepsList || []).map((s: any) => ({
      id: s.id, agent: s.agent || '', action: s.action || 'execute',
      prompt: s.prompt || '', dependsOn: s.dependsOn || [],
      reviewer: s.reviewer || '', priority: s.priority || '',
    }));
    const newStep = {
      id: `step_${currentSteps.length + 1}`,
      agent: '', action: 'execute', prompt: '',
      dependsOn: afterStepId ? [afterStepId] : [],
    };
    const updated = [...currentSteps, newStep];
    setEditSteps(updated);
    setShowWfEditor(true);
  };

  const deleteStep = async (stepId: string) => {
    if (!confirm(`删除步骤 ${stepId}？`)) return;
    const currentSteps = (workflow?.stepsList || [])
      .filter((s: any) => s.id !== stepId)
      .map((s: any) => ({
        id: s.id, agent: s.agent || '', action: s.action || 'execute',
        prompt: s.prompt || '', dependsOn: (s.dependsOn || []).filter((d: string) => d !== stepId),
        reviewer: s.reviewer || '', priority: s.priority || '',
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
    const targetStep = (workflow?.stepsList || []).find((s: any) => s.id === toId);
    if (targetStep) {
      openWfEditor({
        id: targetStep.id, agent: targetStep.agent || '', action: targetStep.action || 'execute',
        prompt: targetStep.prompt || '', dependsOn: targetStep.dependsOn || [],
        reviewer: targetStep.reviewer || '', priority: targetStep.priority || '',
      });
    }
  };

  const deleteEdge = async (fromId: string, toId: string) => {
    if (!confirm(`删除依赖 ${fromId} → ${toId}？`)) return;
    const currentSteps = (workflow?.stepsList || []).map((s: any) => {
      if (s.id === toId) {
        return { ...s, dependsOn: (s.dependsOn || []).filter((d: string) => d !== fromId) };
      }
      return s;
    }).map((s: any) => ({
      id: s.id, agent: s.agent || '', action: s.action || 'execute',
      prompt: s.prompt || '', dependsOn: s.dependsOn || [],
      reviewer: s.reviewer || '', priority: s.priority || '',
    }));
    await fetch(`/api/groups/${name}/workflow`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: currentSteps }),
    });
    fetchWorkflow();
  };

  const addEdge = async (fromId: string, toId: string) => {
    // Add fromId as a dependency of toId
    const currentSteps = (workflow?.stepsList || []).map((s: any) => {
      if (s.id === toId && !(s.dependsOn || []).includes(fromId)) {
        return { ...s, dependsOn: [...(s.dependsOn || []), fromId] };
      }
      return s;
    }).map((s: any) => ({
      id: s.id, agent: s.agent || '', action: s.action || 'execute',
      prompt: s.prompt || '', dependsOn: s.dependsOn || [],
      reviewer: s.reviewer || '', priority: s.priority || '',
    }));
    await fetch(`/api/groups/${name}/workflow`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: currentSteps }),
    });
    fetchWorkflow();
  };

  const isOwner = !!groupConfig?.owner && groupConfig.owner === currentUser;
  const isAdmin = isOwner || !!(groupConfig?.admins?.includes(currentUser));

  const manageGroup = async (action: string, agent?: string, extra?: any) => {
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
      body: JSON.stringify({ by: currentUser, description: descDraft }),
    });
    setEditingDesc(false);
    fetchConfig();
  };

  const saveAnnouncement = async () => {
    if (!annTitle.trim()) return;
    await fetch(`/api/groups/${name}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: currentUser, announcement: { title: annTitle, content: annContent, pinnedBy: currentUser } }),
    });
    setEditingAnnouncement(false);
    setAnnTitle('');
    setAnnContent('');
    fetchConfig();
  };

  const removeAnnouncement = async () => {
    await fetch(`/api/groups/${name}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: currentUser, announcement: null }),
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
    setConfirmAction(null);
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
    } catch (e) { console.error('[app:groups:[name]:page]', e); }
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
            <button onClick={() => setTab('tasks')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='tasks'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
              📋 任务
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
                  {searchResults.slice(0, 15).map((r: any, i: number) => (
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
                  {files.map((f: any, i: number) => (
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
            <div className="flex-1 overflow-hidden">
              {!workflow ? (
                <p className="text-[13px] text-muted-foreground text-center py-16">暂无 workflow</p>
              ) : (
                <div className="h-full">
                  <WorkflowArch
                    steps={(workflow.stepsList || []) as any[]}
                    run={currentRun ? { ...currentRun, startedAt: Date.now() } : null}
                    onTrigger={runWorkflow}
                    running={wfRunning}
                    onStepClick={(step) => openWfEditor({ id: step.id, agent: step.agent || '', action: step.action || 'execute', prompt: step.prompt || '', dependsOn: step.dependsOn || [], priority: '' })}
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

          {/* ── Tasks Tab ── */}
          {tab === 'tasks' && (
            <TasksTab group={name!} />
          )}

            </div>

        {/* ── Right sidebar: 群资料 ── */}
        {showGroupSidebar && (
          <div className="w-[300px] border-l border-border bg-surface overflow-y-auto shrink-0 flex flex-col relative">
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
              <span className="text-[12px] font-semibold text-foreground">群资料</span>
              <button onClick={() => setShowGroupSidebar(false)} className="text-muted-foreground hover:text-muted">
                <X size={14} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Current user selector */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">当前身份</p>
                <select value={currentUser} onChange={e => setCurrentUser(e.target.value)}
                  className="w-full text-[12px] bg-surface-alt border border-border rounded-lg px-2 py-1.5 text-foreground outline-none">
                  {members.map(m => <option key={m} value={m}>{m}{m === groupConfig?.owner ? ' (群主)' : groupConfig?.admins?.includes(m) ? ' (管理)' : ''}</option>)}
                </select>
              </div>

              {/* Group name */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">群名称</p>
                <p className="text-[13px] font-medium text-foreground">{groupConfig?.name || name}</p>
              </div>

              {/* Description */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">群描述</p>
                  {isAdmin && !editingDesc && (
                    <button onClick={() => { setEditingDesc(true); setDescDraft(groupConfig?.description || ''); }}
                      className="text-[10px] text-muted-foreground hover:text-muted">编辑</button>
                  )}
                </div>
                {editingDesc ? (
                  <div className="space-y-1.5">
                    <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)}
                      placeholder="输入群描述..." rows={3}
                      className="w-full text-[12px] bg-surface-alt border border-border rounded-lg px-2 py-1.5 text-foreground outline-none resize-none" />
                    <div className="flex gap-1.5">
                      <button onClick={saveDescription}
                        className="flex-1 text-[11px] py-1 rounded-md bg-foreground text-canvas hover:opacity-90">保存</button>
                      <button onClick={() => setEditingDesc(false)}
                        className="flex-1 text-[11px] py-1 rounded-md bg-surface-alt text-muted hover:text-foreground">取消</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground">{groupConfig?.description || '暂无描述'}</p>
                )}
              </div>

              {/* Announcement */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                    <Bell size={10} /> 公告
                  </p>
                  {isAdmin && !groupConfig?.announcement && !editingAnnouncement && (
                    <button onClick={() => setEditingAnnouncement(true)}
                      className="text-[10px] text-muted-foreground hover:text-muted flex items-center gap-0.5">
                      <Pin size={9} /> 发布
                    </button>
                  )}
                </div>
                {editingAnnouncement ? (
                  <div className="space-y-1.5">
                    <input value={annTitle} onChange={e => setAnnTitle(e.target.value)}
                      placeholder="公告标题" className="w-full text-[12px] bg-surface-alt border border-border rounded-lg px-2 py-1.5 text-foreground outline-none" />
                    <textarea value={annContent} onChange={e => setAnnContent(e.target.value)}
                      placeholder="公告内容..." rows={3}
                      className="w-full text-[12px] bg-surface-alt border border-border rounded-lg px-2 py-1.5 text-foreground outline-none resize-none" />
                    <div className="flex gap-1.5">
                      <button onClick={saveAnnouncement}
                        className="flex-1 text-[11px] py-1 rounded-md bg-foreground text-canvas hover:opacity-90">发布</button>
                      <button onClick={() => setEditingAnnouncement(false)}
                        className="flex-1 text-[11px] py-1 rounded-md bg-surface-alt text-muted hover:text-foreground">取消</button>
                    </div>
                  </div>
                ) : groupConfig?.announcement ? (
                  <div className="bg-surface-alt rounded-lg p-2.5 space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-[12px] font-medium text-foreground">{groupConfig.announcement.title}</p>
                      {isAdmin && (
                        <button onClick={removeAnnouncement} className="text-muted-foreground hover:text-destructive" title="取消置顶">
                          <PinOff size={11} />
                        </button>
                      )}
                    </div>
                    {groupConfig.announcement.content && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed">{groupConfig.announcement.content}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground/50">
                      — {groupConfig.announcement.pinnedBy}, {groupConfig.announcement.pinnedAt ? new Date(groupConfig.announcement.pinnedAt).toLocaleDateString() : ''}
                    </p>
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground/50">暂无公告</p>
                )}
              </div>

              {/* Created date */}
              {groupConfig?.createdAt && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">创建于</p>
                  <p className="text-[12px] text-muted-foreground">{new Date(groupConfig.createdAt).toLocaleDateString()}</p>
                </div>
              )}

              {/* Members */}
              <MemberList
                members={members}
                groupConfig={groupConfig}
                currentUser={currentUser}
                isAdmin={isAdmin}
                isOwner={!!isOwner}
                allAgents={allAgents}
                onSetAdmin={(m) => setConfirmAction({ type: 'setAdmin', target: m })}
                onRemoveAdmin={(m) => setConfirmAction({ type: 'removeAdmin', target: m })}
                onTransfer={(m) => setConfirmAction({ type: 'transfer', target: m })}
                onKick={(m) => setConfirmAction({ type: 'kick', target: m })}
                onInvite={inviteAgent}
              />

              {/* Workflow */}
              {workflow && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Workflow</p>
                    {isAdmin && (
                      <button onClick={() => {
                        setTab('workflow');
                        fetchWorkflow();
                        setShowGroupSidebar(false);
                      }} className="text-[10px] text-muted-foreground hover:text-muted">查看</button>
                    )}
                  </div>
                  <p className="text-[12px] text-muted">{workflow.name} · {workflow.steps} 步</p>
                </div>
              )}
            </div>

            {/* Confirm dialog */}
            {confirmAction && (
              <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-50" onClick={() => setConfirmAction(null)}>
                <div className="bg-surface border border-border rounded-xl p-4 shadow-lg w-[220px] space-y-3" onClick={e => e.stopPropagation()}>
                  <p className="text-[13px] font-medium text-foreground">
                    {confirmAction.type === 'kick' && `踢出 ${confirmAction.target}？`}
                    {confirmAction.type === 'setAdmin' && `设 ${confirmAction.target} 为管理员？`}
                    {confirmAction.type === 'removeAdmin' && `取消 ${confirmAction.target} 的管理员？`}
                    {confirmAction.type === 'transfer' && `转让群主给 ${confirmAction.target}？`}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {confirmAction.type === 'transfer' && '此操作不可撤销'}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => {
                      if (confirmAction.type === 'kick') manageGroup('kick', confirmAction.target);
                      else if (confirmAction.type === 'setAdmin') manageGroup('set_admin', confirmAction.target, { admin: true });
                      else if (confirmAction.type === 'removeAdmin') manageGroup('set_admin', confirmAction.target, { admin: false });
                      else if (confirmAction.type === 'transfer') transferOwnership(confirmAction.target);
                      setConfirmAction(null);
                    }}
                      className={`flex-1 text-[12px] py-1.5 rounded-lg font-medium ${
                        confirmAction.type === 'kick' || confirmAction.type === 'transfer'
                          ? 'bg-destructive-muted text-destructive hover:bg-destructive-muted'
                          : 'bg-foreground text-canvas hover:opacity-90'
                      }`}>
                      确认
                    </button>
                    <button onClick={() => setConfirmAction(null)}
                      className="flex-1 text-[12px] py-1.5 rounded-lg bg-surface-alt text-muted hover:text-foreground">取消</button>
                  </div>
                </div>
              </div>
            )}
          </div>
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
