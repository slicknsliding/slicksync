'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import {
  Card, Button, Modal, ConfirmModal, MediaDetailModal, PosterCard, PosterCardItem,
  SelectionCheckbox, SelectAllCheckbox,
  DndContext, closestCenter, SortableContext, useSortable, useSortableSensors, CSS,
} from '@/components/ui';
import { rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { AvatarPickerModal } from '@/components/modals/AvatarPickerModal';
import { AnimatePresence, motion } from 'framer-motion';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import { api, CustomList, CustomListItem, CatalogSuggestion, RatingsBatchEntry } from '@/lib/api';
import { useRatingsBatch } from '@/lib/hooks/useRatingsBatch';
import { useWatchlistState } from '@/lib/hooks/useWatchlistState';
import { useWatchedStatusBatch } from '@/lib/hooks/useWatchedStatusBatch';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import {
  RectangleStackIcon, PencilSquareIcon, TrashIcon, XMarkIcon, ArrowLeftIcon, SparklesIcon, PhotoIcon,
  CheckCircleIcon, XCircleIcon, ArrowUpTrayIcon,
} from '@heroicons/react/24/outline';

// Matches AvatarPickerModal's own color-swatch formula exactly (also used by
// the Catalogs index card), so a catalog's solid-color cover looks identical
// on both surfaces.
function coverColorStyle(colorIndex: number): React.CSSProperties {
  return { background: `color-mix(in srgb, var(--color-${colorIndex < 4 ? 'primary' : 'secondary'}) ${100 - (colorIndex % 4) * 25}%, white)` };
}

// PosterCard only needs this narrowed shape (see its own comment) - a
// Catalog item's `year` becomes PosterCard's `releaseInfo` string, matching
// how Discover already formats Cinemeta's own releaseInfo field.
function toPosterCardItem(item: CustomListItem): PosterCardItem {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster ?? null,
    releaseInfo: item.year ? String(item.year) : null,
  };
}

// One grid cell: PosterCard + the catalog-only remove button, always wired
// through useSortable (disabled outside "List order" sort / select mode -
// see canReorder) rather than branching between a sortable and plain render
// path, since dnd-kit's own `disabled` option already makes a no-op drag
// handle behave like a normal card with zero extra logic here.
function CatalogGridCard({
  item, ratings, watched, inWatchlist, showWatchlistMenu, showWatchlistBadge,
  showWatchedMenu, showWatchedBadge, onOpenDetails, onToggleWatchlist, onToggleWatched,
  isMenuOpen, onMenuOpenChange, onRemove, selectMode, isSelected, onToggleSelect, disabled,
}: {
  item: CustomListItem;
  ratings?: RatingsBatchEntry;
  watched?: boolean;
  inWatchlist: boolean;
  showWatchlistMenu: boolean;
  showWatchlistBadge: boolean;
  showWatchedMenu: boolean;
  showWatchedBadge: boolean;
  onOpenDetails: () => void;
  onToggleWatchlist: (next: boolean) => void;
  onToggleWatched: (next: boolean) => void;
  isMenuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onRemove: () => void;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 50 : undefined,
  };
  const pcItem = toPosterCardItem(item);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative group ${isDragging ? 'opacity-50' : ''}`}
      {...(disabled ? {} : { ...attributes, ...listeners })}
    >
      <PosterCard
        item={pcItem}
        ratings={ratings}
        watched={watched}
        inWatchlist={inWatchlist}
        showWatchlistMenu={showWatchlistMenu && !selectMode}
        showWatchlistBadge={showWatchlistBadge && !selectMode}
        showWatchedMenu={showWatchedMenu && !selectMode}
        showWatchedBadge={showWatchedBadge && !selectMode}
        onOpenDetails={() => (selectMode ? onToggleSelect() : onOpenDetails())}
        onToggleWatchlist={(_, next) => onToggleWatchlist(next)}
        onToggleWatched={(_, next) => onToggleWatched(next)}
        isMenuOpen={isMenuOpen}
        onMenuOpenChange={onMenuOpenChange}
      />
      {selectMode ? (
        <div className="absolute top-1.5 left-1.5 z-20">
          <SelectionCheckbox checked={isSelected} onChange={onToggleSelect} visible />
        </div>
      ) : (
        // Remove-from-this-catalog - deliberately kept as its own always-
        // there hover affordance rather than folded into PosterCard's own
        // (Discover-owned) context menu, which has no notion of "this
        // specific catalog". Shares the same top-right corner as PosterCard's
        // watched badge - on hover it renders on top of it, which reads fine
        // since the badge is decorative and this is a deliberate action.
        <button
          type="button"
          title="Remove from catalog"
          onClick={onRemove}
          className="absolute top-1.5 right-1.5 z-10 flex items-center justify-center rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ width: 24, height: 24 }}
        >
          <XMarkIcon className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// Mirrors Discover's own sort options - "List order" here instead of
// "Default order" since that's what it actually is (items in the order they
// were added), not a server-side catalog sort.
const SORT_OPTIONS = [
  { key: 'default', label: 'List order' },
  { key: 'title', label: 'Title (A-Z)' },
  { key: 'year-desc', label: 'Year (Newest)' },
  { key: 'year-asc', label: 'Year (Oldest)' },
  { key: 'rating-desc', label: 'Rating (Highest)' },
] as const;
type SortKey = typeof SORT_OPTIONS[number]['key'];

// A list's own page (roadmap #7 follow-up) - opening a list is a destination,
// not a transient popup, so it gets a real route (/catalogs/[id]) with a URL you
// can bookmark/share/back-button out of, same as /groups/[id] or /users/[id].
// Individual titles inside still open the shared MediaDetailModal - that part
// IS a quick preview, unlike the list itself.
export default function ListDetailPage() {
  const { layoutMode } = useLayoutMode();
  const params = useParams();
  const router = useRouter();
  const listId = params.id as string;

  const [list, setList] = useState<CustomList | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [detail, setDetail] = useState<CustomListItem | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('default');
  // Suggest-titles (opt-in, never automatic): opens a review panel of
  // TMDb-sourced candidates for this catalog's theme; nothing is added
  // until the user explicitly picks titles and confirms.
  const [suggesting, setSuggesting] = useState(false);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<CatalogSuggestion[]>([]);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(new Set());
  const [addingSuggestions, setAddingSuggestions] = useState(false);
  // Which poster's right-click menu is open — same lifted single-open-menu
  // pattern Discover uses for its own grid.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [showCoverPicker, setShowCoverPicker] = useState(false);
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ name: string; slug: string | null; added: number | null; existing: number | null; notFound: number | null } | null>(null);
  // Bulk select - mirrors the Set<string> + floating-action-bar pattern from
  // users/page.tsx. Entering select mode hides PosterCard's own badges/menu
  // on every card (see CatalogGridCard below) so a tap toggles selection
  // instead of opening details.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const { enableWatchlist, enableWatchedIndicators } = usePersonalFeatures();
  const { inWatchlistIds, toggleWatchlist } = useWatchlistState();
  const { watchedStatus, toggleWatched } = useWatchedStatusBatch((list?.items || []).map((i) => i.id), enableWatchedIndicators);

  const ratingsById = useRatingsBatch((list?.items || []).map((i) => i.id));
  const sortedItems = !list ? [] : sortBy === 'default' ? list.items : [...list.items].sort((a, b) => {
    if (sortBy === 'title') return a.name.localeCompare(b.name);
    if (sortBy === 'year-desc') return (Number(b.year) || 0) - (Number(a.year) || 0);
    if (sortBy === 'year-asc') return (Number(a.year) || 0) - (Number(b.year) || 0);
    const ratingOf = (i: CustomListItem) => parseFloat(ratingsById[i.id]?.imdbRating || '0') || 0;
    return ratingOf(b) - ratingOf(a);
  });

  const load = useCallback(() => {
    setIsLoading(true);
    api.getLists()
      .then((all) => {
        const found = all.find((l) => l.id === listId) || null;
        setList(found);
        setNotFound(!found);
      })
      .catch(() => setNotFound(true))
      .finally(() => setIsLoading(false));
  }, [listId]);
  useEffect(() => { if (listId) load(); }, [listId, load]);

  const handleRename = async () => {
    if (!list) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      const updated = await api.updateList(list.id, { name });
      setList(updated);
      setRenaming(false);
      toast.success('Renamed');
    } catch { toast.error('Failed to rename'); }
  };

  const handleDelete = async () => {
    if (!list) return;
    try {
      await api.deleteList(list.id);
      toast.success(`Deleted "${list.name}"`);
      router.push('/catalogs');
    } catch { toast.error('Failed to delete'); }
  };

  const handleCoverSave = async (data: { avatarUrl?: string | null; colorIndex?: number }) => {
    if (!list) return;
    const patch: { coverImageUrl?: string | null; coverColorIndex?: number | null } = {};
    if ('avatarUrl' in data) patch.coverImageUrl = data.avatarUrl ?? null;
    if ('colorIndex' in data) patch.coverColorIndex = data.colorIndex ?? null;
    const updated = await api.updateList(list.id, patch);
    setList(updated);
  };

  const handleExportToMdblist = async () => {
    if (!list) return;
    setExporting(true);
    try {
      const result = await api.exportListToMdblist(list.id);
      setShowExportConfirm(false);
      setExportResult(result);
      toast.success(`Exported "${list.name}" to MDBList`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to export to MDBList');
    } finally {
      setExporting(false);
    }
  };

  const handleRemoveItem = async (item: CustomListItem) => {
    if (!list) return;
    const updated = { ...list, items: list.items.filter((i) => i.id !== item.id) };
    setList(updated);
    try { await api.removeFromList(list.id, item.id); }
    catch { toast.error('Failed to remove'); load(); }
  };

  const toggleSelectItem = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (!list) return;
    setIsBulkDeleting(true);
    const ids = Array.from(selectedIds);
    let success = 0;
    for (const id of ids) {
      try { await api.removeFromList(list.id, id); success++; }
      catch (err) { console.error('Failed to remove item:', err); }
    }
    setIsBulkDeleting(false);
    setShowBulkDeleteConfirm(false);
    if (success > 0) toast.success(`Removed ${success} title${success !== 1 ? 's' : ''}`);
    exitSelectMode();
    load();
  }, [list, selectedIds, exitSelectMode, load]);

  const sensors = useSortableSensors();
  // Manual reorder only makes sense against the list's own stored order -
  // dragging a card while it's sorted by title/year/rating would visually
  // reorder the SORTED view but silently write a different underlying
  // itemsJson order, which reads as broken the next time sort resets to
  // "List order". Also off during select mode so a drag gesture can't
  // fight with tap-to-select.
  const canReorder = sortBy === 'default' && !selectMode && sortedItems.length > 1;

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    if (!list || !canReorder) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = list.items.findIndex((i) => i.id === active.id);
    const newIndex = list.items.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(list.items, oldIndex, newIndex);
    const previous = list;
    // Optimistic - reorder locally immediately, revert if the server's
    // same-id-set check rejects it (e.g. a concurrent add/remove elsewhere).
    setList({ ...list, items: reordered });
    try {
      await api.reorderListItems(list.id, reordered.map((i) => i.id));
    } catch (e: any) {
      setList(previous);
      toast.error(e?.message || 'Failed to save new order');
    }
  }, [list, canReorder]);

  const handleOpenSuggest = async () => {
    if (!list) return;
    setSuggesting(true);
    setLoadingSuggestions(true);
    setSelectedSuggestionIds(new Set());
    try {
      const res = await api.suggestCatalogTitles(list.id);
      setSuggestions(res.suggestions);
      // Pre-select everything - reviewing and unchecking the odd miss is
      // faster than starting from nothing and checking each one.
      setSelectedSuggestionIds(new Set(res.suggestions.map((s) => s.id)));
    } catch (e: any) {
      toast.error(e.message || 'Failed to get suggestions');
      setSuggesting(false);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleAddSelectedSuggestions = async () => {
    if (!list) return;
    const toAdd = suggestions.filter((s) => selectedSuggestionIds.has(s.id));
    if (toAdd.length === 0) { setSuggesting(false); return; }
    setAddingSuggestions(true);
    try {
      for (const item of toAdd) {
        await api.addToList(list.id, item);
      }
      toast.success(`Added ${toAdd.length} title${toAdd.length !== 1 ? 's' : ''}`);
      setSuggesting(false);
      load();
    } catch {
      toast.error('Some titles failed to add');
      load();
    } finally {
      setAddingSuggestions(false);
    }
  };

  const title = isLoading ? 'Loading…' : notFound ? 'Catalog not found' : (list?.name || 'Catalog');
  const subtitle = isLoading ? '' : notFound ? '' : `${list?.items.length || 0} title${list?.items.length !== 1 ? 's' : ''}`;

  // Explicit navigation to /catalogs (not router.back()) - back should always
  // land on the Catalogs index in one hop, regardless of how this page was
  // reached, per feedback that clicking "Catalogs" in the nav to get back felt
  // like backtracking.
  const backButton = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={() => router.push('/catalogs')}>
      Back
    </Button>
  );

  // Nebula: Back sits alone in the heading's left column (see `leading`
  // below) - Rename/Delete stay grouped with the bell on the right, since
  // "leave this list" reads as a different kind of action from "edit it".
  // The sidebar Header below has no such left column, so it keeps Back
  // bundled with the other actions - there's nothing to separate it from.
  const editActions = list && !isLoading && !notFound ? (
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="sm" leftIcon={<SparklesIcon className="w-4 h-4" />} onClick={handleOpenSuggest}>
        Suggest titles
      </Button>
      <Button variant="secondary" size="sm" leftIcon={<PhotoIcon className="w-4 h-4" />} onClick={() => setShowCoverPicker(true)}>
        Cover art
      </Button>
      <Button variant="secondary" size="sm" leftIcon={<PencilSquareIcon className="w-4 h-4" />} onClick={() => { setRenameValue(list.name); setRenaming(true); }}>
        Rename
      </Button>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<ArrowUpTrayIcon className="w-4 h-4" />}
        onClick={() => setShowExportConfirm(true)}
        disabled={list.items.length === 0}
        title={list.items.length === 0 ? 'Add titles first' : undefined}
      >
        Export to MDBList
      </Button>
      <Button variant="danger" size="sm" leftIcon={<TrashIcon className="w-4 h-4" />} onClick={() => setDeleting(true)}>
        Delete
      </Button>
    </div>
  ) : null;

  const detailActions = editActions ? (
    <div className="flex items-center gap-2">
      {backButton}
      {editActions}
    </div>
  ) : backButton;

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={
            <Breadcrumbs
              items={[{ label: 'Catalogs', href: '/catalogs' }, { label: title }]}
              className="text-xl font-semibold"
            />
          }
          subtitle={subtitle}
          actions={detailActions}
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
        {layoutMode === 'nebula' && (
          <NebulaPageHeading title={title} subtitle={subtitle || 'Catalogs'} leading={backButton} actions={editActions} />
        )}

        {/* Cover banner - only rendered once a custom cover is actually set;
            this page never had a collage/placeholder here before, so there's
            nothing to "fall back" to otherwise (unlike the index card). */}
        {list && (list.coverImageUrl || list.coverColorIndex !== null) && (
          <div className="mb-6 h-32 md:h-40 rounded-xl overflow-hidden">
            {list.coverImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={list.coverImageUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full" style={coverColorStyle(list.coverColorIndex!)} />
            )}
          </div>
        )}

        <PageSection>
          {notFound ? (
            <Card padding="lg" className="text-center">
              <RectangleStackIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
              <p className="text-sm text-muted">This catalog doesn&apos;t exist (it may have been deleted).</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => router.push('/catalogs')}>Back to Catalogs</Button>
            </Card>
          ) : isLoading ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="aspect-[2/3] rounded-md bg-surface-hover animate-pulse" />
              ))}
            </div>
          ) : list && list.items.length === 0 ? (
            <Card padding="lg" className="text-center">
              <RectangleStackIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
              <p className="text-sm text-muted">No titles yet.</p>
              <p className="text-xs text-subtle mt-1">Open any movie or show and use &quot;Add to catalog&quot;.</p>
            </Card>
          ) : list ? (
            <>
              {list.items.length > 1 && (
                <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    {selectMode ? (
                      <>
                        <SelectAllCheckbox
                          totalCount={sortedItems.length}
                          selectedCount={selectedIds.size}
                          onSelectAll={() => setSelectedIds(new Set(sortedItems.map((i) => i.id)))}
                          onDeselectAll={() => setSelectedIds(new Set())}
                        />
                        <span className="text-xs text-muted">{selectedIds.size} of {sortedItems.length} selected</span>
                      </>
                    ) : (
                      <Button variant="ghost" size="sm" leftIcon={<CheckCircleIcon className="w-4 h-4" />} onClick={() => setSelectMode(true)}>
                        Select
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {selectMode && (
                      <Button variant="ghost" size="sm" leftIcon={<XCircleIcon className="w-4 h-4" />} onClick={exitSelectMode}>
                        Cancel
                      </Button>
                    )}
                    <span className="text-xs text-muted">Sort:</span>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as SortKey)}
                      aria-label="Sort list"
                      className="px-2.5 py-1 rounded-md text-xs font-medium bg-surface-hover text-muted hover:text-default border border-default cursor-pointer"
                    >
                      {SORT_OPTIONS.map((opt) => (
                        <option key={opt.key} value={opt.key}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {!selectMode && sortBy !== 'default' && (
                <p className="text-xs text-subtle mb-3">Switch to List order to drag-reorder titles.</p>
              )}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={sortedItems.map((i) => i.id)} strategy={rectSortingStrategy}>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                    {sortedItems.map((item) => (
                      <CatalogGridCard
                        key={item.id}
                        item={item}
                        ratings={ratingsById[item.id]}
                        watched={watchedStatus[item.id]}
                        inWatchlist={inWatchlistIds.has(item.id)}
                        showWatchlistMenu={enableWatchlist}
                        showWatchlistBadge={enableWatchlist}
                        showWatchedMenu={enableWatchedIndicators}
                        showWatchedBadge={enableWatchedIndicators}
                        onOpenDetails={() => setDetail(item)}
                        onToggleWatchlist={(next) => toggleWatchlist(toPosterCardItem(item), next)}
                        onToggleWatched={(next) => toggleWatched(toPosterCardItem(item), next)}
                        isMenuOpen={openMenuKey === item.id}
                        onMenuOpenChange={(open) => setOpenMenuKey(open ? item.id : null)}
                        onRemove={() => handleRemoveItem(item)}
                        selectMode={selectMode}
                        isSelected={selectedIds.has(item.id)}
                        onToggleSelect={() => toggleSelectItem(item.id)}
                        disabled={!canReorder}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </>
          ) : null}
        </PageSection>
      </div>
      </div>

      {/* Floating bulk-action bar - same pattern as users/page.tsx. */}
      <AnimatePresence>
        {selectMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50"
          >
            <div className="flex items-center gap-4 px-6 py-4 rounded-2xl shadow-2xl bg-surface border border-default backdrop-blur-xl">
              <div className="flex items-center gap-2 pr-4 border-r border-default">
                <div className="w-8 h-8 rounded-lg bg-primary-muted flex items-center justify-center">
                  <span className="text-sm font-bold text-primary">{selectedIds.size}</span>
                </div>
                <span className="text-sm text-muted">selected</span>
              </div>
              <Button variant="danger" size="sm" leftIcon={<TrashIcon className="w-4 h-4" />} onClick={() => setShowBulkDeleteConfirm(true)}>
                Remove
              </Button>
              <button
                onClick={exitSelectMode}
                className="p-2 rounded-lg text-muted hover:bg-surface-hover transition-colors"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmModal
        isOpen={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        onConfirm={handleBulkDelete}
        title="Remove titles"
        description={`Remove ${selectedIds.size} title${selectedIds.size !== 1 ? 's' : ''} from "${list?.name}"? This removes them from this catalog only — nothing about your watch history changes.`}
        confirmText={isBulkDeleting ? 'Removing...' : 'Remove'}
        variant="danger"
        isLoading={isBulkDeleting}
      />

      <ConfirmModal
        isOpen={showExportConfirm}
        onClose={() => setShowExportConfirm(false)}
        onConfirm={handleExportToMdblist}
        title="Export to MDBList"
        description={`This creates a new, separate MDBList list from "${list?.name}"'s ${list?.items.length || 0} title${list?.items.length !== 1 ? 's' : ''}. SlickSync can create the list, but adding it as a catalog inside an addon (e.g. AIOMetadata) is a manual step in that addon's own settings afterward.`}
        confirmText={exporting ? 'Exporting...' : 'Export'}
        isLoading={exporting}
      />

      {/* Export result - no guessed public-list link (MDBList's URL shape for
          a freshly created list isn't confirmed), just what the API actually
          returned plus a link to the account's own MDBList dashboard. */}
      <Modal isOpen={!!exportResult} onClose={() => setExportResult(null)} title="Exported to MDBList" size="sm">
        {exportResult && (
          <div className="space-y-3">
            <p className="text-sm text-default">Created <span className="font-semibold">{exportResult.name}</span> on MDBList.</p>
            <div className="text-xs text-muted space-y-1">
              <p>{exportResult.added ?? '?'} added{exportResult.existing ? `, ${exportResult.existing} already existed` : ''}{exportResult.notFound ? `, ${exportResult.notFound} not found on MDBList` : ''}.</p>
            </div>
            <a
              href="https://mdblist.com/lists"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline inline-block"
            >
              Open your MDBList lists →
            </a>
            <div className="flex justify-end pt-2">
              <Button variant="ghost" size="sm" onClick={() => setExportResult(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={renaming} onClose={() => setRenaming(false)} title="Rename list" size="sm">
        <div className="space-y-4">
          <input
            autoFocus
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
            className="w-full px-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleRename} disabled={!renameValue.trim()}>Save</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={deleting} onClose={() => setDeleting(false)} title="Delete list" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">Delete <span className="font-medium text-default">{list?.name}</span>? This removes the list only — nothing about your watch history changes.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
          </div>
        </div>
      </Modal>

      {/* Suggest titles - purely a review step. Opening this never adds
          anything; only "Add selected" below does. */}
      <Modal isOpen={suggesting} onClose={() => setSuggesting(false)} title={`Suggest titles for "${list?.name || ''}"`} size="lg">
        <div className="space-y-4">
          {loadingSuggestions ? (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-3">
              {[...Array(10)].map((_, i) => (
                <div key={i} className="aspect-[2/3] rounded-md bg-surface-hover animate-pulse" />
              ))}
            </div>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-muted text-center py-6">
              No matches found for &quot;{list?.name}&quot; — try renaming the catalog to something more specific (e.g. &quot;Halloween&quot;, &quot;Christmas&quot;) and suggest again.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted">
                {selectedSuggestionIds.size} of {suggestions.length} selected — uncheck anything that doesn&apos;t belong, nothing is added until you confirm.
              </p>
              <div className="grid grid-cols-4 sm:grid-cols-5 gap-3 max-h-[50vh] overflow-y-auto pr-1">
                {suggestions.map((s) => {
                  const checked = selectedSuggestionIds.has(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setSelectedSuggestionIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                          return next;
                        });
                      }}
                      className={`relative text-left rounded-md overflow-hidden aspect-[2/3] bg-surface-hover border-2 transition-colors ${checked ? 'border-primary' : 'border-transparent'}`}
                    >
                      {s.poster ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.poster} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-xs text-subtle p-1 text-center">{s.name}</div>
                      )}
                      <div className={`absolute inset-0 transition-colors ${checked ? 'bg-primary/20' : 'bg-black/0 hover:bg-black/20'}`} />
                      <div className={`absolute top-1 right-1 w-4 h-4 rounded-sm border flex items-center justify-center ${checked ? 'bg-primary border-primary' : 'bg-black/50 border-white/60'}`}>
                        {checked && <span className="text-white text-[10px] leading-none">✓</span>}
                      </div>
                      <p className="absolute bottom-0 inset-x-0 px-1 py-0.5 text-[10px] text-white bg-gradient-to-t from-black/80 to-transparent truncate">
                        {s.name}{s.year ? ` (${s.year})` : ''}
                      </p>
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setSuggesting(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAddSelectedSuggestions}
                  isLoading={addingSuggestions}
                  disabled={selectedSuggestionIds.size === 0}
                >
                  Add {selectedSuggestionIds.size || ''} title{selectedSuggestionIds.size !== 1 ? 's' : ''}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {detail && (
        <MediaDetailModal
          isOpen={!!detail}
          onClose={() => setDetail(null)}
          itemId={detail.id}
          itemType={detail.type}
          fallbackTitle={detail.name}
          fallbackPoster={detail.poster || undefined}
          fallbackRating={ratingsById[detail.id]?.imdbRating}
          fallbackRottenTomatoes={ratingsById[detail.id]?.rottenTomatoes}
          fallbackMetacritic={ratingsById[detail.id]?.metacritic}
        />
      )}

      {list && showCoverPicker && (
        <AvatarPickerModal
          isOpen={showCoverPicker}
          onClose={() => setShowCoverPicker(false)}
          name={list.name}
          currentAvatarUrl={list.coverImageUrl}
          currentColorIndex={list.coverColorIndex ?? 0}
          onSave={handleCoverSave}
        />
      )}
    </>
  );
}
