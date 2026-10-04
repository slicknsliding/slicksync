'use client';

// AIOStreams Collections - which of SlickSync's catalogs show up as
// collections in an AIOStreams login's apps (and every Jellyfin app signed in
// to it), in what order, under what name and cover. The counterpart of Nuvio
// Collections, and laid out like it: pick the account first. Every profile on
// a login shares its collections - AIOStreams doesn't say which profile is
// asking when it fetches them. Out of the box every catalog with titles is
// one collection; once arranged here, the arrangement is used. Served through
// the AIOStreams link - see server/utils/aioCollections.js and
// routes/traxAddon.js. A tile opens its own page ([collectionId]/page.tsx).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeftIcon, PlusIcon, EyeSlashIcon, EyeIcon, TrashIcon, ArrowUturnLeftIcon, Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { Avatar } from '@/components/ui/Avatar';
import {
  Card, Button, ConfirmModal, Badge,
  DndContext, closestCenter, SortableContext, useSortable, useSortableSensors, CSS,
} from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { posterUrl, cachedImageUrl } from '@/lib/posterUrl';
import { api, type AioCollection, type AioCollectionAccount, type AioCollectionsView } from '@/lib/api';

const LIST = '/catalogs/aiostreams-collections';

function Tile({ c, onOpen, onToggle, onRemove }: {
  c: AioCollection;
  onOpen: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.id });
  // A cover that is just a title's poster shows like that title's poster card.
  const { rpdbEnabled } = usePersonalFeatures();
  const coverSrc = c.coverTitleId ? posterUrl({ id: c.coverTitleId, poster: c.cover }, rpdbEnabled) : cachedImageUrl(c.cover, 342);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}
      aria-label={`Open ${c.name}`}
      title="Open, or drag to reorder"
      className={`group rounded-2xl overflow-hidden bg-surface-hover border border-default hover:border-primary/50 transition-colors cursor-pointer active:cursor-grabbing ${c.hidden ? 'opacity-50' : ''}`}
    >
      <div className="relative aspect-[2/3] bg-surface">
        {coverSrc
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={coverSrc} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
          : <div className="absolute inset-0 flex items-center justify-center"><Squares2X2Icon className="w-10 h-10 text-muted" /></div>}
        {c.hidden && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/40"><EyeSlashIcon className="w-8 h-8 text-white" /></span>
        )}
      </div>
      <div className="p-2.5">
        <p className="text-sm font-medium text-default truncate">{c.name}</p>
        <p className="text-[11px] text-muted truncate">
          {c.titles} title{c.titles === 1 ? '' : 's'}{c.catalogIds.length > 1 ? ` · ${c.catalogIds.length} catalogs` : ''}
        </p>
        <div className="flex items-center gap-1 mt-2" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={onToggle} className="p-1.5 rounded-lg text-muted hover:text-default hover:bg-surface" title={c.hidden ? 'Show' : 'Hide'} aria-label={c.hidden ? `Show ${c.name}` : `Hide ${c.name}`}>
            {c.hidden ? <EyeIcon className="w-4 h-4" /> : <EyeSlashIcon className="w-4 h-4" />}
          </button>
          <button type="button" onClick={onRemove} className="p-1.5 rounded-lg text-muted hover:text-error hover:bg-surface ml-auto" title="Remove" aria-label={`Remove ${c.name}`}>
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AiostreamsCollectionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get('user') || '';
  const { layoutMode } = useLayoutMode();
  const [accounts, setAccounts] = useState<AioCollectionAccount[] | null>(
    () => api.peekGet<{ accounts: AioCollectionAccount[] }>('/jellyfin/collections/accounts')?.accounts ?? null,
  );

  useEffect(() => {
    api.getAioCollectionAccounts()
      .then((r) => setAccounts(r.accounts))
      .catch((e: any) => { toast.error(e?.message || 'Could not load the AIOStreams accounts'); setAccounts([]); });
  }, []);

  // Only one AIOStreams account: nothing to pick.
  useEffect(() => {
    if (!userId && accounts?.length === 1) router.replace(`${LIST}?user=${encodeURIComponent(accounts[0].id)}`);
  }, [accounts, userId, router]);

  const selected = accounts?.find((a) => a.id === userId) || null;
  const pick = (id: string) => router.push(id ? `${LIST}?user=${encodeURIComponent(id)}` : LIST);

  const backButton = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={() => router.push('/catalogs')}>
      Back
    </Button>
  );
  const subtitle = 'Which catalogs show up as collections in an AIOStreams account’s apps';

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={[{ label: 'Catalogs', href: '/catalogs' }, { label: 'AIOStreams Collections' }]} className="text-xl font-semibold" />}
          subtitle={subtitle}
          actions={backButton}
        />
      )}
      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
        <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(120rem, 92vw)' } : undefined}>
          {layoutMode === 'nebula' && (
            <NebulaPageHeading title="AIOStreams Collections" subtitle={subtitle} leading={backButton} />
          )}

          <PageSection>
            {/* Same account grid -> compact strip as Nuvio Collections. */}
            {!selected ? (
              <Card padding="lg" className="mb-6">
                <label className="block text-xs font-medium text-muted mb-3">AIOStreams account</label>
                {accounts === null || (!userId && accounts.length === 1) ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 rounded-xl bg-surface-hover animate-pulse" />)}
                  </div>
                ) : accounts.length === 0 ? (
                  <p className="text-xs text-subtle">
                    No AIOStreams accounts yet. Add someone with Jellyfin | AIOStreams on the Users page, or turn on their AIOStreams watch history link.{' '}
                    <Link href="/guides/aiostreams-watch-history" className="text-primary hover:underline">How</Link>
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {accounts.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => pick(a.id)}
                        className="flex items-center gap-3 p-3 rounded-xl border border-default hover:border-primary/50 bg-subtle hover:bg-surface-hover transition-colors text-left"
                      >
                        <Avatar name={a.name} email={a.email || undefined} src={a.avatarUrl || undefined} colorIndex={a.colorIndex ?? undefined} size="md" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-default truncate">{a.name}</p>
                          {a.profiles.length > 0 && <p className="text-xs text-subtle truncate">{a.profiles.join(', ')}</p>}
                          <Badge variant="aiostreams" size="sm" className="mt-1">AIOStreams</Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </Card>
            ) : (
              <Card padding="lg" className="mb-6">
                <div className="flex flex-wrap gap-x-6 gap-y-3 items-end">
                  <button
                    type="button"
                    onClick={() => (accounts && accounts.length > 1 ? pick('') : undefined)}
                    className="flex items-center gap-3 pr-3 rounded-xl hover:bg-surface-hover transition-colors text-left"
                    title={accounts && accounts.length > 1 ? 'Switch account' : undefined}
                  >
                    <Avatar name={selected.name} email={selected.email || undefined} src={selected.avatarUrl || undefined} colorIndex={selected.colorIndex ?? undefined} size="md" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-sm font-medium text-default truncate">{selected.name}</p>
                        <Badge variant="aiostreams" size="sm" className="shrink-0">AIOStreams</Badge>
                      </div>
                      {accounts && accounts.length > 1 && <p className="text-xs text-primary">Switch account</p>}
                    </div>
                  </button>

                  {selected.profiles.length > 0 && (
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1.5">Profiles - all see these collections</label>
                      <div className="flex flex-wrap gap-2">
                        {[selected.name, ...selected.profiles].map((name) => (
                          <span key={name} className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-lg border border-default bg-subtle text-sm text-subtle">
                            <Avatar name={name} size="xs" />
                            <span className="truncate" style={{ maxWidth: '120px' }}>{name}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                </div>
              </Card>
            )}

            {selected && <AccountCollections key={selected.id} userId={selected.id} />}
          </PageSection>
        </div>
      </div>
    </>
  );
}

/** One AIOStreams account's collections: reorder, hide, remove, open. */
function AccountCollections({ userId }: { userId: string }) {
  const router = useRouter();
  const sensors = useSortableSensors();
  const path = api.aioCollectionsPath(userId);
  const [view, setView] = useState<AioCollectionsView | null>(() => api.peekGet<AioCollectionsView>(path) ?? null);
  const [collections, setCollections] = useState<AioCollection[]>(() => api.peekGet<AioCollectionsView>(path)?.collections ?? []);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [removing, setRemoving] = useState<AioCollection | null>(null);
  // What the server last accepted, to fall back to if a save fails, and the
  // save in flight - each change waits for the one before so they land in order.
  const saved = useRef<AioCollection[]>(collections);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async () => {
    try {
      const next = await api.getAioCollections(userId);
      setView(next);
      setCollections(next.collections);
      saved.current = next.collections;
    } catch (e: any) {
      toast.error(e?.message || 'Could not load the collections');
    }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  // Every change on this page - hide, remove, reorder - saves straight away,
  // like a collection's own page does. There is no separate Save step to
  // forget: a removed collection used to come back on refresh without one.
  const change = (next: AioCollection[]) => {
    setCollections(next);
    queue.current = queue.current.then(async () => {
      try {
        await api.saveAioCollections(userId, next.map(({ id, name, coverUrl, catalogIds, hidden, order }) => ({ id, name, coverUrl, catalogIds, hidden, order })));
        saved.current = next;
        setView((v) => (v ? { ...v, configured: true } : v));
      } catch (e: any) {
        toast.error(e?.message || 'Could not save that change');
        setCollections(saved.current);
      }
    });
  };

  // Letting go of a dragged tile also lands as a tap on it - not an open.
  const draggedAt = useRef(0);
  const onDragEnd = (e: DragEndEvent) => {
    draggedAt.current = Date.now();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = collections.findIndex((c) => c.id === active.id);
    const to = collections.findIndex((c) => c.id === over.id);
    if (from >= 0 && to >= 0) change(arrayMove(collections, from, to));
  };

  const open = async (id: string) => {
    if (Date.now() - draggedAt.current < 300) return;
    await queue.current;
    router.push(`${LIST}/${encodeURIComponent(id)}?user=${encodeURIComponent(userId)}`);
  };

  const reset = async () => {
    await queue.current;
    setSaving(true);
    try {
      await api.resetAioCollections(userId);
      toast.success('Back to one collection per catalog');
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Could not reset');
    } finally {
      setSaving(false);
      setConfirmReset(false);
    }
  };

  return (
    <>
            {view && !view.linked && (
              <Card padding="md" className="mb-4">
                <p className="text-sm text-default">
                  These reach AIOStreams through this account&rsquo;s AIOStreams watch history link. Turn it on (their page &rarr; Watch-tracking integrations) and add its link to AIOStreams.{' '}
                  <Link href="/guides/aiostreams-watch-history" className="text-primary hover:underline">How</Link>
                </p>
              </Card>
            )}

            <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
              <p className="text-sm text-muted">
                {view?.configured
                  ? 'Tap a collection to change it, or drag to reorder. Each one holds the titles of the catalogs in it.'
                  : 'Right now every catalog is its own collection. Tap one to change it, or drag to reorder.'}
              </p>
              <div className="flex items-center gap-2">
                {view?.configured && (
                  <Button variant="ghost" size="sm" leftIcon={<ArrowUturnLeftIcon className="w-4 h-4" />} onClick={() => setConfirmReset(true)}>
                    One per catalog
                  </Button>
                )}
                <Button variant="secondary" size="sm" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={() => open('new')}>
                  New collection
                </Button>
              </div>
            </div>

            {!view ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {Array.from({ length: 6 }).map((_, i) => <div key={i} className="aspect-[2/3] rounded-2xl bg-surface-hover animate-pulse" />)}
              </div>
            ) : collections.length === 0 ? (
              <Card padding="lg">
                <p className="text-sm text-muted text-center">
                  {view.configured
                    ? 'No collections. Add one with New collection, or go back to One per catalog.'
                    : 'No catalogs with titles yet. Make one on the Catalogs page.'}
                </p>
              </Card>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} onDragCancel={() => { draggedAt.current = Date.now(); }}>
                <SortableContext items={collections.map((c) => c.id)} strategy={rectSortingStrategy}>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {collections.map((c) => (
                      <Tile
                        key={c.id}
                        c={c}
                        onOpen={() => open(c.id)}
                        onToggle={() => change(collections.map((x) => (x.id === c.id ? { ...x, hidden: !x.hidden } : x)))}
                        onRemove={() => setRemoving(c)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

      <ConfirmModal
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) change(collections.filter((x) => x.id !== removing.id));
          setRemoving(null);
        }}
        title={`Remove ${removing?.name || 'this collection'}?`}
        description="It stops showing in AIOStreams' apps. The catalogs in it stay as they are."
        confirmText="Remove"
      />

      <ConfirmModal
        isOpen={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={reset}
        title="Go back to one collection per catalog?"
        description="Your arrangement - names, covers, order and which catalogs are grouped - is cleared, and every catalog with titles shows as its own collection again."
        confirmText="Reset"
        isLoading={saving}
      />
    </>
  );
}
