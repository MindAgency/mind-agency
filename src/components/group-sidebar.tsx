'use client';

import { useState } from 'react';
import { X, Pin, PinOff, Bell } from 'lucide-react';
import { MemberList } from '@/components/member-list';

interface GroupConfig {
  owner: string; admins: string[]; createdAt: number;
  name?: string; description?: string;
  announcement?: { title: string; content: string; pinnedBy: string; pinnedAt: number };
  members?: string[];
}

interface Props {
  groupConfig: GroupConfig | null;
  name: string;
  members: string[];
  currentUser: string;
  setCurrentUser: (u: string) => void;
  isAdmin: boolean;
  isOwner: boolean;
  allAgents: string[];
  workflow: { name: string; steps: number } | null;
  onSetTab: (tab: 'chat' | 'workflow' | 'tasks') => void;
  onFetchWorkflow: () => void;
  onClose: () => void;
  onManageGroup: (action: string, agent?: string, extra?: any) => void;
  onTransferOwnership: (target: string) => void;
  onInviteAgent: (agent: string) => void;
  setConfirmAction: (action: { type: string; target: string } | null) => void;
}

export function GroupSidebar({
  groupConfig, name, members, currentUser, setCurrentUser, isAdmin, isOwner,
  allAgents, workflow, onSetTab, onFetchWorkflow, onClose,
  onManageGroup, onTransferOwnership, onInviteAgent, setConfirmAction,
}: Props) {
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [editingAnnouncement, setEditingAnnouncement] = useState(false);
  const [annTitle, setAnnTitle] = useState('');
  const [annContent, setAnnContent] = useState('');
  const [confirmAction, setConfirmActionLocal] = useState<{ type: string; target: string } | null>(null);

  const saveDescription = async () => {
    await fetch(`/api/groups/${name}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: currentUser, description: descDraft }),
    });
    setEditingDesc(false);
  };

  const saveAnnouncement = async () => {
    if (!annTitle.trim()) return;
    await fetch(`/api/groups/${name}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: currentUser, announcement: { title: annTitle, content: annContent, pinnedBy: currentUser } }),
    });
    setEditingAnnouncement(false); setAnnTitle(''); setAnnContent('');
  };

  const removeAnnouncement = async () => {
    await fetch(`/api/groups/${name}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: currentUser, announcement: null }),
    });
  };

  const handleConfirm = (action: { type: string; target: string }) => {
    if (action.type === 'kick') onManageGroup('kick', action.target);
    else if (action.type === 'setAdmin') onManageGroup('set_admin', action.target, { admin: true });
    else if (action.type === 'removeAdmin') onManageGroup('set_admin', action.target, { admin: false });
    else if (action.type === 'transfer') onTransferOwnership(action.target);
    setConfirmActionLocal(null);
  };

  return (
    <div className="w-[300px] border-l border-border bg-surface overflow-y-auto shrink-0 flex flex-col relative">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
        <span className="text-[12px] font-semibold text-foreground">群资料</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-muted"><X size={14} /></button>
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
                <button onClick={saveDescription} className="flex-1 text-[11px] py-1 rounded-md bg-foreground text-canvas hover:opacity-90">保存</button>
                <button onClick={() => setEditingDesc(false)} className="flex-1 text-[11px] py-1 rounded-md bg-surface-alt text-muted hover:text-foreground">取消</button>
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">{groupConfig?.description || '暂无描述'}</p>
          )}
        </div>

        {/* Announcement */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Bell size={10} /> 公告</p>
            {isAdmin && !groupConfig?.announcement && !editingAnnouncement && (
              <button onClick={() => setEditingAnnouncement(true)} className="text-[10px] text-muted-foreground hover:text-muted flex items-center gap-0.5">
                <Pin size={9} /> 发布
              </button>
            )}
          </div>
          {editingAnnouncement ? (
            <div className="space-y-1.5">
              <input value={annTitle} onChange={e => setAnnTitle(e.target.value)} placeholder="公告标题"
                className="w-full text-[12px] bg-surface-alt border border-border rounded-lg px-2 py-1.5 text-foreground outline-none" />
              <textarea value={annContent} onChange={e => setAnnContent(e.target.value)} placeholder="公告内容..." rows={3}
                className="w-full text-[12px] bg-surface-alt border border-border rounded-lg px-2 py-1.5 text-foreground outline-none resize-none" />
              <div className="flex gap-1.5">
                <button onClick={saveAnnouncement} className="flex-1 text-[11px] py-1 rounded-md bg-foreground text-canvas hover:opacity-90">发布</button>
                <button onClick={() => setEditingAnnouncement(false)} className="flex-1 text-[11px] py-1 rounded-md bg-surface-alt text-muted hover:text-foreground">取消</button>
              </div>
            </div>
          ) : groupConfig?.announcement ? (
            <div className="bg-surface-alt rounded-lg p-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-[12px] font-medium text-foreground">{groupConfig.announcement.title}</p>
                {isAdmin && <button onClick={removeAnnouncement} className="text-muted-foreground hover:text-destructive" title="取消置顶"><PinOff size={11} /></button>}
              </div>
              {groupConfig.announcement.content && <p className="text-[11px] text-muted-foreground leading-relaxed">{groupConfig.announcement.content}</p>}
              <p className="text-[10px] text-muted-foreground/50">— {groupConfig.announcement.pinnedBy}, {groupConfig.announcement.pinnedAt ? new Date(groupConfig.announcement.pinnedAt).toLocaleDateString() : ''}</p>
            </div>
          ) : <p className="text-[12px] text-muted-foreground/50">暂无公告</p>}
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
          members={members} groupConfig={groupConfig} currentUser={currentUser}
          isAdmin={isAdmin} isOwner={!!isOwner} allAgents={allAgents}
          onSetAdmin={(m) => setConfirmActionLocal({ type: 'setAdmin', target: m })}
          onRemoveAdmin={(m) => setConfirmActionLocal({ type: 'removeAdmin', target: m })}
          onTransfer={(m) => setConfirmActionLocal({ type: 'transfer', target: m })}
          onKick={(m) => setConfirmActionLocal({ type: 'kick', target: m })}
          onInvite={onInviteAgent}
        />

        {/* Workflow */}
        {workflow && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Workflow</p>
              {isAdmin && <button onClick={() => { onSetTab('workflow'); onFetchWorkflow(); onClose(); }} className="text-[10px] text-muted-foreground hover:text-muted">查看</button>}
            </div>
            <p className="text-[12px] text-muted">{workflow.name} · {workflow.steps} 步</p>
          </div>
        )}
      </div>

      {/* Confirm dialog */}
      {confirmAction && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-50" onClick={() => setConfirmActionLocal(null)}>
          <div className="bg-surface border border-border rounded-xl p-4 shadow-lg w-[220px] space-y-3" onClick={e => e.stopPropagation()}>
            <p className="text-[13px] font-medium text-foreground">
              {confirmAction.type === 'kick' && `踢出 ${confirmAction.target}？`}
              {confirmAction.type === 'setAdmin' && `设 ${confirmAction.target} 为管理员？`}
              {confirmAction.type === 'removeAdmin' && `取消 ${confirmAction.target} 的管理员？`}
              {confirmAction.type === 'transfer' && `转让群主给 ${confirmAction.target}？`}
            </p>
            {confirmAction.type === 'transfer' && <p className="text-[11px] text-muted-foreground">此操作不可撤销</p>}
            <div className="flex gap-2">
              <button onClick={() => handleConfirm(confirmAction)}
                className={`flex-1 text-[12px] py-1.5 rounded-lg font-medium ${confirmAction.type === 'kick' || confirmAction.type === 'transfer' ? 'bg-destructive-muted text-destructive hover:bg-destructive-muted' : 'bg-foreground text-canvas hover:opacity-90'}`}>
                确认
              </button>
              <button onClick={() => setConfirmActionLocal(null)} className="flex-1 text-[12px] py-1.5 rounded-lg bg-surface-alt text-muted hover:text-foreground">取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
