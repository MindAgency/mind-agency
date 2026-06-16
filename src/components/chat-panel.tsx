'use client';

import React, { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useRouter } from 'next/navigation';
import Markdown from '@/components/markdown';
import { ChevronDown, ChevronRight, Brain, Wrench, FileText, ArrowUp, Mail, Users as UsersIcon, Cpu } from 'lucide-react';
import { useToast } from '@/components/toast';

interface ChatEvent { type: 'thinking' | 'tool_use' | 'tool_result' | 'text' | 'done' | 'error'; content?: string; toolName?: string; toolInput?: string; toolOutput?: string; timestamp: string; }
interface Msg { role: 'user' | 'assistant' | 'system'; content: string; events: ChatEvent[]; timestamp: string; }
interface AgentInfo { name: string; emailCount: number; }

// Mind Agency slash commands — only commands relevant to this platform.
// LOCAL commands are handled in-browser (no AI involved).
// The rest are passed through to the AI as messages.
import { COMMANDS, getHelpText, getStatusText, getContextText, CommandPalette } from './chat-commands';

async function skillsCmd(_agentName: string) {
  const parts: string[] = ['## /skills\n'];
  try {
    const r = await fetch('/api/system/skills');
    const d = await r.json();
    const skills = d.skills || [];
    if (skills.length === 0) {
      parts.push('No skills installed.');
      parts.push('\nInstall skills from Settings → Skills tab.');
    } else {
      parts.push(`**Installed:** ${skills.length}\n`);
      for (const s of skills) {
        parts.push(`- **${s.name}** (${s.repo})`);
        if (s.description) parts.push(`  ${s.description.slice(0, 80)}`);
      }
    }
  } catch { parts.push('(unable to fetch)'); }
  return parts.join('\n');
}





export interface ChatPanelHandle {
  scrollToMessage: (index: number) => void;
  getMessages: () => Msg[];
  clearMessages: () => void;
}

const ChatPanel = forwardRef<ChatPanelHandle, { agentName: string }>(function ChatPanel({ agentName }, ref) {
  const router = useRouter();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCmds, setShowCmds] = useState(false);
  const [cmdFilter, setCmdFilter] = useState('');
  const [cmdIdx, setCmdIdx] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [emailCount, setEmailCount] = useState(0);
  const [toastMsg, setToastMsg] = useState('');
  const [activeGroup, setActiveGroup] = useState('');
  const [myGroups, setMyGroups] = useState<string[]>([]);
  const [thinkingMode, setThinkingMode] = useState(false);
  const historyRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const msgContainerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const busyRef = useRef(false);
  const inputValueRef = useRef(''); // always has latest value, no stale closure
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const needsFreshRef = useRef(false);
  const [sendReady, setSendReady] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast; // keep ref current without re-triggering WS reconnect

  // ── localStorage persistence ──
  const STORAGE_KEY = `chat-msgs-${agentName}`;
  const MAX_STORED_MSGS = 200; // sliding window: keep last 200 to stay under 5MB quota

  // Save to localStorage whenever msgs change (debounced)
  const saveRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (msgs.length === 0) return;
    if (saveRef.current) clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => {
      try {
        const trimmed = msgs.length > MAX_STORED_MSGS ? msgs.slice(-MAX_STORED_MSGS) : msgs;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      } catch { /* quota exceeded — ignore */ }
    }, 500);
    return () => { if (saveRef.current) clearTimeout(saveRef.current); };
  }, [msgs]);

  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [model, setModel] = useState<string>(() => {
    if (typeof window === 'undefined') return 'deepseek-v4-pro';
    return localStorage.getItem(`chat-model-${agentName}`) || 'deepseek-v4-pro';
  });
  const setModelPersist = (m: string) => { setModel(m); localStorage.setItem(`chat-model-${agentName}`, m); setShowModels(false); };
  const [showModels, setShowModels] = useState(false);

  const filteredCmds = COMMANDS.filter(c => c.cmd.startsWith(cmdFilter));

  const checkEmails = useCallback(async () => {
    try {
      const r = await fetch(`/api/emails?agent=${agentName}`);
      const emails = await r.json();
      if (Array.isArray(emails) && emails.length > emailCount && emailCount > 0) {
        setToastMsg(`${emails[0].from}: ${emails[0].subject}`);
        setTimeout(() => setToastMsg(''), 4000);
      }
      setEmailCount(Array.isArray(emails) ? emails.length : 0);
    } catch (e) { console.error('[components:chat-panel]', e); }
  }, [agentName, emailCount]);

  const loadGroups = useCallback(async () => {
    try {
      const r = await fetch('/api/groups/scan?agent=' + agentName);
      setMyGroups((await r.json()).groups || []);
    } catch (e) { console.error('[components:chat-panel]', e); }
  }, [agentName]);

  // Load history on mount: localStorage first, API as fallback/backfill
  useEffect(() => {
    // Load from localStorage immediately (offline-first)
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMsgs(parsed);
        }
      }
    } catch (e) { console.error('[components:chat-panel]', e); }

    // Backfill from server (may have newer messages)
    const load = () => {
      fetch(`/api/agents/${agentName}/chat`)
        .then(r => r.json()).then(d => {
          if (!d.messages || busyRef.current) return;
          // Only replace if server has more messages than local
          let localCount = 0;
          try { const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); if (Array.isArray(p)) localCount = p.length; } catch (e) { console.error('[components:chat-panel]', e); }
          if (d.messages.length > localCount) {
            setMsgs(d.messages);
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d.messages)); } catch (e) { console.error('[components:chat-panel]', e); }
          }
        }).catch(() => {});
    };
    load();

    fetch('/api/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
    // v0.4: Fetch available models from configured API
    fetch('/api/system/models').then(r => r.json()).then(d => {
      if (d.models && d.models.length > 0) setModels(d.models);
      else setModels([]); // No provider configured → no models
    }).catch(() => {});
    fetch(`/api/emails?agent=${agentName}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setEmailCount(d.length); }).catch(() => {});
    loadGroups();

    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [agentName]);

  useEffect(() => {
    const t = setInterval(checkEmails, 10000);
    return () => clearInterval(t);
  }, [checkEmails]);

  // Auto-scroll: lock when user scrolls away from bottom
  const scrollLockedRef = useRef(false);
  useEffect(() => {
    const el = endRef.current?.parentElement;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      scrollLockedRef.current = !nearBottom;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!scrollLockedRef.current) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  // Expose imperative methods for session sidebar navigation
  useImperativeHandle(ref, () => ({
    scrollToMessage: (index: number) => {
      const el = historyRefs.current.get(index);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Highlight briefly
        el.style.transition = 'background 0.3s';
        el.style.background = 'var(--surface-alt)';
        setTimeout(() => { el.style.background = ''; }, 1200);
      }
    },
    getMessages: () => msgs,
    clearMessages: () => {
      setMsgs([]);
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { console.error('[components:chat-panel]', e); }
    },
  }), [msgs]);

  // ── WebSocket via unified hook ──
  const wsUrl = typeof window !== 'undefined' ? `ws://${window.location.hostname}:3001` : null;
  useWebSocket(wsUrl, (data) => {
    if (data.type === 'group_message' && data.from && data.message) {
      toastRef.current(`[${data.group}] ${data.from}: ${data.message.slice(0, 80)}`);
    } else if (data.type === 'new_email' && data.from && data.subject) {
      toastRef.current(`New email from ${data.from}: ${data.subject}`);
    }
  }, { reconnectDelay: 3000 });

  const selectCmd = (cmd: string) => { const v = cmd + ' '; setInput(v); inputValueRef.current = v; setShowCmds(false); inputRef.current?.focus(); };

  // Helper: update the last message in the array immutably
  const patchLastMsg = useCallback((mutate: (msg: Msg) => Msg) => {
    setMsgs(prev => {
      const next = [...prev];
      next[next.length - 1] = mutate(next[next.length - 1]);
      return next;
    });
  }, []);

  const send = async () => {
    const t = (inputValueRef.current || input).trim(); // ref has latest, state as fallback
    if (!t || busy) return;
    setInput(''); inputValueRef.current = ''; setShowCmds(false);

    // ── Intercept slash commands ──
    const m = t.match(/^(\/\w+)/);
    if (m) {
      const cmd = COMMANDS.find(c => c.cmd === m[1]);
      // Commands with handlers run locally in browser
      if (cmd?.handler) {
        if (cmd.cmd === '/clear') {
          await fetch(`/api/agents/${agentName}/chat`, { method: 'DELETE' });
          setMsgs([]);
          needsFreshRef.current = true;
          return;
        }
        const result = await cmd.handler(agentName);
        setMsgs(p => [...p,
          { role: 'user', content: t, events: [], timestamp: new Date().toISOString() },
          { role: 'system', content: result, events: [], timestamp: new Date().toISOString() },
        ]);
        return;
      }
      // Commands without handlers: pass through to AI
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); busyRef.current = true;
    setMsgs(p => [...p, { role: 'user', content: t, events: [], timestamp: new Date().toISOString() }]);
    setMsgs(p => [...p, { role: 'assistant', content: '', events: [], timestamp: new Date().toISOString() }]);
    try {
      const body: any = { message: t, model };
      if (needsFreshRef.current) { body.fresh = true; needsFreshRef.current = false; }
      if (thinkingMode) body.thinking = true;
      if (activeGroup) body.group = activeGroup;
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
              if (evt.type === 'error' && evt.content?.includes('abort')) {
                aborted = true; done = true; break;
              }
              patchLastMsg(msg => ({
                ...msg,
                events: [...msg.events, evt],
                content: evt.type === 'text' ? msg.content + (evt.content || '') : msg.content,
              }));
            } catch (e) { console.error('[components:chat-panel]', e); }
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
      setBusy(false); busyRef.current = false; inputRef.current?.focus();
    }
  };

  return (
    <div className="flex flex-col h-full bg-canvas">
      {toastMsg && (
        <div className="fixed top-4 right-4 z-50 bg-canvas border border-border rounded-xl px-5 py-4 shadow-lg animate-in flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center"><Mail size={18} className="text-muted" /></div>
          <div><p className="text-xs text-muted-foreground">New email</p><p className="text-sm text-foreground font-medium">{toastMsg}</p></div>
        </div>
      )}

      <div className="flex items-center justify-between px-6 py-3 shrink-0 select-none">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-full bg-surface-alt flex items-center justify-center text-sm font-medium text-muted">{agentName[0]}</span>
          <span className="text-base font-medium text-foreground">{agentName}</span>
        </div>
      </div>

      <div className="flex-1 flex min-h-0" id="tour-chat-panel">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Scrollable messages container */}

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-[820px] mx-auto px-6 py-6 space-y-5">
        {msgs.length === 0 && (
          <div className="flex items-center justify-center h-[60vh] text-center">
            <div>
              <p className="text-lg text-muted-foreground font-medium">Mind Agency</p>
              <p className="text-base text-muted-foreground mt-2">开始和 {agentName} 对话</p>
              <p className="text-sm text-muted-foreground mt-3">输入 <code className="text-muted-foreground">/help</code> 查看命令</p>
            </div>
          </div>
        )}
        {msgs.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <div key={i} ref={(el) => { if (el) historyRefs.current.set(i, el); }}
                className="flex justify-end" id={`msg-${i}`}>
                <div className="max-w-[75%] bg-surface-alt rounded-3xl rounded-br-md px-5 py-3">
                  <p className="text-base text-foreground leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
                </div>
              </div>
            );
          }
          if (msg.role === 'system') {
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] bg-surface border border-border rounded-2xl px-5 py-4 text-sm text-muted leading-relaxed font-mono">
                  <Markdown text={msg.content} />
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="space-y-2">
              {(() => {
                // Merge consecutive thinking events into one
                const merged: { type: string; content?: string; key: number; [k: string]: any }[] = [];
                let thinkBuf = '';
                let thinkStart = -1;
                for (let j = 0; j < msg.events.length; j++) {
                  const evt = msg.events[j];
                  if (evt.type === 'thinking') {
                    if (thinkStart === -1) thinkStart = j;
                    thinkBuf += evt.content || '';
                  } else {
                    if (thinkBuf) { merged.push({ type: 'thinking', content: thinkBuf, key: thinkStart }); thinkBuf = ''; thinkStart = -1; }
                    merged.push({ type: evt.type, content: evt.content, toolName: evt.toolName, toolInput: evt.toolInput, toolOutput: evt.toolOutput, key: j });
                  }
                }
                if (thinkBuf) merged.push({ type: 'thinking', content: thinkBuf, key: thinkStart });
                return merged.map(evt => {
                  if (evt.type === 'thinking') return <Think key={evt.key} text={evt.content || ''} />;
                  if (evt.type === 'tool_use') return <Tool key={evt.key} name={evt.toolName || ''} input={evt.toolInput || ''} />;
                  if (evt.type === 'tool_result') return <Result key={evt.key} output={evt.toolOutput || ''} />;
                  if (evt.type === 'text') return <MdText key={evt.key} text={evt.content || ''} />;
                  if (evt.type === 'error') return <Err key={evt.key} text={evt.content || ''} />;
                  return null;
                });
              })()}
              {!msg.events.some(e => e.type === 'text') && msg.content && <MdText text={msg.content} />}
            </div>
          );
        })}
        {busy && (
          <div className="flex items-center gap-1.5 pl-1">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
        <div ref={endRef} />
        </div>
      </div>

      <div className="px-6 py-3 shrink-0 border-t border-border relative">
        {showCmds && filteredCmds.length > 0 && (
          <div className="absolute bottom-[calc(100%+4px)] left-0 right-0 bg-canvas border border-border rounded-2xl shadow-xl max-h-[280px] overflow-y-auto z-20 py-1 mb-1">
            {filteredCmds.map((item, i) => (
              <button key={item.cmd} onClick={() => selectCmd(item.cmd)}
                className={`w-full text-left px-5 py-3 transition-colors flex items-start gap-4 ${i === cmdIdx ? 'bg-surface' : 'hover:bg-surface/50'}`}>
                <span className="text-sm font-medium text-foreground font-mono whitespace-nowrap">{item.cmd}</span>
                <span className="text-sm text-muted-foreground leading-snug">{item.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="max-w-[820px] mx-auto">
          <div className="flex items-center gap-1.5 mb-1.5 px-1 relative" id="tour-model-selector">
            {/* Model selector dropdown */}
            <button onClick={() => setShowModels(!showModels)}
              className="text-sm px-3 py-1 rounded-lg flex items-center gap-1.5 text-muted-foreground hover:text-muted transition-colors border border-border">
              <Cpu size={14} /> {models.length === 0 ? '无模型' : (models.find(m => m.id === model)?.label || model)} <ChevronDown size={14} />
            </button>
            {showModels && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowModels(false)} />
                <div className="absolute bottom-full left-0 mb-1 bg-canvas border border-border rounded-xl shadow-xl z-20 py-2 min-w-[200px]">
                  {models.map(m => (
                    <button key={m.id} onClick={() => setModelPersist(m.id)}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${model === m.id ? 'bg-surface-alt text-foreground font-medium' : 'text-muted hover:bg-surface-hover'}`}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="w-px h-4 bg-border mx-2" />
            <button onClick={() => setThinkingMode(!thinkingMode)}
              className={`text-sm px-3 py-1 rounded-lg transition-colors flex items-center gap-1.5 ${thinkingMode ? 'bg-primary-muted text-primary font-medium' : 'text-muted-foreground hover:text-muted'}`}>
              <Brain size={14} /> 深度思考
            </button>
          </div>
          <div className="flex items-center gap-2 bg-canvas border border-border rounded-2xl px-4 py-3 shadow-sm focus-within:border-border-strong focus-within:shadow-md transition-all">
            <textarea ref={inputRef as any} value={input}
              onChange={e => {
                const v = e.target.value; setInput(v); inputValueRef.current = v;
                if (debounceRef.current) clearTimeout(debounceRef.current);
                setSendReady(false);
                debounceRef.current = setTimeout(() => setSendReady(true), 300);
                if (v.startsWith('/') && !/\s/.test(v.slice(0, 30))) { setCmdFilter(v); setShowCmds(true); setCmdIdx(0); }
                else if (v.startsWith('/')) { setCmdFilter(v); setShowCmds(true); }
                else setShowCmds(false);
                const ta = e.target;
                ta.style.height = 'auto';
                ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
              }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={`给 ${agentName} 发消息...`}
              rows={1}
              className="flex-1 bg-transparent border-0 outline-none text-base text-foreground placeholder:text-muted-foreground resize-none"
              autoFocus />
            {busy ? (
              <button onClick={() => abortRef.current?.abort()}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-destructive text-canvas hover:bg-destructive transition-all shrink-0"
                title="停止">
                <span className="w-4 h-4 bg-white rounded-sm" />
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim() || !sendReady}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-foreground text-canvas hover:opacity-90 disabled:opacity-20 transition-all shrink-0">
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
        </div>
      </div>
    </div>
  );
});

export default ChatPanel;

// taste: React.memo prevents re-render on every SSE chunk
const MdText = React.memo(function MdText({ text }: { text: string }) {
  const isLong = text.length > 500;
  return (
    <div className={`text-base text-muted leading-relaxed ${isLong ? 'max-h-[400px] overflow-y-auto' : ''}`}>
      <Markdown text={text} />
    </div>
  );
});
const Think = React.memo(function Think({ text }: { text: string }) {
  const [on, setOn] = useState(false);
  if (!text) return null;
  return (
    <div className="text-sm">
      <button onClick={() => setOn(!on)} className="flex items-center gap-1.5 text-muted-foreground hover:text-muted transition-colors text-left font-medium">
        {on ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Brain size={14} className="text-primary" /> Thinking
      </button>
      {on && <div className="mt-2 ml-7 pl-4 border-l-2 border-primary/30 text-muted-foreground leading-relaxed whitespace-pre-wrap">{text}</div>}
    </div>
  );
});
const Tool = React.memo(function Tool({ name, input }: { name: string; input: string }) {
  const [on, setOn] = useState(false);
  const short = name.replace(/^mcp__group-chat__/, '');

  // v0.4: Parse file operations for diff display
  let parsed: any = null;
  try { parsed = JSON.parse(input); } catch (e) { console.error('[components:chat-panel]', e); }
  const isFileOp = parsed && ['Write', 'Edit', 'Delete', 'Read'].includes(parsed.tool_name || short);
  const filePath = parsed?.file_path || parsed?.path || '';
  const isWrite = short === 'Write' || parsed?.tool_name === 'Write';
  const isEdit = short === 'Edit' || parsed?.tool_name === 'Edit';
  const isDelete = short === 'Delete' || parsed?.tool_name === 'Delete';

  return (
    <div className="text-sm">
      <button onClick={() => setOn(!on)} className="flex items-center gap-1.5 text-muted-foreground hover:text-muted transition-colors text-left font-medium">
        {on ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {isFileOp ? (
          <FileText size={14} className={isWrite ? 'text-success' : isEdit ? 'text-info' : 'text-destructive'} />
        ) : (
          <Wrench size={14} className="text-info" />
        )}
        {isFileOp ? (
          <span className="flex items-center gap-2">
            <span className={`text-xs px-1.5 py-0.5 rounded-md ${isWrite ? 'bg-success-muted text-success' : isEdit ? 'bg-info-muted text-info' : 'bg-destructive-muted text-destructive'}`}>
              {short}
            </span>
            <span className="text-muted-foreground truncate max-w-[220px]">{filePath}</span>
          </span>
        ) : short}
      </button>
      {on && (
        <div className="mt-2 ml-7 pl-4 border-l-2 border-info/30 max-h-[400px] overflow-y-auto">
          {isFileOp && filePath && (
            <div className="text-xs text-muted-foreground mb-1 font-mono">{filePath}</div>
          )}
          {isEdit && parsed?.old_string && parsed?.new_string ? (
            <div className="text-xs font-mono">
              <div className="text-destructive/70 bg-destructive/5 rounded-md px-3 py-2 mb-1 whitespace-pre-wrap">{parsed.old_string}</div>
              <div className="text-success/70 bg-success/5 rounded-md px-3 py-2 whitespace-pre-wrap">{parsed.new_string}</div>
            </div>
          ) : isWrite && parsed?.content ? (
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{parsed.content.slice(0, 2000)}{parsed.content.length > 2000 ? '\n...(truncated)' : ''}</pre>
          ) : isDelete ? (
            <div className="text-xs text-destructive">删除文件: {filePath}</div>
          ) : (
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{input}</pre>
          )}
        </div>
      )}
    </div>
  );
});
const Result = React.memo(function Result({ output }: { output: string }) {
  const [on, setOn] = useState(false);
  if (!output) return null;
  return (
    <div className="text-sm">
      <button onClick={() => setOn(!on)} className="flex items-center gap-1.5 text-muted-foreground hover:text-muted transition-colors text-left font-medium">
        {on ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FileText size={14} className="text-success" /> Result
      </button>
      {on && <pre className="mt-2 ml-7 pl-4 border-l-2 border-success/30 text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto">{output}</pre>}
    </div>
  );
});
const Err = React.memo(function Err({ text }: { text: string }) { return <div className="text-base text-destructive">{text}</div>; });
