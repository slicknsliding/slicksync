'use client';

// A person's page in the v2 page design: small pieces the page puts together
// (the tool tile that wraps an existing popup button, the Copy watch history
// tile, a row of titles) and the header of the Copy watch history page. The
// page itself (app/(admin)/users/[id]/page.tsx) keeps all the data and handlers.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ShareIcon } from '@heroicons/react/24/outline';
import { UserAvatar } from '@/components/ui';
import { api, type User, type WatchCopySide } from '@/lib/api';
import { V2DetailHead, V2ToolTile } from './V2Detail';

/**
 * A tool tile whose control is an existing popup button (Sign in a TV, Devices,
 * AIOStreams health...). The whole tile is the target: a click anywhere on it
 * presses that button, so the popup opens anchored to it as before.
 */
export function PillTool({ icon, title, line, children }: { icon: ReactNode; title: string; line?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="cursor-pointer"
      onClick={(e) => {
        const box = ref.current;
        const t = e.target as HTMLElement;
        // Popups render in a portal: only clicks that landed on the tile itself count.
        if (!box || !box.contains(t) || t.closest('button,a,input,select,[role="dialog"]')) return;
        box.querySelector<HTMLButtonElement>('button')?.click();
      }}
    >
      <V2ToolTile icon={icon} title={title} line={line} state={<span className="inline-flex">{children}</span>} />
    </div>
  );
}

/** The Copy watch history tile: only for someone with a sign-in to copy from or to. */
export function CopyHistoryTool({ userId, icon }: { userId: string; icon: ReactNode }) {
  const [sides, setSides] = useState<WatchCopySide[] | null>(null);
  const [inStep, setInStep] = useState(false);
  useEffect(() => {
    api.getWatchCopySides(userId).then((r) => setSides(r.sides)).catch(() => setSides([]));
    api.getKeepInStep(userId).then((k) => setInStep(k.enabled)).catch(() => {});
  }, [userId]);
  if (!sides || sides.length === 0) return null;
  return (
    <Link href={`/users/${encodeURIComponent(userId)}/copy-history`} className="v2-tool hover:border-primary" style={{ textDecoration: 'none' }}>
      <span className="v2-tool-icon">{icon}</span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block font-semibold text-[14.5px] text-default">Copy watch history</span>
        <span className="block text-muted text-[12.5px] mt-0.5">To or from another sign-in (AIOSync)</span>
      </span>
      {inStep && <span className="shrink-0 text-[12.5px]" style={{ color: 'var(--color-success)' }}>Keep in step: on</span>}
    </Link>
  );
}

/** A short list of titles with a poster, a name and one line under it. */
export function TitleRows({ rows, empty }: {
  rows: { key: string; name: string; poster?: string | null; type?: string; line: ReactNode; live?: boolean }[];
  empty: string;
}) {
  if (rows.length === 0) return <div className="text-muted text-sm py-4">{empty}</div>;
  return (
    <div>
      {rows.map((r, i) => (
        <div key={r.key} className="flex items-center gap-3 py-2.5" style={i ? { borderTop: '1px solid var(--color-surface-border)' } : undefined}>
          <div className="w-10 h-14 rounded-lg overflow-hidden shrink-0 flex items-center justify-center" style={{ background: 'var(--color-surface-hover)' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {r.poster ? <img src={r.poster} alt="" className="w-full h-full object-cover" /> : <span className="text-subtle text-xs">{r.type === 'movie' ? 'Film' : 'Show'}</span>}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-default break-words">{r.name}</div>
            <div className="text-muted text-[12.5px] break-words">{r.line}</div>
          </div>
          {r.live && <span className="v2-chip" style={{ color: 'var(--color-success, #22c55e)' }}>Live</span>}
        </div>
      ))}
    </div>
  );
}

/** The header of the Copy watch history page: whose history, and that nothing is removed. */
export function copyHistoryHeadV2(user: User | null) {
  const name = user?.username || user?.name || 'their';
  return {
    lead: user ? (
        <UserAvatar
          userId={user.id}
          name={user.username || user.name || 'User'}
          email={user.email}
          src={user.avatarUrl ?? undefined}
          useGravatar={user.useGravatar}
          colorIndex={user.colorIndex || 0}
          size="2xl"
          className="w-16 h-16 rounded-2xl"
          avatarClassName="rounded-2xl"
        />
    ) : <span className="w-16 h-16 rounded-2xl" style={{ background: 'var(--color-surface-hover)' }}><ShareIcon className="w-6 h-6" /></span>,
    title: user ? `Copy ${name}’s watch history` : 'Copy watch history',
    status: <span className="text-muted text-[14px]">From one sign-in to another</span>,
    facts: 'nothing is removed from where it comes from',
  };
}
