'use client';

// "Age limit": the highest rating someone may play (server/utils/ageLimits.js),
// as a card with its own switch under Daily limit and Bedtime in the Limits
// popup (LimitsButton). On a real Jellyfin server it is the server's own age
// limit, from the server's own rating list, so every Jellyfin app keeps to it
// (it needs an administrator's sign-in there). On Stremio, Nuvio, a Nuvio
// profile and AIOMetadata, SlickSync keeps it and its stream gate has nothing
// to play for a title rated above it. Where it can't be set - AIOStreams, a
// Nuvio profile on the main profile's addons - the card says why.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import { toast } from '@/components/ui/Toast';
import { MiniSwitch, chipClass } from '@/components/user/ScreenTimePanel';
import { api, type AgeLimitView } from '@/lib/api';

/** "PG, TV-PG" for the level set, or null for none. */
export function ageLimitLabel(state: AgeLimitView | null): string | null {
  if (state?.current == null) return null;
  return state.levels?.find((l) => l.value === state.current)?.label?.split(' · ')[0] || null;
}

export function AgeLimitCard({ userId, name, onChange, onClose }: {
  userId: string;
  name: string;
  onChange?: (state: AgeLimitView) => void;
  onClose?: () => void;
}) {
  const [state, setState] = useState<AgeLimitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The level switched off last, so switching back on restores it.
  const lastLevel = useRef<number | null>(null);

  useEffect(() => {
    api.getAgeLimit(userId).then(setState).catch((e: any) => setError(e?.message || 'Could not read the age limit'));
  }, [userId]);
  useEffect(() => {
    if (!state) return;
    if (state.current != null) lastLevel.current = state.current;
    onChange?.(state);
  }, [state]);

  const save = async (value: number | null, blockUnrated?: boolean) => {
    setSaving(true);
    try {
      setState(await api.setAgeLimit(userId, value, blockUnrated));
    } catch (e: any) {
      toast.error(e?.message || 'Could not set the age limit');
    } finally {
      setSaving(false);
    }
  };

  const levels = state?.levels || [];
  const on = state?.current != null;
  const label = ageLimitLabel(state);
  // Switched on: the last level, or PG - the middle of the list - the first time.
  const startLevel = () => lastLevel.current ?? levels.find((l) => l.value >= 10)?.value ?? levels[0]?.value ?? null;
  const settable = !!state?.available && !state.needsAdmin;
  const streams = state?.source === 'streams';

  return (
    <div className="rounded-xl border border-default p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <ShieldCheckIcon className={`w-4 h-4 mt-0.5 shrink-0 ${on ? 'text-primary' : 'text-subtle'}`} />
          <div className="min-w-0">
            <p className="text-xs font-medium text-default">Age limit</p>
            <p className="text-xs text-muted leading-snug">
              {on && label ? `Nothing rated above ${label}` : 'The highest rating they may play'}
            </p>
          </div>
        </div>
        <MiniSwitch
          checked={on}
          onChange={(next) => save(next ? startLevel() : null)}
          label={on ? 'Turn the age limit off' : 'Turn the age limit on'}
          disabled={!state || !settable || saving}
        />
      </div>

      {error && <p className="text-xs text-error">{error}</p>}
      {state && !state.available && (
        <p className="text-xs text-muted leading-snug">{state.reason || 'An age limit can’t be set here.'}</p>
      )}
      {state?.needsAdmin && (
        <p className="text-xs text-muted leading-snug">Jellyfin lets only administrators set this - add someone here who signs in to that server as one.</p>
      )}

      {on && settable && (
        <>
          <div>
            <p className="text-xs text-muted mb-1">Highest rating</p>
            <div className="flex flex-wrap gap-1.5">
              {levels.map((l) => (
                <button key={l.value} type="button" disabled={saving} onClick={() => save(l.value)} aria-pressed={state?.current === l.value} className={chipClass(state?.current === l.value)}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-start gap-2 text-xs text-default">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!!state?.blockUnrated}
              disabled={saving}
              onChange={(e) => save(state?.current ?? null, e.target.checked)}
            />
            <span>{streams ? 'Also block films and shows with no rating' : 'Hide films and shows with no rating'}</span>
          </label>
          {streams && state?.needsKey && (
            <p className="text-xs text-warning leading-snug">
              Ratings come from OMDb, and there’s no OMDb key yet - until one is added, every title counts as unrated.{' '}
              <Link href="/settings?highlight=OMDb%20API%20key" onClick={onClose} className="underline">Add a key</Link>
            </p>
          )}
          {streams && state?.needsAddress && (
            <p className="text-xs text-warning leading-snug">
              It takes hold once this instance’s public address can be reached without a login.{' '}
              <Link href="/settings?highlight=Public%20address%20of%20this%20instance" onClick={onClose} className="underline">Settings</Link>
            </p>
          )}
          {streams && !state?.needsAddress && (
            <p className="text-xs text-muted leading-snug">{name}’s app needs reopening once, the first time a limit is set for them. Catalogs stay; only playing is stopped.</p>
          )}
        </>
      )}
    </div>
  );
}
