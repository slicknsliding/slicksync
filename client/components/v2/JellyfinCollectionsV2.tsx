'use client';

// The pieces of Jellyfin Collections (the list page) in the v2 page design:
// the header's picture, the one button that says which server or AIOStreams
// sign-in (and profile) this is, the choices before one is picked, and a
// collection as a tile with its cover. The page and its modals own the data
// and handlers; this only draws them.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ChevronDownIcon, EyeIcon, EyeSlashIcon, ServerStackIcon, Squares2X2Icon, TrashIcon,
} from '@heroicons/react/24/outline';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Avatar } from '@/components/ui/Avatar';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { posterUrl, cachedImageUrl } from '@/lib/posterUrl';
import type { AioCollection, AioCollectionAccount, JellyfinCollectionServer } from '@/lib/api';
import { V2AppPill } from './V2Bits';
import { V2MoreMenu, V2Tiles } from './V2Detail';

/** The header's picture: a small server tile in Jellyfin's blue. */
export function JfLead() {
  return (
    <span className="w-[58px] h-[58px] rounded-2xl flex items-center justify-center" style={{ background: '#0b2447', border: '1px solid #38bdf8', color: '#38bdf8' }}>
      <Squares2X2Icon className="w-7 h-7" />
    </span>
  );
}

type SwitcherProps = {
  servers: JellyfinCollectionServer[];
  accounts: AioCollectionAccount[];
  serverKey: string;
  accountId: string;
  profileId: string | null;
  onPickServer: (key: string) => void;
  onPickAccount: (id: string) => void;
  onPickProfile: (id: string | null) => void;
};

/** Which server or AIOStreams sign-in (and which profile) this page is about, as one button. */
export function JfSwitcher({ servers, accounts, serverKey, accountId, profileId, onPickServer, onPickAccount, onPickProfile }: SwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const server = servers.find((s) => s.key === serverKey) || null;
  const account = !server ? accounts.find((a) => a.id === accountId) || null : null;
  const profile = account?.profiles.find((p) => p.id === profileId) || null;
  const choices = servers.length + accounts.length;
  const switchable = choices > 1 || (account?.profiles.length ?? 0) > 0;
  if (!server && !account) return null;

  const lead = server
    ? <span className="w-8 h-8 rounded-[10px] bg-surface-hover flex items-center justify-center shrink-0"><ServerStackIcon className="w-[18px] h-[18px] text-muted" /></span>
    : <Avatar name={account!.name} email={account!.email || undefined} src={account!.avatarUrl || undefined} useGravatar={account!.useGravatar} colorIndex={account!.colorIndex ?? undefined} size="sm" />;
  const name = server ? server.name : account!.name;
  const sub = server
    ? `Jellyfin · ${server.people.map((p) => p.username).join(', ')}`
    : `AIOStreams${profile ? ` · ${profile.name}` : ''}`;

  const body = (
    <>
      {lead}
      <span className="text-left min-w-0">
        <b className="block text-[13.5px] truncate">{name}</b>
        <span className="block text-muted text-[12px] truncate">{sub}</span>
      </span>
      {switchable && <ChevronDownIcon className="w-4 h-4 shrink-0 text-muted" />}
    </>
  );

  return (
    <div ref={ref} className="relative inline-block max-w-full">
      {switchable ? (
        <button type="button" className="v2-btn" style={{ padding: '6px 12px 6px 6px', gap: 10, maxWidth: '100%' }} aria-haspopup="menu" aria-expanded={open} title="Switch server, account or profile" onClick={() => setOpen((v) => !v)}>
          {body}
        </button>
      ) : (
        <span className="v2-btn" style={{ padding: '6px 12px 6px 6px', gap: 10, maxWidth: '100%', cursor: 'default' }}>{body}</span>
      )}
      {open && (
        <div role="menu" className="arrange-menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 'auto', zIndex: 40, width: 290, maxWidth: '86vw', maxHeight: '60vh', overflowY: 'auto' }}>
          {servers.map((s) => (
            <button key={s.key} type="button" role="menuitem" className="arrange-menu-item" onClick={() => { setOpen(false); if (s.key !== serverKey) onPickServer(s.key); }}>
              <ServerStackIcon className="w-4 h-4" />
              <span className="truncate flex-1 text-left">{s.name}</span>
              <span className="text-muted text-[12px]">{s.key === serverKey ? 'Current' : 'Jellyfin'}</span>
            </button>
          ))}
          {accounts.map((a) => {
            const here = !server && a.id === accountId;
            return (
              <div key={a.id}>
                <button type="button" role="menuitem" className="arrange-menu-item" onClick={() => { if (here) return; setOpen(false); onPickAccount(a.id); }}>
                  <Avatar name={a.name} email={a.email || undefined} src={a.avatarUrl || undefined} useGravatar={a.useGravatar} colorIndex={a.colorIndex ?? undefined} size="xs" />
                  <span className="truncate flex-1 text-left">{a.name}</span>
                  <span className="text-muted text-[12px]">{here ? 'Current' : 'AIOStreams'}</span>
                </button>
                {here && a.profiles.length > 0 && (
                  <div className="pl-5">
                    {[{ id: null as string | null, name: a.name, own: true }, ...a.profiles].map((p) => {
                      const on = (p.id || null) === (profileId || null);
                      return (
                        <button key={p.id || 'main'} type="button" role="menuitemradio" aria-checked={on} className="arrange-menu-item" onClick={() => { setOpen(false); onPickProfile(p.id); }}>
                          <Avatar name={p.name} size="xs" />
                          <span className="truncate flex-1 text-left">{p.id ? p.name : `${p.name} (main)`}</span>
                          {on ? <span className="text-muted text-[12px]">Open</span> : p.id && !p.own ? <span className="text-muted text-[12px]">shared</span> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Before anything is picked: the servers and AIOStreams sign-ins as tiles. */
export function JfChoices({ loading, servers, accounts, onPickServer, onPickAccount }: {
  loading: boolean;
  servers: JellyfinCollectionServer[];
  accounts: AioCollectionAccount[];
  onPickServer: (key: string) => void;
  onPickAccount: (id: string) => void;
}) {
  const total = servers.length + accounts.length;
  return (
    <section className="arrange-section" aria-label="Server or sign-in">
      <h2 className="text-lg font-semibold mb-3">Choose a server or sign-in</h2>
      {loading ? (
        <V2Tiles wide={3}>{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-[66px] rounded-2xl bg-surface-hover animate-pulse" />)}</V2Tiles>
      ) : total === 0 ? (
        <p className="text-sm text-muted">
          Nobody here signs in with AIOStreams or to a Jellyfin server of their own yet. Add someone with Users &rarr; Add &rarr; Jellyfin.{' '}
          <Link href="/guides/add-jellyfin-account" className="text-primary hover:underline">How</Link>
        </p>
      ) : (
        <V2Tiles wide={3}>
          {servers.map((s) => (
            <button key={s.key} type="button" className="v2-tool" onClick={() => onPickServer(s.key)}>
              <span className="v2-tool-icon"><ServerStackIcon className="w-[18px] h-[18px]" /></span>
              <span className="flex-1 min-w-0 text-left">
                <b className="block text-[14.5px] truncate text-default">{s.name}</b>
                <span className="block text-muted text-[12.5px] truncate">{s.people.map((p) => p.username).join(', ')}</span>
              </span>
              <V2AppPill label="Jellyfin" color="#38bdf8" />
            </button>
          ))}
          {accounts.map((a) => (
            <button key={a.id} type="button" className="v2-tool" onClick={() => onPickAccount(a.id)}>
              <Avatar name={a.name} email={a.email || undefined} src={a.avatarUrl || undefined} useGravatar={a.useGravatar} colorIndex={a.colorIndex ?? undefined} size="md" />
              <span className="flex-1 min-w-0 text-left">
                <b className="block text-[14.5px] truncate text-default">{a.name}</b>
                {a.profiles.length > 0 && <span className="block text-muted text-[12.5px] truncate">{a.profiles.map((p) => p.name).join(', ')}</span>}
              </span>
              <V2AppPill label="AIOStreams" color="#a78bfa" />
            </button>
          ))}
        </V2Tiles>
      )}
    </section>
  );
}

/** A collection: its cover, its name and how many titles. Click opens it, drag reorders; Hide and Remove in ⋯. */
export function JfCollectionTile({ c, onOpen, onToggle, onRemove }: {
  c: AioCollection;
  onOpen: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.id });
  const { rpdbEnabled } = usePersonalFeatures();
  const coverSrc = c.coverTitleId ? posterUrl({ id: c.coverTitleId, poster: c.cover }, rpdbEnabled) : cachedImageUrl(c.cover, 342);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const items: { label: string; icon: ReactNode; onClick: () => void; danger?: boolean }[] = [
    { label: c.hidden ? 'Show' : 'Hide', icon: c.hidden ? <EyeIcon className="w-4 h-4" /> : <EyeSlashIcon className="w-4 h-4" />, onClick: onToggle },
    { label: 'Remove', icon: <TrashIcon className="w-4 h-4" />, onClick: onRemove, danger: true },
  ];
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition: isDragging ? 'none' : transition, zIndex: isDragging ? 10 : undefined }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}
      aria-label={`Open ${c.name}`}
      title="Open, or drag to reorder"
      className={`v2-box cursor-pointer active:cursor-grabbing p-3 hover:border-[var(--color-primary)] transition-colors ${isDragging ? 'shadow-lg ring-2 ring-primary' : ''}`}
    >
      <div className="relative h-[110px] rounded-lg overflow-hidden bg-[var(--color-surface-hover)]">
        {coverSrc
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={coverSrc} alt="" draggable={false} className={`absolute inset-0 w-full h-full object-cover ${c.hidden ? 'opacity-40' : ''}`} />
          : <div className="absolute inset-0 flex items-center justify-center"><Squares2X2Icon className="w-8 h-8 text-muted" /></div>}
      </div>
      <div className="flex items-start gap-2 mt-2.5">
        <div className="flex-1 min-w-0">
          <b className="block truncate text-default">{c.name}</b>
          <span className="block text-muted text-[12.5px] truncate">
            {c.titles} title{c.titles === 1 ? '' : 's'}{c.catalogIds.length > 1 ? ` · ${c.catalogIds.length} catalogs` : ''}{c.hidden ? ' · hidden' : ''}
          </span>
        </div>
        <span onClick={stop} onPointerDown={stop} onKeyDown={stop}>
          <V2MoreMenu label={`${c.name} options`} items={items} />
        </span>
      </div>
    </div>
  );
}
