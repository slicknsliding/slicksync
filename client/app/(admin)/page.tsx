'use client';

import { memo, useEffect, useState, useMemo, useCallback, useRef, Fragment } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { NebulaPageHeading, NEBULA_GLASS_CLASS, nebulaGlassStyle, NebulaGlassStripe } from '@/components/layout/NebulaTopbar';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useLastKnown } from '@/lib/hooks/useLastKnown';
import { TVPageProvider } from '@/components/tv/TVPageProvider';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { TVLink } from '@/components/tv/TVLink';
import { Button, Card, StatCard, Avatar, UserAvatar, Badge, StatusBadge, VersionBadge, ResourceBadge, ContextMenu, useContextMenu, MediaDetailModal } from '@/components/ui';
import { UpcomingEpisodesPanel } from '@/components/ui/UpcomingEpisodesPanel';
import { NowPlayingSection } from '@/components/admin';
import { PageSection, StaggerContainer, StaggerItem } from '@/components/layout/PageContainer';
import { SetupChecklist } from '@/components/dashboard/SetupChecklist';
import { api, AccountStats, MetricsData, Addon, ContinueWatchingItem } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { useLayoutMode } from '@/lib/layout-mode';
import {
  UsersIcon,
  UserGroupIcon,
  PuzzlePieceIcon,
  EnvelopeIcon,
  ArrowPathIcon,
  ArrowTrendingUpIcon,
  ClockIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  FireIcon,
  PlayIcon,
  XCircleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// Sync status data type
interface SyncStatusData {
  time: string;
  syncs: number;
}

// Hoisted tooltip style for charts
const CHART_TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-surface)',
  border: '1px solid var(--color-surface-border)',
  borderRadius: '10px',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
} as const;

const CHART_LABEL_STYLE = { color: 'var(--color-text)' } as const;

// Fixed height for activity items (5 items)
const ACTIVITY_CARD_HEIGHT = 'h-[420px]';

// Memoized chart component
const SyncActivityChart = memo(function SyncActivityChart({ data }: { data: SyncStatusData[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data}>
        <defs>
          <linearGradient id="colorSyncs" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-surface-border)" />
        <XAxis dataKey="time" stroke="var(--color-text-subtle)" fontSize={11} />
        <YAxis stroke="var(--color-text-subtle)" fontSize={11} />
        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} labelStyle={CHART_LABEL_STYLE} />
        <Area
          type="monotone"
          dataKey="syncs"
          stroke="var(--color-primary)"
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorSyncs)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

// Recent Addon Item component with error handling
const RecentAddonItem = memo(function RecentAddonItem({ 
  addon, 
  isReloading, 
  onReload 
}: { 
  addon: any; 
  isReloading: boolean; 
  onReload: (e: React.MouseEvent) => void 
}) {
  const [imageError, setImageError] = useState(false);
  const logo = addon.logo;

  return (
    <TVLink href={`/addons/${addon.id}`} className="block" focusWrapperClassName="block">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ scale: 1.01 }}
        className="flex items-center gap-4 p-3.5 rounded-xl transition-colors bg-surface-hover hover:bg-surface cursor-pointer group border border-transparent hover:border-default"
      >
        {/* Logo */}
        <div 
          className="w-12 h-12 rounded-xl flex items-center justify-center overflow-hidden shrink-0 border border-default shadow-inner"
          style={{ 
            background: 'linear-gradient(135deg, var(--color-primary-muted), var(--color-secondary-muted))' 
          }}
        >
          {logo && !imageError ? (
            <img 
              src={logo} 
              alt="" 
              className="w-full h-full object-contain p-1.5" 
              onError={() => setImageError(true)}
            />
          ) : (
            <PuzzlePieceIcon className="w-6 h-6 text-primary" />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="font-semibold text-sm text-default truncate group-hover:text-primary transition-colors">
              {addon.name}
            </p>
            {addon.version && <VersionBadge version={addon.version} size="sm" />}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <UsersIcon className="w-3.5 h-3.5" />
              {addon.userCount} users
            </div>
            <div className="flex gap-1.5">
              {addon.resources.slice(0, 2).map((resource: string) => (
                <ResourceBadge key={resource} resource={resource} size="sm" />
              ))}
            </div>
          </div>
        </div>

        {/* Action */}
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-2"
          onClick={onReload}
        >
          <ArrowPathIcon className={`w-4 h-4 ${isReloading ? 'animate-spin' : ''}`} />
        </Button>
      </motion.div>
    </TVLink>
  );
});

// Continue Watching card - right-click to remove, and guards its own click
// against firing right after a drag-to-scroll gesture on the parent row
// (checked via a shared ref rather than local state, since the drag
// happens on the scroll container, not the card itself).
//
// Navigation is a plain native <a href> with no JS in the way - confirmed
// working for Stremio's app link (a real click opened the app). An earlier
// attempt to add a JS-driven fallback (intercepting the click, setting
// location.href programmatically, timing a fallback) broke that working
// case: browsers treat a direct anchor click far more reliably for
// custom-scheme navigation than a script-driven location.href assignment,
// even from inside a genuine click handler. So: appUrl (Stremio only - see
// continueWatching.js) opens natively in the same tab; webUrl (everyone
// else, or Stremio's own fallback if no appUrl) opens as an ordinary link
// in a new tab. The only JS involved is the drag-cancel.
const ContinueWatchingCard = memo(function ContinueWatchingCard({
  item,
  wasDraggedRef,
  onRemove,
  onOpenDetails,
  isMenuOpen,
  onMenuOpenChange,
}: {
  item: ContinueWatchingItem;
  wasDraggedRef: React.RefObject<boolean>;
  onRemove: (item: ContinueWatchingItem) => void;
  onOpenDetails: (item: ContinueWatchingItem) => void;
  isMenuOpen: boolean;
  // Receives this card's own composite key so the parent can use ONE stable
  // useCallback for every card instead of a fresh
  // `(open) => setOpenMenuKey(open ? key : null)` closure per card per
  // render - a new function identity every render silently defeats this
  // component's own React.memo below, which is exactly what was happening at
  // both call sites (Continue Watching appears twice on this page).
  onMenuOpenChange: (open: boolean, key: string) => void;
}) {
  // position/preventDefault still come from the hook, but which card's menu
  // is actually rendered open is driven by isMenuOpen (lifted to the parent)
  // rather than this hook's own isOpen - each card had its own independent
  // isOpen before, and right-clicking a second card's own stopPropagation
  // (needed to suppress the native menu) blocked the FIRST card's "close on
  // outside click" listener from ever firing, orphaning it open. A single
  // shared "which card owns the open menu" value fixes that by construction.
  const { position, handleContextMenu, setExternalClose } = useContextMenu();
  // Registers the REAL close (onClose below) for cross-section/cross-page
  // closing - onMenuOpenChange is the lifted state that actually drives
  // isOpen here, so this hook's own internal close wouldn't hide anything.
  setExternalClose(() => onMenuOpenChange(false, `${item.userId}-${item.showId}`));

  // Long-press → context menu for touch devices. onContextMenu alone (below)
  // only reliably fires from an actual right-click; mobile browsers don't
  // consistently synthesize it from a long-press on an arbitrary div/anchor
  // the way they sometimes do for plain text/images, so it was silently
  // never opening on phones. Same pattern AddonCard and UpcomingRow already
  // use: a 500ms timer, cancelled on move/scroll (parent row's drag-to-scroll
  // shouldn't also trigger this) so a scroll gesture isn't hijacked into a
  // menu open. Cleared with a longer than typical 10px threshold makes sense
  // here since this row scrolls horizontally right where you'd press.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const clearPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    startPos.current = null;
  };
  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    startPos.current = { x: t.clientX, y: t.clientY };
    pressTimer.current = setTimeout(() => {
      handleContextMenu(e as unknown as Event, t.clientX, t.clientY);
      onMenuOpenChange(true, `${item.userId}-${item.showId}`);
      pressTimer.current = null;
    }, 500);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!startPos.current || !pressTimer.current) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - startPos.current.x);
    const dy = Math.abs(t.clientY - startPos.current.y);
    if (dx > 10 || dy > 10) clearPress();
  };

  return (
    <div
      onContextMenu={(e) => {
        handleContextMenu(e);
        onMenuOpenChange(true, `${item.userId}-${item.showId}`);
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={clearPress}
      onTouchCancel={clearPress}
      onTouchMove={handleTouchMove}
      className="shrink-0 relative"
    >
      <div
        onClick={() => {
          // Suppress the click that fires immediately after a long-press
          // opens the menu - otherwise a long-press both opens the menu AND
          // the detail modal as soon as the finger lifts.
          if (wasDraggedRef.current || isMenuOpen) return;
          onOpenDetails(item);
        }}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        className="group relative block w-40 rounded-xl overflow-hidden bg-slate-800 shadow-lg select-none cursor-pointer tap-card"
      >
        <div className="relative aspect-video">
          {/* Image priority for this landscape (16:9) frame: episode still
              first (already 16:9), then the show/movie's landscape backdrop,
              and only then the portrait poster as a last resort - a portrait
              poster forced into a 16:9 frame is what caused the "too zoomed
              in" hard crop. */}
          {(item.nextEpisode?.thumbnail || item.background || item.poster) ? (
            <img
              src={item.nextEpisode?.thumbnail || item.background || item.poster || ''}
              alt={item.showName}
              draggable={false}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105 pointer-events-none"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-slate-800">
              <PlayIcon className="w-8 h-8 text-slate-600" />
            </div>
          )}
          {/* ONLY this play button navigates straight to the app/web link -
              everywhere else on the card opens the detail modal instead
              (onClick above). Previously the whole card was one <a>, so
              clicking anywhere - poster art, title, anywhere - launched the
              app link; only the small (i) button below opened the modal.
              stopPropagation keeps this click from also bubbling to the
              card's own onClick and opening the modal right behind it. */}
          <a
            href={item.appUrl || item.webUrl}
            target={item.appUrl ? undefined : '_blank'}
            rel={item.appUrl ? undefined : 'noopener noreferrer'}
            onClick={(e) => {
              e.stopPropagation();
              if (wasDraggedRef.current || isMenuOpen) e.preventDefault();
            }}
            aria-label={`Resume ${item.showName}`}
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: 'rgba(0,0,0,0.4)' }}
          >
            <PlayIcon className="w-8 h-8 text-white" />
          </a>
          {/* Netflix-style progress bar for partway-through items - only on
              resume entries, where progressPercent is real position data from
              WatchSession (not shown for next-episode cards, which by
              definition start from 0). Ratings deliberately not shown on this
              card - they're in the detail modal the info button opens.
              Fill defaults to the theme's primary→secondary accent gradient
              (so it re-colors with every theme, not just one) plus a matching
              glow, but --color-progress (Settings → Themes → Build your own
              theme → "Progress bar") overrides both with a flat color when
              set. Over a dark track, so it stays clearly visible against any
              poster art. Sits in its own thin strip below the thumbnail
              rather than overlaid on it, so nothing covers it. */}
          {item.resume && item.progressPercent != null && (
            <div className="absolute bottom-0 left-0 right-0 h-1.5 pointer-events-none" style={{ background: 'rgba(0,0,0,0.55)' }}>
              <div
                className="h-full rounded-r-full"
                style={{
                  width: `${Math.min(100, Math.max(3, item.progressPercent))}%`,
                  background: 'var(--color-progress, linear-gradient(90deg, var(--color-primary), var(--color-secondary)))',
                  boxShadow: '0 0 6px var(--color-progress, var(--color-primary))',
                }}
              />
            </div>
          )}
        </div>
        <div className="p-2">
          <p className="text-xs font-medium text-default truncate">{item.showName}</p>
          <p className="text-[11px] text-muted truncate">
            {item.nextEpisode
              ? `${item.resume ? 'Resume ' : ''}S${String(item.nextEpisode.season).padStart(2, '0')}E${String(item.nextEpisode.episode).padStart(2, '0')}${item.nextEpisode.title ? ` · ${item.nextEpisode.title}` : ''}`
              : `Resume${item.progressPercent != null ? ` · ${item.progressPercent}% watched` : ''}`}
          </p>
          <div className="flex items-center gap-1 mt-0.5">
            <p className="text-[10px] text-subtle truncate">{item.username}</p>
            {item.providerType && (
              <Badge variant={item.providerType === 'nuvio' ? 'nuvio' : 'stremio'} size="sm" className="shrink-0">
                {item.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Now redundant with the card's own default click (which opens this
          same modal), since only the play button navigates away - kept as a
          visible, explicit affordance for "view details" rather than
          removing it, and still useful as the one spot that works even if
          the play button's target changes. stopPropagation avoids also
          re-firing the card's own onClick behind it. */}
      {item.appUrl && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenDetails(item);
          }}
          title="View details"
          aria-label="View details"
          className="absolute top-1.5 right-1.5 z-10 p-1.5 rounded-md transition-colors"
          style={{ color: 'white', background: 'rgba(0,0,0,0.6)' }}
        >
          <InformationCircleIcon className="w-5 h-5" />
        </button>
      )}

      <ContextMenu isOpen={isMenuOpen} position={position} onClose={() => onMenuOpenChange(false, `${item.userId}-${item.showId}`)}>
        <button
          onClick={() => {
            onMenuOpenChange(false, `${item.userId}-${item.showId}`);
            onRemove(item);
            toast.success(`Removed "${item.showName}" - it rests in the Graveyard now (Activity -> Graveyard). Digging it up there brings it back here.`);
          }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <XCircleIcon className="w-4 h-4" />
          Remove from Continue Watching
        </button>
      </ContextMenu>
    </div>
  );
});

export default function DashboardPage() {
  const { layoutMode } = useLayoutMode();
  const isTV = useIsTV();
  const [accountStats, setAccountStats] = useState<AccountStats | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsData | null>(null);
  const [recentAddonsData, setRecentAddons] = useState<Addon[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [reloadingAddons, setReloadingAddons] = useState<Set<string>>(new Set());
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingItem[]>([]);
  const [detailModalItem, setDetailModalItem] = useState<ContinueWatchingItem | null>(null);
  // Which Continue Watching card's context menu is open, keyed the same way
  // as each card - shared across all cards so opening one always closes any
  // other, instead of each card tracking its own independent isOpen.
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  // One stable identity for every Continue Watching card's onMenuOpenChange
  // (this row appears twice on this page), rather than each card getting a
  // fresh `(open) => setOpenMenuKey(...)` closure on every render - a new
  // function per card per render defeats ContinueWatchingCard's React.memo,
  // so the whole row re-rendered on any state change at all, including
  // simply closing the detail modal.
  const handleMenuOpenChange = useCallback((open: boolean, key: string) => {
    setOpenMenuKey(open ? key : null);
  }, []);

  // Fetched independently of the main dashboard load - Cinemeta lookups
  // powering this are a nice-to-have, and shouldn't be able to fail the
  // whole dashboard if Cinemeta is briefly unreachable.
  useEffect(() => {
    api.getContinueWatching().then(setContinueWatching).catch(() => setContinueWatching([]));
  }, []);

  // Dismissal is persisted server-side (DismissedContinueWatching), not
  // localStorage, so it stays dismissed when checking the Dashboard from a
  // different browser or device. Removed from local state immediately for a
  // responsive click; the backend call is fire-and-forget since the item is
  // already gone from view either way, and the next full fetch would exclude
  // it regardless.
  const handleDismissContinueWatching = useCallback((item: ContinueWatchingItem) => {
    setContinueWatching((prev) => prev.filter((i) => !(i.userId === item.userId && i.showId === item.showId)));
    api.dismissContinueWatching(item.userId, item.showId).catch(() => {});
  }, []);

  // Grab-and-drag horizontal scrolling for the Continue Watching row - mouse
  // only. Touch/pen are deliberately left alone: overflow-x-auto already
  // gives touch native horizontal scrolling with proper momentum, and this
  // row sits inside a vertically-scrolling page - capturing every pointer
  // move here (as an earlier version did for all pointer types) fought with
  // the browser's own touch scroll gesture on the same element, which is
  // exactly the kind of thing that reads as "laggy" on a phone. wasDragged
  // distinguishes a real drag from a click so dragging past a card doesn't
  // also open its link - it's a ref, not state, since it needs to be read
  // synchronously in the click handler that fires immediately after
  // pointerup.
  const scrollRowRef = useRef<HTMLDivElement>(null);
  const isPointerDownRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartScrollLeftRef = useRef(0);
  const wasDraggedRef = useRef(false);
  const hasCapturedPointerRef = useRef(false);

  const handleRowPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // button 0 = primary/left only - a right-click (button 2, opening the
    // context menu) was falling through this same check and calling
    // setPointerCapture on the row, which had no business engaging for a
    // gesture that was never a drag to begin with.
    if (e.pointerType !== 'mouse' || e.button !== 0 || !scrollRowRef.current) return;
    if ((e.target as HTMLElement).closest('button')) return;
    isPointerDownRef.current = true;
    wasDraggedRef.current = false;
    hasCapturedPointerRef.current = false;
    dragStartXRef.current = e.clientX;
    dragStartScrollLeftRef.current = scrollRowRef.current.scrollLeft;
    // setPointerCapture is deliberately NOT called here. It used to fire on
    // every mouse-down regardless of whether a drag ever happened, on the
    // theory that native <a href> navigation is independent of this JS-level
    // pointer retargeting (per the Pointer Events spec, a captured pointer's
    // subsequent events retarget to the capturing element) - true for
    // ordinary navigation, but not for external-protocol links
    // (nuvio://, stremio://): Firefox silently refused to hand off to the
    // registered app when the click's pointer had been captured by an
    // ancestor, even though the DOM click event itself still reached the
    // <a> and fired normally. Deferred to handleRowPointerMove instead, so a
    // plain click (no movement past the drag threshold) never touches
    // capture at all - only a real drag does.
  }, []);

  const handleRowPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !isPointerDownRef.current || !scrollRowRef.current) return;
    // Deferring capture (below) means a release that happens before the drag
    // threshold is crossed - e.g. mostly-vertical movement off the row's top
    // or bottom edge with under 5px of horizontal travel - never reaches
    // handleRowPointerUp at all, since nothing retargets it back to us.
    // e.buttons catches that on the very next move/hover: if the primary
    // button isn't pressed anymore, the "pointer down" state is stale, so
    // clear it now instead of letting a later hover compute scrollLeft from
    // a stale drag-start and yank the row around with no button even held.
    if ((e.buttons & 1) === 0) {
      isPointerDownRef.current = false;
      return;
    }
    const dx = e.clientX - dragStartXRef.current;
    if (Math.abs(dx) > 5) {
      wasDraggedRef.current = true;
      if (!hasCapturedPointerRef.current) {
        scrollRowRef.current.setPointerCapture(e.pointerId);
        hasCapturedPointerRef.current = true;
      }
    }
    scrollRowRef.current.scrollLeft = dragStartScrollLeftRef.current - dx;
  }, []);

  const handleRowPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    isPointerDownRef.current = false;
    if (hasCapturedPointerRef.current) {
      scrollRowRef.current?.releasePointerCapture(e.pointerId);
      hasCapturedPointerRef.current = false;
    }
  }, []);

  // Tick once a second so live watch time counts up - but ONLY while
  // something is actually playing. Unconditionally, this re-rendered the whole
  // dashboard (every card, row and poster) once a second for the life of the
  // page, to advance a counter that has nothing to advance whenever Now
  // Playing is empty - which is most of the time. That constant work is felt
  // on a phone as taps and modal closes responding a beat late.
  const hasLivePlayback = (metricsData?.nowPlaying?.length ?? 0) > 0;
  useEffect(() => {
    if (!hasLivePlayback) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLivePlayback]);

  // Calculate live watch time
  const liveWatchTimeMinutes = useMemo(() => {
    if (!metricsData) return 0;
    
    let totalSeconds = (metricsData.summary?.totalWatchTimeHours || 0) * 3600;

    // Add live seconds from active sessions
    if (metricsData.nowPlaying && metricsData.nowPlaying.length > 0) {
      metricsData.nowPlaying.forEach(np => {
        const startMs = np.watchedAtTimestamp || new Date(np.watchedAt).getTime();
        if (startMs) {
          totalSeconds += Math.max(0, (nowTick - startMs) / 1000);
        }
      });
    }

    return Math.round(totalSeconds / 60);
  }, [metricsData, nowTick]);

  // Instant navigation: last-known metrics/addons shown immediately while
  // refreshData below refreshes them - see useLastKnown's own comment.
  // Only metrics gates the spinner: it's the payload the whole page is
  // built from, while addons/stats just fill two cards.
  useLastKnown<MetricsData>('/users/metrics?period=7d', (cached) => {
    setMetricsData(cached);
    setIsLoading(false);
  });
  useLastKnown<Addon[]>('/addons', (cached) => setRecentAddons(cached.slice(0, 3)));

  // Fetch dashboard data. `silent` skips the loading spinner - used by the
  // 30s auto-refresh below so Now Playing stays live without the whole
  // Dashboard flashing back to a loading state every cycle (same pattern
  // Activity's own 30s Now Playing refresh already uses).
  const refreshData = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    setError(null);
    try {
      const [stats, metrics, addons] = await Promise.all([
        // Separately caught - a fresh account has no API key configured
        // yet, so this legitimately 401s on every first visit. That's not a
        // real failure (totalUsers/totalGroups/totalAddons below all already
        // fall back gracefully to null), and shouldn't block metrics/addons
        // from loading or put a scary "Failed to load dashboard data" banner
        // in front of a brand new signup.
        api.getAccountStats().catch(() => null),
        api.getMetrics('7d'),
        api.getAddons(),
      ]);

      setAccountStats(stats);
      setMetricsData(metrics);
      setRecentAddons(addons.slice(0, 3));
    } catch (err) {
      console.error('Dashboard data fetch failed:', err);
      if (!silent) setError(err as Error);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshData();
    // Keeps Now Playing live - see the "Live" badge on its section header.
    const id = setInterval(() => refreshData(true), 30000);
    return () => clearInterval(id);
  }, [refreshData]);

  // Derived stats with fallbacks
  const stats = useMemo(() => {
    return {
      totalUsers: accountStats?.totalUsers ?? metricsData?.summary?.totalUsers ?? 0,
      totalGroups: accountStats?.totalGroups ?? 0,
      totalAddons: accountStats?.totalAddons ?? recentAddonsData.length ?? 0,
      pendingInvites: accountStats?.pendingInvites ?? 0,
    };
  }, [accountStats, metricsData, recentAddonsData]);

  // Nebula layout's ring stat - users currently watching right now, out of
  // total. metricsData.summary.activeUsers counts anyone with watch activity
  // in the whole metrics period (i.e. "watched something recently"), which
  // reads as permanently-active on a small instance and contradicts "Active
  // Now" / Activity's own "Currently Watching" count sitting at 0 alongside
  // it. nowPlaying is the same live-presence feed Activity's "Currently
  // Watching" stat uses - dedupe by user id since one user can have more
  // than one nowPlaying entry (e.g. the same title picked up under both
  // their Stremio and Nuvio profiles).
  const activeUsers = metricsData?.nowPlaying
    ? new Set(metricsData.nowPlaying.map((np) => np.user.id)).size
    : 0;
  const ringCircumference = 2 * Math.PI * 28;
  const ringRatio = stats.totalUsers > 0 ? Math.min(1, activeUsers / stats.totalUsers) : 0;

  const handleSyncAll = async () => {
    setIsSyncing(true);
    try {
      await api.syncAllUsers();
      toast.success('Global sync triggered for all users');
      await refreshData();
    } catch (err: any) {
      toast.error(err.message || 'Failed to trigger global sync');
    } finally {
      setIsSyncing(false);
    }
  };

  // Transform metrics to sync status data (placeholder - would need actual sync history)
  const syncStatusData: SyncStatusData[] = useMemo(() => {
    // TODO: Get actual sync history from API
    return [
      { time: '00:00', syncs: 0 },
      { time: '04:00', syncs: 0 },
      { time: '08:00', syncs: 0 },
      { time: '12:00', syncs: 0 },
      { time: '16:00', syncs: 0 },
      { time: '20:00', syncs: 0 },
      { time: 'Now', syncs: 0 },
    ];
  }, []);

  // Transform top users from metrics
  const topUsers = useMemo(() => {
    if (!metricsData?.watchActivity?.byUser) return [];
    return metricsData.watchActivity.byUser
      .slice(0, 3)
      .map(user => ({
        id: user.id,
        name: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        useGravatar: user.useGravatar,
        watchTime: Math.round(user.watchTimeHours * 60),
        // metricsBuilder computes this per user and sends it on
        // watchActivity.byUser - the same payload this list is built from -
        // and the Metrics page reads it. The dashboard hardcoded 0, and since
        // the badge renders behind `streak > 0` it never appeared at all, so
        // it looked like nobody had a streak while Metrics showed real ones.
        streak: user.streak || 0,
      }));
  }, [metricsData]);

  // Transform recent activity (Live + Recent History)
  const recentActivityItems = useMemo(() => {
    if (!metricsData) return [];
    
    const items: any[] = [];
    
    // Add live items first
    if (metricsData.nowPlaying) {
      metricsData.nowPlaying.forEach(np => {
        items.push({
          ...np,
          isLive: true,
          timestamp: new Date(np.watchedAt).getTime()
        });
      });
    }
    
    // Add recently completed sessions
    if (metricsData.watchSessions) {
      const liveUserItemKeys = new Set(items.map(i => `${i.user.id}-${i.item.id}`));
      
      metricsData.watchSessions
        .filter(s => !s.isActive && s.endTime) // Only completed
        .filter(s => !liveUserItemKeys.has(`${s.user.id}-${s.item.id}`)) // Don't duplicate if already in live
        .forEach(s => {
          items.push({
            user: s.user,
            item: s.item,
            watchedAt: s.endTime,
            timestamp: new Date(s.endTime!).getTime(),
            isLive: false
          });
        });
    }

    // Merge in the reliable WatchActivity-derived feed (movies + episodes)
    // for anything not already covered by a live/session entry above — same
    // reasoning as the Activity page: WatchSession requires an item's
    // progress to visibly change between two 5-minute polls to register at
    // all, which doesn't reliably happen for either provider, so this fills
    // in real watch history the session data misses.
    if (metricsData.recentActivity) {
      const seenUserItemKeys = new Set(items.map(i => `${i.user.id}-${i.item.id}`));

      metricsData.recentActivity
        .filter(a => !seenUserItemKeys.has(`${a.user.id}-${a.item.id}`))
        .forEach(a => {
          items.push({
            user: a.user,
            item: a.item,
            watchedAt: a.watchedAt,
            timestamp: a.watchedAtTimestamp,
            isLive: false
          });
        });
    }
    
    return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
  }, [metricsData]);

  // Transform recent addons for display
  const recentAddons = useMemo(() => {
    return recentAddonsData.map(addon => {
      const anyAddon = addon as any;
      
      // Mirror Addons page logo logic
      const logo =
        anyAddon.customLogo ||
        addon.logo ||
        anyAddon.iconUrl ||
        (anyAddon.stremioAddonId && `https://stremio-addon.netlify.app/${anyAddon.stremioAddonId}/icon.png`) ||
        undefined;

      return {
        id: addon.id,
        name: addon.name,
        status: (addon as any).status || 'active',
        version: addon.version,
        resources: addon.resources || [],
        userCount: anyAddon.users || 0,
        groupCount: anyAddon.groups || 0,
        logo,
      };
    });
  }, [recentAddonsData]);

  // Nebula layout - same data/handlers as above (refreshData, continueWatching,
  // recentActivityItems, etc.), just a different arrangement: top nav instead
  // of the sidebar (swapped in by AdminClientLayout based on layoutMode),
  // glass panels, an orbital-style ring stat instead of a flat stat card.
  // Continue Watching reuses the exact same ContinueWatchingCard + row drag
  // handlers as Current mode - only the wrapping panel is different - so the
  // carefully-debugged pointer-capture/context-menu/app-link logic isn't
  // duplicated.
  if (layoutMode === 'nebula') {
    const Wrapper = isTV ? TVPageProvider : Fragment;
    return (
      <Wrapper>
        <div className="px-4 md:px-6 pb-8 pt-6">
          {/* Same 72rem cap as NebulaTopbar, set inline for the same reason
              (globals.css's unlayered `* { max-width: 100vw }` silently
              no-ops the max-w-6xl class) - keeps the whole page reading as
              one centered column instead of stretching into dead space. */}
          <div className="mx-auto" style={{ maxWidth: 'min(120rem, 92vw)' }}>
            <NebulaPageHeading
              title="Dashboard"
              subtitle="Welcome back! Here's what's happening with SlickSync."
              actions={(() => {
                const syncBtn = (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<ArrowPathIcon className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />}
                    onClick={handleSyncAll}
                    isLoading={isSyncing}
                  >
                    Sync All
                  </Button>
                );
                return isTV ? <TVFocusable onEnterPress={handleSyncAll}>{syncBtn}</TVFocusable> : syncBtn;
              })()}
            />

            {error && (
              <div className="mb-6 p-4 rounded-xl bg-error-muted border border-error text-error text-sm flex items-center gap-3">
                <ExclamationCircleIcon className="w-5 h-5 shrink-0" />
                <div>
                  <p className="font-semibold">Failed to load dashboard data</p>
                  <p className="opacity-90">{error.message}</p>
                </div>
                {(() => {
                  const retryBtn = (
                    <Button variant="ghost" size="sm" onClick={() => refreshData()} className={isTV ? undefined : 'ml-auto'}>
                      Retry
                    </Button>
                  );
                  return isTV ? (
                    <TVFocusable className="ml-auto" onEnterPress={() => refreshData()}>{retryBtn}</TVFocusable>
                  ) : retryBtn;
                })()}
              </div>
            )}

            {/* Ring stat + mini stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
              <div className={`${NEBULA_GLASS_CLASS} p-5 flex items-center gap-5`} style={nebulaGlassStyle}>
                <NebulaGlassStripe />
                <svg width="72" height="72" viewBox="0 0 64 64" className="shrink-0 -rotate-90">
                  <circle cx="32" cy="32" r="28" fill="none" stroke="var(--color-surface-border)" strokeWidth="6" />
                  <circle
                    cx="32" cy="32" r="28" fill="none"
                    stroke="url(#nebulaRingGradient)" strokeWidth="6" strokeLinecap="round"
                    strokeDasharray={ringCircumference}
                    strokeDashoffset={ringCircumference * (1 - ringRatio)}
                  />
                  <defs>
                    <linearGradient id="nebulaRingGradient" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="var(--color-primary)" />
                      <stop offset="100%" stopColor="var(--color-secondary)" />
                    </linearGradient>
                  </defs>
                </svg>
                <div>
                  <p className="text-sm text-muted mb-1">Active Now</p>
                  <p className="text-3xl font-bold text-default">
                    {isLoading ? '...' : activeUsers}
                    <span className="text-base text-muted font-normal"> / {isLoading ? '...' : stats.totalUsers} users</span>
                  </p>
                </div>
              </div>
              <TVLink href="/groups" className={`${NEBULA_GLASS_CLASS} p-5 flex items-center justify-between`} style={nebulaGlassStyle} focusWrapperClassName="block">
                <NebulaGlassStripe />
                <div>
                  <p className="text-sm text-muted mb-1">Groups</p>
                  <p className="text-3xl font-bold text-default">{isLoading ? '...' : stats.totalGroups}</p>
                </div>
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: 'var(--color-primary-muted)', color: 'var(--color-primary)' }}
                >
                  <UserGroupIcon className="w-6 h-6" />
                </div>
              </TVLink>
              <TVLink href="/addons" className={`${NEBULA_GLASS_CLASS} p-5 flex items-center justify-between`} style={nebulaGlassStyle} focusWrapperClassName="block">
                <NebulaGlassStripe />
                <div>
                  <p className="text-sm text-muted mb-1">Addons</p>
                  <p className="text-3xl font-bold text-default">{isLoading ? '...' : stats.totalAddons}</p>
                </div>
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: 'var(--color-secondary-muted)', color: 'var(--color-secondary)' }}
                >
                  <PuzzlePieceIcon className="w-6 h-6" />
                </div>
              </TVLink>
            </div>

            {/* Now Playing - identical to Current mode's placement, just above Continue Watching */}
            {metricsData?.nowPlaying && metricsData.nowPlaying.length > 0 && (
              <div className={`${NEBULA_GLASS_CLASS} p-5 mb-5`} style={nebulaGlassStyle}>
                <NebulaGlassStripe />
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-semibold font-display text-default">Now Playing</h3>
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    <span>Live</span>
                  </div>
                </div>
                <NowPlayingSection items={metricsData.nowPlaying} />
              </div>
            )}

            {/* Continue Watching - identical cards/drag logic to Current mode */}
            {continueWatching.length > 0 && (
              <div className={`${NEBULA_GLASS_CLASS} p-5 mb-5`} style={nebulaGlassStyle}>
                <NebulaGlassStripe />
                <h3 className="text-base font-semibold font-display text-default mb-4">Continue Watching</h3>
                <div
                  ref={scrollRowRef}
                  onPointerDown={handleRowPointerDown}
                  onPointerMove={handleRowPointerMove}
                  onPointerUp={handleRowPointerUp}
                  onPointerLeave={handleRowPointerUp}
                  className="flex gap-3 overflow-x-auto pb-1 cursor-grab active:cursor-grabbing no-scrollbar"
                >
                  {continueWatching.map((item) => {
                    const card = (
                      <ContinueWatchingCard
                        item={item}
                        wasDraggedRef={wasDraggedRef}
                        onRemove={handleDismissContinueWatching}
                        onOpenDetails={setDetailModalItem}
                        isMenuOpen={openMenuKey === `${item.userId}-${item.showId}`}
                        onMenuOpenChange={handleMenuOpenChange}
                      />
                    );
                    return isTV ? (
                      <TVFocusable key={`${item.userId}-${item.showId}`} onEnterPress={() => setDetailModalItem(item)}>
                        {card}
                      </TVFocusable>
                    ) : (
                      <Fragment key={`${item.userId}-${item.showId}`}>{card}</Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Coming up - upcoming episodes for shows being watched */}
            <UpcomingEpisodesPanel />

            {/* Recent Activity (left, spans both rows) + Top Viewers / Recent
                Addons stacked on the right - desktop only (lg:). Recent
                Addons used to be its own full-width panel below this grid,
                which on a wide screen meant one addon-row per line with a
                lot of empty horizontal space next to it; folding it into
                the right column under Top Viewers instead gives it the
                same half-width sizing those panels already use. Below lg,
                grid-cols-1 and the row-span both collapse to a normal
                single-column stack - unchanged from before, since that
                was already fine on mobile. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 items-start">
              <div className={`${NEBULA_GLASS_CLASS} p-5 lg:row-span-2`} style={nebulaGlassStyle}>
                <NebulaGlassStripe />
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-semibold font-display text-default">Recent Activity</h3>
                  <TVLink href="/activity" className="text-sm font-medium" style={{ color: 'var(--color-secondary)' }}>
                    View All →
                  </TVLink>
                </div>
                <div className="flex flex-col gap-1">
                  {isLoading ? (
                    <div className="text-center py-8 text-sm text-muted">Loading...</div>
                  ) : recentActivityItems.length > 0 ? (
                    recentActivityItems.map((np, index) => (
                      <div
                        key={`${np.user.id}-${np.item.id}-${np.timestamp}-${index}`}
                        className="flex items-center gap-3 p-2.5 rounded-xl relative pl-4"
                      >
                        <span
                          className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full opacity-70"
                          style={{ background: 'linear-gradient(180deg, var(--color-primary), var(--color-secondary))' }}
                        />
                        <TVLink
                        href={`/users/${np.user.id}`}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Open ${np.user.username}'s profile`}
                        className="shrink-0 rounded-full transition-transform hover:scale-105"
                      >
                        <UserAvatar userId={np.user.id} name={np.user.username} email={np.user.email} src={np.user.useGravatar ? undefined : (np.user.avatarUrl ?? undefined)} size="sm" />
                      </TVLink>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate text-muted">
                            <span className="font-medium" style={{ color: 'var(--color-secondary)' }}>
                              {np.user.username.split(' ')[0]}
                            </span>{' '}
                            {np.isLive ? 'is watching' : 'watched'} {np.item.name}
                            {np.item.type === 'series' && np.item.episode !== undefined && np.item.episode > 0 && (
                              <span className="text-subtle ml-1">
                                {np.item.season !== undefined && np.item.season > 0
                                  ? `S${String(np.item.season).padStart(2, '0')}E${String(np.item.episode).padStart(2, '0')}`
                                  : `E${String(np.item.episode).padStart(2, '0')}`}
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-subtle">
                            {new Date(np.watchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </p>
                        </div>
                        {np.isLive && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider animate-pulse" style={{ color: 'var(--color-secondary)' }}>
                            Live
                          </span>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-8 text-sm text-muted">No recent activity</div>
                  )}
                </div>
              </div>

              {/* Top Viewers - same topUsers data Current mode's own panel
                  uses, restyled to match Nebula's glass treatment. */}
              <div className={`${NEBULA_GLASS_CLASS} p-5`} style={nebulaGlassStyle}>
                <NebulaGlassStripe />
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-semibold font-display text-default">Top Viewers</h3>
                  <TVLink href="/users" className="text-sm font-medium" style={{ color: 'var(--color-secondary)' }}>
                    See All →
                  </TVLink>
                </div>
                <div className="flex flex-col gap-1">
                  {isLoading ? (
                    <div className="text-center py-8 text-sm text-muted">Loading...</div>
                  ) : topUsers.length > 0 ? (
                    topUsers.map((user, index) => (
                      <TVLink key={user.id || user.name} href={`/users/${user.id}`} className="flex items-center gap-3 p-2.5 rounded-xl relative pl-4" focusWrapperClassName="block">
                        <span
                          className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full opacity-70"
                          style={{ background: 'linear-gradient(180deg, var(--color-primary), var(--color-secondary))' }}
                        />
                        <div className="relative shrink-0">
                          <UserAvatar userId={user.id} name={user.name} email={user.email} src={user.useGravatar ? undefined : (user.avatarUrl ?? undefined)} size="sm" />
                          <div
                            className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold"
                            style={{
                              background: index === 0 ? 'var(--color-warning)' : index === 1 ? 'var(--color-text-muted)' : 'var(--color-text-subtle)',
                              color: 'var(--color-bg)',
                            }}
                          >
                            {index + 1}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate text-default">{user.name}</p>
                          <div className="flex items-center gap-3 text-xs text-muted">
                            <span className="flex items-center gap-1">
                              <ClockIcon className="w-3.5 h-3.5" />
                              {Math.floor(user.watchTime / 60)}h {user.watchTime % 60}m
                            </span>
                            {user.streak > 0 && (
                              <span className="flex items-center gap-1">
                                <FireIcon className="w-3.5 h-3.5 text-warning" />
                                {user.streak}d
                              </span>
                            )}
                          </div>
                        </div>
                      </TVLink>
                    ))
                  ) : (
                    <div className="text-center py-8 text-sm text-muted">No user data</div>
                  )}
                </div>
              </div>

              {/* Recent Addons - reuses the exact same RecentAddonItem rows
                  (and reload handler) as Current mode, just inside a glass
                  panel instead of a Card. Third grid child, not a separate
                  full-width section - CSS Grid auto-placement drops it into
                  the right column's second row, under Top Viewers, since
                  Recent Activity's row-span-2 already claims the left
                  column for both rows. */}
              <div className={`${NEBULA_GLASS_CLASS} p-5`} style={nebulaGlassStyle}>
                <NebulaGlassStripe />
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-semibold font-display text-default">Recent Addons</h3>
                  <TVLink href="/addons" className="text-sm font-medium" style={{ color: 'var(--color-secondary)' }}>
                    View All →
                  </TVLink>
                </div>
                <div className="flex flex-col gap-2">
                  {isLoading ? (
                    <div className="text-center py-8 text-sm text-muted">Loading...</div>
                  ) : recentAddons.length > 0 ? (
                    recentAddons.map((addon) => (
                      <RecentAddonItem
                        key={addon.id}
                        addon={addon}
                        isReloading={reloadingAddons.has(addon.id)}
                        onReload={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (reloadingAddons.has(addon.id)) return;

                          setReloadingAddons((prev) => new Set(prev).add(addon.id));
                          try {
                            await api.reloadAddon(addon.id);
                            toast.success(`Reloaded ${addon.name}`);
                          } catch (err: any) {
                            toast.error(err.message || 'Reload failed');
                          } finally {
                            setReloadingAddons((prev) => {
                              const next = new Set(prev);
                              next.delete(addon.id);
                              return next;
                            });
                          }
                        }}
                      />
                    ))
                  ) : (
                    <div className="text-center py-8 text-sm text-muted">No recent addons</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {detailModalItem && (
          <MediaDetailModal
            isOpen={!!detailModalItem}
            onClose={() => setDetailModalItem(null)}
            itemId={detailModalItem.showId}
            itemType={detailModalItem.contentType}
            videoId={detailModalItem.nextEpisode ? `${detailModalItem.showId}:${detailModalItem.nextEpisode.season}:${detailModalItem.nextEpisode.episode}` : null}
            fallbackTitle={detailModalItem.showName}
            fallbackPoster={detailModalItem.poster}
          />
        )}
      </Wrapper>
    );
  }

  return (
    <>
      <Header
        title="Dashboard"
        subtitle="Welcome back! Here's what's happening with SlickSync."
        actions={
          <Button
            variant="primary"
            leftIcon={<ArrowPathIcon className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />}
            onClick={handleSyncAll}
            isLoading={isSyncing}
          >
            Sync All
          </Button>
        }
      />

      <div className="p-6 lg:p-8">
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-error-muted border border-error text-error text-sm flex items-center gap-3">
            <ExclamationCircleIcon className="w-5 h-5 shrink-0" />
            <div>
              <p className="font-semibold">Failed to load dashboard data</p>
              <p className="opacity-90">{error.message}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => refreshData()} className="ml-auto">
              Retry
            </Button>
          </div>
        )}

        {/* What this instance still isn't set up with - hides itself once
            everything's done, and can be dismissed permanently. */}
        <SetupChecklist />

        {/* Stats Grid - Fixed height cards */}
        <PageSection className="mb-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Link href="/users" className="block">
              <StatCard
                label="Total Users"
                value={isLoading ? '...' : stats.totalUsers}
                icon={<UsersIcon className="w-5 h-5" />}
                delay={0}
              />
            </Link>
            <Link href="/groups" className="block">
              <StatCard
                label="Groups"
                value={isLoading ? '...' : stats.totalGroups}
                icon={<UserGroupIcon className="w-5 h-5" />}
                delay={0.05}
              />
            </Link>
            <Link href="/addons" className="block">
              <StatCard
                label="Addons"
                value={isLoading ? '...' : stats.totalAddons}
                icon={<PuzzlePieceIcon className="w-5 h-5" />}
                delay={0.1}
              />
            </Link>
            <Link href="/invitations" className="block">
              <StatCard
                label="Pending Invites"
                value={isLoading ? '...' : stats.pendingInvites}
                icon={<EnvelopeIcon className="w-5 h-5" />}
                delay={0.15}
              />
            </Link>
          </div>
        </PageSection>

        {/* Now Playing - same live nowPlaying feed Activity's "Currently
            Watching" reads, surfaced here too so it's visible without
            leaving the Dashboard. */}
        {metricsData?.nowPlaying && metricsData.nowPlaying.length > 0 && (
          <PageSection className="mb-6" delay={0.17}>
            <Card padding="lg">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold font-display text-default">Now Playing</h3>
                <div className="flex items-center gap-1.5 text-xs text-muted">
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  <span>Live</span>
                </div>
              </div>
              <NowPlayingSection items={metricsData.nowPlaying} />
            </Card>
          </PageSection>
        )}

        {/* Continue Watching */}
        {continueWatching.length > 0 && (
          <PageSection className="mb-6" delay={0.18}>
            <Card padding="lg">
              <h3 className="text-base font-semibold font-display text-default mb-4">
                Continue Watching
              </h3>
              <div
                ref={scrollRowRef}
                onPointerDown={handleRowPointerDown}
                onPointerMove={handleRowPointerMove}
                onPointerUp={handleRowPointerUp}
                onPointerLeave={handleRowPointerUp}
                className="flex gap-3 overflow-x-auto pb-1 cursor-grab active:cursor-grabbing no-scrollbar"
              >
                {continueWatching.map((item) => (
                  <ContinueWatchingCard
                    key={`${item.userId}-${item.showId}`}
                    item={item}
                    wasDraggedRef={wasDraggedRef}
                    onRemove={handleDismissContinueWatching}
                    onOpenDetails={setDetailModalItem}
                    isMenuOpen={openMenuKey === `${item.userId}-${item.showId}`}
                    onMenuOpenChange={handleMenuOpenChange}
                  />
                ))}
              </div>
            </Card>
          </PageSection>
        )}

        {/* Coming up - upcoming episodes for shows being watched */}
        <UpcomingEpisodesPanel />

        {/* Main content grid - Matched heights */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          {/* Sync Activity Chart */}
          <PageSection delay={0.2} className="lg:col-span-2">
            <Card padding="lg" className={ACTIVITY_CARD_HEIGHT}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-semibold font-display text-default">
                    Sync Activity
                  </h3>
                  <p className="text-sm text-muted">
                    Syncs over the last 24 hours
                  </p>
                </div>
                <Badge variant="muted">
                  <ArrowTrendingUpIcon className="w-3.5 h-3.5 mr-1" />
                  Last 24h
                </Badge>
              </div>
              <div className="h-[calc(100%-80px)]">
                <SyncActivityChart data={syncStatusData} />
              </div>
            </Card>
          </PageSection>

          {/* Recent Activity - Same height */}
          <PageSection delay={0.25}>
            <Card padding="lg" className={ACTIVITY_CARD_HEIGHT}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold font-display text-default">
                  Recent Activity
                </h3>
                <Link href="/activity">
                  <Button variant="ghost" size="sm">View All</Button>
                </Link>
              </div>

              <div className="flex flex-col gap-2 overflow-y-auto max-h-[330px] pr-1 custom-scrollbar">
                {isLoading ? (
                  <div className="text-center py-8 text-sm text-muted">Loading...</div>
                ) : recentActivityItems.length > 0 ? (
                  recentActivityItems.map((np, index) => (
                    <motion.div
                      key={`${np.user.id}-${np.item.id}-${np.timestamp}-${index}`}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.3 + index * 0.05 }}
                      whileHover={{ x: 4 }}
                      className="flex items-center gap-3 p-2.5 rounded-lg transition-colors cursor-pointer bg-surface-hover hover:bg-surface"
                    >
                      <Link
                        href={`/users/${np.user.id}`}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Open ${np.user.username}'s profile`}
                        className="shrink-0 rounded-full transition-transform hover:scale-105"
                      >
                        <UserAvatar userId={np.user.id} name={np.user.username} email={np.user.email} src={np.user.useGravatar ? undefined : (np.user.avatarUrl ?? undefined)} size="sm" />
                      </Link>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate text-muted">
                          <span className="font-medium text-default">
                            {np.user.username.split(' ')[0]}
                          </span>{' '}
                          {np.isLive ? 'is watching' : 'watched'} {np.item.name}
                          {np.item.type === 'series' && np.item.episode !== undefined && np.item.episode > 0 && (
                            <span className="text-subtle ml-1">
                              {np.item.season !== undefined && np.item.season > 0
                                ? `S${String(np.item.season).padStart(2, '0')}E${String(np.item.episode).padStart(2, '0')}`
                                : `E${String(np.item.episode).padStart(2, '0')}`}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-subtle">
                          {new Date(np.watchedAt).toLocaleTimeString()}
                        </p>
                      </div>
                      {np.isLive && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-semibold text-secondary uppercase tracking-wider animate-pulse">Live</span>
                          <div className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
                        </div>
                      )}
                    </motion.div>
                  ))
                ) : (
                  <div className="text-center py-8 text-sm text-muted">No recent activity</div>
                )}
              </div>
            </Card>
          </PageSection>
        </div>

        {/* Bottom section - Matched heights */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
          {/* Top Users */}
          <PageSection delay={0.3} className="h-full">
            <Card padding="lg" className="h-full">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold font-display text-default">
                  Top Viewers
                </h3>
                <Link href="/users">
                  <Button variant="ghost" size="sm">See All</Button>
                </Link>
              </div>

              <div className="flex flex-col gap-3">
                {isLoading ? (
                  <div className="text-center py-8 text-sm text-muted">Loading...</div>
                ) : topUsers.length > 0 ? (
                  topUsers.map((user, index) => (
                    <Link key={user.id || user.name} href={`/users/${user.id}`} className="block">
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.35 + index * 0.05 }}
                        whileHover={{ scale: 1.01 }}
                        className="flex items-center gap-3 p-3 rounded-lg transition-colors bg-surface-hover hover:bg-surface cursor-pointer"
                      >
                        <div className="relative">
                          <UserAvatar userId={user.id} name={user.name} email={user.email} src={user.useGravatar ? undefined : (user.avatarUrl ?? undefined)} size="md" />
                          <div 
                            className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                            style={{ 
                              background: index === 0 ? 'var(--color-warning)' : index === 1 ? 'var(--color-text-muted)' : 'var(--color-text-subtle)',
                              color: 'var(--color-bg)'
                            }}
                          >
                            {index + 1}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate text-default">
                            {user.name}
                          </p>
                          <div className="flex items-center gap-3 text-xs text-muted">
                            <span className="flex items-center gap-1">
                              <ClockIcon className="w-3.5 h-3.5" />
                              {Math.floor(user.watchTime / 60)}h {user.watchTime % 60}m
                            </span>
                            {user.streak > 0 && (
                              <span className="flex items-center gap-1">
                                <FireIcon className="w-3.5 h-3.5 text-warning" />
                                {user.streak}{user.streak === 1 ? 'd' : 'd'}
                              </span>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    </Link>
                  ))
                ) : (
                  <div className="text-center py-8 text-sm text-muted">No user data</div>
                )}
              </div>
            </Card>
          </PageSection>

          {/* Recent Addons - Adapts to content */}
          <PageSection delay={0.35} className="h-full">
            <Card padding="lg" className="h-full">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold font-display text-default">
                  Recent Addons
                </h3>
                <Link href="/addons">
                  <Button variant="ghost" size="sm">View All</Button>
                </Link>
              </div>

              <div className="flex flex-col gap-3">
                {isLoading ? (
                  <div className="text-center py-8 text-sm text-muted">Loading...</div>
                ) : recentAddons.length > 0 ? (
                  recentAddons.map((addon) => (
                    <RecentAddonItem
                      key={addon.id}
                      addon={addon}
                      isReloading={reloadingAddons.has(addon.id)}
                      onReload={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (reloadingAddons.has(addon.id)) return;
                        
                        setReloadingAddons(prev => new Set(prev).add(addon.id));
                        try {
                          await api.reloadAddon(addon.id);
                          toast.success(`Reloaded ${addon.name}`);
                        } catch (err: any) {
                          toast.error(err.message || 'Reload failed');
                        } finally {
                          setReloadingAddons(prev => {
                            const next = new Set(prev);
                            next.delete(addon.id);
                            return next;
                          });
                        }
                      }}
                    />
                  ))
                ) : (
                  <div className="text-center py-8 text-sm text-muted">No recent addons</div>
                )}
              </div>
            </Card>
          </PageSection>
        </div>

        {/* Quick Actions */}
        <PageSection delay={0.4} className="mt-4">
          <Card 
            padding="lg" 
            className="accent-border bg-surface"
          >
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold font-display mb-1 text-default">
                  Quick Actions
                </h3>
                <p className="text-sm text-muted">
                  Common tasks to manage your SlickSync instance
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/users">
                  <Button variant="primary" size="sm" leftIcon={<UsersIcon className="w-4 h-4" />}>
                    Manage Users
                  </Button>
                </Link>
                <Link href="/groups">
                  <Button variant="secondary" size="sm" leftIcon={<UserGroupIcon className="w-4 h-4" />}>
                    Manage Groups
                  </Button>
                </Link>
                <Link href="/invitations">
                  <Button variant="ghost" size="sm" leftIcon={<EnvelopeIcon className="w-4 h-4" />}>
                    Invitations
                  </Button>
                </Link>
              </div>
            </div>
          </Card>
        </PageSection>
      </div>

      {detailModalItem && (
        <MediaDetailModal
          isOpen={!!detailModalItem}
          onClose={() => setDetailModalItem(null)}
          itemId={detailModalItem.showId}
          itemType={detailModalItem.contentType}
          videoId={detailModalItem.nextEpisode ? `${detailModalItem.showId}:${detailModalItem.nextEpisode.season}:${detailModalItem.nextEpisode.episode}` : null}
          fallbackTitle={detailModalItem.showName}
          fallbackPoster={detailModalItem.poster}
        />
      )}
    </>
  );
}
