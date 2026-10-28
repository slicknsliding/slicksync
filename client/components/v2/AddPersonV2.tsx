'use client';

// The v2 look of Add a person (CreateUserModal draws these when Page design
// is v2): two steps you can see - which app they watch on, as four tiles with
// a letter mark each, then how they sign in, as whole tiles to tap with the
// easiest first. The sign-in flows themselves are the modal's own.

import type { ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

export type AddPersonApp = 'stremio' | 'nuvio' | 'jellyfin' | 'aiostreams';

export const ADD_PERSON_APPS: { id: AddPersonApp; name: string; line: string; letter: string; gradient: string }[] = [
  { id: 'stremio', name: 'Stremio', line: 'The Stremio app', letter: 'S', gradient: 'linear-gradient(135deg,#8b5cf6,#6d28d9)' },
  { id: 'nuvio', name: 'Nuvio', line: 'The Nuvio app', letter: 'N', gradient: 'linear-gradient(135deg,#6366f1,#a855f7)' },
  { id: 'jellyfin', name: 'Jellyfin', line: 'Their own Jellyfin account', letter: 'J', gradient: 'linear-gradient(135deg,#aa5cc3,#00a4dc)' },
  { id: 'aiostreams', name: 'AIOStreams', line: 'Or AIOMetadata, as a server', letter: 'A', gradient: 'linear-gradient(135deg,#2dd4bf,#0e7490)' },
];

export function appName(id: AddPersonApp) {
  return ADD_PERSON_APPS.find((a) => a.id === id)?.name || 'their app';
}

/** The title and the two steps, the current one lit. */
export function AddPersonHead({ step2 }: { step2: boolean }) {
  const step = (n: number, label: string, on: boolean) => (
    <span className="inline-flex items-center gap-2 text-[13px]" style={{ color: on ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
      <span
        className="inline-flex items-center justify-center rounded-full text-[11.5px] font-bold"
        style={{ width: 20, height: 20, background: on ? 'var(--color-primary)' : 'var(--color-surface-hover)', color: on ? '#fff' : undefined }}
      >{n}</span>
      {label}
    </span>
  );
  return (
    <div className="mb-4 pr-8">
      <h2 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>Add a person</h2>
      <div className="flex items-center gap-3.5 mt-2.5">
        {step(1, 'Their app', !step2)}
        <span className="text-muted">→</span>
        {step(2, 'How they sign in', step2)}
      </div>
    </div>
  );
}

/** Step 1: four tiles with a letter mark each. */
export function AppTiles({ value, onPick }: { value: AddPersonApp; onPick: (a: AddPersonApp) => void }) {
  return (
    <div role="radiogroup" aria-label="Which app do they watch on?">
      <p className="text-[13px] text-muted mb-2">Which app do they watch on?</p>
      <div className="grid grid-cols-2 gap-2">
        {ADD_PERSON_APPS.map((a) => {
          const on = a.id === value;
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(a.id)}
              className="v2-tool flex items-center gap-2.5 text-left"
              style={{ padding: '10px 12px', outline: on ? '2px solid var(--color-primary)' : undefined, outlineOffset: on ? 1 : undefined, cursor: 'pointer' }}
            >
              <span
                className="shrink-0 flex items-center justify-center rounded-[10px] text-white font-extrabold text-[15px]"
                style={{ width: 34, height: 34, background: a.gradient }}
                aria-hidden="true"
              >{a.letter}</span>
              <span className="flex-1 min-w-0">
                <b className="block text-sm truncate">{a.name}</b>
                <span className="hidden sm:block text-xs text-muted truncate">{a.line}</span>
              </span>
              {on && <CheckIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The step 2 question. */
export function SignInQuestion({ app }: { app: AddPersonApp }) {
  return <p className="text-[13px] text-muted mt-5 mb-1">How do they sign in to {appName(app)}?</p>;
}

/** One way to sign in: the whole tile is the button. */
export function MethodTile({ icon, title, line, easiest, selected, onClick }: {
  icon: ReactNode;
  title: string;
  line: string;
  easiest?: boolean;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className="v2-tool w-full flex items-center gap-3 text-left mt-2"
      style={{
        padding: '13px 14px',
        cursor: 'pointer',
        borderColor: easiest || selected ? 'color-mix(in srgb, var(--color-primary) 55%, transparent)' : undefined,
        outline: selected ? '2px solid var(--color-primary)' : undefined,
        outlineOffset: selected ? 1 : undefined,
      }}
    >
      <span
        className="shrink-0 flex items-center justify-center rounded-[11px]"
        style={{
          width: 36, height: 36,
          background: easiest ? 'color-mix(in srgb, var(--color-primary) 22%, transparent)' : 'var(--color-surface-hover)',
          color: easiest ? 'var(--color-primary)' : 'var(--color-text-muted)',
        }}
        aria-hidden="true"
      >{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 flex-wrap">
          <b className="text-[14.5px]">{title}</b>
          {easiest && (
            <span className="text-[11.5px] font-semibold px-2 py-0.5 rounded-full" style={{ color: 'var(--color-success, #22c55e)', background: 'color-mix(in srgb, var(--color-success, #22c55e) 14%, transparent)' }}>Easiest</span>
          )}
        </span>
        <span className="block text-[12.5px] text-muted mt-0.5">{line}</span>
      </span>
      <ChevronRightIcon className="w-4 h-4 shrink-0 text-muted" />
    </button>
  );
}
