'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * useChatPanel — extracted state management for ChatPanel.
 * Follows frontend-ui-engineering skill: separate data from presentation.
 */

export interface ChatEvent { type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'done' | 'error'; content?: string; toolName?: string; toolInput?: string; toolOutput?: string; timestamp: string; }
export interface Msg { role: 'user' | 'assistant' | 'system'; content: string; events: ChatEvent[]; timestamp: string; }

export function useChatPanel(agentName: string) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [model, setModel] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem(`chat-model-${agentName}`) || '';
  });
  const [activeGroup, setActiveGroup] = useState('');
  const [myGroups, setMyGroups] = useState<string[]>([]);
  const [thinkingMode, setThinkingMode] = useState(false);

  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const needsFreshRef = useRef(false);
  const STORAGE_KEY = `chat-msgs-${agentName}`;
  const MAX_STORED_MSGS = 200;

  // Save to localStorage (debounced)
  const saveRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (msgs.length === 0) return;
    if (saveRef.current) clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => {
      try {
        const trimmed = msgs.length > MAX_STORED_MSGS ? msgs.slice(-MAX_STORED_MSGS) : msgs;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      } catch { /* quota exceeded */ }
    }, 500);
    return () => { if (saveRef.current) clearTimeout(saveRef.current); };
  }, [msgs, STORAGE_KEY]);

  // Load history from localStorage + server backfill
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) setMsgs(parsed);
      }
    } catch { /* ignore */ }

    // Server backfill
    const load = () => {
      fetch(`/api/agents/${agentName}/chat`)
        .then(r => r.json()).then(d => {
          if (!d.messages || busyRef.current) return;
          let localCount = 0;
          try { const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); if (Array.isArray(p)) localCount = p.length; } catch { /* ignore */ }
          if (d.messages.length > localCount) {
            setMsgs(d.messages);
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d.messages)); } catch { /* ignore */ }
          }
        }).catch(() => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [agentName, STORAGE_KEY]);

  // Load models and groups
  useEffect(() => {
    fetch('/api/system/models').then(r => r.json()).then(d => {
      if (d.models && d.models.length > 0) setModels(d.models);
      else setModels([]);
    }).catch(() => {});
    fetch('/api/groups/scan?agent=' + agentName).then(r => r.json())
      .then(d => setMyGroups(d.groups || [])).catch(() => {});
  }, [agentName]);

  const setModelPersist = useCallback((m: string) => {
    setModel(m);
    localStorage.setItem(`chat-model-${agentName}`, m);
  }, [agentName]);

  const patchLastMsg = useCallback((mutate: (msg: Msg) => Msg) => {
    setMsgs(prev => {
      const next = [...prev];
      if (next.length === 0) return next;
      next[next.length - 1] = mutate(next[next.length - 1]);
      return next;
    });
  }, []);

  const clearMessages = useCallback(() => {
    setMsgs([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, [STORAGE_KEY]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || busyRef.current) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); busyRef.current = true;
    setMsgs(p => [...p, { role: 'user', content: text, events: [], timestamp: new Date().toISOString() }]);
    setMsgs(p => [...p, { role: 'assistant', content: '', events: [], timestamp: new Date().toISOString() }]);

    try {
      const body: any = { message: text, model };
      if (needsFreshRef.current) { body.fresh = true; needsFreshRef.current = false; }
      if (activeGroup) body.group = activeGroup;
      if (thinkingMode) body.thinking = true;
      const r = await fetch(`/api/agents/${agentName}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '', done = false, aborted = false;
      while (!done) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const p = line.slice(6);
            if (p === '[DONE]') { done = true; continue; }
            try {
              const evt: ChatEvent = JSON.parse(p);
              if (evt.type === 'error' && evt.content?.includes('abort')) { aborted = true; done = true; break; }
              patchLastMsg(msg => ({
                ...msg,
                events: [...msg.events, evt],
                content: evt.type === 'text' ? msg.content + (evt.content || '') : msg.content,
              }));
            } catch { /* ignore malformed */ }
          }
        }
      }
      if (aborted) patchLastMsg(msg => ({ ...msg, content: msg.content + '\n\n_[已中断]_' }));
    } catch (e: any) {
      if (e.name === 'AbortError') {
        patchLastMsg(msg => ({ ...msg, content: msg.content + '\n\n_[已中断]_' }));
      } else {
        patchLastMsg(msg => ({
          ...msg,
          events: [...msg.events, { type: 'error', content: String(e), timestamp: new Date().toISOString() }],
        }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false); busyRef.current = false;
    }
  }, [model, activeGroup, thinkingMode, agentName, patchLastMsg]);

  const abort = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
  }, []);

  return {
    msgs, busy, models, model, activeGroup, myGroups, thinkingMode,
    setModel: setModelPersist, setActiveGroup, setThinkingMode,
    sendMessage, abort, clearMessages, patchLastMsg,
    needsFreshRef,
  };
}
