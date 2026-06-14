'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import ChatPanel from '@/components/chat-panel';
import EmailClient from '@/components/email-client';
import Sidebar from '@/components/sidebar';
import { Mail, Hash, Settings, Shield, MessageCircle, FileText, GitBranch } from 'lucide-react';
import { useT } from '@/components/i18n';
import { TokenBalance, TokenBalanceFull } from '@/components/token-balance';
import { OpsLog } from '@/components/agent-ops-log';
import { TasksPanel } from '@/components/agent-tasks-panel';
import { Toggle } from '@/components/toggle';

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
  const [tab, setTab] = useState<'chat' | 'email' | 'ops' | 'tasks'>('chat');
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
        </div>

        {/* ── Content row: main + config sidebar ── */}
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 flex flex-col min-h-0">
            {tab === 'chat' ? (
              <ChatPanel agentName={name} />
            ) : tab === 'tasks' ? (
              <TasksPanel agentName={name} tasks={tasks} onRefresh={fetchTasks} />
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

// Components imported from: token-balance.tsx, agent-ops-log.tsx, agent-tasks-panel.tsx, toggle.tsx
