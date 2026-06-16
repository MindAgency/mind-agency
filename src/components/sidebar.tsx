'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Hash, Users, Activity, Trash2, User, Settings, PanelLeftClose, PanelLeftOpen, TrendingUp, DollarSign, FileText, BarChart3, X, LayoutDashboard } from 'lucide-react';
import { useSidebarData } from './sidebar-context';
import { useNotifications } from './notification-provider';
import { useT } from './i18n';
import LogoCanvas from './logo-canvas';
import { SectionHeader, CreateForm, GroupItem, AgentItem } from './sidebar-section';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { agents, groups, activity, loading, refresh, collapsed, setCollapsed } = useSidebarData();
  const { unreadGroups, unreadEmails } = useNotifications();
  const [confirmDel, setConfirmDel] = useState('');
  const { t } = useT();

  // Inline creation + section collapse
  const [creating, setCreating] = useState<'group' | 'agent' | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sectionsClosed, setSectionsClosed] = useState<Set<string>>(new Set());

  // Auto-collapse on narrow window (< 1200px collapse, < 768px force collapse)
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      const narrow = w < 768;
      setIsMobile(narrow);
      if (narrow) setCollapsed(true);
      else if (w < 1200) setCollapsed(true);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const ts = (key: string) => {
    setSectionsClosed(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  const createItem = async () => {
    if (!newName.trim() || !creating || busy) return;
    setBusy(true);
    try {
      if (creating === 'group') {
        await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) });
      } else {
        await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim(), roles: ['member'], autoRespondToEmail: true, permissions: { canCreateGroup: true, canDeleteGroup: false, canDeploy: false } }) });
      }
      setNewName(''); setCreating(null); refresh(); setBusy(false);
    } catch { setBusy(false); }
  };

  const doDelete = async () => {
    if (!confirmDel) return;
    const [type, name] = confirmDel.split(':');
    try {
      if (type === 'group') await fetch(`/api/groups/${name}`, { method: 'DELETE' });
      else await fetch(`/api/agents?name=${name}`, { method: 'DELETE' });
      if (pathname.includes(`/${name}`)) router.push('/');
    } catch (e) { console.error('[components:sidebar]', e); }
    setConfirmDel('');
    refresh();
  };

  // Link item helper
  const NavItem = ({ href, icon: Icon, label, badge }: { href: string; icon: any; label: string; badge?: number }) => {
    const active = pathname === href;
    return (
      <Link href={href} prefetch title={collapsed ? label : undefined}
        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-all ${active ? 'bg-canvas shadow-sm text-foreground font-medium border border-border' : 'text-muted hover:text-foreground hover:bg-canvas/50'} ${collapsed ? 'justify-center px-1.5' : ''}`}>
        <Icon size={14} className="shrink-0" />
        {!collapsed && <span className="flex-1 truncate">{label}</span>}
        {!collapsed && badge != null && badge > 0 && (
          <span className="text-[9px] bg-destructive text-canvas rounded-full w-4 h-4 flex items-center justify-center font-bold shrink-0">{badge > 9 ? '9+' : badge}</span>
        )}
      </Link>
    );
  };

  return (
    <>
      {/* Mobile overlay */}
      {collapsed === false && (
        <div className="fixed inset-0 bg-black/30 z-40 md:hidden" onClick={() => setCollapsed(true)} />
      )}

      <aside className={`
        bg-surface border-r border-border flex flex-col shrink-0 h-full overflow-hidden
        transition-all duration-200
        ${collapsed ? 'w-0 -ml-px md:w-[52px] md:ml-0' : 'w-[220px]'}
        ${collapsed === false ? 'fixed inset-y-0 left-0 z-50 md:static md:z-auto' : 'static'}
      `}>
        {/* Header */}
        <div className={`flex items-center border-b border-border ${collapsed ? 'px-2 py-4 justify-center' : 'px-5 py-4 gap-3'}`}>
          <button onClick={() => setCollapsed(!collapsed)} title={collapsed ? t('expand_sidebar') : t('collapse_sidebar')}
            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 overflow-hidden">
            {collapsed ? <PanelLeftOpen size={14} className="text-foreground" /> : <LogoCanvas size={28} />}
          </button>
          {!collapsed && <span className="text-[14px] font-semibold text-foreground tracking-tight flex-1">Mind Agency</span>}
          {!collapsed && (
            <button onClick={() => setCollapsed(true)} className="text-disabled hover:text-muted">
              <PanelLeftClose size={14} />
            </button>
          )}
        </div>

        <nav className="flex-1 py-3 px-2.5 space-y-4 overflow-y-auto">
          <NavItem href="/" icon={Activity} label={t('dashboard')} />
          <NavItem href="/dashboard" icon={LayoutDashboard} label={t('management')} />
          <NavItem href="/audit" icon={FileText} label={t('audit')} />

          {/* Teams section */}
          {!collapsed ? (
            <section>
              <SectionHeader title={t('teams')} icon={Hash}
                isOpen={!sectionsClosed.has('teams')}
                onToggle={() => ts('teams')}
                onAdd={() => setCreating('group')} />
              {!sectionsClosed.has('teams') && (
                <div className="space-y-0.5">
                  {groups.map(g => (
                    <GroupItem key={g.name} name={g.name}
                      isActive={pathname === `/groups/${g.name}`}
                      unread={unreadGroups[g.name]}
                      collapsed={false}
                      onDelete={() => setConfirmDel(`group:${g.name}`)} />
                  ))}
                  {creating === 'group' && (
                    <CreateForm type="group" onSubmit={createItem} onCancel={() => setCreating(null)} />
                  )}
                </div>
              )}
            </section>
          ) : (
            <div className="space-y-0.5">
              {groups.map(g => (
                <GroupItem key={g.name} name={g.name}
                  isActive={pathname === `/groups/${g.name}`}
                  collapsed={true}
                  onDelete={() => setConfirmDel(`group:${g.name}`)} />
              ))}
            </div>
          )}

          {/* Members section */}
          {!collapsed ? (
            <section id="tour-sidebar-agents">
              <div id="tour-sidebar-create">
                <SectionHeader title={t('members')} icon={Users}
                  isOpen={!sectionsClosed.has('members')}
                  onToggle={() => ts('members')}
                  onAdd={() => setCreating('agent')} />
              </div>
              {!sectionsClosed.has('members') && (
                <div className="space-y-0.5">
                  {agents.filter(a => a.name !== 'me').map(a => (
                    <AgentItem key={a.name} name={a.name}
                      isActive={pathname === `/agents/${a.name}`}
                      isAdmin={(a as any).config?.roles?.includes('admin')}
                      status={activity[a.name]?.status}
                      collapsed={false}
                      onDelete={() => setConfirmDel(`agent:${a.name}`)} />
                  ))}
                  {creating === 'agent' && (
                    <CreateForm type="agent" onSubmit={createItem} onCancel={() => setCreating(null)} />
                  )}
                </div>
              )}
            </section>
          ) : (
            <div className="space-y-0.5">
              {agents.filter(a => a.name !== 'me').map(a => (
                <AgentItem key={a.name} name={a.name}
                  isActive={pathname === `/agents/${a.name}`}
                  collapsed={true}
                  onDelete={() => setConfirmDel(`agent:${a.name}`)} />
              ))}
            </div>
          )}

          {!collapsed ? (
            <>
              <NavItem href="/me" icon={User} label={t('me')} badge={unreadEmails} />
              <NavItem href="/economy" icon={DollarSign} label={t('usage')} />
              <NavItem href="/learning" icon={TrendingUp} label={t('learning')} />
              <NavItem href="/settings" icon={Settings} label={t('settings')} />
            </>
          ) : (
            <div className="space-y-0.5">
              <NavItem href="/me" icon={User} label="" badge={unreadEmails} />
              <NavItem href="/analytics" icon={BarChart3} label="" />
              <NavItem href="/learning" icon={TrendingUp} label="" />
              <NavItem href="/settings" icon={Settings} label="" />
            </div>
          )}
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div className="px-4 py-3 border-t border-border flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            {loading ? '...' : t('agents_groups_count', { a: agents.length, g: groups.length })}
          </div>
        )}
      </aside>

      {/* Delete confirm modal */}
      {confirmDel && (
        <div className="fixed inset-0 bg-black/20 z-50 flex items-center justify-center" onClick={() => setConfirmDel('')}>
          <div className="bg-canvas rounded-2xl p-6 shadow-xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h3 className="text-[14px] font-semibold text-foreground">{t('delete_confirm_title', { name: confirmDel.split(':')[1] })}</h3><button onClick={() => setConfirmDel('')} className="text-disabled hover:text-muted"><X size={16} /></button></div>
            <p className="text-[13px] text-destructive mb-4">{t('delete_warning')}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDel('')} className="px-3 py-1.5 text-[12px] text-muted hover:bg-surface rounded-lg">{t('cancel')}</button>
              <button onClick={doDelete} className="px-4 py-1.5 text-[12px] font-medium text-canvas bg-destructive hover:bg-destructive rounded-lg">{t('delete')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
