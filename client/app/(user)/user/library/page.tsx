'use client';

import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MagnifyingGlassIcon,
  FilmIcon,
  TvIcon,
  TrashIcon,
  PlayIcon,
  ClockIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';
import { useUserAuth, useUserAuthHeaders } from '@/lib/hooks/useUserAuth';
import { userLibrary, LibraryItem } from '@/lib/user-api';
import { UserPageHeader } from '@/components/user/UserPageContainer';
import { buildStremioAppUrl, buildNuvioAppUrl } from '@/lib/appLinks';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useArtworkFallback } from '@/lib/hooks/useArtworkFallback';
import { useDefaultViewMode } from '@/lib/viewMode';
import { usePageArrangement, usePageDesign } from '@/lib/arrange';
import { MeLibraryV2, LIBRARY_SECTIONS, type LibraryFilter } from '@/components/v2/MeLibraryV2';
import { providerTypeLabel } from '@/lib/providers';
import { V2MoreMenu, type V2MenuItem } from '@/components/v2/V2Detail';
import { AnchoredConfirm, libraryDeleteLine } from '@/components/ui/AnchoredConfirm';
import { TVPageProvider } from '@/components/tv/TVPageProvider';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { setFocus } from '@noriginmedia/norigin-spatial-navigation';

// Format watch time from milliseconds to human-readable string
function formatWatchTime(ms: number | undefined | null): string | null {
  if (!ms || ms <= 0) return null;
  
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  }
  return null;
}

// The poster the library gave, then the same title's poster by its IMDb id.
function posterCandidates(item: LibraryItem): string[] {
  const imdbId = /^tt\d+$/.test(item._id) ? item._id : null;
  return [item.poster, imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : null].filter((u): u is string => !!u);
}

// Card item component
interface LibraryCardItemProps {
  item: LibraryItem;
  isSelected: boolean;
  isDeleting: boolean;
  onToggle: () => void;
  onDelete: () => void;
  // Nuvio's API has no library-removal capability (see server/providers/
  // nuvio.js's removeLibraryItem stub) - defaults true so every existing
  // Stremio call site is unaffected.
  canDelete?: boolean;
  stremioLink: string | null;
  watchTime: string | null;
  /** "Open in Stremio" in the ⋯ menu; null when their app has no link. */
  appName: string | null;
  /** The line under "Delete …?" that names their app. */
  deleteLine?: string;
  isTV: boolean;
}

function LibraryCardItem({ item, isSelected, isDeleting, onToggle, onDelete, canDelete = true, stremioLink, watchTime, appName, deleteLine, isTV }: LibraryCardItemProps) {
  const { url: poster, onError: onPosterError } = useArtworkFallback(posterCandidates(item));
  const menuKey = `library-more-${item._id}`;

  // The ⋯ on every poster, always showing (a hover-only bin could not be
  // found on a phone or reached with a TV remote). Deleting asks first.
  const menu: V2MenuItem[] = [];
  if (stremioLink && appName) menu.push({ label: `Open in ${appName}`, icon: <PlayIcon className="w-4 h-4" />, onClick: () => { window.location.href = stremioLink; } });
  if (canDelete) {
    menu.push({ label: isSelected ? 'Deselect' : 'Select', icon: <CheckIcon className="w-4 h-4" />, onClick: onToggle });
    menu.push({ label: 'Delete from library', icon: <TrashIcon className="w-4 h-4" />, danger: true, disabled: isDeleting, onClick: onDelete, confirm: { title: `Delete ${item.name}?`, line: deleteLine } });
  }

  const card = (
    <>
      {/* Poster Card */}
      <div
        className={`relative aspect-[2/3] rounded-xl overflow-hidden shadow-xl ${isSelected ? 'bd3-sel' : 'bd-ok'}`}
      >
        {poster ? (
          <>
            <img
              src={poster}
              alt={item.name}
              className="w-full h-full object-cover transition-all duration-700 group-hover:scale-110"
              onError={onPosterError}
            />
            {/* Gradient overlay - subtle */}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/50 to-transparent opacity-40 group-hover:opacity-60 transition-opacity" />
          </>
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: 'var(--color-surface-elevated)' }}
          >
            {item.type === 'movie' ? (
              <FilmIcon className="w-12 h-12" style={{ color: 'var(--color-text-subtle)' }} />
            ) : (
              <TvIcon className="w-12 h-12" style={{ color: 'var(--color-text-subtle)' }} />
            )}
          </div>
        )}

        {/* Selection indicator - top left */}
        {isSelected && (
          <div
            className="absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center"
            style={{ background: 'var(--color-primary)' }}
          >
            <CheckIcon className="w-4 h-4 text-white" />
          </div>
        )}

        {/* Stremio link - top right */}
        {stremioLink && (
          <a
            href={stremioLink}
            onClick={(e) => e.stopPropagation()}
            tabIndex={isTV ? -1 : undefined}
            className="absolute top-2 right-2 p-1.5 rounded-full transition-opacity opacity-80 hover:opacity-100"
            style={{ background: 'rgba(0,0,0,0.7)' }}
            title="Open"
          >
            <PlayIcon className="w-4 h-4 text-white" />
          </a>
        )}

        {isDeleting && (
          <div className="absolute bottom-2 left-2 p-1.5 rounded-full" style={{ background: 'rgba(0,0,0,0.65)' }}>
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Content Info - Below the poster */}
      <div className="mt-2 space-y-0.5 text-center">
        {/* Content title */}
        <h4
          className="font-semibold text-sm leading-tight line-clamp-3 break-words"
          style={{ color: 'var(--color-text-muted)' }}
          title={item.name}
        >
          {item.name}
        </h4>

        {/* Watch time */}
        {watchTime && (
          <div
            className="flex items-center justify-center gap-1 text-xs"
            style={{ color: 'var(--color-text-subtle)' }}
          >
            <ClockIcon className="w-3 h-3" />
            <span>{watchTime}</span>
          </div>
        )}
      </div>
    </>
  );

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ y: -4 }}
      onClick={onToggle}
      className="group relative cursor-pointer"
    >
      {/* TV: Right from a poster goes to its own ⋯ first, then on to the next poster. */}
      {isTV ? (
        <TVFocusable
          onEnterPress={onToggle}
          onArrowPress={(dir) => {
            if (dir !== 'right' || menu.length === 0) return true;
            setFocus(menuKey);
            return false;
          }}
        >
          {card}
        </TVFocusable>
      ) : card}

      {/* The ⋯, over the poster's bottom-right corner. A sibling of the
          poster (not inside it) so on a TV it is its own remote stop. */}
      {menu.length > 0 && (
        <div className="absolute inset-x-0 top-0 aspect-[2/3] pointer-events-none">
          <span
            className="absolute bottom-2 right-2 pointer-events-auto [&_button]:!p-1.5 [&_button]:!rounded-full [&_button]:!bg-black/65 [&_button]:!border-transparent [&_button]:!text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <V2MoreMenu items={menu} label={`${item.name} options`} focusKey={menuKey} />
          </span>
        </div>
      )}
    </motion.div>
  );
}

// List item component
interface LibraryListItemProps {
  item: LibraryItem;
  isSelected: boolean;
  isDeleting: boolean;
  onToggle: () => void;
  onDelete: () => void;
  canDelete?: boolean;
  stremioLink: string | null;
  watchTime: string | null;
  deleteLine?: string;
  isTV: boolean;
}

function LibraryListItem({ item, isSelected, isDeleting, onToggle, onDelete, canDelete = true, stremioLink, watchTime, deleteLine, isTV }: LibraryListItemProps) {
  const { url: poster, onError: onPosterError } = useArtworkFallback(posterCandidates(item));
  // The bin asks first, in a small question right under it.
  const [asking, setAsking] = useState(false);
  const binRef = useRef<HTMLButtonElement>(null);
  const binKey = `library-bin-${item._id}`;

  const about = (
    <>
      {/* Poster */}
      <div className="w-12 h-16 rounded-lg overflow-hidden flex-shrink-0 relative">
        {poster ? (
          <img
            src={poster}
            alt={item.name}
            className="w-full h-full object-cover"
            onError={onPosterError}
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: 'var(--color-surface-elevated)' }}
          >
            {item.type === 'movie' ? (
              <FilmIcon className="w-5 h-5" style={{ color: 'var(--color-text-subtle)' }} />
            ) : (
              <TvIcon className="w-5 h-5" style={{ color: 'var(--color-text-subtle)' }} />
            )}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {item.type === 'movie' ? (
            <FilmIcon className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-primary)' }} />
          ) : (
            <TvIcon className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-secondary)' }} />
          )}
          <span
            className="font-medium truncate"
            style={{ color: 'var(--color-text)' }}
          >
            {item.name}
          </span>
        </div>

        {/* Watch time */}
        {watchTime && (
          <div className="mt-2 flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            <ClockIcon className="w-3 h-3" />
            <span>{watchTime}</span>
          </div>
        )}
      </div>
    </>
  );

  const open = stremioLink && (
    <a
      href={stremioLink}
      tabIndex={isTV ? -1 : undefined}
      className="p-2 rounded-lg transition-colors"
      style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-muted)' }}
      title="Open"
    >
      <PlayIcon className="w-4 h-4" />
    </a>
  );
  const askDelete = () => { if (!isDeleting) setAsking((v) => !v); };
  const bin = canDelete && (
    <button
      ref={binRef}
      onClick={askDelete}
      disabled={isDeleting}
      tabIndex={isTV ? -1 : undefined}
      className="p-2 rounded-lg transition-all"
      style={{ background: 'var(--color-error-muted)', color: 'var(--color-error)' }}
      title="Delete"
      aria-label={`Delete ${item.name}`}
    >
      {isDeleting ? (
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        <TrashIcon className="w-4 h-4" />
      )}
    </button>
  );

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ x: 4 }}
      onClick={onToggle}
      className={`flex items-start gap-4 p-4 rounded-xl cursor-pointer transition-colors ${isSelected ? 'bd2-sel' : 'bd-ok'}`}
      style={{
        background: 'var(--color-surface)',
      }}
    >
      {isTV ? (
        <TVFocusable onEnterPress={onToggle} className="flex items-start gap-4 flex-1 min-w-0">{about}</TVFocusable>
      ) : about}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        {open && (isTV ? <TVFocusable onEnterPress={() => { window.location.href = stremioLink!; }}>{open}</TVFocusable> : open)}
        {bin && (isTV ? <TVFocusable focusKey={binKey} onEnterPress={askDelete}>{bin}</TVFocusable> : bin)}
        <AnchoredConfirm
          anchorRef={binRef}
          open={asking}
          ask={{ title: `Delete ${item.name}?`, line: deleteLine }}
          returnFocusKey={binKey}
          onKeep={() => setAsking(false)}
          onConfirm={() => { setAsking(false); onDelete(); }}
        />
      </div>

      {/* Selection indicator */}
      {isSelected && (
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--color-primary)' }}
        >
          <CheckIcon className="w-4 h-4 text-white" />
        </div>
      )}
    </motion.div>
  );
}

// Get watch date from item (used for sorting)
function getWatchDate(item: LibraryItem): Date | null {
  const dates: number[] = [];
  if ((item as any)._mtime) {
    const d = new Date((item as any)._mtime).getTime();
    if (!isNaN(d)) dates.push(d);
  }
  if (item.state?.lastWatched) {
    const d = new Date(item.state.lastWatched).getTime();
    if (!isNaN(d)) dates.push(d);
  }
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates)); // Most recent date
}

export default function UserLibraryPage() {
  const { userId, provider } = useUserAuth();
  const { authKey, isReady } = useUserAuthHeaders();
  // Nuvio's API has no library-removal capability - hide the delete
  // controls entirely for a Nuvio-provider user rather than show them and
  // fail (the server already guards this too, see publicLibrary.js's
  // DELETE /library/:itemId).
  const canDeleteLibraryItems = provider !== 'nuvio';
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Grid or list is one choice in Settings -> Page design; no switch here.
  const { viewMode } = useDefaultViewMode();
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  // v2 (Themes -> Page design): one design for their own pages too.
  const { design } = usePageDesign();
  const isTV = useIsTV();
  const v2 = design === 'v2' && !isTV;
  const v2Arrange = usePageArrangement('library', [...LIBRARY_SECTIONS]);
  const [typeFilter, setTypeFilter] = useState<LibraryFilter>('all');
  const [selecting, setSelecting] = useState(false);
  const Wrapper = isTV ? TVPageProvider : Fragment;
  // Deleting what's picked asks first, in a small question by the Delete button.
  const [askMany, setAskMany] = useState(false);
  const deleteManyRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Fetch library
  useEffect(() => {
    if (!isReady || !userId) return;

    const fetchLibrary = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await userLibrary.getLibrary(userId, authKey || undefined);
        // Filter to only show items that are in the library (not removed)
        // !item.removed handles false, 0, null, undefined
        const activeItems = (result.library || []).filter((item: any) => !item.removed);
        setLibrary(activeItems);
      } catch (err: any) {
        console.error('Failed to load library:', err);
        setError(err.message || 'Failed to load library');
      } finally {
        setLoading(false);
      }
    };

    fetchLibrary();
  }, [userId, authKey, isReady]);

  // Filter, search, and sort library (most recent first)
  const filteredLibrary = useMemo(() => {
    let filtered = library.filter((item) => {
      // Only show items with valid IDs (tt* format)
      const itemId = item._id;
      return typeof itemId === 'string' && itemId.startsWith('tt');
    });

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter((item) =>
        item.name?.toLowerCase().includes(searchLower)
      );
    }

    // Sort by watch date (most recent first)
    filtered.sort((a, b) => {
      const dateA = getWatchDate(a)?.getTime() || 0;
      const dateB = getWatchDate(b)?.getTime() || 0;
      return dateB - dateA;
    });

    return filtered;
  }, [library, search]);

  // Handle item selection
  const handleItemToggle = useCallback((itemId: string) => {
    setSelectedItems((prev) =>
      prev.includes(itemId)
        ? prev.filter((id) => id !== itemId)
        : [...prev, itemId]
    );
  }, []);

  // Select/Deselect all
  const handleSelectAll = useCallback(() => {
    const allIds = filteredLibrary.map((item) => item._id).filter(Boolean);
    setSelectedItems(allIds);
  }, [filteredLibrary]);

  const handleDeselectAll = useCallback(() => {
    setSelectedItems([]);
  }, []);

  // Clear selection when search changes
  useEffect(() => {
    setSelectedItems([]);
  }, [search]);

  // Delete single item
  const handleDeleteItem = async (itemId: string) => {
    if (!userId || deletingIds.has(itemId)) return;

    setDeletingIds((prev) => new Set(prev).add(itemId));
    try {
      await userLibrary.deleteItem(userId, itemId, authKey || undefined);
      setLibrary((prev) => prev.filter((item) => item._id !== itemId));
      setSelectedItems((prev) => prev.filter((id) => id !== itemId));
    } catch (err: any) {
      setError(err.message || 'Failed to delete item');
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  };

  // Delete selected items
  const handleDeleteSelected = async () => {
    if (!userId || selectedItems.length === 0) return;

    const toDelete = [...selectedItems];
    setDeletingIds(new Set(toDelete));

    try {
      await Promise.all(
        toDelete.map((itemId) =>
          userLibrary.deleteItem(userId, itemId, authKey || undefined)
        )
      );
      setLibrary((prev) => prev.filter((item) => !toDelete.includes(item._id)));
      setSelectedItems([]);
    } catch (err: any) {
      setError(err.message || 'Failed to delete items');
    } finally {
      setDeletingIds(new Set());
    }
  };

  // Open in the user's own provider app
  const getStremioLink = (item: LibraryItem): string | null => {
    const itemId = item._id;
    if (!itemId) return null;
    const type = item.type === 'series' ? 'series' : 'movie';
    // Jellyfin apps share no link scheme to open a title with.
    if (provider === 'jellyfin') return null;
    return provider === 'nuvio' ? buildNuvioAppUrl(itemId, type) : buildStremioAppUrl(itemId, type);
  };

  // v2: the search and Everything / Shows / Movies, applied together.
  const v2Items = useMemo(
    () => (typeFilter === 'all' ? filteredLibrary : filteredLibrary.filter((i) => i.type === typeFilter)),
    [filteredLibrary, typeFilter],
  );
  const appLabel = provider === 'nuvio' || provider === 'stremio' ? providerTypeLabel(provider) : null;
  const deleteLine = libraryDeleteLine(provider);
  const openAppUrl = provider === 'nuvio' ? 'nuvio://' : provider === 'stremio' ? 'stremio:///' : null;

  return (
    <Wrapper>
    <div className="p-4 sm:p-8">
      {v2 ? (
        <MeLibraryV2
          items={v2Items}
          total={filteredLibrary.length}
          arrange={v2Arrange}
          view={viewMode}
          search={search}
          onSearch={setSearch}
          filter={typeFilter}
          onFilter={setTypeFilter}
          selecting={selecting}
          onSelecting={setSelecting}
          selected={selectedItems}
          onToggle={handleItemToggle}
          onSelectAll={() => setSelectedItems(v2Items.map((i) => i._id).filter(Boolean))}
          onClear={handleDeselectAll}
          onDeleteSelected={handleDeleteSelected}
          deleting={deletingIds.size > 0}
          canDelete={canDeleteLibraryItems}
          onDeleteOne={handleDeleteItem}
          linkOf={getStremioLink}
          watchTimeOf={(item) => formatWatchTime(item.state?.overallTimeWatched)}
          appName={appLabel}
          openAppUrl={openAppUrl}
          subtitle={`${filteredLibrary.length} ${filteredLibrary.length === 1 ? 'title' : 'titles'}`}
          provider={provider}
        />
      ) : (
      <>
      <UserPageHeader
        title="My Library"
        subtitle={`${filteredLibrary.length} items in your library`}
      />

      {/* Toolbar */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-center gap-2 sm:gap-4 mb-6"
      >
        {/* Search */}
        <div className="relative flex-1 min-w-0">
          <MagnifyingGlassIcon
            className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5"
            style={{ color: 'var(--color-text-muted)' }}
          />
          {(() => {
            const input = (
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by title..."
                tabIndex={isTV ? -1 : undefined}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm"
                style={{
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-surface-border)',
                  color: 'var(--color-text)',
                }}
              />
            );
            return isTV ? <TVFocusable onEnterPress={() => searchRef.current?.focus()}>{input}</TVFocusable> : input;
          })()}
        </div>

        {/* Selection actions */}
        {selectedItems.length > 0 && (
          <div className="flex items-center gap-2 max-sm:order-last max-sm:w-full">
            <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {selectedItems.length} selected
            </span>
            {(() => {
              const clear = (
                <button
                  onClick={handleDeselectAll}
                  tabIndex={isTV ? -1 : undefined}
                  className="px-3 py-2 rounded-lg text-sm font-medium"
                  style={{
                    background: 'var(--color-surface)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  Clear
                </button>
              );
              return isTV ? <TVFocusable onEnterPress={handleDeselectAll}>{clear}</TVFocusable> : clear;
            })()}
            {canDeleteLibraryItems && (() => {
              const ask = () => { if (deletingIds.size === 0) setAskMany((v) => !v); };
              const del = (
                <button
                  ref={deleteManyRef}
                  onClick={ask}
                  disabled={deletingIds.size > 0}
                  tabIndex={isTV ? -1 : undefined}
                  className="px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2"
                  style={{
                    background: 'var(--color-error)',
                    color: 'white',
                  }}
                >
                  <TrashIcon className="w-4 h-4" />
                  Delete
                </button>
              );
              return isTV ? <TVFocusable focusKey="library-delete-picked" onEnterPress={ask}>{del}</TVFocusable> : del;
            })()}
            <AnchoredConfirm
              anchorRef={deleteManyRef}
              open={askMany && selectedItems.length > 0}
              ask={selectedItems.length === 1
                ? { title: 'Delete 1 title?', line: deleteLine }
                : { title: `Delete ${selectedItems.length} titles?`, line: libraryDeleteLine(provider, selectedItems.length), keepLabel: 'Keep them', confirmLabel: `Delete ${selectedItems.length}` }}
              returnFocusKey="library-delete-picked"
              onKeep={() => setAskMany(false)}
              onConfirm={() => { setAskMany(false); handleDeleteSelected(); }}
            />
          </div>
        )}

      </motion.div>

      {/* Select all / Deselect all - selection only exists to enable bulk
          delete above, which isn't available for Nuvio users */}
      {canDeleteLibraryItems && filteredLibrary.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-4 mb-4"
        >
          {(() => {
            const all = selectedItems.length === filteredLibrary.length;
            const btn = (
              <button
                onClick={all ? handleDeselectAll : handleSelectAll}
                tabIndex={isTV ? -1 : undefined}
                className="text-sm font-medium transition-colors hover:opacity-80"
                style={{ color: 'var(--color-primary)' }}
              >
                {all ? 'Deselect All' : 'Select All'}
              </button>
            );
            return isTV ? <TVFocusable onEnterPress={all ? handleDeselectAll : handleSelectAll}>{btn}</TVFocusable> : btn;
          })()}
        </motion.div>
      )}

      </>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div
            className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent' }}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="p-4 rounded-xl text-center mb-6"
          style={{ background: 'var(--color-error-muted)', color: 'var(--color-error)' }}
        >
          {error}
        </motion.div>
      )}

      {/* Empty state */}
      {!loading && !error && filteredLibrary.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center py-20"
        >
          <FilmIcon
            className="w-16 h-16 mx-auto mb-4"
            style={{ color: 'var(--color-text-subtle)' }}
          />
          <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
            {search ? 'No matching items' : 'Your library is empty'}
          </h3>
          <p style={{ color: 'var(--color-text-muted)' }}>
            {search
              ? 'Try adjusting your search terms'
              : 'Start watching content on Stremio to see it here'}
          </p>
        </motion.div>
      )}

      {/* Library - flat list, no date grouping */}
      {!v2 && !loading && !error && filteredLibrary.length > 0 && (
        viewMode === 'grid' ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3">
            <AnimatePresence mode="popLayout">
              {filteredLibrary.map((item) => (
                <LibraryCardItem
                  key={item._id}
                  item={item}
                  isSelected={selectedItems.includes(item._id)}
                  isDeleting={deletingIds.has(item._id)}
                  onToggle={() => handleItemToggle(item._id)}
                  onDelete={() => handleDeleteItem(item._id)}
                  canDelete={canDeleteLibraryItems}
                  stremioLink={getStremioLink(item)}
                  watchTime={formatWatchTime(item.state?.overallTimeWatched)}
                  appName={appLabel}
                  deleteLine={deleteLine}
                  isTV={isTV}
                />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {filteredLibrary.map((item) => (
                <LibraryListItem
                  key={item._id}
                  item={item}
                  isSelected={selectedItems.includes(item._id)}
                  isDeleting={deletingIds.has(item._id)}
                  onToggle={() => handleItemToggle(item._id)}
                  onDelete={() => handleDeleteItem(item._id)}
                  canDelete={canDeleteLibraryItems}
                  stremioLink={getStremioLink(item)}
                  watchTime={formatWatchTime(item.state?.overallTimeWatched)}
                  deleteLine={deleteLine}
                  isTV={isTV}
                />
              ))}
            </AnimatePresence>
          </div>
        )
      )}
    </div>
    </Wrapper>
  );
}
