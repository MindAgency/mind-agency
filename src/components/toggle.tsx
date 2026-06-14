'use client';

export function Toggle({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-2 p-2 rounded-lg hover:bg-canvas/50 cursor-pointer transition-colors">
      <div className="relative shrink-0">
        <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
        <div className={`w-8 h-4.5 rounded-full transition-colors ${checked ? 'bg-foreground' : 'bg-border'}`}>
          <div className={`w-3.5 h-3.5 rounded-full bg-canvas shadow-sm transition-transform mt-0.5 ml-0.5 ${checked ? 'translate-x-[13px]' : ''}`} />
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-foreground">{label}</p>
        <p className="text-[10px] text-muted-foreground">{desc}</p>
      </div>
    </label>
  );
}
