'use client';

// The menu on an Activity poster: right-click on a computer, press and hold on
// a phone. One menu for the whole page (the page keeps which card it's for),
// drawn at the click or the finger with the shared ContextMenu.
//
// "Remove from Activity" asks first, in the menu itself, because it takes the
// viewing out of that person's watch time and history too (into the Trash).

import { useRef, useState } from 'react';
import {
  InformationCircleIcon, FunnelIcon, UserIcon, BookmarkIcon, CheckCircleIcon, ArchiveBoxIcon, XCircleIcon,
} from '@heroicons/react/24/outline';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { UserAvatar } from '@/components/ui/UserAvatar';

export interface MenuWatcher { userId: string; userName: string; userEmail?: string; userAvatarUrl?: string | null; userUseGravatar?: boolean; userColorIndex?: number }
export interface MenuTarget {
  x: number;
  y: number;
  title: string; // "Twin Peaks · S1 E2"
  detail: string; // "47 min · today 3:18 PM"
  isShow: boolean;
  watchers: MenuWatcher[];
}

/** Right-click and press-and-hold on one card. `suppressClick()` is true for
 * the tap that ends a hold, so it doesn't also open the details. */
export function useCardMenuPress(open: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return {
    handlers: {
      onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); open(e.clientX, e.clientY); },
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        if (!t) return;
        held.current = false;
        start.current = { x: t.clientX, y: t.clientY };
        clear();
        timer.current = setTimeout(() => { held.current = true; timer.current = null; open(t.clientX, t.clientY); }, 500);
      },
      onTouchMove: (e: React.TouchEvent) => {
        const t = e.touches[0];
        if (!t || !start.current) return;
        if (Math.abs(t.clientX - start.current.x) > 10 || Math.abs(t.clientY - start.current.y) > 10) clear();
      },
      onTouchEnd: clear,
      onTouchCancel: clear,
    },
    suppressClick: () => { const h = held.current; held.current = false; return h; },
  };
}

export function ActivityCardMenu({ target, onClose, actions }: {
  target: MenuTarget | null;
  onClose: () => void;
  actions: {
    openDetails: () => void;
    onlyTitle: () => void;
    onlyPerson: (userId: string) => void;
    addToWatchlist: () => void;
    markNotWatched: () => void;
    buryShow: () => void;
    remove: (watcher: MenuWatcher) => Promise<void>;
  };
}) {
  // The question belongs to the card it was asked on. Right-clicking another
  // card while it showed used to carry it over, and Remove then went for the
  // new card's viewing under the old card's person - nothing was found.
  const [asked, setAsked] = useState<{ card: string; watcher: MenuWatcher } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!target) return null;
  // Which card: where it was opened and what it is (the page rebuilds the
  // target object on every refresh, so not the object itself).
  const card = `${target.x},${target.y}|${target.title}|${target.watchers.map((w) => w.userId).join(',')}`;
  const confirm = asked && asked.card === card ? asked.watcher : null;
  const setConfirm = (w: MenuWatcher | null) => setAsked(w ? { card, watcher: w } : null);
  const close = () => { setConfirm(null); onClose(); };
  const item = 'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors text-left';
  const icon = 'w-4 h-4 text-muted shrink-0';
  const run = (fn: () => void) => () => { close(); fn(); };
  return (
    <ContextMenu isOpen position={{ x: target.x, y: target.y }} onClose={close}>
      <div className="w-[min(296px,calc(100vw-1.5rem))]">
        <div className="px-3.5 pt-2 pb-2.5 mb-1 border-b border-default">
          <div className="text-[15px] font-semibold text-default truncate">{target.title}</div>
          {/* Who watched it, each with their picture, in the theme's accent
              lightened for reading; when and how long underneath. */}
          <div className="mt-1.5 flex flex-col gap-1">
            {target.watchers.map((w) => (
              <div key={w.userId} className="flex items-center gap-2 min-w-0 text-[14px] font-semibold" style={{ color: 'color-mix(in srgb, var(--color-primary) 45%, #ffffff)' }}>
                <UserAvatar userId={w.userId} name={w.userName} email={w.userEmail} src={w.userAvatarUrl || undefined} useGravatar={w.userUseGravatar} colorIndex={w.userColorIndex} size="xs" />
                <span className="truncate">{w.userName}</span>
              </div>
            ))}
          </div>
          {target.detail && (
            <div className="text-[13px] truncate mt-1" style={{ color: 'color-mix(in srgb, var(--color-text) 78%, transparent)' }}>Watched {target.detail}</div>
          )}
        </div>
        {confirm ? (
          <div className="px-3 py-2">
            <p className="text-[15px] text-default font-medium">Remove {confirm.userName}&rsquo;s viewing?</p>
            <p className="text-[13px] text-muted mt-1">
              It comes off the Activity page and out of {confirm.userName}&rsquo;s watch time and history for that day, so their totals and stats drop too. The Trash keeps it for 30 days if you want it back.
            </p>
            <div className="flex justify-end gap-2 mt-3">
              <button type="button" onClick={() => setConfirm(null)} className="px-3 py-1.5 rounded-lg text-sm text-default hover:bg-surface-hover">Cancel</button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => { setBusy(true); try { await actions.remove(confirm); } finally { setBusy(false); close(); } }}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-60"
                style={{ background: 'var(--color-error)' }}
              >
                {busy ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className={item} onClick={run(actions.openDetails)}><InformationCircleIcon className={icon} />Open details</button>
            <button type="button" className={item} onClick={run(actions.onlyTitle)}><FunnelIcon className={icon} /><span className="truncate">Only show {target.title.split(' · ')[0]}</span></button>
            {target.watchers.map((w) => (
              <button key={`only-${w.userId}`} type="button" className={item} onClick={run(() => actions.onlyPerson(w.userId))}><UserIcon className={icon} /><span className="truncate">Only show {w.userName}&rsquo;s activity</span></button>
            ))}
            <div className="h-px my-1 bg-[color:var(--color-surface-border)]" />
            <button type="button" className={item} onClick={run(actions.addToWatchlist)}><BookmarkIcon className={icon} />Add to Watchlist</button>
            <button type="button" className={item} onClick={run(actions.markNotWatched)}><CheckCircleIcon className={icon} />Mark as not watched</button>
            {target.isShow && <button type="button" className={item} onClick={run(actions.buryShow)}><ArchiveBoxIcon className={icon} />Bury show in the Graveyard</button>}
            <div className="h-px my-1 bg-[color:var(--color-surface-border)]" />
            {target.watchers.map((w) => (
              <button key={`rm-${w.userId}`} type="button" className={item} style={{ color: 'var(--color-error)' }} onClick={() => setConfirm(w)}>
                <XCircleIcon className="w-4 h-4 shrink-0" />
                <span className="truncate">{target.watchers.length > 1 ? `Remove ${w.userName}’s viewing` : 'Remove from Activity'}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </ContextMenu>
  );
}
