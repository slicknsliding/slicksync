'use client';

// The v2 pieces of a title's details window (MediaDetailModal draws these when
// Page design is v2): who here is on it, one primary Resume/Open button in the
// right app with a small arrow that picks the other app, Watchlist and Follow
// beside it, thumbs and ⋯ on the right, and the folds. The backdrop, trailer,
// cast, ratings and everything the window does are the modal's own.

import { useRef, useState, type ReactNode } from 'react';
import {
  BellIcon, BookmarkIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, HandThumbDownIcon, HandThumbUpIcon,
  NoSymbolIcon, PlayIcon, RectangleStackIcon, ShareIcon,
} from '@heroicons/react/24/outline';
import { BookmarkIcon as BookmarkSolidIcon } from '@heroicons/react/24/solid';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { Avatar } from '@/components/ui/Avatar';
import { V2MoreMenu, type V2MenuItem } from './V2Detail';
import { V2Status } from './V2Bits';

export type TitleApp = 'stremio' | 'nuvio';

/** Who here is on this title, from Continue Watching. */
export type TitleViewer = { name: string; line: string };

export function TitleWatching({ viewers }: { viewers: TitleViewer[] }) {
  if (viewers.length === 0) return null;
  return (
    <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap mt-3" aria-label="Who here is watching this">
      <V2Status tone="live">Watching</V2Status>
      {viewers.map((v, i) => (
        <span key={`${v.name}-${i}`} className="inline-flex items-center gap-1.5 text-[13.5px]">
          <Avatar name={v.name} size="xs" />
          {v.name} {v.line}
        </span>
      ))}
    </div>
  );
}

/** The line that opens a fold: a chevron, a name, a short note. */
export function TitleFoldHeader({ title, note, icon, open, onToggle }: {
  title: string;
  note?: ReactNode;
  icon?: ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-2.5 py-3 text-left">
      {open ? <ChevronDownIcon className="w-4 h-4 text-muted shrink-0" /> : <ChevronRightIcon className="w-4 h-4 text-muted shrink-0" />}
      {icon}
      <b className="flex-1 min-w-0 text-[15px]">{title}</b>
      {note && <span className="text-[13px] text-muted truncate max-w-[55%]">{note}</span>}
    </button>
  );
}

/** The rule above each fold. */
export const TITLE_FOLD_RULE = 'border-t border-[var(--color-surface-border)]';

const APP_NAME: Record<TitleApp, string> = { stremio: 'Stremio', nuvio: 'Nuvio' };

export function TitleActions({
  app, onPickApp, label, hrefs, watchlist, follow, reactions, isNarrow, menu, extra,
}: {
  /** The app the main button opens. */
  app: TitleApp;
  onPickApp: (a: TitleApp) => void;
  /** "Resume S2 E3" or "Open", without the app name. */
  label: string;
  /** Where each app opens this title (the main button uses the chosen app's). */
  hrefs: Record<TitleApp, string>;
  watchlist?: { on: boolean; busy: boolean; onClick: () => void };
  follow?: { label: string; on: boolean; busy: boolean; title: string; onClick: () => void };
  reactions?: { value: 'happy' | 'sad' | null; busy: boolean; onToggle: (r: 'happy' | 'sad') => void };
  isNarrow: boolean;
  menu: V2MenuItem[];
  /** More ways to open it (Jellyfin, AIOStreams...), shown beside the main button. */
  extra?: ReactNode;
}) {
  const arrowRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const other: TitleApp = app === 'stremio' ? 'nuvio' : 'stremio';

  const thumb = (kind: 'happy' | 'sad') => {
    if (!reactions) return null;
    const on = reactions.value === kind;
    const Icon = kind === 'happy' ? HandThumbUpIcon : HandThumbDownIcon;
    return (
      <button
        type="button"
        onClick={() => reactions.onToggle(kind)}
        disabled={reactions.busy}
        aria-label={kind === 'happy' ? 'Thumbs up' : 'Thumbs down'}
        aria-pressed={on}
        title={kind === 'happy' ? 'Liked it' : 'Not for me'}
        className="v2-btn"
        style={{
          padding: '7px 10px',
          ...(on ? { borderColor: kind === 'happy' ? 'var(--color-success)' : 'var(--color-error)', color: kind === 'happy' ? 'var(--color-success)' : 'var(--color-error)' } : {}),
        }}
      >
        <Icon className="w-5 h-5" />
      </button>
    );
  };

  const items: V2MenuItem[] = [...menu];
  if (isNarrow && reactions) {
    items.unshift(
      { label: reactions.value === 'sad' ? 'Not for me (on)' : 'Not for me', icon: <HandThumbDownIcon className="w-4 h-4" />, onClick: () => reactions.onToggle('sad') },
      { label: reactions.value === 'happy' ? 'Liked it (on)' : 'Liked it', icon: <HandThumbUpIcon className="w-4 h-4" />, onClick: () => reactions.onToggle('happy') },
    );
  }

  const primary = (
    <div className="flex w-full sm:w-auto">
      <a
        href={hrefs[app]}
        className="v2-btn v2-btn-main justify-center"
        // Inline, because .v2-btn's own flex and corners win over utilities:
        // on a phone the button fills the row and joins its arrow.
        style={{ padding: '9px 14px', gap: 8, fontSize: 14, flex: isNarrow ? '1 1 auto' : 'none', borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
      >
        <PlayIcon className="w-4 h-4 shrink-0" />
        {label} in {APP_NAME[app]}
      </a>
      <button
        ref={arrowRef}
        type="button"
        aria-label="Choose the app"
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          const r = arrowRef.current?.getBoundingClientRect();
          setPos({ x: r ? r.left : 16, y: r ? r.bottom + 6 : 80 });
        }}
        className="v2-btn v2-btn-main"
        style={{ padding: '9px 12px', borderLeft: '1px solid rgba(255,255,255,.35)', borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
      >
        <ChevronDownIcon className="w-4 h-4" />
      </button>
      <ContextMenu isOpen={!!pos} position={pos || { x: 0, y: 0 }} onClose={() => setPos(null)}>
        <div className="w-56 p-1.5">
          <a href={hrefs[other]} onClick={() => { onPickApp(other); setPos(null); }} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-hover text-sm text-default">
            <PlayIcon className="w-4 h-4 shrink-0" />
            {label} in {APP_NAME[other]}
          </a>
          <button type="button" onClick={() => { onPickApp(other); setPos(null); }} className="w-full text-left px-2 py-1.5 rounded-lg text-xs text-muted hover:bg-surface-hover">
            Use {APP_NAME[other]} from now on
          </button>
        </div>
      </ContextMenu>
    </div>
  );

  return (
    <div className="mt-4 flex items-center gap-2 flex-wrap">
      {primary}
      {extra}
      <div className="flex items-center gap-2 w-full sm:w-auto sm:flex-1">
        {watchlist && (
          <button type="button" onClick={watchlist.onClick} disabled={watchlist.busy} aria-pressed={watchlist.on} className="v2-btn" style={{ padding: '8px 13px' }} title={watchlist.on ? 'In your Watchlist - tap to remove' : 'Add to Watchlist'}>
            {watchlist.on ? <BookmarkSolidIcon className="w-4 h-4" /> : <BookmarkIcon className="w-4 h-4" />}
            Watchlist
          </button>
        )}
        {follow && (
          <button type="button" onClick={follow.onClick} disabled={follow.busy} aria-pressed={follow.on} className="v2-btn" style={{ padding: '8px 13px' }} title={follow.title}>
            <BellIcon className="w-4 h-4" />
            {follow.label}
          </button>
        )}
        <span className="flex-1" />
        {!isNarrow && <>{thumb('happy')}{thumb('sad')}</>}
        <V2MoreMenu items={items} label="More" />
      </div>
    </div>
  );
}

export const TITLE_MENU_ICONS = {
  watched: <CheckCircleIcon className="w-4 h-4" />,
  catalog: <RectangleStackIcon className="w-4 h-4" />,
  share: <ShareIcon className="w-4 h-4" />,
  notInterested: <NoSymbolIcon className="w-4 h-4" />,
};
