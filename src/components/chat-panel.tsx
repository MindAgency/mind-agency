'use client';

import React, { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import { useRouter } from 'next/navigation';
import Markdown from '@/components/markdown';
import { ChevronDown, ChevronRight, Brain, Wrench, FileText, ArrowUp, Mail, Cpu } from 'lucide-react';
import { useToast } from '@/components/toast';
import { useChatPanel, type Msg } from '@/hooks/use-chat-panel';
import { COMMANDS } from './chat-commands';

interface AgentInfo { name: string; emailCount: number; }

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
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // ── Hook: all messaging state ──
  const {
    msgs, busy, models, model, activeGroup, myGroups, thinkingMode,
    setModel: setModelPersist, setActiveGroup, setThinkingMode,
    sendMessage, abort, clearMessages, patchLastMsg, needsFreshRef,
  } = useChatPanel(agentName);

  // ── Local UI state ──
  const [input, setInput] = useState('');
  const [showCmds, setShowCmds] = useState(false);
  const [cmdFilter, setCmdFilter] = useState('');
  const [cmdIdx, setCmdIdx] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [emailCount, setEmailCount] = useState(0);
  const [toastMsg, setToastMsg] = useState('');
  const [showModels, setShowModels] = useState(false);
  const [sendReady, setSendReady] = useState(true);

  const historyRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const inputValueRef = useRef('');
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const filteredCmds = COMMANDS.filter(c => c.cmd.startsWith(cmdFilter));

  // ── Data loading ──
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

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => setAgents(d.agents || [])).catch(() => {});
    fetch(`/api/emails?agent=${agentName}`).then(r => r.json())
      .then(d => { if (Array.isArray(d)) setEmailCount(d.length); }).catch(() => {});
  }, [agentName]);

  useEffect(() => {
    const t = setInterval(checkEmails, 10000);
    return () => clearInterval(t);
  }, [checkEmails]);

  // ── Auto-scroll ──
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

  // ── Imperative handle ──
  useImperativeHandle(ref, () => ({
    scrollToMessage: (index: number) => {
      const el = historyRefs.current.get(index);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.style.transition = 'background 0.3s';
        el.style.background = 'var(--surface-alt)';
        setTimeout(() => { el.style.background = ''; }, 1200);
      }
    },
    getMessages: () => msgs,
    clearMessages,
  }), [msgs, clearMessages]);

  // ── WebSocket ──
  const wsUrl = typeof window !== 'undefined' ? `ws://${window.location.hostname}:3001` : null;
  useWebSocket(wsUrl, (data) => {
    if (data.type === 'group_message' && data.from && data.message) {
      toastRef.current(`[${data.group}] ${data.from}: ${data.message.slice(0, 80)}`);
    } else if (data.type === 'new_email' && data.from && data.subject) {
      toastRef.current(`New email from ${data.from}: ${data.subject}`);
    }
  }, { reconnectDelay: 3000 });

  // ── Command selection ──
  const selectCmd = (cmd: string) => {
    const v = cmd + ' ';
    setInput(v); inputValueRef.current = v;
    setShowCmds(false); inputRef.current?.focus();
  };

  // ── Send with slash command interception ──
  const send = async () => {
    const t = (inputValueRef.current || input).trim();
    if (!t || busy) return;
    setInput(''); inputValueRef.current = ''; setShowCmds(false);

    // Intercept slash commands
    const m = t.match(/^(\/\w+)/);
    if (m) {
      const cmd = COMMANDS.find(c => c.cmd === m[1]);
      if (cmd?.handler) {
        if (cmd.cmd === '/clear') {
          await fetch(`/api/agents/${agentName}/chat`, { method: 'DELETE' });
          clearMessages();
          needsFreshRef.current = true;
          return;
        }
        const result = await cmd.handler(agentName);
        patchLastMsg(() => ({ role: 'user', content: t, events: [], timestamp: new Date().toISOString() }));
        patchLastMsg(() => ({ role: 'system', content: result, events: [], timestamp: new Date().toISOString() }));
        return;
      }
    }

    // Delegate to hook's sendMessage (handles SSE streaming)
    await sendMessage(t);
  };

  return (
    <div className="flex flex-col h-full bg-canvas">
      {toastMsg && (
        <div className="fixed top-4 right-4 z-50 bg-canvas border border-border rounded-xl px-4 py-3 shadow-lg animate-in flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center"><Mail size={14} className="text-muted" /></div>
          <div><p className="text-[11px] text-muted-foreground">New email</p><p className="text-[13px] text-foreground font-medium">{toastMsg}</p></div>
        </div>
      )}

      <div className="flex items-center justify-between px-6 py-2 shrink-0 select-none">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-surface-alt flex items-center justify-center text-[10px] font-medium text-muted">{agentName[0]}</span>
          <span className="text-[13px] font-medium text-foreground">{agentName}</span>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-[820px] mx-auto px-6 py-6 space-y-5">
        {msgs.length === 0 && (
          <div className="flex items-center justify-center h-[60vh] text-center">
            <div>
              <p className="text-[15px] text-muted-foreground font-medium">Mind Agency</p>
              <p className="text-[13px] text-muted-foreground mt-1">开始和 {agentName} 对话</p>
              <p className="text-[12px] text-muted-foreground mt-2">输入 <code className="text-muted-foreground">/help</code> 查看命令</p>
            </div>
          </div>
        )}
        {msgs.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <div key={i} ref={(el) => { if (el) historyRefs.current.set(i, el); }}
                className="flex justify-end" id={`msg-${i}`}>
                <div className="max-w-[75%] bg-surface-alt rounded-2xl rounded-br-sm px-4 py-2.5">
                  <p className="text-[14px] text-foreground leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
                </div>
              </div>
            );
          }
          if (msg.role === 'system') {
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] bg-surface border border-border rounded-xl px-4 py-3 text-[13px] text-muted leading-relaxed font-mono">
                  <Markdown text={msg.content} />
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="space-y-2">
              {(() => {
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
                className={`w-full text-left px-4 py-2.5 transition-colors flex items-start gap-3 ${i === cmdIdx ? 'bg-surface' : 'hover:bg-surface/50'}`}>
                <span className="text-[13px] font-medium text-foreground font-mono whitespace-nowrap">{item.cmd}</span>
                <span className="text-[12px] text-muted-foreground leading-snug">{item.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="max-w-[820px] mx-auto">
          <div className="flex items-center gap-1.5 mb-1.5 px-1 relative">
            <button onClick={() => setShowModels(!showModels)}
              className="text-[11px] px-2 py-0.5 rounded-md flex items-center gap-1 text-muted-foreground hover:text-muted transition-colors border border-border">
              <Cpu size={11} /> {models.length === 0 ? '无模型' : (models.find(m => m.id === model)?.label || model)} <ChevronDown size={10} />
            </button>
            {showModels && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowModels(false)} />
                <div className="absolute bottom-full left-0 mb-1 bg-canvas border border-border rounded-xl shadow-xl z-20 py-1 min-w-[160px]">
                  {models.map(m => (
                    <button key={m.id} onClick={() => { setModelPersist(m.id); setShowModels(false); }}
                      className={`w-full text-left px-3 py-2 text-[12px] transition-colors ${model === m.id ? 'bg-surface-alt text-foreground font-medium' : 'text-muted hover:bg-surface-hover'}`}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="w-px h-3 bg-border mx-1" />
            <button onClick={() => setThinkingMode(!thinkingMode)}
              className={`text-[11px] px-2 py-0.5 rounded-md transition-colors flex items-center gap-1 ${thinkingMode ? 'bg-primary-muted text-primary font-medium' : 'text-muted-foreground hover:text-muted'}`}>
              <Brain size={12} /> 深度思考
            </button>
          </div>
          <div className="flex items-end gap-2 bg-canvas border border-border rounded-2xl px-4 py-3 shadow-sm focus-within:border-border-strong focus-within:shadow-md transition-all">
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
              className="flex-1 bg-transparent border-0 outline-none text-[14px] text-foreground placeholder:text-muted-foreground resize-none"
              autoFocus />
            {busy ? (
              <button onClick={abort}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-destructive text-canvas hover:bg-destructive transition-all shrink-0"
                title="停止">
                <span className="w-3 h-3 bg-white rounded-sm" />
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim() || !sendReady}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-foreground text-canvas hover:opacity-90 disabled:opacity-20 transition-all shrink-0">
                <ArrowUp size={14} />
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

const MdText = React.memo(function MdText({ text }: { text: string }) {
  const isLong = text.length > 500;
  return (
    <div className={`text-[14px] text-muted leading-relaxed ${isLong ? 'max-h-[300px] overflow-y-auto' : ''}`}>
      <Markdown text={text} />
    </div>
  );
});
const Think = React.memo(function Think({ text }: { text: string }) {
  const [on, setOn] = useState(false);
  if (!text) return null;
  return (
    <div className="text-[12px]">
      <button onClick={() => setOn(!on)} className="flex items-center gap-1.5 text-muted-foreground hover:text-muted transition-colors text-left">
        {on ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<Brain size={11} className="text-primary" /> Thinking
      </button>
      {on && <div className="mt-1 ml-6 pl-3 border-l-2 border-primary/30 text-muted-foreground leading-relaxed whitespace-pre-wrap">{text}</div>}
    </div>
  );
});
const Tool = React.memo(function Tool({ name, input }: { name: string; input: string }) {
  const [on, setOn] = useState(false);
  const short = name.replace(/^mcp__group-chat__/, '');
  let parsed: any = null;
  try { parsed = JSON.parse(input); } catch (e) { console.error('[components:chat-panel]', e); }
  const isFileOp = parsed && ['Write', 'Edit', 'Delete', 'Read'].includes(parsed.tool_name || short);
  const filePath = parsed?.file_path || parsed?.path || '';
  const isWrite = short === 'Write' || parsed?.tool_name === 'Write';
  const isEdit = short === 'Edit' || parsed?.tool_name === 'Edit';
  const isDelete = short === 'Delete' || parsed?.tool_name === 'Delete';

  return (
    <div className="text-[12px]">
      <button onClick={() => setOn(!on)} className="flex items-center gap-1.5 text-muted-foreground hover:text-muted transition-colors text-left">
        {on ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {isFileOp ? (
          <FileText size={11} className={isWrite ? 'text-success' : isEdit ? 'text-info' : 'text-destructive'} />
        ) : (
          <Wrench size={11} className="text-info" />
        )}
        {isFileOp ? (
          <span className="flex items-center gap-1">
            <span className={`text-[10px] px-1 py-0.5 rounded ${isWrite ? 'bg-success-muted text-success' : isEdit ? 'bg-info-muted text-info' : 'bg-destructive-muted text-destructive'}`}>
              {short}
            </span>
            <span className="text-muted-foreground truncate max-w-[180px]">{filePath}</span>
          </span>
        ) : short}
      </button>
      {on && (
        <div className="mt-1 ml-6 pl-3 border-l-2 border-info/30 max-h-[300px] overflow-y-auto">
          {isFileOp && filePath && (
            <div className="text-[11px] text-muted-foreground mb-1 font-mono">{filePath}</div>
          )}
          {isEdit && parsed?.old_string && parsed?.new_string ? (
            <div className="text-[11px] font-mono">
              <div className="text-destructive/70 bg-destructive/5 rounded px-2 py-1 mb-0.5 whitespace-pre-wrap">{parsed.old_string}</div>
              <div className="text-success/70 bg-success/5 rounded px-2 py-1 whitespace-pre-wrap">{parsed.new_string}</div>
            </div>
          ) : isWrite && parsed?.content ? (
            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap">{parsed.content.slice(0, 2000)}{parsed.content.length > 2000 ? '\n...(truncated)' : ''}</pre>
          ) : isDelete ? (
            <div className="text-[11px] text-destructive">删除文件: {filePath}</div>
          ) : (
            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap">{input}</pre>
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
    <div className="text-[12px]">
      <button onClick={() => setOn(!on)} className="flex items-center gap-1.5 text-muted-foreground hover:text-muted transition-colors text-left">
        {on ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<FileText size={11} className="text-success" /> Result
      </button>
      {on && <pre className="mt-1 ml-6 pl-3 border-l-2 border-success/30 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-[200px] overflow-y-auto">{output}</pre>}
    </div>
  );
});
const Err = React.memo(function Err({ text }: { text: string }) { return <div className="text-[13px] text-destructive">{text}</div>; });
