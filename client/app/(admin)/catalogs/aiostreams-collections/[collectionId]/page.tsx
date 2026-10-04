'use client';

// One AIOStreams collection, as its own page (/catalogs/aiostreams-collections/
// <id>, or /new) - the same shape as a Nuvio collection: open it and you see
// the titles in it, search to add more, × to take one out, drag to reorder. A collection's
// titles live in SlickSync catalogs (usually one, named like the collection),
// so Discover's "Add to Catalogs" fills it too. Everything saves as it
// happens - there is no Save step to forget.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeftIcon, CheckIcon, ChevronDownIcon, MagnifyingGlassIcon, PlusIcon, Squares2X2Icon, TrashIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  Card, Button, ConfirmModal, MediaDetailModal, PosterCard,
  DndContext, closestCenter, SortableContext, useSortable, useSortableSensors, CSS,
} from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { posterUrl, cachedImageUrl } from '@/lib/posterUrl';
import { api, type AioCollection, type AioCollectionsView, type CustomList, type CustomListItem, type DiscoverItem } from '@/lib/api';

const LIST = '/catalogs/aiostreams-collections';

const noop = () => {};

function toPosterItem(t: { id: string; type: 'movie' | 'series'; name: string; poster?: string | null; year?: number | string | null; releaseInfo?: string | null }) {
  return { id: t.id, type: t.type, name: t.name, poster: t.poster ?? null, releaseInfo: t.releaseInfo ?? (t.year ? String(t.year) : null) };
}

// `order` is only used by a collection built from several catalogs - one
// built from a single catalog takes that catalog's own order.
type Form = { name: string; coverUrl: string; catalogIds: string[]; order: string[] };

function newId() {
  return `c-${Math.random().toString(36).slice(2, 12)}`;
}

// The form's starting values, or null while that collection isn't in hand yet.
function formFrom(view: AioCollectionsView | null, id: string): Form | null {
  if (id === 'new') return { name: '', coverUrl: '', catalogIds: [], order: [] };
  const existing = view?.collections.find((c) => c.id === id);
  return existing ? { name: existing.name, coverUrl: existing.coverUrl || '', catalogIds: existing.catalogIds, order: existing.order ?? [] } : null;
}

const stored = (list: Pick<AioCollection, 'id' | 'name' | 'coverUrl' | 'catalogIds' | 'hidden' | 'order'>[]) =>
  list.map(({ id, name, coverUrl, catalogIds, hidden, order }) => ({ id, name, coverUrl, catalogIds, hidden, order }));

const isImdb = (id: string) => /^tt\d+$/.test(id);

// The same PosterCard the catalog page and Discover use - same artwork, same
// long-press / right-click menu, where Remove takes a title out - wired for drag.
function TitleTile({ t, onOpen, onRemove, menuOpen, onMenuOpenChange }: {
  t: CustomListItem;
  onOpen: () => void;
  onRemove: () => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean, itemId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition: isDragging ? 'none' : transition, zIndex: isDragging ? 50 : undefined }}
      className={`relative group ${isDragging ? 'opacity-50' : ''}`}
      {...attributes}
      {...listeners}
    >
      <PosterCard
        item={toPosterItem(t)}
        onOpenDetails={onOpen}
        onToggleWatchlist={noop}
        onToggleWatched={noop}
        showWatchlistMenu={false}
        showWatchedMenu={false}
        onRemoveFromCatalog={onRemove}
        removeLabel="Remove from collection"
        isMenuOpen={menuOpen}
        onMenuOpenChange={onMenuOpenChange}
      />
    </div>
  );
}

export default function AiostreamsCollectionPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const userId = searchParams.get('user') || '';
  // The profile whose collections these are, when it isn't the account's.
  const profileId = searchParams.get('profile') || null;
  const scope = `user=${encodeURIComponent(userId)}${profileId ? `&profile=${encodeURIComponent(profileId)}` : ''}`;
  const listPath = `${LIST}?${scope}`;
  const collectionId = String(params.collectionId || 'new');
  const isNew = collectionId === 'new';
  const { layoutMode } = useLayoutMode();

  const [initial] = useState(() => {
    const cached = userId ? api.peekGet<AioCollectionsView>(api.aioCollectionsPath(userId, profileId)) ?? null : null;
    return { view: cached, form: formFrom(cached, collectionId) };
  });
  const [view, setView] = useState<AioCollectionsView | null>(initial.view);
  const [form, setForm] = useState<Form>(initial.form ?? { name: '', coverUrl: '', catalogIds: [], order: [] });
  const [ready, setReady] = useState(!!initial.form);
  const filled = useRef(!!initial.form);
  const [lists, setLists] = useState<CustomList[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [detail, setDetail] = useState<CustomListItem | null>(null);
  const [busyTitle, setBusyTitle] = useState<string | null>(null);
  // One title's long-press / right-click menu open at a time, as on the catalog page.
  const [menuTitleId, setMenuTitleId] = useState<string | null>(null);
  const onMenuOpenChange = useCallback((open: boolean, itemId: string) => {
    setMenuTitleId((cur) => (open ? itemId : cur === itemId ? null : cur));
  }, []);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DiscoverItem[]>([]);
  const [searching, setSearching] = useState(false);

  // Saves go one after another, newest arrangement last; `latest` is the
  // whole arrangement as the server last saw it (plus anything queued).
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef<AioCollection[]>(initial.view?.collections ?? []);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!userId) { router.replace(LIST); return; }
    api.getAioCollections(userId, profileId)
      .then((next) => {
        setView(next);
        latest.current = next.collections;
        const f = formFrom(next, collectionId);
        if (!f) {
          toast.error('That collection is gone');
          router.replace(listPath);
          return;
        }
        if (!filled.current) {
          filled.current = true;
          setForm(f);
          setReady(true);
        }
      })
      .catch((e: any) => toast.error(e?.message || 'Could not load the collections'));
    api.getLists()
      .then((r) => setLists(Array.isArray(r) ? r.filter((l) => l.isOwner) : []))
      .catch(() => setLists([]));
  }, [collectionId, router, userId, profileId, listPath]);

  useEffect(() => () => { if (typingTimer.current) clearTimeout(typingTimer.current); }, []);

  const listsRef = useRef<CustomList[] | null>(null);
  useEffect(() => { listsRef.current = lists; }, [lists]);
  const listById = useMemo(() => new Map((lists ?? []).map((l) => [l.id, l])), [lists]);
  const catalogs = useMemo(() => view?.catalogs ?? [], [view]);
  // Where new titles go: the collection's first catalog.
  const home = listById.get(form.catalogIds[0]) || null;

  // The collection's titles: its catalogs' titles, in order, each once - the
  // same thing AIOStreams is served (server/utils/aioCollections.js).
  const titles = useMemo(() => {
    const seen = new Set<string>();
    const out: CustomListItem[] = [];
    for (const id of form.catalogIds) {
      for (const item of listById.get(id)?.items ?? []) {
        if (!isImdb(item.id) || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    if (form.order.length === 0) return out;
    const rank = new Map(form.order.map((id, i) => [id, i]));
    return out
      .map((item, i) => ({ item, key: rank.get(item.id) ?? form.order.length + i }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.item);
  }, [form.catalogIds, form.order, listById]);
  const inCollection = useMemo(() => new Set(titles.map((t) => t.id)), [titles]);
  // The collection's own cover, its first catalog's, or its first title's
  // poster - that last one shown the way the poster cards below show it.
  const { rpdbEnabled } = usePersonalFeatures();
  const ownCover = form.coverUrl.trim() || listById.get(form.catalogIds[0])?.coverImageUrl || null;
  const firstTitle = titles.find((t) => t.poster);
  const cover = ownCover ? cachedImageUrl(ownCover, 342) : firstTitle ? posterUrl(firstTitle, rpdbEnabled) : null;

  const persist = useCallback((next: Form) => {
    queue.current = queue.current.then(async () => {
      const mine = latest.current.find((c) => c.id === collectionId);
      if (!mine) return;
      const entry = { ...mine, name: next.name.trim() || mine.name, coverUrl: next.coverUrl.trim() || null, catalogIds: next.catalogIds, order: next.order };
      const list = latest.current.map((c) => (c.id === collectionId ? entry : c));
      try {
        await api.saveAioCollections(userId, stored(list), profileId);
        latest.current = list;
        // A collection with its own same-named catalog keeps the two names
        // together, so Discover's Add to Catalogs shows the new name too.
        const only = entry.catalogIds.length === 1 ? listsRef.current?.find((l) => l.id === entry.catalogIds[0]) : null;
        if (only && only.name === mine.name && entry.name !== mine.name) {
          await api.updateList(only.id, { name: entry.name });
          setLists((prev) => (prev ?? []).map((l) => (l.id === only.id ? { ...l, name: entry.name } : l)));
        }
      } catch (e: any) {
        toast.error(e?.message || 'Could not save that change');
      }
    });
  }, [collectionId, userId, profileId]);

  // Typing saves a moment after the last key; picking catalogs saves at once.
  const editText = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (isNew) return;
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => persist(next), 700);
  };
  const toggleCatalog = (id: string) => {
    const on = form.catalogIds.includes(id);
    if (on && form.catalogIds.length === 1) { toast.error('A collection needs at least one catalog'); return; }
    const next = { ...form, catalogIds: on ? form.catalogIds.filter((x) => x !== id) : [...form.catalogIds, id] };
    setForm(next);
    persist(next);
  };

  // Search as you type, movies and shows together.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const [movies, shows] = await Promise.all([api.discoverSearch('movie', q), api.discoverSearch('series', q)]);
      const merged: DiscoverItem[] = [];
      for (let i = 0; i < Math.max(movies.length, shows.length); i++) {
        if (movies[i]) merged.push(movies[i]);
        if (shows[i]) merged.push(shows[i]);
      }
      setResults(merged.filter((r) => isImdb(r.id)).slice(0, 24));
      setSearching(false);
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  // Dragging a title: a collection from one catalog reorders that catalog
  // (so the catalog page and AIOStreams agree); one from several keeps its
  // own order. Letting go also lands as a tap - not an open.
  const sensors = useSortableSensors();
  const draggedAt = useRef(0);
  const onDragEnd = async (e: DragEndEvent) => {
    draggedAt.current = Date.now();
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = titles.findIndex((t) => t.id === active.id);
    const to = titles.findIndex((t) => t.id === over.id);
    if (from < 0 || to < 0) return;
    const moved = arrayMove(titles, from, to);
    if (form.catalogIds.length === 1 && home) {
      const before = home;
      const others = home.items.filter((i) => !isImdb(i.id));
      const items = [...moved, ...others];
      setLists((prev) => (prev ?? []).map((l) => (l.id === home.id ? { ...l, items } : l)));
      if (form.order.length > 0) {
        const next = { ...form, order: [] };
        setForm(next);
        persist(next);
      }
      try {
        await api.reorderListItems(home.id, items.map((i) => i.id));
      } catch (err: any) {
        toast.error(err?.message || 'Could not save the new order');
        setLists((prev) => (prev ?? []).map((l) => (l.id === before.id ? before : l)));
      }
      return;
    }
    const next = { ...form, order: moved.map((t) => t.id) };
    setForm(next);
    persist(next);
  };
  const openTitle = (t: CustomListItem) => {
    if (Date.now() - draggedAt.current < 300) return;
    setDetail(t);
  };

  const replaceList = (updated: CustomList) => setLists((prev) => (prev ?? []).map((l) => (l.id === updated.id ? { ...updated, isOwner: true } : l)));

  const addTitle = async (item: DiscoverItem) => {
    if (!home) { toast.error('This collection has no catalog of yours to add to'); return; }
    setBusyTitle(item.id);
    try {
      const year = item.releaseInfo ? parseInt(item.releaseInfo, 10) || null : null;
      replaceList(await api.addToList(home.id, { id: item.id, type: item.type, name: item.name, poster: item.poster, year }));
      toast.success(`Added ${item.name}`);
    } catch (e: any) {
      toast.error(e?.message || 'Could not add it');
    } finally {
      setBusyTitle(null);
    }
  };

  // Out of the collection = out of every one of its catalogs that has it.
  const removeTitle = async (item: CustomListItem) => {
    setBusyTitle(item.id);
    try {
      for (const id of form.catalogIds) {
        const list = listById.get(id);
        if (list?.items.some((i) => i.id === item.id)) replaceList(await api.removeFromList(id, item.id));
      }
    } catch (e: any) {
      toast.error(e?.message || 'Could not take it out');
    } finally {
      setBusyTitle(null);
    }
  };

  // A new collection gets its own catalog, named the same, so it shows up in
  // Discover's "Add to Catalogs" too. Then it opens like any other.
  const create = async () => {
    const name = form.name.trim();
    if (!name) { toast.error('Give the collection a name'); return; }
    setCreating(true);
    try {
      const list = await api.createList(name);
      const current = await api.getAioCollections(userId, profileId);
      const id = newId();
      await api.saveAioCollections(userId, stored([
        ...current.collections,
        { id, name, coverUrl: form.coverUrl.trim() || null, catalogIds: [list.id], hidden: false },
      ]), profileId);
      router.replace(`${LIST}/${id}?${scope}`);
    } catch (e: any) {
      toast.error(e?.message || 'Could not make the collection');
      setCreating(false);
    }
  };

  const remove = async () => {
    await queue.current;
    try {
      await api.saveAioCollections(userId, stored(latest.current.filter((c) => c.id !== collectionId)), profileId);
      toast.success('Collection removed');
      router.push(listPath);
    } catch (e: any) {
      toast.error(e?.message || 'Could not remove it');
    }
  };

  const goBack = async () => {
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; if (!isNew) persist(form); }
    await queue.current;
    router.push(listPath);
  };

  const backButton = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={goBack}>
      Back
    </Button>
  );
  const actions = isNew ? (
    <Button variant="primary" size="sm" onClick={create} isLoading={creating}>Create</Button>
  ) : (
    <Button variant="ghost" size="sm" leftIcon={<TrashIcon className="w-4 h-4" />} onClick={() => setConfirmRemove(true)} disabled={!ready}>
      Remove
    </Button>
  );
  const title = isNew ? 'New collection' : (form.name.trim() || 'Collection');
  const subtitle = isNew ? 'A collection in AIOStreams’ apps' : `${titles.length} title${titles.length === 1 ? '' : 's'} · changes save as you go`;
  const field = 'w-full px-4 py-3 rounded-xl text-sm';
  const fieldStyle = { background: 'var(--color-bg)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' };
  const grid = 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3';
  // Search results on a phone: one row that scrolls sideways, so the
  // collection itself stays in view below; the usual grid from sm up.
  const resultsRow = 'flex gap-3 overflow-x-auto snap-x snap-mandatory scroll-px-4 -mx-4 px-4 pb-2 sm:scroll-px-0 sm:mx-0 sm:px-0 sm:pb-0 sm:overflow-visible sm:grid sm:grid-cols-4 md:grid-cols-6';
  const resultCell = 'w-[30%] shrink-0 snap-start sm:w-auto';

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={[{ label: 'Catalogs', href: '/catalogs' }, { label: 'AIOStreams Collections', href: listPath }, { label: title }]} className="text-xl font-semibold" />}
          subtitle={subtitle}
          actions={<div className="flex items-center gap-2">{backButton}{actions}</div>}
        />
      )}
      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
        <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(120rem, 92vw)' } : undefined}>
          {layoutMode === 'nebula' && <NebulaPageHeading title={title} subtitle={subtitle} leading={backButton} actions={actions} />}

          <PageSection>
            {!ready ? (
              <div className="space-y-4">
                <div className="h-40 rounded-2xl bg-surface-hover animate-pulse" />
                <div className="h-64 rounded-2xl bg-surface-hover animate-pulse" />
              </div>
            ) : (
              <div className="space-y-6">
                <Card padding="md" className="sm:p-6">
                  <div className="flex gap-4 sm:gap-5">
                    <div className="w-20 sm:w-32 shrink-0 self-start">
                      <div className="relative aspect-[2/3] rounded-2xl overflow-hidden bg-surface-hover border border-default">
                        {cover
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img src={cover} alt="" className="absolute inset-0 w-full h-full object-cover" />
                          : <div className="absolute inset-0 flex items-center justify-center"><Squares2X2Icon className="w-8 h-8 sm:w-10 sm:h-10 text-muted" /></div>}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 space-y-3 sm:space-y-4">
                      <div>
                        <label htmlFor="aio-col-name" className="block text-sm font-medium mb-2 text-default">Name</label>
                        <input id="aio-col-name" value={form.name} onChange={(e) => editText({ name: e.target.value })} maxLength={80} className={field} style={fieldStyle}
                          onKeyDown={(e) => { if (isNew && e.key === 'Enter') create(); }} autoFocus={isNew} />
                      </div>
                      <div>
                        <label htmlFor="aio-col-cover" className="block text-sm font-medium mb-2 text-default">Cover image address</label>
                        <input id="aio-col-cover" value={form.coverUrl} onChange={(e) => editText({ coverUrl: e.target.value })} placeholder="Optional - first title's poster" className={field} style={fieldStyle} />
                      </div>
                    </div>
                  </div>
                </Card>

                {isNew ? (
                  <p className="text-sm text-muted text-center">Name it and press Create - then search for titles to put in it.</p>
                ) : (
                  <>
                    <div>
                      <div className="relative mb-3">
                        <MagnifyingGlassIcon className="w-4 h-4 text-muted absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Search movies and shows to add"
                          aria-label="Search movies and shows to add"
                          className={`${field} pl-10 pr-10`}
                          style={fieldStyle}
                        />
                        {query && (
                          <button type="button" onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg text-muted hover:text-default" aria-label="Clear search">
                            <XMarkIcon className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                      {query.trim().length >= 2 && (
                        searching ? (
                          <div className={resultsRow}>
                            {Array.from({ length: 8 }).map((_, i) => <div key={i} className={`${resultCell} aspect-[2/3] rounded-xl bg-surface-hover animate-pulse`} />)}
                          </div>
                        ) : results.length === 0 ? (
                          <p className="text-sm text-muted">Nothing found for “{query.trim()}”.</p>
                        ) : (
                          <div className={resultsRow}>
                            {results.map((r) => {
                              const added = inCollection.has(r.id);
                              return (
                                <div key={`${r.type}-${r.id}`} className={`relative ${resultCell}`}>
                                  <PosterCard
                                    item={toPosterItem(r)}
                                    onOpenDetails={() => setDetail({ id: r.id, type: r.type, name: r.name, poster: r.poster })}
                                    onToggleWatchlist={noop}
                                    onToggleWatched={noop}
                                    showWatchlistMenu={false}
                                    showWatchedMenu={false}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => (added ? undefined : addTitle(r))}
                                    disabled={busyTitle === r.id || added}
                                    className={`absolute top-1.5 right-1.5 z-10 w-8 h-8 rounded-full flex items-center justify-center shadow transition-colors ${added ? 'bg-primary' : 'bg-black/70 hover:bg-primary'}`}
                                    aria-label={added ? `${r.name} is in this collection` : `Add ${r.name}`}
                                    title={added ? 'In this collection' : 'Add to this collection'}
                                  >
                                    {added ? <CheckIcon className="w-4 h-4 text-white" /> : <PlusIcon className="w-4 h-4 text-white" />}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )
                      )}
                    </div>

                    <div>
                      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 sm:gap-3 mb-3">
                        <h2 className="text-base font-semibold text-default">In this collection</h2>
                        {titles.length > 0 && <p className="text-xs text-muted">Drag to reorder · hold or right-click a title to remove it</p>}
                      </div>
                      {lists === null ? (
                        <div className={grid}>
                          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="aspect-[2/3] rounded-xl bg-surface-hover animate-pulse" />)}
                        </div>
                      ) : titles.length === 0 ? (
                        <Card padding="lg">
                          <p className="text-sm text-muted text-center">
                            Nothing in it yet. Search above, or use Add to Catalogs on any title in Discover{home ? ` and pick “${home.name}”` : ''}.
                          </p>
                        </Card>
                      ) : (
                        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} onDragCancel={() => { draggedAt.current = Date.now(); }}>
                          <SortableContext items={titles.map((t) => t.id)} strategy={rectSortingStrategy}>
                            <div className={grid}>
                              {titles.map((t) => (
                                <TitleTile key={t.id} t={t} onOpen={() => openTitle(t)} onRemove={() => removeTitle(t)} menuOpen={menuTitleId === t.id} onMenuOpenChange={onMenuOpenChange} />
                              ))}
                            </div>
                          </SortableContext>
                        </DndContext>
                      )}
                    </div>

                    <div className="rounded-2xl border border-default">
                      <button type="button" onClick={() => setShowSources((v) => !v)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={showSources}>
                        <span>
                          <span className="block text-sm font-medium text-default">Built from catalogs</span>
                          <span className="block text-xs text-muted">
                            {form.catalogIds.map((id) => catalogs.find((c) => c.id === id)?.name).filter(Boolean).join(', ') || 'None'}
                            {' '}- new titles go into {home ? `“${home.name}”` : 'the first one'}
                          </span>
                        </span>
                        <ChevronDownIcon className={`w-4 h-4 text-muted shrink-0 transition-transform ${showSources ? 'rotate-180' : ''}`} />
                      </button>
                      {showSources && (
                        <div className="px-4 pb-4">
                          <p className="text-xs text-muted mb-3">Pick more catalogs to show their titles here too.</p>
                          <div className={grid}>
                            {catalogs.map((cat) => {
                              const on = form.catalogIds.includes(cat.id);
                              return (
                                <button
                                  key={cat.id}
                                  type="button"
                                  onClick={() => toggleCatalog(cat.id)}
                                  aria-pressed={on}
                                  className={`group text-left rounded-xl overflow-hidden border transition-colors ${on ? 'border-primary ring-2 ring-primary/60' : 'border-default hover:border-primary/50'}`}
                                >
                                  <div className="relative aspect-[2/3] bg-surface-hover">
                                    {cat.cover
                                      // eslint-disable-next-line @next/next/no-img-element
                                      ? <img src={cat.cover} alt="" className={`absolute inset-0 w-full h-full object-cover transition-opacity ${on ? '' : 'opacity-50 group-hover:opacity-90'}`} />
                                      : <div className="absolute inset-0 flex items-center justify-center"><Squares2X2Icon className="w-8 h-8 text-muted" /></div>}
                                    {on && (
                                      <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-primary flex items-center justify-center shadow">
                                        <CheckIcon className="w-4 h-4 text-white" />
                                      </span>
                                    )}
                                  </div>
                                  <div className="p-1.5">
                                    <p className="text-[11px] font-medium text-default truncate">{cat.name}</p>
                                    <p className="text-[10px] text-muted">{cat.titles} title{cat.titles === 1 ? '' : 's'}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </PageSection>
        </div>
      </div>

      {detail && (
        <MediaDetailModal
          isOpen={!!detail}
          onClose={() => setDetail(null)}
          itemId={detail.id}
          itemType={detail.type}
          fallbackTitle={detail.name}
          fallbackPoster={detail.poster || undefined}
        />
      )}

      <ConfirmModal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={remove}
        title={`Remove ${form.name.trim() || 'this collection'}?`}
        description="It stops showing in AIOStreams' apps. Its titles stay in their catalogs."
        confirmText="Remove"
      />
    </>
  );
}
