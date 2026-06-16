'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';

interface ManagedTool {
  name: string;
  description: string;
  type: string;
  enabled: boolean;
  risk: string;
  endpoint?: string;
}

export default function ToolsPanel({ lang }: { lang: string }) {
  const [tools, setTools] = useState<ManagedTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [description, setDescription] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const d = await fetch('/api/system/tools').then(r => r.json());
      setTools(d.tools || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const saveTool = async (tool: Partial<ManagedTool> & { name: string }) => {
    await fetch('/api/system/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tool),
    });
    await load();
  };

  const addHttpTool = async () => {
    if (!name.trim() || !endpoint.trim()) return;
    await saveTool({
      name: name.trim(),
      description: description || name.trim(),
      type: 'http',
      endpoint: endpoint.trim(),
      enabled: false,
      risk: 'medium',
    });
    setName('');
    setEndpoint('');
    setDescription('');
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[13px] font-semibold text-foreground">Tools</h3>
          <p className="text-[11px] text-muted-foreground">
            {lang === 'zh' ? '管理 Agent 可调用的工具。网页搜索默认关闭，启用后 Agent 可按需检索并返回引用。' : 'Manage tools available to agents. Web search is opt-in and returns citations.'}
          </p>
        </div>
        <button onClick={load} className="p-1.5 rounded-lg hover:bg-surface-alt text-muted-foreground">
          <RefreshCw size={13} />
        </button>
      </div>

      {loading ? (
        <div className="py-8 flex justify-center"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-2">
          {tools.map(t => (
            <div key={t.name} className="flex items-center gap-3 rounded-lg border border-border bg-canvas px-3 py-3">
              <div className="w-8 h-8 rounded-lg bg-surface-alt flex items-center justify-center text-muted-foreground">
                <Search size={14} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground">{t.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.enabled ? 'bg-success-muted text-success' : 'bg-surface-alt text-muted'}`}>
                    {t.enabled ? 'enabled' : 'disabled'}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-muted text-warning">{t.risk}</span>
                </div>
                <p className="text-[11px] text-muted-foreground truncate">{t.description}</p>
                {t.endpoint && <p className="text-[10px] text-muted-foreground/60 font-mono truncate">{t.endpoint}</p>}
              </div>
              <button
                onClick={() => saveTool({ ...t, enabled: !t.enabled })}
                className="px-2.5 py-1.5 rounded-lg bg-surface-alt text-[11px] text-foreground hover:bg-surface-hover"
              >
                {t.enabled ? 'Disable' : 'Enable'}
              </button>
              {t.type !== 'builtin' && (
                <button
                  onClick={async () => { await fetch(`/api/system/tools?name=${encodeURIComponent(t.name)}`, { method: 'DELETE' }); await load(); }}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive-muted"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border bg-canvas p-4 space-y-3">
        <h4 className="text-[12px] font-medium text-foreground">{lang === 'zh' ? '添加 HTTP Tool' : 'Add HTTP Tool'}</h4>
        <div className="grid grid-cols-2 gap-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="tool_name" className="px-3 py-2 rounded-lg border border-border bg-surface text-[12px] outline-none focus:border-border-strong" />
          <input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://..." className="px-3 py-2 rounded-lg border border-border bg-surface text-[12px] outline-none focus:border-border-strong" />
        </div>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder={lang === 'zh' ? '描述' : 'Description'} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-[12px] outline-none focus:border-border-strong" />
        <button onClick={addHttpTool} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-foreground text-canvas text-[12px] font-medium">
          <Plus size={13} /> {lang === 'zh' ? '添加' : 'Add'}
        </button>
      </div>
    </div>
  );
}
