'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { createLogger } from '@/lib/logger';

const logger = createLogger('sidebar-context');

interface AgentInfo { name: string; emailCount: number; }
interface GroupInfo { name: string; }
interface AgentActivityEntry { active: boolean; status: string; detail: string; }
interface AgentActivity { [name: string]: AgentActivityEntry; }

interface SidebarData {
  agents: AgentInfo[];
  groups: GroupInfo[];
  activity: AgentActivity;
  loading: boolean;
  refresh: () => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
}

const SidebarContext = createContext<SidebarData>({ agents: [], groups: [], activity: {}, loading: true, refresh: () => {}, collapsed: false, setCollapsed: () => {} });

/**
 * Context provider that supplies sidebar data (agents, groups, activity) to the
 * entire component tree. Handles polling, heartbeat checks, and WebSocket events
 * for real-time updates.
 *
 * @param children - React children to wrap with the sidebar context
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [activity, setActivity] = useState<AgentActivity>({});
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  // Ref to avoid stale closure in heartbeat poll interval
  const agentsRef = useRef<AgentInfo[]>([]);
  agentsRef.current = agents;

  // Unified refresh — taste: one intent, one action
  const refresh = useCallback(() => {
    setLoading(true);
    return Promise.all([
      fetch('/api/agents').then(r => {
        if (!r.ok) throw new Error(`agents ${r.status}`);
        return r.json();
      }),
      fetch('/api/groups/scan').then(r => {
        if (!r.ok) throw new Error(`groups ${r.status}`);
        return r.json();
      }),
    ]).then(([a, g]) => {
      setAgents(a.agents || []);
      setGroups((g.groups || []).map((n: string) => ({ name: n })));
    }).catch((err) => {
      // Log but don't crash — next poll cycle will retry
      if (typeof console !== 'undefined') console.warn('[sidebar] refresh failed:', err?.message || err);
    }).finally(() => setLoading(false));
  }, []);

  const [loaded, setLoaded] = useState(false);

  // Init — load once, mark loaded after first fetch settles
  useEffect(() => {
    refresh().finally(() => setLoaded(true));
  }, [refresh]);

  // Unified polling — taste: one interval, not four
  // Combines: sidebar refresh (10s) + heartbeat (5s) + chat polling
  useEffect(() => {
    if (!loaded) return;

    const poll = async () => {
      try {
        const currentAgents = agentsRef.current;
        if (currentAgents.length === 0) return;
        // Batch heartbeat check for all agents
        const agentResults = await Promise.all(
          currentAgents.map(a =>
            fetch(`/api/agents/${a.name}/heartbeat`)
              .then(r => r.json())
              .then(d => ({ name: a.name, active: d.active || false, status: d.status || 'idle', detail: d.detail || '' }))
              .catch(() => ({ name: a.name, active: false, status: 'idle', detail: '' }))
          )
        );
        const map: AgentActivity = {};
        agentResults.forEach(r => { map[r.name] = { active: r.active, status: r.status, detail: r.detail }; });
        setActivity(map);
      } catch (e) { logger.error('Heartbeat poll failed', e); }
    };

    // Initial poll
    poll();

    // Single interval — 15s (was 4 separate intervals: 5s + 10s + 15s)
    const t = setInterval(() => {
      refresh();
      poll();
    }, 15_000);

    return () => clearInterval(t);
  }, [loaded, refresh]);

  // Single WebSocket — unified hook
  const wsUrl = typeof window !== 'undefined' ? `ws://${window.location.hostname}:3001` : null;
  useWebSocket(wsUrl, (data) => {
    if (data.type === 'sidebar_refresh') refresh();
    if (data.type === 'wf_step_status') {
      window.dispatchEvent(new CustomEvent('wf_step_status', { detail: data }));
    }
    if (data.type === 'wf_approval') {
      window.dispatchEvent(new CustomEvent('wf_approval', { detail: data }));
    }
  });

  return (
    <SidebarContext.Provider value={{ agents, groups, activity, loading, refresh, collapsed, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  );
}

/**
 * Hook to consume sidebar data from the nearest {@link SidebarProvider}.
 * Returns agents, groups, activity status, loading flag, and controls.
 */
export function useSidebarData() { return useContext(SidebarContext); }
