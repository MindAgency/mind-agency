'use client';

import React, { useState, useEffect, useCallback, useRef, Component } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Sidebar from '@/components/sidebar';
import { Send, Loader2, Play, MessageCircle, GitBranch, Settings, X, RefreshCw, Plus, Crown, Star, Trash2, ArrowRightLeft, Pin, PinOff, Bell, ArrowRight, Search, Paperclip } from 'lucide-react';
import { useT } from '@/components/i18n';
import WorkflowGantt from '@/components/workflow-gantt';
import WorkflowArch from '@/components/workflow-arch';
import { WorkflowEditor } from '@/components/workflow-editor';
import { MemberList } from '@/components/member-list';

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
    // Safety timeout: force loading=false after 8s even if fetch hangs
    const safetyTimer = setTimeout(() => setLoading(false), 8000);
    fetch(`/api/groups/${name}`).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then(d => {
      setMembers(d.members || []);
      setMessages(d.messages || []);
      if (!pickAgent && d.members?.length > 0) setPickAgent(d.members[0]);
    }).catch(e => {
      console.error('[groups page] fetchGroup failed:', e);
    }).finally(() => {
      clearTimeout(safetyTimer);
      setLoading(false);
    });
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
                <div className="h-full relative">
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
                  <WorkflowProcessOverview workflow={workflow} run={currentRun} running={wfRunning} results={wfResults} />
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

const DAG_COLORS = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6'];

function DagViewSafe(props: any) {
  try { return <DagView {...props} />; }
  catch (e: any) {
    console.error('[DagView ERROR]', e?.message || e);
    return <div className="bg-surface rounded-xl p-4 text-[12px] text-destructive">DAG error: {e?.message || String(e)}</div>;
  }
}

function DagView({ steps, hoveredStep, setHoveredStep }: { steps: any[]; hoveredStep: string | null; setHoveredStep: (id: string | null) => void }) {
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

function timeFmt(d: string): string {
  if (!d) return '';
  try { return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return d.slice(11, 16); }
}

// ── v1.2: Orchestrate Button ──────────────────────────────────────
function OrchestrateButton({ group, onDone }: { group: string; onDone: () => void }) {
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
    } catch (e) { console.error('[app:groups:[name]:page]', e); }
    setLoading(false);
  };

  const confirm = async () => {
    setLoading(true);
    try {
      await fetch('/api/orchestrate', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ goal, group, coordinator:'user', confirm:true }) });
      setShow(false); setGoal(''); setPlan(null);
      onDone();
    } catch (e) { console.error('[app:groups:[name]:page]', e); }
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

function WorkflowProcessOverview({ workflow, run, running, results }: { workflow: WorkflowDef; run: any; running: boolean; results: WorkflowResult[] }) {
  const steps = workflow.stepsList || [];
  const statuses = run?.steps || {};
  const done = steps.filter(s => ['completed', 'skipped'].includes(statuses[s.id])).length;
  const failed = steps.filter(s => statuses[s.id] === 'failed').length;
  const active = steps.find(s => ['in_progress', 'waiting', 'running'].includes(statuses[s.id]));
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;

  return (
    <div className="absolute left-5 right-5 bottom-5 rounded-lg border border-border bg-canvas/95 shadow-lg backdrop-blur px-4 py-3">
      <div className="flex items-center gap-4">
        <div className="min-w-[180px]">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${running ? 'bg-success animate-pulse' : failed ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
            <span className="text-[12px] font-semibold text-foreground">{workflow.name}</span>
            <span className="text-[10px] text-muted-foreground">{pct}%</span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-surface-alt overflow-hidden">
            <div className={`h-full ${failed ? 'bg-destructive' : 'bg-success'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="flex-1 grid grid-cols-4 gap-2">
          {steps.slice(0, 8).map(s => {
            const st = statuses[s.id] || 'pending';
            const tone = st === 'completed' ? 'border-success/40 bg-success-muted text-success'
              : st === 'failed' ? 'border-destructive/40 bg-destructive-muted text-destructive'
              : ['in_progress', 'waiting', 'running'].includes(st) ? 'border-info/40 bg-info-muted text-info'
              : 'border-border bg-surface text-muted-foreground';
            return (
              <div key={s.id} className={`min-w-0 rounded-md border px-2 py-1.5 ${tone}`}>
                <p className="text-[10px] font-medium truncate">{s.id}</p>
                <p className="text-[9px] truncate opacity-80">{s.agent || 'unassigned'} · {st}</p>
              </div>
            );
          })}
        </div>
        <div className="w-[220px] text-[11px] text-muted-foreground">
          <p className="truncate">Active: {active ? `${active.id} / ${active.agent}` : running ? 'scheduling' : 'idle'}</p>
          <p className="truncate">Latest: {results[results.length - 1]?.reply?.slice(0, 80) || 'No result yet'}</p>
        </div>
      </div>
    </div>
  );
}

// ── v1.2: Tasks Tab ──────────────────────────────────────────────
function TasksTab({ group }: { group: string }) {
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
