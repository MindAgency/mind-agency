'use client';

import { useEffect, useState } from 'react';
import { BookOpen, Loader2, PenLine, Upload } from 'lucide-react';

interface SkillDraft {
  id: string;
  agent: string;
  name: string;
  description: string;
  status: string;
  source: string;
  createdAt: number;
}

export default function SkillDraftsPanel({ lang }: { lang: string }) {
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [agent, setAgent] = useState('me');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const d = await fetch('/api/system/skill-drafts').then(r => r.json()).catch(() => ({ drafts: [] }));
    setDrafts(d.drafts || []);
  };

  useEffect(() => { load(); }, []);

  const analyze = async () => {
    setBusy(true);
    await fetch('/api/system/skill-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'analyze', agent, name: name || undefined }),
    }).catch(() => {});
    setBusy(false);
    setName('');
    await load();
  };

  const publish = async (id: string, enableForAgent?: string) => {
    setBusy(true);
    await fetch('/api/system/skill-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', id, enableForAgent }),
    }).catch(() => {});
    setBusy(false);
    await load();
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[13px] font-semibold text-foreground">{lang === 'zh' ? 'Skill 草稿' : 'Skill Drafts'}</h3>
        <p className="text-[11px] text-muted-foreground">
          {lang === 'zh' ? '让 Agent 在任务结束后提炼经验为 SKILL.md 草稿，再由用户发布和启用。' : 'Turn completed work into SKILL.md drafts, then publish and enable them deliberately.'}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-canvas p-4 space-y-3">
        <h4 className="text-[12px] font-medium text-foreground flex items-center gap-1.5"><PenLine size={13} /> {lang === 'zh' ? '从最近会话生成' : 'Generate From Recent Session'}</h4>
        <div className="grid grid-cols-2 gap-2">
          <input value={agent} onChange={e => setAgent(e.target.value)} placeholder="agent" className="px-3 py-2 rounded-lg border border-border bg-surface text-[12px] outline-none focus:border-border-strong" />
          <input value={name} onChange={e => setName(e.target.value)} placeholder="skill-name" className="px-3 py-2 rounded-lg border border-border bg-surface text-[12px] outline-none focus:border-border-strong" />
        </div>
        <button onClick={analyze} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-foreground text-canvas text-[12px] font-medium disabled:opacity-50">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <BookOpen size={13} />}
          {lang === 'zh' ? '生成草稿' : 'Create Draft'}
        </button>
      </div>

      <div className="space-y-2">
        {drafts.map(d => (
          <div key={d.id} className="rounded-lg border border-border bg-canvas px-3 py-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-surface-alt flex items-center justify-center text-muted-foreground">
              <BookOpen size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-foreground">{d.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-alt text-muted">{d.status}</span>
                <span className="text-[10px] text-muted-foreground">{d.agent}</span>
              </div>
              <p className="text-[11px] text-muted-foreground truncate">{d.description}</p>
            </div>
            <button onClick={() => publish(d.id, d.agent)} disabled={busy || d.status === 'published'} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-alt text-[11px] text-foreground hover:bg-surface-hover disabled:opacity-40">
              <Upload size={12} /> {lang === 'zh' ? '发布并启用' : 'Publish'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
