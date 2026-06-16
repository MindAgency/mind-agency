'use client';
import { useState, useEffect } from 'react';
import Sidebar from '@/components/sidebar';
import { Settings, Palette, Server, Cpu, Save, Loader2, ChevronRight, Zap, Puzzle, Wrench, BookOpen } from 'lucide-react';
import { useT } from '@/components/i18n';
import { useTheme, THEMES, type ThemeId } from '@/lib/theme';
import ProviderProfiles from '@/components/settings/ProviderProfiles';
import SkillsPanel from '@/components/settings/SkillsPanel';
import ToolsPanel from '@/components/settings/ToolsPanel';
import SkillDraftsPanel from '@/components/settings/SkillDraftsPanel';

type Tab = 'appearance' | 'providers' | 'skills' | 'skill-drafts' | 'tools' | 'system' | 'agent';

const TABS: { id: Tab; icon: React.ReactNode; labelZh: string; labelEn: string }[] = [
  { id: 'appearance', icon: <Palette size={15}/>, labelZh: '外观', labelEn: 'Appearance' },
  { id: 'providers',  icon: <Zap size={15}/>,    labelZh: '供应商', labelEn: 'Providers' },
  { id: 'skills',     icon: <Puzzle size={15}/>, labelZh: 'Skills', labelEn: 'Skills' },
  { id: 'system',    icon: <Server size={15}/>,   labelZh: '系统', labelEn: 'System' },
  { id: 'agent',     icon: <Cpu size={15}/>,      labelZh: 'Agent', labelEn: 'Agent' },
];
TABS.splice(3, 0,
  { id: 'skill-drafts', icon: <BookOpen size={15}/>, labelZh: 'Skill Drafts', labelEn: 'Skill Drafts' },
  { id: 'tools', icon: <Wrench size={15}/>, labelZh: 'Tools', labelEn: 'Tools' },
);

export default function SettingsPage() {
  const { lang, t, setLang } = useT();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<Tab>('appearance');
  const [data, setData] = useState<any>({});
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [port, setPort] = useState('');
  const [wsPort, setWsPort] = useState('');
  const [heartbeatMin, setHeartbeatMin] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [apiModels, setApiModels] = useState<Array<{ id: string; label: string }>>([]);

  useEffect(() => {
    fetch('/api/system/settings').then(r=>r.json()).then(d => {
      setData(d);
      setApiKey((d.apiKey && !d.apiKey.startsWith('••••')) ? d.apiKey : (d.apiKey || ''));
      setBaseUrl(d.baseUrl || '');
      setModel(d.model || '');
      setPort(d.port ? String(d.port) : '');
      setWsPort(d.wsPort ? String(d.wsPort) : '');
      setHeartbeatMin(d.heartbeatIntervalMs ? String(Math.round(d.heartbeatIntervalMs / 60000 * 10) / 10) : '2');
    }).catch(()=>{});
    // v0.4: Fetch available models from API
    fetch('/api/system/models').then(r => r.json()).then(d => {
      if (d.models && d.models.length > 0) setApiModels(d.models);
    }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      const body: any = {};
      if (apiKey && !apiKey.startsWith('••••') && apiKey !== data.apiKey) body.apiKey = apiKey;
      else if (!apiKey && data.apiKey) body.apiKey = '';
      if (baseUrl !== data.baseUrl) body.baseUrl = baseUrl || '';
      if (model !== data.model) body.model = model || '';
      if (port && port !== String(data.port || '')) body.port = parseInt(port);
      if (wsPort && wsPort !== String(data.wsPort || '')) body.wsPort = parseInt(wsPort);
      if (heartbeatMin) body.heartbeatIntervalMs = Math.round(parseFloat(heartbeatMin) * 60000);
      const r = await fetch('/api/system/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.success) { setMsg(t('saved_ok')); setData(d.settings); } else setMsg('❌ ' + (d.error || t('save_failed')));
    } catch { setMsg('❌ ' + t('network_error')); }
    setSaving(false);
  };

  return (
    <div className="flex h-full bg-canvas"><Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-10">
          {/* Header */}
          <h1 className="text-[18px] font-semibold text-foreground mb-1 flex items-center gap-2">
            <Settings size={18} className="text-muted-foreground"/> {t('settings')}
          </h1>
          <p className="text-[12px] text-muted-foreground mb-8">
            {lang==='zh'?'配置 API、外观和系统参数。':'Configure API, appearance & system.'}
          </p>

          <div className="flex gap-8">
            {/* ── Left: Tab list ── */}
            <nav className="w-48 shrink-0">
              <div className="space-y-0.5">
                {TABS.map(tb => (
                  <button key={tb.id} onClick={() => setTab(tb.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors text-left
                      ${tab === tb.id
                        ? 'bg-surface text-foreground font-medium shadow-sm'
                        : 'text-muted-foreground hover:bg-surface-alt hover:text-foreground'}`}>
                    <span className={tab === tb.id ? 'text-foreground' : 'text-muted-foreground'}>{tb.icon}</span>
                    {lang==='zh' ? tb.labelZh : tb.labelEn}
                    {tab === tb.id && <ChevronRight size={12} className="ml-auto text-muted-foreground"/>}
                  </button>
                ))}
              </div>
            </nav>

            {/* ── Right: Content ── */}
            <div className="flex-1 min-w-0">
              <div className="bg-surface rounded-xl border border-border p-6">
                {tab === 'appearance' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-[13px] font-semibold text-foreground mb-1">{lang==='zh'?'主题':'Theme'}</h3>
                      <p className="text-[11px] text-muted-foreground mb-3">{lang==='zh'?'选择界面风格':'Choose interface style'}</p>
                      <div className="grid grid-cols-4 gap-2">
                        {THEMES.map(th => {
                          const active = theme === th.id;
                          const gradients: Record<string, string> = {
                            'notion': 'linear-gradient(135deg, #ffffff 40%, #f7f6f3 100%)',
                            'minimal-white': 'linear-gradient(135deg, #ffffff 40%, #e9ecef 100%)',
                            'warm-wood': 'linear-gradient(135deg, #faf8f5 40%, #e5dbd0 100%)',
                            'solarized-light': 'linear-gradient(135deg, #fdf6e3 40%, #eee8d5 100%)',
                            'deep-space': 'linear-gradient(135deg, #0d0d12 40%, #32323f 100%)',
                            'nord': 'linear-gradient(135deg, #2e3440 40%, #4c566a 100%)',
                            'tokyo-night': 'linear-gradient(135deg, #1a1b26 40%, #2f3347 100%)',
                            'dracula': 'linear-gradient(135deg, #282a36 40%, #44475a 100%)',
                          };
                          return (
                            <button key={th.id} onClick={() => setTheme(th.id as ThemeId)}
                              className={`relative flex flex-col items-center gap-1.5 p-2.5 rounded-xl border transition-all
                                ${active ? 'border-foreground/20 bg-canvas shadow-sm ring-1 ring-foreground/10' : 'border-border hover:border-border-strong'}`}>
                              <div className="w-full h-8 rounded-lg overflow-hidden" style={{ background: gradients[th.id] || gradients['minimal-white'] }} />
                              <span className={`text-[11px] ${active ? 'text-foreground font-medium' : 'text-muted'}`}>{th.labelZh}</span>
                              {active && <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-foreground rounded-full flex items-center justify-center"><span className="text-[8px] text-canvas font-bold">✓</span></span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-[13px] font-semibold text-foreground mb-1">{t('language')}</h3>
                      <p className="text-[11px] text-muted-foreground mb-3">{lang==='zh'?'界面语言':'Interface language'}</p>
                      <div className="flex gap-2">
                        {[['zh','中文'],['en','English']].map(([k,l]) => (
                          <button key={k} onClick={() => { setLang(k as 'zh' | 'en'); localStorage.setItem('mind-lang',k); }}
                            className={`px-4 py-2 rounded-lg text-[12px] font-medium transition-colors ${lang===k?'bg-foreground text-canvas shadow-sm':'bg-canvas text-muted border border-border hover:border-border-strong'}`}>{l}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {tab === 'providers' && (
                  <ProviderProfiles lang={lang} />
                )}

                {tab === 'skills' && (
                  <SkillsPanel lang={lang} />
                )}

                {tab === 'skill-drafts' && (
                  <SkillDraftsPanel lang={lang} />
                )}

                {tab === 'tools' && (
                  <ToolsPanel lang={lang} />
                )}

                {tab === 'system' && (
                  <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[13px] font-semibold text-foreground">{t('port')}</label>
                        <p className="text-[11px] text-muted-foreground mb-2">Next.js 服务端口</p>
                        <input value={port} onChange={e => setPort(e.target.value)} placeholder="3000"
                          className="w-full px-3 py-2.5 bg-canvas border border-border rounded-lg text-[12px] outline-none focus:border-foreground/30 focus:ring-1 focus:ring-foreground/10" />
                      </div>
                      <div>
                        <label className="text-[13px] font-semibold text-foreground">{t('ws_port')}</label>
                        <p className="text-[11px] text-muted-foreground mb-2">WebSocket 服务端口</p>
                        <input value={wsPort} onChange={e => setWsPort(e.target.value)} placeholder="3001"
                          className="w-full px-3 py-2.5 bg-canvas border border-border rounded-lg text-[12px] outline-none focus:border-foreground/30 focus:ring-1 focus:ring-foreground/10" />
                      </div>
                    </div>
                  </div>
                )}

                {tab === 'agent' && (
                  <div className="space-y-5">
                    <div>
                      <label className="text-[13px] font-semibold text-foreground">Heartbeat 间隔</label>
                      <p className="text-[11px] text-muted-foreground mb-2">
                        {lang==='zh'?'全局默认心跳间隔，各 Agent 可单独覆盖。0 关闭。':'Global heartbeat interval. Per-agent override available. 0=off.'}
                      </p>
                      <div className="flex items-center gap-2">
                        <input value={heartbeatMin} onChange={e => setHeartbeatMin(e.target.value)} placeholder="2"
                          className="w-24 px-3 py-2.5 bg-canvas border border-border rounded-lg text-[12px] outline-none focus:border-foreground/30 focus:ring-1 focus:ring-foreground/10" />
                        <span className="text-[11px] text-muted-foreground">{lang==='zh'?'分钟':'min'}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Save button */}
              <div className="flex items-center gap-3 mt-4">
                <button onClick={save} disabled={saving}
                  className="flex items-center gap-1.5 px-5 py-2.5 text-[12px] font-medium bg-foreground text-canvas rounded-lg hover:opacity-90 disabled:opacity-50 shadow-sm transition-all">
                  {saving ? <Loader2 size={12} className="animate-spin"/> : <Save size={12}/>} {t('save_config')}
                </button>
                {msg && <span className={`text-[12px] ${msg.startsWith('✅') ? 'text-success' : 'text-destructive'}`}>{msg}</span>}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
