'use client';

// Keep in step (server/utils/watchCopy/keepInStep.js), at the bottom of Sync
// watch history: one switch per person, and for each of their sign-ins and
// profiles whether it sends and receives, only receives, or is left out -
// chosen from a small popup anchored to that row. "Recently moved" lists what
// it carried across.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, CheckIcon } from '@heroicons/react/24/outline';
import { ToggleSwitch } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api, type KeepInStep, type KeepInStepMode } from '@/lib/api';

const MODE_LABEL: Record<KeepInStepMode, string> = {
  both: '⇄ Sends and receives',
  receive: '← Only receives',
  off: 'Left out',
};

const LOOK: Record<string, string> = {
  stremio: 'linear-gradient(135deg,#8a5cf6,#5b3fd6)',
  nuvio: 'linear-gradient(135deg,#38599e,#ff9800)',
  jellyfin: 'linear-gradient(135deg,#aa5cc3,#00a4dc)',
  aiostreams: 'linear-gradient(135deg,#9f92ff,#5b4fd6)',
  aiometadata: 'linear-gradient(135deg,#14b8a6,#0e7490)',
};

function ago(at: string) {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// The menu is about this tall; with less room than that under the button -
// the last rows of the card, which clips what spills over - it opens upward.
const MENU_HEIGHT = 150;

function ModePicker({ mode, onPick }: { mode: KeepInStepMode; onPick: (m: KeepInStepMode) => void }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toggle = () => {
    if (!open && ref.current) {
      const below = ref.current.getBoundingClientRect().bottom;
      let limit = window.innerHeight;
      for (let el = ref.current.parentElement; el; el = el.parentElement) {
        const o = getComputedStyle(el);
        if (/(hidden|clip|auto|scroll)/.test(o.overflowY)) { limit = Math.min(limit, el.getBoundingClientRect().bottom); break; }
      }
      setUp(limit - below < MENU_HEIGHT);
    }
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0 ml-auto">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-default text-xs whitespace-nowrap ${mode === 'off' ? 'text-muted' : 'text-default'}`}
      >
        {MODE_LABEL[mode]}
        <ChevronDownIcon className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className={`absolute z-30 right-0 w-56 rounded-xl border border-default p-1.5 shadow-2xl ${up ? 'bottom-full mb-2' : 'top-full mt-2'}`} style={{ background: 'var(--color-surface)' }}>
          {(['both', 'receive', 'off'] as KeepInStepMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setOpen(false); onPick(m); }}
              className="w-full flex items-center justify-between gap-2 text-left text-sm px-3 py-2 rounded-lg hover:bg-surface-hover text-default"
            >
              {MODE_LABEL[m]}
              {m === mode && <CheckIcon className="w-4 h-4 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function KeepInStepCard({ userId }: { userId: string }) {
  const [data, setData] = useState<KeepInStep | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.getKeepInStep(userId).then(setData).catch(() => setData(null));
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const save = async (patch: { enabled?: boolean; members?: { side: string; mode: KeepInStepMode }[] }) => {
    setSaving(true);
    try {
      setData(await api.saveKeepInStep(userId, patch));
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not change Keep in step');
    } finally {
      setSaving(false);
    }
  };

  if (!data || data.places.length < 2) return null;
  const setMode = (side: string, mode: KeepInStepMode) =>
    save({ members: data.places.map((p) => ({ side: p.side, mode: p.side === side ? mode : p.mode })) });

  return (
    <div className="rounded-2xl relative overflow-hidden" style={{ background: 'color-mix(in srgb, var(--color-surface) 55%, transparent)', backdropFilter: 'blur(18px)', border: '1px solid var(--color-surface-border)' }}>
      <div aria-hidden="true" className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }} />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-default">Keep in step</div>
            <div className="text-sm text-muted mt-0.5">From now on, whatever they finish or stop part-way on one sign-in shows up on the others within a few minutes.</div>
          </div>
          <div className="shrink-0 pt-0.5">
            <ToggleSwitch checked={data.enabled} disabled={saving} onChange={() => save({ enabled: !data.enabled })} title={data.enabled ? 'Turn Keep in step off' : 'Turn Keep in step on'} />
          </div>
        </div>

        <div className="mt-3">
          {data.places.map((p) => (
            <div key={p.side} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 py-2 border-t border-default">
              <span className="w-[26px] h-[26px] rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0" style={{ background: LOOK[p.kind] || LOOK.jellyfin }}>
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              <span className={`flex-1 min-w-[8rem] text-sm ${p.mode === 'off' ? 'text-muted' : 'text-default'}`}>{p.name}{p.profile && p.profile !== p.name ? ` · ${p.profile}` : ''}</span>
              <ModePicker mode={p.mode} onPick={(m) => setMode(p.side, m)} />
            </div>
          ))}
        </div>

        {data.enabled && (
          <div className="mt-3 px-3 py-2.5 rounded-xl bg-surface-hover">
            <div className="text-xs text-subtle mb-1">Recently moved</div>
            {data.moves.length === 0 && <div className="text-xs text-muted py-1">Nothing yet - it checks every few minutes.</div>}
            {data.moves.slice(0, 8).map((m, i) => (
              <div key={`${m.at}-${i}`} className="text-xs py-1">
                <div className="flex gap-2"><span className="text-subtle w-12 shrink-0">{ago(m.at)}</span><span className="text-default min-w-0">{m.title} — {m.what}</span></div>
                <div className="text-muted pl-14">{m.from} → {m.to.join(', ')}</div>
              </div>
            ))}
          </div>
        )}
        {data.enabled && data.lastError && <div className="mt-2 text-xs" style={{ color: '#f5a524' }}>Last check: {data.lastError}</div>}
        <div className="text-xs text-subtle mt-2.5">Never moves anything backwards: a title further along on one side stays as it is.</div>
      </div>
    </div>
  );
}
