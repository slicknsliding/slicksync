'use client';

// The way into AIOSync from a person's page (inside the Watch
// History section): their sign-in logos and a plain title. Shown for anyone
// with a sign-in - with a single one they copy to or from someone else's.

import { useEffect, useState } from 'react';
import { TVLink } from '@/components/tv/TVLink';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { api, type WatchCopySide } from '@/lib/api';

const LOOK: Record<string, { letter: string; bg: string }> = {
  stremio: { letter: 'S', bg: 'linear-gradient(135deg,#8a5cf6,#5b3fd6)' },
  nuvio: { letter: 'N', bg: 'linear-gradient(135deg,#38599e,#ff9800)' },
  jellyfin: { letter: 'J', bg: 'linear-gradient(135deg,#aa5cc3,#00a4dc)' },
  aiostreams: { letter: 'A', bg: 'linear-gradient(135deg,#9f92ff,#5b4fd6)' },
  aiometadata: { letter: 'A', bg: 'linear-gradient(135deg,#14b8a6,#0e7490)' },
};

export function CopyHistoryTile({ userId, name }: { userId: string; name: string }) {
  const [sides, setSides] = useState<WatchCopySide[] | null>(null);
  const [inStep, setInStep] = useState(false);
  useEffect(() => {
    api.getWatchCopySides(userId).then((r) => setSides(r.sides)).catch(() => setSides([]));
    api.getKeepInStep(userId).then((k) => setInStep(k.enabled)).catch(() => {});
  }, [userId]);
  if (!sides) return null;
  if (!sides.length) return null;
  const places = sides.reduce((n, s) => n + Math.max(1, s.profiles.length), 0);
  const what = places < 2
    ? `Copy to or from someone else’s sign-in · ${name}’s ${sides[0].name}`
    : `Copy once or keep in step · ${name}’s ${sides.length > 1 ? `${sides.length} sign-ins` : `${places} profiles`}`;
  // One sign-in with several profiles: their pictures (colour + initial when none).
  const profilePics = (size: number) => (
    <span className="flex gap-1 shrink-0">
      {sides[0].profiles.slice(0, 6).map((p) => (p.avatar
        // eslint-disable-next-line @next/next/no-img-element
        ? <img key={p.side} src={p.avatar} alt="" className="rounded-full object-cover" style={{ width: size, height: size, background: p.color || undefined }} />
        : <span key={p.side} className="rounded-full flex items-center justify-center text-white font-bold" style={{ width: size, height: size, fontSize: size * 0.45, background: p.color || LOOK[sides[0].kind]?.bg }}>{(p.name || '?').slice(0, 1).toUpperCase()}</span>))}
    </span>
  )
  const logos = (size: number) => sides.length === 1 && sides[0].profiles.length ? profilePics(size) : (
    <span className="flex gap-1 shrink-0">
      {sides.map((s) => (
        <span key={s.provider} className="flex items-center justify-center text-white font-bold" style={{ width: size, height: size, borderRadius: size * 0.3, background: LOOK[s.kind]?.bg, fontSize: size * 0.42 }}>
          {LOOK[s.kind]?.letter}
        </span>
      ))}
    </span>
  );
  const chip = <span className="text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: 'color-mix(in srgb, var(--color-success) 18%, transparent)', color: 'var(--color-success)' }}>Keep in step: on</span>;
  return (
    <TVLink
      href={`/users/${encodeURIComponent(userId)}/copy-history`}
      className="mt-3.5 w-full flex items-center gap-3.5 p-3.5 rounded-2xl border transition-colors hover:border-primary"
      style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 45%, var(--color-surface-border))', background: 'color-mix(in srgb, var(--color-primary) 7%, var(--color-surface))' }}
    >
      <span className="hidden sm:flex">{logos(30)}</span>
      <span className="flex-1 min-w-0">
        <span className="block font-semibold text-default whitespace-nowrap">AIOSync</span>
        <span className="block text-sm text-muted">{what}</span>
        <span className="flex sm:hidden items-center gap-2 mt-2">{logos(22)}{inStep && chip}</span>
      </span>
      {inStep && <span className="hidden sm:inline">{chip}</span>}
      <ChevronRightIcon className="w-[18px] h-[18px] text-muted shrink-0" />
    </TVLink>
  );
}
