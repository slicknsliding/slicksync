'use client';

import { memo, useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { NebulaTopbar, NebulaPageHeading, NEBULA_GLASS_CLASS, nebulaGlassStyle, NebulaGlassStripe } from '@/components/layout/NebulaTopbar';
import { Button, Card, StatCard, Avatar, UserAvatar, Badge, StatusBadge, VersionBadge, ResourceBadge, ContextMenu, useContextMenu, MediaDetailModal, RatingBadges } from '@/components/ui';
import { PageSection, StaggerContainer, StaggerItem } from '@/components/layout/PageContainer';
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
    <Link href={`/addons/${addon.id}`} className="block">
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
    </Link>
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
  onMenuOpenChange: (open: boolean) => void;
}) {
  // position/preventDefault still come from the hook, but which card's menu
  // is actually rendered open is driven by isMenuOpen (lifted to the parent)
  // rather than this hook's own isOpen - each card had its own independent
  // isOpen before, and right-clicking a second card's own stopPropagation
  // (needed to suppress the native menu) blocked the FIRST card's "close on
  // outside click" listener from ever firing, orphaning it open. A single
  // shared "which card owns the open menu" value fixes that by construction.
  const { position, handleContextMenu } = useContextMenu();

  return (
    <div
      onContextMenu={(e) => {
        handleContextMenu(e);
        onMenuOpenChange(true);
      }}
      className="shrink-0 relative"
    >
      <a
        href={item.appUrl || item.webUrl}
        target={item.appUrl ? undefined : '_blank'}
        rel={item.appUrl ? undefined : 'noopener noreferrer'}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        onClick={(e) => {
          if (wasDraggedRef.current) e.preventDefault();
        }}
        className="group relative block w-40 rounded-xl overflow-hidden bg-slate-800 shadow-lg select-none cursor-pointer"
      >
        <div className="relative aspect-video">
          {(item.nextEpisode.thumbnail || item.poster) ? (
            <img
              src={item.nextEpisode.thumbnail || item.poster || ''}
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
          <div
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ background: 'rgba(0,0,0,0.4)' }}
          >
            <PlayIcon className="w-8 h-8 text-white" />
          </div>
          <div className="absolute bottom-1 left-1 right-1 pointer-events-none">
            <RatingBadges
              imdbRating={item.imdbRating}
              rottenTomatoes={item.rottenTomatoes}
              metacritic={item.metacritic}
            />
          </div>
        </div>
        <div className="p-2">
          <p className="text-xs font-medium text-default truncate">{item.showName}</p>
          <p className="text-[11px] text-muted truncate">
            S{String(item.nextEpisode.season).padStart(2, '0')}E{String(item.nextEpisode.episode).padStart(2, '0')}
            {item.nextEpisode.title ? ` · ${item.nextEpisode.title}` : ''}
          </p>
          <p className="text-[10px] text-subtle truncate mt-0.5">{item.username}</p>
        </div>
      </a>

      {/* A custom-scheme app link either opens the app or the OS shows its
          own "no app registered for this link" dialog - the page has no way
          to detect which happened or react to it (an earlier attempt to
          intercept the click and add a JS-driven fallback ended up breaking
          the Stremio link that already worked). Rather than try that again,
          this is a second, always-functional affordance - can't nest it
          inside the card's own <a> (invalid HTML), so it's a small
          absolutely-positioned sibling instead. Opens the same rich detail
          modal the Activity page's poster click uses (cast, trailer,
          rating, IMDb/TMDb links) instead of bouncing straight to an
          external site - more useful than a bare link, and sidesteps
          picking "the right" external URL entirely. Only shown when
          there's an app link to fall back FROM; when there's only a web
          link, the card itself already goes straight there. */}
      {item.appUrl && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onOpenDetails(item);
          }}
          title="App didn't open? View details instead"
          aria-label="App didn't open? View details instead"
          className="absolute top-1.5 right-1.5 z-10 p-1.5 rounded-md transition-colors"
          style={{ color: 'white', background: 'rgba(0,0,0,0.6)' }}
        >
          <InformationCircleIcon className="w-5 h-5" />
        </button>
      )}

      <ContextMenu isOpen={isMenuOpen} position={position} onClose={() => onMenuOpenChange(false)}>
        <button
          onClick={() => {
            onMenuOpenChange(false);
            onRemove(item);
            toast.success(`Removed "${item.showName}" from Continue Watching`);
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

  // Update ticker every second
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  // Fetch dashboard data
  const refreshData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [stats, metrics, addons] = await Promise.all([
        api.getAccountStats(),
        api.getMetrics('7d'),
        api.getAddons(),
      ]);
      
      setAccountStats(stats);
      setMetricsData(metrics);
      setRecentAddons(addons.slice(0, 3));
    } catch (err) {
      console.error('Dashboard data fetch failed:', err);
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshData();
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
        streak: 0, // TODO: Fetch from user streaks
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
    return (
      <>
        <NebulaTopbar />

        <div className="px-4 md:px-6 pb-8 pt-6">
          {/* Same 72rem cap as NebulaTopbar, set inline for the same reason
              (globals.css's unlayered `* { max-width: 100vw }` silently
              no-ops the max-w-6xl class) - keeps the whole page reading as
              one centered column instead of stretching into dead space. */}
          <div className="mx-auto" style={{ maxWidth: '72rem' }}>
            <NebulaPageHeading
              title="Dashboard"
              subtitle="Welcome back! Here's what's happening with SlickSync."
              actions={
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<ArrowPathIcon className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />}
                  onClick={handleSyncAll}
                  isLoading={isSyncing}
                >
                  Sync All
                </Button>
              }
            />

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
              <Link href="/groups" className={`${NEBULA_GLASS_CLASS} p-5 flex items-center justify-between`} style={nebulaGlassStyle}>
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
              </Link>
              <Link href="/addons" className={`${NEBULA_GLASS_CLASS} p-5 flex items-center justify-between`} style={nebulaGlassStyle}>
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
              </Link>
            </div>

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
                  {continueWatching.map((item) => (
                    <ContinueWatchingCard
                      key={`${item.userId}-${item.showId}`}
                      item={item}
                      wasDraggedRef={wasDraggedRef}
                      onRemove={handleDismissContinueWatching}
                      onOpenDetails={setDetailModalItem}
                      isMenuOpen={openMenuKey === `${item.userId}-${item.showId}`}
                      onMenuOpenChange={(open) =>
                        setOpenMenuKey(open ? `${item.userId}-${item.showId}` : null)
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Recent Activity + Top Viewers, side by side - was previously
                a single full-width Recent Activity panel with a lot of
                empty space below its 5 rows on desktop; pairing it with
                Top Viewers (same data Current mode already shows) fills
                that space with something useful instead of padding. */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 items-start">
              <div className={`${NEBULA_GLASS_CLASS} p-5`} style={nebulaGlassStyle}>
                <NebulaGlassStripe />
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-semibold font-display text-default">Recent Activity</h3>
                  <Link href="/activity" className="text-sm font-medium" style={{ color: 'var(--color-secondary)' }}>
                    View All →
                  </Link>
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
                        <UserAvatar userId={np.user.id} name={np.user.username} email={np.user.email} src={np.user.useGravatar ? undefined : (np.user.avatarUrl ?? undefined)} size="sm" />
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
                          <p className="text-xs text-subtle">{new Date(np.watchedAt).toLocaleTimeString()}</p>
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
                  <Link href="/users" className="text-sm font-medium" style={{ color: 'var(--color-secondary)' }}>
                    See All →
                  </Link>
                </div>
                <div className="flex flex-col gap-1">
                  {isLoading ? (
                    <div className="text-center py-8 text-sm text-muted">Loading...</div>
                  ) : topUsers.length > 0 ? (
                    topUsers.map((user, index) => (
                      <Link key={user.id || user.name} href={`/users/${user.id}`} className="flex items-center gap-3 p-2.5 rounded-xl relative pl-4">
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
                      </Link>
                    ))
                  ) : (
                    <div className="text-center py-8 text-sm text-muted">No user data</div>
                  )}
                </div>
              </div>
            </div>

            {/* Recent Addons - reuses the exact same RecentAddonItem rows
                (and reload handler) as Current mode, just inside a glass
                panel instead of a Card. */}
            <div className={`${NEBULA_GLASS_CLASS} p-5`} style={nebulaGlassStyle}>
              <NebulaGlassStripe />
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold font-display text-default">Recent Addons</h3>
                <Link href="/addons" className="text-sm font-medium" style={{ color: 'var(--color-secondary)' }}>
                  View All →
                </Link>
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

        {detailModalItem && (
          <MediaDetailModal
            isOpen={!!detailModalItem}
            onClose={() => setDetailModalItem(null)}
            itemId={detailModalItem.showId}
            itemType="series"
            videoId={`${detailModalItem.showId}:${detailModalItem.nextEpisode.season}:${detailModalItem.nextEpisode.episode}`}
            fallbackTitle={detailModalItem.showName}
            fallbackPoster={detailModalItem.poster}
          />
        )}
      </>
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
                    onMenuOpenChange={(open) =>
                      setOpenMenuKey(open ? `${item.userId}-${item.showId}` : null)
                    }
                  />
                ))}
              </div>
            </Card>
          </PageSection>
        )}

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
                      <UserAvatar userId={np.user.id} name={np.user.username} email={np.user.email} src={np.user.useGravatar ? undefined : (np.user.avatarUrl ?? undefined)} size="sm" />
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
          itemType="series"
          videoId={`${detailModalItem.showId}:${detailModalItem.nextEpisode.season}:${detailModalItem.nextEpisode.episode}`}
          fallbackTitle={detailModalItem.showName}
          fallbackPoster={detailModalItem.poster}
        />
      )}
    </>
  );
}
