'use client';

import { useState, memo } from 'react';
import { RatingBadges } from './RatingBadges';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { CatalogPickerMenu } from './AddToListButton';
import { RatingsBatchEntry } from '@/lib/api';
import { useLongPress } from '@/lib/hooks/useLongPress';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { posterUrl, posterSrcSet, isRpdbPoster } from '@/lib/posterUrl';
import {
  FilmIcon, TvIcon, CheckBadgeIcon, BookmarkIcon as BookmarkOutlineIcon,
  XCircleIcon, EyeIcon, EyeSlashIcon, HandThumbDownIcon, RectangleStackIcon, TrashIcon,
} from '@heroicons/react/24/outline';
import { BookmarkIcon as BookmarkSolidIcon } from '@heroicons/react/24/solid';
import { TVFocusable } from '@/components/tv/TVFocusable';

// Extracted from Discover's own poster card (originally local/un-exported)
// so Catalogs can share the same watched/watchlist badges + right-click
// quick-action menu instead of duplicating them. Only needs the fields it
// actually renders - callers with a richer item type (Discover's own
// DiscoverItem) pass straight through structurally, no adapter needed.
export interface PosterCardItem {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster: string | null;
  releaseInfo?: string | null;
  imdbRating?: string | null;
}

export interface PosterCardProps {
  item: PosterCardItem;
  ratings?: RatingsBatchEntry;
  /** True when this account has watch history for this item's id. */
  watched?: boolean;
  /** True when this item is currently saved to the account's watchlist. */
  inWatchlist?: boolean;
  onOpenDetails: (item: PosterCardItem) => void;
  /** Adds or removes from the watchlist based on current state. */
  onToggleWatchlist: (item: PosterCardItem, next: boolean) => void;
  /** Flips the watched marker between true and false. */
  onToggleWatched: (item: PosterCardItem, nextWatched: boolean) => void;
  /** When false, hides the corresponding context-menu item + card badge. */
  showWatchlistMenu?: boolean;
  showWatchedMenu?: boolean;
  showWatchedBadge?: boolean;
  showWatchlistBadge?: boolean;
  /** SlickTrax feedback - only meaningful on recommendation-style rows. */
  showNotInterested?: boolean;
  onMarkNotInterested?: (item: PosterCardItem) => void;
  /** Catalogs-only "remove from this catalog" menu entry - opt-in (undefined
   *  on every other caller, e.g. Discover), so this stays out of the menu
   *  everywhere it isn't relevant. Replaced an always-visible X button that
   *  sat in the same top-right corner as the watched badge above, reading as
   *  a confusing double-icon; long-press/right-click already opens this
   *  same menu, so removal lives there instead. */
  onRemoveFromCatalog?: (item: PosterCardItem) => void;
  /** Only-one-menu-open-at-a-time state, lifted to the parent so opening
   *  a second card's menu closes the previous card's. */
  isMenuOpen?: boolean;
  /** Identity reported through onMenuOpenChange - defaults to item.id.
   *  Parents rendering the SAME title in multiple sections (For You rows
   *  regularly repeat items, trending overlaps the grid) must scope this
   *  (e.g. `${rowId}:${item.id}`): with a bare item.id, every card sharing
   *  the id believed the menu was ITS OWN open menu, and the duplicates -
   *  having never received click coordinates - rendered a ghost copy of the
   *  menu at the viewport origin. */
  menuKey?: string;
  // Receives this card's own item id as a second argument so the parent can
  // use ONE stable useCallback for every card. Passing an inline
  // `(open) => setOpenMenuKey(open ? item.id : null)` gives each card a fresh
  // function identity on every parent render, which silently defeats the
  // React.memo below - every card in the grid then re-renders on any state
  // change at all, including simply closing a modal.
  onMenuOpenChange?: (open: boolean, itemId: string) => void;
  /** TV mode: wraps the card in a D-pad-focusable container with a visible
   *  focus ring, Enter/OK opens details the same way a click does. */
  focusable?: boolean;
}

export const PosterCard = memo(function PosterCard({
  item,
  ratings,
  watched,
  inWatchlist,
  onOpenDetails,
  onToggleWatchlist,
  onToggleWatched,
  showWatchlistMenu = true,
  showWatchedMenu = true,
  showWatchedBadge = true,
  showWatchlistBadge = true,
  showNotInterested = false,
  onMarkNotInterested,
  onRemoveFromCatalog,
  isMenuOpen,
  onMenuOpenChange,
  menuKey,
  focusable = false,
}: PosterCardProps) {
  const [imageError, setImageError] = useState(false);
  const { rpdbEnabled, enablePosterRatings } = usePersonalFeatures();
  // Right-click menu's "Add to Catalogs" swaps the menu's own content to the
  // catalog picker in place (single-panel nav with a Back row) rather than
  // opening a second flyout - simplest way to fit a multi-catalog picker
  // into a menu that's otherwise plain one-tap toggle buttons.
  const [catalogView, setCatalogView] = useState(false);
  // useContextMenu still owns the position calc + preventDefault, but the
  // OPEN state is driven by the parent's isMenuOpen prop so only one card's
  // menu is visible at a time across the whole grid.
  const { position, handleContextMenu, close: closeInternal, setExternalClose } = useContextMenu();
  const controlledOpen = isMenuOpen === true;
  const close = () => { closeInternal(); onMenuOpenChange?.(false, menuKey ?? item.id); setCatalogView(false); };
  // Registers the REAL close (above) for cross-page/cross-section closing -
  // this card's own isMenuOpen is lifted, so closeInternal alone (this hook's
  // unused-for-rendering internal state) wouldn't actually hide anything.
  setExternalClose(close);
  // onContextMenu alone covers a real desktop right-click, but iOS Safari
  // doesn't reliably synthesize a `contextmenu` DOM event from a touch
  // long-press - this card's Add to Watchlist/Mark as Watched/Not Interested
  // menu was effectively unreachable by holding on iPhone before. See
  // useLongPress's own comment for why this needs a plain JS timer instead.
  const longPress = useLongPress({
    onLongPress: (e, x, y) => {
      handleContextMenu(e, x, y);
      onMenuOpenChange?.(true, menuKey ?? item.id);
    },
  });

  const card = (
    <div
      className="group relative cursor-pointer tap-card"
      onClick={() => {
        // Suppress the click that fires immediately after a long-press
        // opens the menu - otherwise a long-press both opens the menu AND
        // the detail modal as soon as the finger lifts.
        if (controlledOpen) return;
        onOpenDetails(item);
      }}
      onContextMenu={(e) => {
        handleContextMenu(e);
        onMenuOpenChange?.(true, menuKey ?? item.id);
      }}
      {...longPress}
    >
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-slate-800 shadow-xl">
        {item.poster && !imageError ? (
          <>
            <img
              src={posterUrl(item, rpdbEnabled)}
              // Lets the browser take the 154px file where a card renders
              // small (most phone grids) instead of always the 342 - fewer
              // bytes and less decode work per scroll, which is a real part
              // of scroll cost on phones. `sizes` describes the card's own
              // rendered width at each breakpoint, matching the grid.
              srcSet={posterSrcSet(item, rpdbEnabled)}
              sizes="(max-width: 640px) 33vw, (max-width: 1024px) 22vw, 170px"
              alt={item.name}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover transition-all duration-700 group-hover:scale-110"
              onError={() => setImageError(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/50 to-transparent opacity-40 group-hover:opacity-60 transition-opacity" />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-slate-800">
            {item.type === 'movie' ? (
              <FilmIcon className="w-12 h-12 text-slate-600" />
            ) : (
              <TvIcon className="w-12 h-12 text-slate-600" />
            )}
          </div>
        )}

        {/* Watched-status corner badge — subtle checkmark on the top-right so
            you can see at a glance while browsing what you've already seen.
            Layered above the poster's dark gradient so it stays visible on
            both light and dark posters. */}
        {watched && showWatchedBadge && (
          <div
            className="absolute top-1.5 right-1.5 flex items-center justify-center rounded-full bg-emerald-500/90 text-white shadow-lg backdrop-blur-sm"
            style={{ width: 24, height: 24 }}
            title="You've watched this"
          >
            <CheckBadgeIcon className="w-4 h-4" />
          </div>
        )}

        {/* Watchlist bookmark indicator — smaller than the watched badge and
            in the opposite corner so both can coexist on the same card. */}
        {inWatchlist && showWatchlistBadge && !(watched && showWatchedBadge) && (
          <div
            className="absolute top-1.5 left-1.5 flex items-center justify-center rounded-full bg-primary/90 text-white shadow-lg backdrop-blur-sm"
            style={{ width: 22, height: 22 }}
            title="In your watchlist"
          >
            <BookmarkSolidIcon className="w-3.5 h-3.5" />
          </div>
        )}

        {enablePosterRatings && !isRpdbPoster(item, rpdbEnabled) && (
          <div className="absolute bottom-1.5 left-1.5 right-1.5">
            <RatingBadges
              imdbRating={item.imdbRating}
              rottenTomatoes={ratings?.rottenTomatoes}
              metacritic={ratings?.metacritic}
            />
          </div>
        )}
      </div>

      <div className="mt-2 space-y-0.5 text-center">
        <h4 className="font-semibold text-sm text-slate-300 leading-tight line-clamp-2">
          {item.name}
        </h4>
        {item.releaseInfo && (
          <p className="text-xs text-slate-500">{item.releaseInfo}</p>
        )}
      </div>

      {(showWatchlistMenu || showWatchedMenu || showNotInterested || onRemoveFromCatalog) && (
        <ContextMenu isOpen={controlledOpen} position={position} onClose={close}>
          {catalogView ? (
            <CatalogPickerMenu
              item={{ id: item.id, type: item.type, name: item.name, poster: item.poster }}
              onBack={() => setCatalogView(false)}
              onDone={close}
            />
          ) : (
            <>
              {showWatchlistMenu && (
                <button
                  type="button"
                  onClick={() => { close(); onToggleWatchlist(item, !inWatchlist); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
                >
                  {inWatchlist
                    ? <><XCircleIcon className="w-4 h-4" /> Remove from Watchlist</>
                    : <><BookmarkOutlineIcon className="w-4 h-4" /> Add to Watchlist</>}
                </button>
              )}
              <button
                type="button"
                onClick={() => setCatalogView(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
              >
                <RectangleStackIcon className="w-4 h-4" /> Add to Catalogs
              </button>
              {showWatchedMenu && (
                <button
                  type="button"
                  onClick={() => { close(); onToggleWatched(item, !watched); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
                >
                  {watched
                    ? <><EyeSlashIcon className="w-4 h-4" /> Mark as unwatched</>
                    : <><EyeIcon className="w-4 h-4" /> Mark as watched</>}
                </button>
              )}
              {showNotInterested && (
                <button
                  type="button"
                  onClick={() => { close(); onMarkNotInterested?.(item); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
                >
                  <HandThumbDownIcon className="w-4 h-4" /> Not interested
                </button>
              )}
              {onRemoveFromCatalog && (
                <button
                  type="button"
                  onClick={() => { close(); onRemoveFromCatalog(item); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-surface-hover transition-colors"
                >
                  <TrashIcon className="w-4 h-4" /> Remove from catalog
                </button>
              )}
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );

  if (!focusable) return card;
  return <TVFocusable onEnterPress={() => onOpenDetails(item)}>{card}</TVFocusable>;
});
