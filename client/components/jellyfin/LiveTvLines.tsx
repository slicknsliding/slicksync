'use client';

import { useEffect, useState } from 'react';
import { api, type LiveTvSource } from '@/lib/api';

function ago(iso: string | null, now: number): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The Live TV sources in a person's AIOStreams setup (playlists and IPTV
 * logins) and how each stands. SlickSync checks them by itself (the server's
 * utils/liveTvWatch.js); this only shows what it found. Names only - never an
 * address or a login. Draws nothing when the setup has none.
 */
export function LiveTvLines({ userId, active }: { userId: string; active: boolean }) {
  const [sources, setSources] = useState<LiveTvSource[] | null>(null);
  // The moment they were read: "2h ago" and "runs out soon" are measured from it.
  const [readAt, setReadAt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api.getLiveTv(userId).then((r) => { if (!cancelled) { setReadAt(Date.now()); setSources(r.sources); } }).catch(() => { if (!cancelled) setSources([]); });
    return () => { cancelled = true; };
  }, [active, userId]);
  if (!sources || sources.length === 0) return null;
  return (
    <div className="space-y-1.5" data-setting="Live TV">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-default">Live TV</p>
        <p className="text-[11px] text-muted">Checked by itself</p>
      </div>
      {sources.map((s) => {
        const soon = s.working && s.expiresAt ? Date.parse(s.expiresAt) - readAt < 7 * 24 * 60 * 60 * 1000 : false;
        const tone = !s.working ? 'var(--color-error)' : soon ? 'var(--color-warning)' : 'var(--color-success)';
        const state = !s.working
          ? `Not working${s.since ? ` since ${new Date(s.since).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}`
          : s.expiresAt ? `Runs out ${day(s.expiresAt)}` : `Checked ${ago(s.checkedAt, readAt)}`;
        return (
          <div key={`${s.kind}:${s.name}`} className="flex items-center gap-2.5 text-xs">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tone }} />
            <span className="min-w-0 truncate text-default"><b className="font-semibold">{s.name}</b> <span className="text-muted">{s.kind === 'm3u' ? 'Live TV playlist' : 'IPTV login'}</span></span>
            <span className="ml-auto shrink-0 text-muted" title={!s.working && s.message ? s.message : undefined}>{state}</span>
          </div>
        );
      })}
    </div>
  );
}
