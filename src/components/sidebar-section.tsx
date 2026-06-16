'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Plus, Trash2, Shield } from 'lucide-react';
import { useT } from './i18n';

// ═══════ Section Header ═══════
export function SectionHeader({ title, icon: Icon, isOpen, onToggle, onAdd }: {
  title: string;
  icon: any;
  isOpen: boolean;
  onToggle: () => void;
  onAdd?: () => void;
}) {
  return (
    <div className="px-3 mb-2 flex items-center justify-between group/header cursor-pointer" onClick={onToggle}>
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
        <ChevronDown size={14} className={`transition-transform ${isOpen ? '' : '-rotate-90'}`} />
        <Icon size={14} /> {title}
      </span>
      {onAdd && (
        <button onClick={e => { e.stopPropagation(); onAdd(); }}
          className="opacity-0 group-hover/header:opacity-100 transition-opacity text-disabled hover:text-muted">
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}

// ═══════ Create Form ═══════
export function CreateForm({ type, onSubmit, onCancel }: {
  type: 'group' | 'agent';
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');

  return (
    <div className="px-3 py-2">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder={type === 'group' ? 'group name' : 'agent name'}
        autoFocus
        className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:border-border-strong"
        onKeyDown={e => {
          if (e.key === 'Enter') { onSubmit(name); setName(''); }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="flex gap-2 mt-2">
        <button onClick={() => { onSubmit(name); setName(''); }}
          disabled={!name.trim()}
          className="px-3 py-1.5 text-sm font-medium bg-foreground text-canvas rounded-md hover:opacity-90 disabled:opacity-40">
          {t('create')}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-muted">
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

// ═══════ Group Item ═══════
export function GroupItem({ name, isActive, unread, collapsed, onDelete }: {
  name: string;
  isActive: boolean;
  unread?: number;
  collapsed: boolean;
  onDelete: () => void;
}) {
  if (collapsed) {
    return (
      <Link href={`/groups/${name}`} prefetch title={name}
        className="flex items-center justify-center px-2 py-3 rounded-xl text-sm transition-all bg-canvas shadow-sm text-foreground font-medium border border-border">
        <span className="w-7 h-7 rounded-lg bg-surface-alt flex items-center justify-center text-xs font-bold text-muted shrink-0">#</span>
      </Link>
    );
  }

  return (
    <div className="group relative mb-1">
      <Link href={`/groups/${name}`} prefetch
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all ${isActive ? 'bg-canvas shadow-sm text-foreground font-medium border border-border' : 'text-muted hover:text-foreground hover:bg-canvas/50'}`}>
        <span className="w-7 h-7 rounded-lg bg-surface-alt flex items-center justify-center text-xs font-bold text-muted shrink-0">#</span>
        <span className="truncate flex-1">{name}</span>
        {!isActive && (unread || 0) > 0 && (
          <span className="text-xs bg-destructive text-canvas rounded-full px-1.5 min-w-5 h-5 flex items-center justify-center font-bold shrink-0">{unread}</span>
        )}
      </Link>
      <button onClick={onDelete}
        className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded-lg text-disabled hover:text-destructive hover:bg-destructive-muted transition-all">
        <Trash2 size={16} />
      </button>
    </div>
  );
}

// ═══════ Agent Item ═══════
export function AgentItem({ name, isActive, isAdmin, status, collapsed, onDelete }: {
  name: string;
  isActive: boolean;
  isAdmin?: boolean;
  status?: string;
  collapsed: boolean;
  onDelete: () => void;
}) {
  const isActiveStatus = status === 'chatting' || status === 'processing' || status === 'working';

  if (collapsed) {
    return (
      <Link href={`/agents/${name}`} prefetch title={name}
        className="flex items-center justify-center px-2 py-3 rounded-xl text-sm transition-all bg-canvas shadow-sm text-foreground font-medium border border-border">
        <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium shrink-0 bg-surface-alt text-muted">{name[0]}</span>
      </Link>
    );
  }

  return (
    <div className="group relative mb-1">
      <Link href={`/agents/${name}`} prefetch
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all ${isActive ? 'bg-canvas shadow-sm text-foreground font-medium border border-border' : 'text-muted hover:text-foreground hover:bg-canvas/50'}`}>
        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${isActiveStatus ? 'bg-success-muted text-success' : 'bg-surface-alt text-muted'}`}>
          {name[0]}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm">{name}</span>
            {isAdmin && <Shield size={14} className="text-muted-foreground shrink-0" />}
          </div>
        </div>
      </Link>
      <button onClick={onDelete}
        className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded-lg text-disabled hover:text-destructive hover:bg-destructive-muted transition-all">
        <Trash2 size={16} />
      </button>
    </div>
  );
}
