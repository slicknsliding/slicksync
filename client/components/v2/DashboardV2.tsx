'use client';

// The pieces the Dashboard (and Activity's Watched tab) are built from in the
// v2 page design: Now Playing as the same big banner a person sees on their
// own Home, what needs the admin, and the rows of people.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { V2MoreMenu } from './V2Detail';
import { UserAvatar, Avatar } from '@/components/ui';
import { NowPlayingBanner } from '@/components/user/home/NowPlayingBanner';
import type { MetricsData } from '@/lib/api';
import { V2Status, type V2Tone } from './V2Bits';
import { StretchHandle } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';

export type NowPlayingRows = MetricsData['nowPlaying'];

/** Which app a viewing is in: the person's own, else what the row's links say. */
export function appOfRow(np: NowPlayingRows[number], providerByUser: Map<string, string>): string {
  const known = providerByUser.get(np.user.id);
  if (known) return known;
  if (np.source === 'jellyfin') return 'jellyfin';
  if (np.nuvioAppUrl && !np.stremioAppUrl) return 'nuvio';
  return 'stremio';
}

function Who({ np }: { np: NowPlayingRows[number] }) {
  return (
    <Link href={`/users/${np.user.id}`} className="inline-flex items-center gap-2 min-w-0 hover:underline" style={{ color: 'inherit' }} aria-label={`Open ${np.user.username}’s profile`}>
      <UserAvatar userId={np.user.id} name={np.user.username} email={np.user.email} colorIndex={np.user.colorIndex} src={np.user.useGravatar ? undefined : (np.user.avatarUrl ?? undefined)} useGravatar={np.user.useGravatar} size="xs" />
      <b className="truncate">{np.user.username.split(' ')[0]}</b>
      <span aria-hidden="true">·</span>
    </Link>
  );
}

/**
 * Who is watching right now, as the Now Playing banner from a person’s Home:
 * the first one large, everyone else in smaller banners beside and under it.
 */
export function NowPlayingV2({ rows: allRows, providerByUser, max = 6, moreHref, detail }: {
  rows: NowPlayingRows;
  providerByUser: Map<string, string>;
  /** How many banners before pointing at the rest. */
  max?: number;
  moreHref?: string;
  /** A small line under each banner (live-updated time, how long they have watched). */
  detail?: (np: NowPlayingRows[number]) => ReactNode;
}) {
  // A stream whose title isn't known yet is dropped while the same person
  // has a known one playing - it is usually the same viewing, still resolving.
  const known = new Set(allRows.filter((r) => !r.item.titlePending).map((r) => r.user.id));
  const rows = allRows.filter((r) => !r.item.titlePending || !known.has(r.user.id));
  if (rows.length === 0) {
    return <div className="v2-box v2-box-pad text-sm text-muted text-center py-6">No one is watching right now.</div>;
  }
  const [first, ...others] = rows;
  const shown = others.slice(0, Math.max(0, max - 1));
  const left = rows.length - 1 - shown.length;
  const banner = (np: NowPlayingRows[number], compact: boolean) => {
    const key = `${np.user.id}-${np.item.id}-${np.item.season ?? ''}-${np.item.episode ?? ''}`;
    const el = (
      <NowPlayingBanner
        key={detail ? undefined : key}
        row={np}
        provider={appOfRow(np, providerByUser)}
        profileLabel={np.profileLabel}
        who={<Who np={np} />}
        compact={compact}
        flush
      />
    );
    if (!detail) return el;
    const line = detail(np);
    return (
      <div key={key} className="min-w-0">
        {el}
        {line && <div className="px-2 pt-1.5">{line}</div>}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {banner(first, false)}
      {shown.length > 0 && (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((np) => banner(np, true))}
        </div>
      )}
      {left > 0 && moreHref && (
        <Link href={moreHref} className="text-sm font-medium self-start" style={{ color: 'var(--color-secondary)' }}>
          {left} more on Activity →
        </Link>
      )}
    </div>
  );
}

export type NeedsYouItem = {
  key: string;
  /** What kind of tile this is ('signin', 'request', 'vault'): "don't show this kind again" acts on it. */
  kind: string;
  /** The tile's state: a put-away tile comes back when this changes. */
  sig: string;
  /** A person of ours (picture from their account) or just a name. */
  person: { id?: string; name: string; email?: string; colorIndex?: number; avatarUrl?: string | null; useGravatar?: boolean } | null;
  /** Shown when there is no person (a service). */
  icon?: ReactNode;
  title: string;
  line: string;
  actions: ReactNode;
};

/**
 * What needs the admin: one tile each, with the button that fixes it. Given
 * `onPutAway`, every tile has an ✕ with a menu: dismiss it, snooze it for a
 * week, or stop showing that kind. `stretch` lets the tiles be stretched to size while arranging.
 */
export function NeedsYouTiles({ items, onPutAway, stretch }: {
  items: NeedsYouItem[];
  onPutAway?: (item: NeedsYouItem, how: 'dismiss' | 'snooze' | 'kind') => void;
  stretch?: { arrange: PageArrange; id: string };
}) {
  return (
    <div className="v2-tiles v2-tiles-3" {...(stretch ? stretch.arrange.cardAttrs(stretch.id) : {})}>
      {items.map((it) => (
        <div key={it.key} className="v2-tool" style={{ alignItems: 'center', borderColor: 'color-mix(in srgb, var(--color-warning, #f59e0b) 35%, var(--color-surface-border))' }}>
          {it.person
            ? (it.person.id
              ? <UserAvatar userId={it.person.id} name={it.person.name} email={it.person.email} colorIndex={it.person.colorIndex} src={it.person.useGravatar ? undefined : (it.person.avatarUrl ?? undefined)} useGravatar={it.person.useGravatar} size="md" />
              : <Avatar name={it.person.name} email={it.person.email} size="md" />)
            : <span className="v2-tool-icon">{it.icon}</span>}
          <span className="flex-1 min-w-0 text-left">
            <span className="block font-semibold text-[14.5px] text-default truncate">{it.title}</span>
            <span className="block text-[12.5px] truncate" style={{ color: 'var(--color-warning, #f59e0b)' }}>{it.line}</span>
          </span>
          <span className="flex gap-2 shrink-0">{it.actions}</span>
          {onPutAway && (
            <V2MoreMenu
              small
              label={`Put away ${it.title}`}
              icon={<XMarkIcon className="w-4 h-4" />}
              items={[
                { label: 'Dismiss this one', onClick: () => onPutAway(it, 'dismiss') },
                { label: 'Snooze for a week', onClick: () => onPutAway(it, 'snooze') },
                { label: 'Don’t show this kind again', onClick: () => onPutAway(it, 'kind') },
              ]}
              menuLabel="Bring it back from Settings → Notifications, or while arranging this page."
            />
          )}
        </div>
      ))}
      {stretch && <StretchHandle arrange={stretch.arrange} id={stretch.id} label="Needs you" />}
    </div>
  );
}

/** One line in a list of people: picture, what they did, when. */
export function PersonRow({ href, avatar, children, when, extra }: {
  href?: string;
  avatar: ReactNode;
  children: ReactNode;
  when?: ReactNode;
  extra?: ReactNode;
}) {
  const lead = href
    ? <Link href={href} className="shrink-0 rounded-full">{avatar}</Link>
    : <span className="shrink-0">{avatar}</span>;
  return (
    <div className="v2-row">
      {lead}
      <div className="flex-1 min-w-0">
        <div className="text-[14px] truncate">{children}</div>
        {when && <div className="text-muted text-[12px] truncate">{when}</div>}
      </div>
      {extra}
    </div>
  );
}

/** One row of a status list: what it is, a line under it, one status in words, and its button. */
export function StatusRow({ tone, words, title, line, actions }: {
  tone: V2Tone;
  words: string;
  title: ReactNode;
  line?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="v2-row">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-[14.5px] truncate">{title}</div>
        {line && <div className="text-muted text-[12.5px] truncate">{line}</div>}
      </div>
      <V2Status tone={tone}>{words}</V2Status>
      {actions}
    </div>
  );
}
