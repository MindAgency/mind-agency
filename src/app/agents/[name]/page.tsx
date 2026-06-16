'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import ChatPanel from '@/components/chat-panel';
import EmailClient from '@/components/email-client';
import Sidebar from '@/components/sidebar';
import { Mail, Hash, Settings, Shield, MessageCircle, FileText, GitBranch, RefreshCw, DollarSign, Brain, Trash2, Save } from 'lucide-react';
import { useT } from '@/components/i18n';

interface AgentConfig {
  autoRespondToEmail: boolean; autoProcessGroupInvites: boolean;
  notifyOnEmail: boolean; notifyOnGroupMention: boolean;
  roles: string[]; permissions: Record<string, boolean>;
  heartbeatIntervalMs?: number;
}
interface AuditEntry { agent: string; action: string; resource: string; timestamp: string; status?: string; details?: string; }

const defaultConfig: AgentConfig = {
  autoRespondToEmail: false, autoProcessGroupInvites: false,
  notifyOnEmail: true, notifyOnGroupMention: true,
  roles: [], permissions: {},
  heartbeatIntervalMs: 0,
};

export default function AgentPage() {
  const { name } = useParams<{ name: string }>();
  const { t } = useT();
  const [tab, setTab] = useState<'chat' | 'email' | 'ops' | 'tasks' | 'memory'>('chat');
  const [tasks, setTasks] = useState<any[]>([]);
  const [config, setConfig] = useState<AgentConfig>(defaultConfig);
  const [saving, setSaving] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showClaude, setShowClaude] = useState(false);
  const [claudeMd, setClaudeMd] = useState('');
  const [claudeSaving, setClaudeSaving] = useState(false);
  const [emailCount, setEmailCount] = useState(0);
  const [groups, setGroups] = useState<string[]>([]);
  const loadInfo = useCallback(() => {
    Promise.all([
      fetch(`/api/emails?agent=${name}`).then(r=>r.json()),
      fetch(`/api/groups/scan?agent=${name}`).then(r=>r.json()),
    ]).then(([emails, g]) => {
      setEmailCount(Array.isArray(emails) ? emails.length : 0);
      setGroups(g.groups || []);
    }).catch(()=>{});
  }, [name]);

  const loadConfig = useCallback(() => {
    fetch(`/api/agents/${name}/config`).then(r=>r.json())
      .then(d => { if (!d.error) { const c = { ...defaultConfig, ...d }; setConfig(c); setRolesInput((c.roles || []).join(', ')); setHeartbeatMin(String(Math.round((c.heartbeatIntervalMs ?? 0) / 60000 * 10) / 10)); } }).catch(() => {});
  }, [name]);

  const loadClaude = useCallback(() => {
    fetch(`/api/agents/${name}/config?file=claude`).then(r=>r.json())
      .then(d => setClaudeMd(d.content || '')).catch(() => {});
  }, [name]);

  const fetchTasks = useCallback(() => {
    fetch(`/api/agents/${name}/tasks`).then(r => r.json()).then(d => setTasks(d.tasks || [])).catch(() => {});
  }, [name]);

  useEffect(() => { loadInfo(); loadConfig(); loadClaude(); fetchTasks(); }, [loadInfo, loadConfig, loadClaude, fetchTasks]);

  const toggleConfig = async (key: keyof AgentConfig) => {
    const next = { ...config, [key]: !config[key] }; setConfig(next); setSaving(true);
    try { await fetch(`/api/agents/${name}/config`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ [key]: !config[key] }) }); } catch (e) { console.error('[app:agents:[name]:page]', e); }
    setSaving(false);
  };

  const saveClaude = async () => {
    setClaudeSaving(true);
    try { await fetch(`/api/agents/${name}/config`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ claudeMd }) }); } catch (e) { console.error('[app:agents:[name]:page]', e); }
    setClaudeSaving(false);
  };

  const [rolesInput, setRolesInput] = useState('');
  const [heartbeatMin, setHeartbeatMin] = useState('0');
  const saveConfigField = async (key: string, value: any) => {
    try { await fetch(`/api/agents/${name}/config`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ [key]: value }) }); } catch (e) { console.error('[app:agents:[name]:page]', e); }
  };
  const saveRoles = async () => {
    const roles = rolesInput.split(',').map(s => s.trim()).filter(Boolean);
    await saveConfigField('roles', roles);
    setConfig({ ...config, roles });
  };
  const saveHeartbeat = async () => {
    const min = parseFloat(heartbeatMin) || 0;
    const ms = Math.round(min * 60000);
    await saveConfigField('heartbeatIntervalMs', ms);
    setConfig({ ...config, heartbeatIntervalMs: ms });
  };

  const isAdmin = config.roles?.includes('admin');

  return (
    <div className="flex h-full overflow-hidden bg-canvas">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0">

        {/* ── Compact header ── */}
        <div className="px-5 py-3 border-b border-border flex items-center gap-4 shrink-0 bg-canvas">
          <span className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium bg-surface-alt text-muted`}>{name[0]}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[14px] font-semibold text-foreground">{name}</h1>
              {isAdmin && <Shield size={11} className="text-muted-foreground"/>}
              {config.autoRespondToEmail && <span className="text-[9px] bg-success-muted text-success px-1.5 py-0.5 rounded-full font-medium">auto</span>}
            </div>
            <p className="text-[10px] text-muted-foreground flex items-center gap-2">
              {config.roles.length > 0 ? config.roles.join(', ') : '成员'}
              <span className="text-border">·</span>
              <Mail size={10}/> {emailCount} 封
              <span className="text-border">·</span>
              <Hash size={10}/> {groups.length} 群
            </p>
          </div>
          {/* Token balance — visible in header */}
          <TokenBalance agent={name!} />
          <button onClick={() => setShowConfig(!showConfig)}
            className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg transition-colors ${showConfig ? 'bg-surface-alt text-muted' : 'text-muted-foreground hover:text-muted'}`}>
            <Settings size={12}/> 配置
          </button>
        </div>


        {/* ── Chat / Email tabs ── */}
        <div className="flex items-center gap-1 px-5 py-2 border-b border-border shrink-0 bg-canvas">
          <button onClick={() => setTab('chat')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='chat'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
            <MessageCircle size={13}/> Chat
          </button>
          <button onClick={() => setTab('email')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='email'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
            <Mail size={13}/> 邮箱
            {emailCount > 0 && <span className="text-[10px] bg-info-muted text-info rounded-full w-4 h-4 flex items-center justify-center">{emailCount}</span>}
          </button>
          <button onClick={() => setTab('ops')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='ops'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
            <FileText size={13}/> 操作
          </button>
          <button onClick={() => { setTab('tasks'); fetchTasks(); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='tasks'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
            <GitBranch size={13}/> 任务
            {tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length > 0 && (
              <span className="text-[10px] bg-warning-muted text-warning rounded-full w-4 h-4 flex items-center justify-center">
                {tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length}
              </span>
            )}
          </button>
          <button onClick={() => setTab('memory')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${tab==='memory'?'bg-surface-alt text-foreground':'text-muted hover:text-foreground'}`}>
            <Brain size={13}/> Memory
          </button>
        </div>

        {/* ── Content row: main + config sidebar ── */}
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 flex flex-col min-h-0">
            {tab === 'chat' ? (
              <ChatPanel agentName={name} />
            ) : tab === 'tasks' ? (
              <TasksPanel agentName={name} tasks={tasks} onRefresh={fetchTasks} />
            ) : tab === 'memory' ? (
              <MemoryPanel agentName={name} />
            ) : tab === 'ops' ? (
              <OpsLog agentName={name} />
            ) : (
              <EmailClient agentName={name} displayName={name} />
            )}
          </div>

          {showConfig && (
            <div className="w-[300px] border-l border-border bg-surface overflow-y-auto shrink-0">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
                <span className="text-[12px] font-medium text-foreground">配置 · {name}</span>
                <button onClick={() => setShowConfig(false)} className="text-muted-foreground hover:text-foreground">
                  <span className="text-[16px] leading-none">&times;</span>
                </button>
              </div>
              <div className="p-4 space-y-3">
                <div className="grid grid-cols-1 gap-1">
                  <Toggle label="自动回复邮件" desc="有新邮件时自动响应" checked={config.autoRespondToEmail} onChange={() => toggleConfig('autoRespondToEmail')} />
                  <Toggle label="自动加入群组" desc="被邀请时自动接受" checked={config.autoProcessGroupInvites} onChange={() => toggleConfig('autoProcessGroupInvites')} />
                  <Toggle label="新邮件通知" desc="收到新邮件时弹窗提醒" checked={config.notifyOnEmail} onChange={() => toggleConfig('notifyOnEmail')} />
                  <Toggle label="群@通知" desc="被@时弹窗提醒" checked={config.notifyOnGroupMention} onChange={() => toggleConfig('notifyOnGroupMention')} />
                </div>

                {/* Token Balance — full view in config */}
                <TokenBalanceFull agent={name!} />

                <div className="border-t border-border pt-3 space-y-3">
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-1 block">Roles (逗号分隔)</label>
                    <div className="flex gap-1">
                      <input value={rolesInput} onChange={e => setRolesInput(e.target.value)}
                        placeholder="admin, reviewer, developer"
                        className="flex-1 px-2.5 py-1.5 text-[12px] border border-border rounded-lg outline-none focus:border-border-strong" />
                      <button onClick={saveRoles}
                        className="px-2.5 py-1.5 text-[11px] font-medium bg-foreground text-canvas rounded-lg hover:opacity-90">{t('save')}</button>
                    </div>
                  </div>
                  {/* v0.4: Provider selector — only show if API key is configured */}
                  <div style={{ display: (config as any).apiKey ? 'block' : 'none' }}>
                    <label className="text-[10px] text-muted-foreground mb-1 block">AI Provider</label>
                    <select value={(config as any).provider || 'claude'}
                      onChange={async (e) => {
                        const v = e.target.value;
                        setConfig({ ...config, provider: v } as any);
                        await saveConfigField('provider', v);
                      }}
                      className="w-full px-2.5 py-1.5 text-[12px] border border-border rounded-lg outline-none focus:border-border-strong bg-canvas">
                      <option value="claude">Claude (Anthropic / DeepSeek)</option>
                      <option value="codex">Codex (OpenAI CLI)</option>
                    </select>
                    <p className="text-[10px] text-muted-foreground/50 mt-1">切换后新对话从头开始，旧记录保留</p>
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-1 block">Heartbeat (分钟, 0=关闭)</label>
                    <div className="flex gap-1">
                      <input value={heartbeatMin} onChange={e => setHeartbeatMin(e.target.value)}
                        placeholder="2 (分钟)"
                        className="flex-1 px-2.5 py-1.5 text-[12px] border border-border rounded-lg outline-none focus:border-border-strong" />
                      <button onClick={saveHeartbeat}
                        className="px-2.5 py-1.5 text-[11px] font-medium bg-foreground text-canvas rounded-lg hover:opacity-90">{t('save')}</button>
                    </div>
                  </div>
                  <button onClick={() => setShowClaude(!showClaude)} className="text-[11px] font-medium text-muted hover:text-foreground flex items-center gap-1">
                    <Settings size={11} /> {showClaude ? t('cancel') : '编辑 CLAUDE.md (人设)'}
                  </button>
                  {showClaude && (
                    <div className="mt-2 space-y-2">
                      <textarea value={claudeMd} onChange={e => setClaudeMd(e.target.value)}
                        placeholder="# Agent 人设&#10;&#10;用 Markdown 写你的 Agent 性格、工作方式、表达风格。"
                        rows={10}
                        className="w-full px-3 py-2 border border-border rounded-lg text-[12px] outline-none focus:border-border-strong font-mono resize-y" />
                      <button onClick={saveClaude} disabled={claudeSaving}
                        className="px-3 py-1.5 text-[11px] font-medium bg-foreground text-canvas rounded-lg hover:opacity-90 disabled:opacity-50">
                        {claudeSaving ? t('saving') : t('save')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function MemoryPanel({ agentName }: { agentName: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [key, setKey] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (q?: string) => {
    setLoading(true);
    const url = q ? `/api/agents/${agentName}/memory?q=${encodeURIComponent(q)}` : `/api/agents/${agentName}/memory`;
    const d = await fetch(url).then(r => r.json()).catch(() => ({ memories: [] }));
    setItems(d.memories || []);
    setLoading(false);
  }, [agentName]);

  useEffect(() => { load(); }, [load]);

  const saveMemory = async () => {
    if (!key.trim() || !content.trim()) return;
    await fetch(`/api/agents/${agentName}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, content }),
    });
    setKey('');
    setContent('');
    await load();
  };

  const removeMemory = async (memoryKey: string) => {
    await fetch(`/api/agents/${agentName}/memory?key=${encodeURIComponent(memoryKey)}`, { method: 'DELETE' });
    await load(query || undefined);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-surface">
      <div className="max-w-5xl mx-auto p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-foreground flex items-center gap-2"><Brain size={16}/> Memory</h2>
            <p className="text-[11px] text-muted-foreground">Long-term memory entries used by this agent.</p>
          </div>
          <button onClick={() => load(query || undefined)} className="p-2 rounded-lg border border-border bg-canvas text-muted-foreground hover:text-foreground">
            <RefreshCw size={14}/>
          </button>
        </div>

        <div className="rounded-lg border border-border bg-canvas p-4 space-y-3">
          <div className="grid grid-cols-[220px_1fr_auto] gap-2">
            <input value={key} onChange={e => setKey(e.target.value)} placeholder="key" className="px-3 py-2 rounded-lg border border-border bg-surface text-[12px] outline-none focus:border-border-strong" />
            <input value={content} onChange={e => setContent(e.target.value)} placeholder="memory content" className="px-3 py-2 rounded-lg border border-border bg-surface text-[12px] outline-none focus:border-border-strong" />
            <button onClick={saveMemory} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-foreground text-canvas text-[12px] font-medium">
              <Save size={13}/> Save
            </button>
          </div>
          <div className="flex gap-2">
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search memory" className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-[12px] outline-none focus:border-border-strong" />
            <button onClick={() => load(query || undefined)} className="px-3 py-2 rounded-lg border border-border bg-surface text-[12px] text-foreground">Search</button>
          </div>
        </div>

        {loading ? (
          <div className="py-10 flex justify-center text-muted-foreground"><RefreshCw size={16} className="animate-spin"/></div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {items.map(m => (
              <div key={m.key} className="rounded-lg border border-border bg-canvas p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">{m.key}</span>
                      <span className="text-[10px] text-muted-foreground">{m.updated ? new Date(m.updated).toLocaleString() : ''}</span>
                    </div>
                    <p className="text-[12px] text-muted-foreground whitespace-pre-wrap mt-2">{m.content}</p>
                  </div>
                  <button onClick={() => removeMemory(m.key)} className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive-muted">
                    <Trash2 size={14}/>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Operations log — shows file Write/Edit/Delete/Bash actions by this agent. */
function OpsLog({ agentName }: { agentName: string }) {
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

function formatTime(ts: string): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function Toggle({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-canvas/50 cursor-pointer transition-colors">
      <div className="relative shrink-0">
        <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
        <div className={`w-8 h-4.5 rounded-full transition-colors ${checked ? 'bg-foreground' : 'bg-border'}`}>
          <div className={`w-3.5 h-3.5 rounded-full bg-canvas shadow-sm transition-transform mt-0.5 ml-0.5 ${checked ? 'translate-x-[13px]' : ''}`} />
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-foreground">{label}</p>
        <p className="text-[10px] text-muted-foreground">{desc}</p>
      </div>
    </label>
  );
}

function TasksPanel({ agentName, tasks, onRefresh }: { agentName: string; tasks: any[]; onRefresh: () => void }) {
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

// ── v1.2: Token Balance Component (compact) ──────────────────
function TokenBalance({ agent }: { agent: string }) {
  const [account, setAccount] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/economy/account?agent=${agent}`)
      .then(r => r.json()).then(d => setAccount(d.account)).catch(() => {});
  }, [agent]);

  if (!account) return null;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 bg-surface rounded-lg">
      <DollarSign size={11} className="text-muted-foreground" />
      <span className="text-[12px] font-bold text-foreground font-mono">{account.balance.toLocaleString()}</span>
      <span className="text-[9px] text-muted-foreground">tokens</span>
    </div>
  );
}

// ── v1.2: Token Balance Full (in config panel) ───────────────
function TokenBalanceFull({ agent }: { agent: string }) {
  const [account, setAccount] = useState<any>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    fetch(`/api/economy/account?agent=${agent}`)
      .then(r => r.json()).then(d => setAccount(d.account)).catch(() => {});
  }, [agent]);

  if (!account) return null;

  const recentTx = (account.transactions || []).slice(-5).reverse();

  return (
    <div className="space-y-2">
      <label className="text-[10px] text-muted-foreground block">💰 Token 账户</label>
      <div className="bg-canvas border border-border rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[18px] font-bold text-foreground font-mono">{account.balance.toLocaleString()}</span>
          <span className="text-[10px] text-muted-foreground">tokens</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div className="bg-surface rounded-lg px-2 py-1.5">
            <p className="text-muted-foreground">累计收入</p>
            <p className="font-medium text-foreground font-mono">{account.earned.toLocaleString()}</p>
          </div>
          <div className="bg-surface rounded-lg px-2 py-1.5">
            <p className="text-muted-foreground">累计支出</p>
            <p className="font-medium text-foreground font-mono">{account.spent.toLocaleString()}</p>
          </div>
        </div>
        {recentTx.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <button onClick={() => setShowHistory(!showHistory)} className="text-[10px] text-muted hover:text-foreground transition-colors">
              {showHistory ? '收起' : '最近交易'} ▾
            </button>
            {showHistory && (
              <div className="mt-1.5 space-y-1">
                {recentTx.map((tx: any, i: number) => (
                  <div key={i} className="flex items-center gap-1.5 text-[9px]">
                    <span className={`px-1 py-0.5 rounded font-medium ${
                      tx.type === 'deposit' || tx.type === 'reward' || tx.type === 'bonus' || tx.type === 'transfer_in'
                        ? 'bg-success-muted text-success' : 'bg-destructive-muted text-destructive'
                    }`}>{tx.type === 'deposit' ? '存入' : tx.type === 'reward' ? '奖励' : tx.type === 'bonus' ? '优质' : tx.type === 'transfer_in' ? '转入' : tx.type === 'transfer_out' ? '转出' : tx.type === 'withdraw' ? '扣费' : '处罚'}</span>
                    <span className="font-mono text-foreground">{tx.amount > 0 ? '+' : ''}{tx.amount}</span>
                    {tx.reason && <span className="text-muted-foreground truncate flex-1">{tx.reason}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
