'use client';

import { useState, memo, useMemo, useEffect, useCallback, Fragment } from 'react';
import { motion } from 'framer-motion';
import { Header } from '@/components/layout/Header';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVPageProvider } from '@/components/tv/TVPageProvider';
import { Card, StatCard, Badge, Button, UserAvatar, PageToolbar, YearInReviewCard } from '@/components/ui';
import { PageSection, StaggerContainer, StaggerItem } from '@/components/layout/PageContainer';
import { api, MetricsData, AtRiskUser, TasteOverlapPair, TasteProfile, HealthStatus } from '@/lib/api';
import {
  UserLifecycleCard,
  HourlyHeatmap,
  AtRiskUsersTable,
  AddonPerformanceCard,
  ServerHealthDashboard,
  UserStreaksList,
  TopItemsSection,
  BingeWatchesSection,
} from '@/components/admin';
import { DbStorageCard } from '@/components/admin/DbStorageCard';
import {
  ChartBarIcon,
  ClockIcon,
  FilmIcon,
  TvIcon,
  FireIcon,
  TrophyIcon,
  ArrowTrendingUpIcon,
  ArrowTrendingDownIcon,
  CalendarIcon,
  UsersIcon,
  PlayIcon,
  ExclamationTriangleIcon,
  ServerIcon,
  PuzzlePieceIcon,
  HeartIcon,
  CheckCircleIcon,
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  ShieldCheckIcon,
  SignalIcon,
  EyeSlashIcon,
  EyeIcon,
  ChevronDownIcon,
  TagIcon,
} from '@heroicons/react/24/outline';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// Period options for filtering
const PERIOD_OPTIONS = [
  { value: 'all', label: 'All Time' },
  { value: '1h', label: '1 Hour' },
  { value: '24h', label: '24 Hours' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: '90d', label: '90 Days' },
  { value: '1y', label: '1 Year' },
];

// Helper function to format minutes
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

// Hoisted tooltip style - uses CSS variable compatible colors
const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(20, 20, 35, 0.95)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '12px',
  backdropFilter: 'blur(12px)',
} as const;

const TOOLTIP_LABEL_STYLE = { color: '#fff' } as const;

// Memoized chart component
const WatchTimeChart = memo(function WatchTimeChart({ data }: { data: Array<{ date: string; hours: number }> }) {
  // Calculate max hours to determine ticks dynamically or use a fixed set if small
  const maxHours = Math.max(...data.map(d => d.hours), 1);
  const tickCount = Math.ceil(maxHours / 0.5);
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => i * 0.5);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data}>
        <defs>
          <linearGradient id="colorWatchTime" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.4} />
            <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
        <XAxis 
          dataKey="date" 
          stroke="#64748b" 
          fontSize={12}
          tickFormatter={(value) => {
            const date = new Date(value);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
          }}
        />
        <YAxis 
          stroke="#64748b" 
          fontSize={12}
          ticks={ticks}
          tickFormatter={(value) => {
            if (value === 0) return '0m';
            const h = Math.floor(value);
            const m = Math.round((value - h) * 60);
            if (h === 0) return `${m}m`;
            return m === 0 ? `${h}h` : `${h}h${m}m`;
          }}
        />
        <Tooltip 
          contentStyle={TOOLTIP_STYLE} 
          labelStyle={TOOLTIP_LABEL_STYLE}
          labelFormatter={(value: any) => {
            const date = new Date(value);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
          }}
          formatter={(value: any) => [formatMinutes(Math.round(value * 60)), 'Time']}
        />
        <Area
          type="monotone"
          dataKey="hours"
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorWatchTime)"
          isAnimationActive={false} // Disable animation to prevent blinking during updates
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

const ContentBreakdownChart = memo(function ContentBreakdownChart({ data }: { data: Array<{ date: string; movies: number; series: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
        <XAxis 
          dataKey="date" 
          stroke="#64748b" 
          fontSize={12}
          tickFormatter={(value) => {
            const date = new Date(value);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
          }}
        />
        <YAxis stroke="#64748b" fontSize={12} />
        <Tooltip 
          contentStyle={TOOLTIP_STYLE} 
          labelStyle={TOOLTIP_LABEL_STYLE}
          labelFormatter={(value: any) => {
            const date = new Date(value);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
          }}
        />
        <Bar dataKey="movies" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} name="Movies" />
        <Bar dataKey="series" fill="var(--color-chart-2)" radius={[4, 4, 0, 0]} name="Series" />
      </BarChart>
    </ResponsiveContainer>
  );
});

// Health tab: "is everything actually working right now." Every number
// here reads state an existing background monitor already maintains (Sync
// Guardian, addon health checker, vault monitor, the AIOStreams proxy
// poller) - this computes nothing live, it just unifies signals that were
// previously scattered across four different admin pages. Ported from the
// standalone Health page, now a tab here since it's monitoring-only with no
// real actions, same as this page's other tabs.
function healthTimeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function HealthStatusPill({ ok }: { ok: boolean | null }) {
  if (ok === null) return <Badge variant="default" size="sm">Unknown</Badge>;
  return ok ? <Badge variant="success" size="sm">Healthy</Badge> : <Badge variant="warning" size="sm">Attention</Badge>;
}

function HealthCheckCard({
  icon, title, ok, summary, children,
}: {
  icon: React.ReactNode;
  title: string;
  ok: boolean | null;
  summary: string;
  children?: React.ReactNode;
}) {
  return (
    <Card padding="lg">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${ok === false ? 'bg-warning/15 text-warning' : 'bg-primary/10 text-primary'}`}>
            {icon}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-default">{title}</h3>
            <p className="text-xs text-muted">{summary}</p>
          </div>
        </div>
        <HealthStatusPill ok={ok} />
      </div>
      {children}
    </Card>
  );
}

function HealthIssueRow({
  title, detail, meta, onIgnore,
}: {
  title: string; detail?: string | null; meta?: string;
  /** Present only when this row can be dismissed as a known, accepted
   *  failure (e.g. an indexer that blocks this server's IP) - hides it from
   *  this list and from notifications, without needing it to actually
   *  resolve first. Reversible any time from the card's "Ignored" list. */
  onIgnore?: () => void;
}) {
  return (
    <div className="py-2 border-t border-default first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-default truncate">{title}</p>
        <div className="flex items-center gap-2 flex-shrink-0">
          {meta && <span className="text-xs text-subtle">{meta}</span>}
          {onIgnore && (
            <button
              type="button"
              onClick={onIgnore}
              title="Ignore - hide this from Health and its notifications"
              className="p-1 rounded text-subtle hover:text-default hover:bg-surface-hover transition-colors"
            >
              <EyeSlashIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {detail && <p className="text-xs text-warning mt-0.5 truncate">{detail}</p>}
    </div>
  );
}

function HealthIgnoredList({
  items, onUnignore,
}: {
  items: Array<{ id: string; name: string }>;
  onUnignore: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-2 pt-2 border-t border-default">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-subtle hover:text-default transition-colors"
      >
        <ChevronDownIcon className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        {items.length} ignored
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-2">
              <p className="text-xs text-subtle truncate">{item.name}</p>
              <button
                type="button"
                onClick={() => onUnignore(item.id)}
                title="Un-ignore"
                className="p-1 rounded text-subtle hover:text-default hover:bg-surface-hover transition-colors flex-shrink-0"
              >
                <EyeIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MetricsPage() {
  const { layoutMode } = useLayoutMode();
  const isTV = useIsTV();
  const Wrapper = isTV ? TVPageProvider : Fragment;
  const [period, setPeriod] = useState('30d');
  const [viewMode, setViewMode] = useState<'users' | 'content' | 'admin' | 'health'>('users');
  const [metricsData, setMetricsData] = useState<MetricsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [selectedUser, setSelectedUser] = useState<AtRiskUser | null>(null);
  const [tasteOverlap, setTasteOverlap] = useState<TasteOverlapPair[]>([]);
  const [tasteProfiles, setTasteProfiles] = useState<TasteProfile[]>([]);
  const [healthData, setHealthData] = useState<HealthStatus | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthRefreshing, setHealthRefreshing] = useState(false);

  const loadHealth = useCallback((silent = false) => {
    if (silent) setHealthRefreshing(true); else setHealthLoading(true);
    api.getHealthStatus()
      .then(setHealthData)
      .catch(() => setHealthData(null))
      .finally(() => { setHealthLoading(false); setHealthRefreshing(false); });
  }, []);
  useEffect(() => { loadHealth(); }, [loadHealth]);

  const toggleVaultIgnored = useCallback((id: string, healthIgnored: boolean) => {
    api.setVaultHealthIgnored(id, healthIgnored).then(() => loadHealth(true)).catch(() => {});
  }, [loadHealth]);
  const toggleAddonIgnored = useCallback((id: string, healthIgnored: boolean) => {
    api.setAddonHealthIgnored(id, healthIgnored).then(() => loadHealth(true)).catch(() => {});
  }, [loadHealth]);

  // Fetch metrics data
  useEffect(() => {
    setIsLoading(true);
    setError(null);
    api.getMetrics(period)
      .then((data) => {
        setMetricsData(data);
        setIsLoading(false);
      })
      .catch((err) => {
        setError(err);
        setIsLoading(false);
      });
  }, [period]);

  // Taste overlap is all-time real watch-time comparison, not windowed by
  // the period filter above - fetched once, independently.
  useEffect(() => {
    api.getTasteOverlap()
      .then((data) => setTasteOverlap(data.pairs || []))
      .catch(() => setTasteOverlap([]));
    api.getTasteProfile()
      .then((data) => setTasteProfiles(data.profiles || []))
      .catch(() => setTasteProfiles([]));
  }, []);

  // Same fix as Dashboard/Activity's "Active Users" stat:
  // metricsData.summary.activeUsers counts anyone with watch activity
  // anywhere in the selected period, not who's watching right now - per
  // explicit request, this stat should read the same live count Dashboard
  // and Activity show (0 when nobody's actually streaming), not a
  // period-wide "was active at some point" count. Derived from the same
  // live nowPlaying feed, deduped by user id.
  const liveActiveUsersCount = metricsData?.nowPlaying
    ? new Set(metricsData.nowPlaying.map((np) => np.user.id)).size
    : 0;

  // Transform watch time data for chart
  const watchTimeChartData = useMemo(() => {
    if (!metricsData?.watchTime?.byDay) return [];
    return metricsData.watchTime.byDay.map((item) => ({
      date: item.date,
      hours: item.hours,
    }));
  }, [metricsData]);

  // Transform content breakdown data for chart - calculated from watchSessions for accuracy
  const contentBreakdownData = useMemo(() => {
    if (!metricsData?.watchActivity?.byDay || metricsData.watchActivity.byDay.length === 0) {
      return [];
    }
    
    // Use watchSessions to get actual counts (movies watched and episodes watched)
    // instead of unique series count from the API
    return metricsData.watchActivity.byDay.map((item) => {
      const dateStr = item.date;
      
      // If we have watchSessions, calculate actual counts from them
      if (metricsData.watchSessions && metricsData.watchSessions.length > 0) {
        const sessionsForDate = metricsData.watchSessions.filter((session) => {
          const sessionDate = new Date(session.startTime).toLocaleDateString('sv-SE');
          return sessionDate === dateStr;
        });
        
        const movieCount = sessionsForDate.filter((s) => s.item.type === 'movie').length;
        const seriesCount = sessionsForDate.filter((s) => s.item.type === 'series').length;
        
        return {
          date: dateStr,
          movies: movieCount,
          series: seriesCount,
        };
      }
      
      // Fallback to API data if no sessions available
      return {
        date: dateStr,
        movies: item.movies || 0,
        series: item.shows || 0,
      };
    });
  }, [metricsData]);

  // Transform top users data
  const topUsersData = useMemo(() => {
    if (!metricsData?.watchActivity?.byUser) return [];
    return metricsData.watchActivity.byUser
      .sort((a, b) => (b.watchTimeHours || 0) - (a.watchTimeHours || 0))
      .slice(0, 5)
      .map((user) => ({
        id: user.id,
        name: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        useGravatar: user.useGravatar,
        watchTime: Math.round(user.watchTimeHours * 60), // Convert to minutes
        movies: user.movies,
        series: user.shows,
        streak: user.streak || 0,
        trend: 'up' as const, // Trend calculation would need historical data
      }));
  }, [metricsData]);

  const periodSelect = (
    <select
      value={period}
      onChange={(e) => setPeriod(e.target.value)}
      className="px-4 py-2 rounded-xl text-sm bg-surface border border-default text-default"
      aria-label="Select time period"
    >
      {PERIOD_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  return (
    <Wrapper>
      {layoutMode !== 'nebula' && (
        <Header
          title="Metrics"
          subtitle="Track watch time, content consumption, and user activity"
          actions={<div className="flex items-center gap-3">{periodSelect}</div>}
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
      {layoutMode === 'nebula' && (
        <NebulaPageHeading
          title="Metrics"
          subtitle="Track watch time, content consumption, and user activity"
          actions={periodSelect}
        />
      )}
        {/* View Mode Toggle - Centered */}
        <PageSection className="mb-6">
          <PageToolbar
            animate={false}
            filterTabs={{
              options: [
                { key: 'users', label: 'Users', icon: <UsersIcon className="w-4 h-4" /> },
                { key: 'content', label: 'Content', icon: <PlayIcon className="w-4 h-4" /> },
                { key: 'admin', label: 'Admin', icon: <ServerIcon className="w-4 h-4" /> },
                { key: 'health', label: 'Health', icon: <HeartIcon className="w-4 h-4" /> },
              ],
              activeKey: viewMode,
              onChange: (key) => setViewMode(key as 'users' | 'content' | 'admin' | 'health'),
              layoutId: 'metrics-view-tabs',
            }}
          />
        </PageSection>

        {/* Year in Review (roadmap #8) - a Wrapped-style yearly summary. Only
            on the Users tab - it's a personal viewing-habits recap, out of
            place above Content/Admin/Health's more operational content. */}
        {viewMode === 'users' && (
          <PageSection className="mb-6">
            <YearInReviewCard />
          </PageSection>
        )}

        {/* Users Tab - User Leaderboard + Streaks + Watch Time Trend */}
        {viewMode === 'users' && (
          <div className="space-y-6">
            {/* Stats Grid for Users Tab */}
            <PageSection className="mb-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Active Users"
                  value={isLoading ? '...' : liveActiveUsersCount}
                  icon={<UsersIcon className="w-6 h-6" />}
                  delay={0}
                />
                <StatCard
                  label="Avg Watch Time/User"
                  value={isLoading ? '...' : formatMinutes(Math.round(metricsData?.admin?.interestingMetrics?.avgWatchTimePerUser || 0))}
                  icon={<ClockIcon className="w-6 h-6" />}
                  delay={0.05}
                />
                <StatCard
                  label="At-Risk Users"
                  value={isLoading ? '...' : ((metricsData?.admin?.userLifecycle?.criticalRisk?.length || 0) + (metricsData?.admin?.userLifecycle?.atRisk?.length || 0))}
                  icon={<ExclamationTriangleIcon className="w-6 h-6" />}
                  delay={0.1}
                />
                <StatCard
                  label="Top Streaker"
                  value={isLoading ? '...' : (topUsersData.length > 0 ? `${topUsersData.reduce((max, u) => Math.max(max, u.streak), 0)} days` : '0 days')}
                  icon={<FireIcon className="w-6 h-6" />}
                  delay={0.15}
                />
              </div>
            </PageSection>

            {/* Top Row: Leaderboard + Streaks side by side */}
            <PageSection delay={0.25}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* User Leaderboard */}
                <Card padding="lg">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <TrophyIcon className="w-6 h-6" />
                      <h3 className="text-lg font-semibold font-display text-default">User Leaderboard</h3>
                    </div>
                    <Badge variant="primary">Top 5</Badge>
                  </div>

                  <StaggerContainer className="space-y-3">
                    {topUsersData.length === 0 ? (
                      <div className="text-center py-8 text-sm text-muted">
                        {isLoading ? 'Loading...' : 'No user data available'}
                      </div>
                    ) : (
                      topUsersData.map((user, index) => (
                      <StaggerItem key={user.id}>
                        <motion.div
                          whileHover={{ x: 4 }}
                          className="flex items-center gap-4 p-4 rounded-xl transition-colors bg-surface-hover overflow-hidden"
                        >
                          {/* Rank */}
                          <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
                            style={{
                              background: index === 0
                                ? 'var(--color-warning-muted)'
                                : index === 1
                                ? 'rgba(148, 163, 184, 0.2)'
                                : index === 2
                                ? 'rgba(180, 83, 9, 0.2)'
                                : 'var(--color-surface-hover)',
                              color: index === 0
                                ? 'var(--color-warning)'
                                : index === 1
                                ? '#94a3b8'
                                : index === 2
                                ? '#b45309'
                                : 'var(--color-text-muted)'
                            }}
                          >
                            {index + 1}
                          </div>

                          {/* Avatar & Name */}
                          <UserAvatar userId={user.id} name={user.name} email={user.email} src={user.useGravatar ? undefined : (user.avatarUrl ?? undefined)} size="md" className="shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-default truncate">{user.name}</p>
                            <div className="flex items-center gap-4 text-sm text-muted">
                              <span className="flex items-center gap-1 shrink-0">
                                <FilmIcon className="w-4 h-4" />
                                {user.movies}
                              </span>
                              <span className="flex items-center gap-1 shrink-0">
                                <TvIcon className="w-4 h-4" />
                                {user.series}
                              </span>
                              <span className="flex items-center gap-1 shrink-0">
                                <FireIcon className="w-4 h-4" />
                                {user.streak} {user.streak === 1 ? 'day' : 'days'}
                              </span>
                            </div>
                          </div>

                          {/* Watch Time */}
                          <div className="text-right shrink-0">
                            <p className="text-lg font-bold text-default">{formatMinutes(user.watchTime)}</p>
                            <div className="flex items-center justify-end gap-1 text-sm">
                              {user.trend === 'up' ? (
                                <>
                                  <ArrowTrendingUpIcon className="w-4 h-4 text-primary" />
                                  <span className="text-primary">Rising</span>
                                </>
                              ) : (
                                <>
                                  <ArrowTrendingDownIcon className="w-4 h-4" />
                                  <span>Falling</span>
                                </>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      </StaggerItem>
                      ))
                    )}
                  </StaggerContainer>
                </Card>

                {/* User Watch Streaks */}
                <Card padding="lg">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <FireIcon className="w-6 h-6" />
                      <h3 className="text-lg font-semibold font-display text-default">Watch Streaks</h3>
                    </div>
                  </div>
                  {topUsersData.length > 0 && (
                    <UserStreaksList 
                      users={topUsersData.map(u => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl, useGravatar: u.useGravatar }))} 
                    />
                  )}
                </Card>
              </div>
            </PageSection>

            {/* Watch Time Trend - Full width */}
            <PageSection delay={0.3}>
              <Card padding="lg">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-lg font-semibold font-display text-default">Watch Time Trend</h3>
                    <p className="text-sm text-muted">Daily watch time over the period</p>
                  </div>
                  {metricsData?.watchTime?.trend && metricsData.watchTime.trend.percentage > 0 && (
                    <Badge variant="primary">
                      {metricsData.watchTime.trend.direction === 'up' ? (
                        <ArrowTrendingUpIcon className="w-4 h-4 mr-1" />
                      ) : (
                        <ArrowTrendingDownIcon className="w-4 h-4 mr-1" />
                      )}
                      {metricsData.watchTime.trend.direction === 'up' ? '+' : '-'}{metricsData.watchTime.trend.percentage}%
                    </Badge>
                  )}
                </div>
                <div className="h-40 md:h-64">
                  {isLoading ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="flex items-center gap-2 text-sm text-muted">
                        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        <span>Loading...</span>
                      </div>
                    </div>
                  ) : watchTimeChartData.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-sm text-muted">
                      No data available
                    </div>
                  ) : (
                    <WatchTimeChart data={watchTimeChartData} />
                  )}
                </div>
              </Card>
            </PageSection>

            {/* Taste profiles - per-user profile built from real watch data
                (top titles by actual time, movie/series split, genres, and
                closest household match). The richer replacement for the old
                flat overlap list; the overlap "shared favorites" detail stays
                below as a companion. */}
            {tasteProfiles.length > 0 && (
              <PageSection delay={0.33}>
                <Card padding="lg">
                  <div className="flex items-center gap-3 mb-6">
                    <HeartIcon className="w-6 h-6" />
                    <div>
                      <h3 className="text-lg font-semibold font-display text-default">Taste profiles</h3>
                      <p className="text-sm text-muted">Each member&apos;s real viewing fingerprint — from actual watch-time, not tags</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {tasteProfiles.map((p) => {
                      const hrs = Math.floor(p.totalSeconds / 3600);
                      const mins = Math.round((p.totalSeconds % 3600) / 60);
                      const timeLabel = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
                      return (
                        <div key={p.user.id} className="p-4 rounded-xl bg-surface-hover flex flex-col gap-3">
                          <div className="flex items-center gap-3">
                            <UserAvatar userId={p.user.id} name={p.user.username} email={p.user.email} src={p.user.useGravatar ? undefined : (p.user.avatarUrl ?? undefined)} size="md" />
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-default truncate">{p.user.username}</p>
                              <p className="text-xs text-muted">{timeLabel} · {p.movieCount} movies · {p.seriesCount} series</p>
                            </div>
                          </div>

                          {p.topGenres.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {p.topGenres.map((g) => (
                                <span key={g.genre} className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-primary-muted text-primary">{g.genre}</span>
                              ))}
                            </div>
                          )}

                          {p.topTitles.length > 0 && (
                            <div className="flex gap-2 overflow-x-auto pb-1">
                              {p.topTitles.map((t) => (
                                <div key={t.key} title={t.name} className="w-14 shrink-0">
                                  <div className="w-14 h-20 rounded-lg overflow-hidden bg-surface border border-default">
                                    {t.poster && <img src={t.poster} alt={t.name} className="w-full h-full object-cover" />}
                                  </div>
                                  <p className="text-[10px] text-muted mt-1 truncate">{t.name}</p>
                                </div>
                              ))}
                            </div>
                          )}

                          {p.tasteTwin && (
                            <div className="flex items-center gap-2 pt-1 border-t border-default/50 mt-auto">
                              <span className="text-xs text-muted">Closest match:</span>
                              <UserAvatar userId={p.tasteTwin.user.id} name={p.tasteTwin.user.username} email={p.tasteTwin.user.email} src={p.tasteTwin.user.useGravatar ? undefined : (p.tasteTwin.user.avatarUrl ?? undefined)} size="xs" />
                              <span className="text-xs font-medium text-default truncate">{p.tasteTwin.user.username}</span>
                              <Badge variant="primary" size="sm">{p.tasteTwin.similarity}%</Badge>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Card>
              </PageSection>
            )}

            {/* Taste Overlap - real behavioral overlap (actual watch-time
                on shared titles), not genre-tag matching. Hidden entirely
                for a single-user household, where a "pair" can't exist. */}
            {tasteOverlap.length > 0 && (
              <PageSection delay={0.35}>
                <Card padding="lg">
                  <div className="flex items-center gap-3 mb-6">
                    <HeartIcon className="w-6 h-6" />
                    <div>
                      <h3 className="text-lg font-semibold font-display text-default">Taste overlap</h3>
                      <p className="text-sm text-muted">Real shared watch-time between household members, not genre matching</p>
                    </div>
                  </div>
                  <div className="space-y-5">
                    {tasteOverlap.map((pair) => (
                      <div key={`${pair.userA.id}-${pair.userB.id}`} className="p-4 rounded-xl bg-surface-hover">
                        <div className="flex items-center gap-3 mb-3">
                          <UserAvatar userId={pair.userA.id} name={pair.userA.username} email={pair.userA.email} src={pair.userA.useGravatar ? undefined : (pair.userA.avatarUrl ?? undefined)} size="sm" />
                          <span className="text-sm font-medium text-default truncate">{pair.userA.username}</span>
                          <Badge variant="primary">{pair.similarity}% overlap</Badge>
                          <span className="text-sm font-medium text-default truncate">{pair.userB.username}</span>
                          <UserAvatar userId={pair.userB.id} name={pair.userB.username} email={pair.userB.email} src={pair.userB.useGravatar ? undefined : (pair.userB.avatarUrl ?? undefined)} size="sm" />
                        </div>
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {pair.shared.map((item) => (
                            <div key={item.key} title={item.name || undefined} className="w-16 shrink-0">
                              <div className="w-16 h-24 rounded-lg overflow-hidden bg-surface border border-default">
                                {item.poster && (
                                  <img src={item.poster} alt={item.name || ''} className="w-full h-full object-cover" />
                                )}
                              </div>
                              <p className="text-xs text-muted mt-1 truncate">{item.name}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </PageSection>
            )}
          </div>
        )}

        {/* Content Tab - Top Content + Engagement + Top Items + Watch Velocity + Started Playing */}
        {viewMode === 'content' && (
          <div className="space-y-6">
            {/* Stats Grid for Content Tab */}
            <PageSection className="mb-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Movies Watched"
                  value={isLoading ? '...' : (metricsData?.summary?.totalMovies || 0)}
                  icon={<FilmIcon className="w-6 h-6" />}
                  delay={0}
                />
                <StatCard
                  label="Series Watched"
                  value={isLoading ? '...' : (metricsData?.summary?.totalShows || 0)}
                  icon={<TvIcon className="w-6 h-6" />}
                  delay={0.05}
                />
                <StatCard
                  label="Most Watched"
                  value={isLoading ? '...' : (() => {
                    const name = metricsData?.admin?.topItems?.series?.[0]?.name;
                    if (!name) return 'N/A';
                    return name.length > 15 ? name.substring(0, 15) + '...' : name;
                  })()}
                  icon={<TrophyIcon className="w-6 h-6" />}
                  delay={0.1}
                />
                <StatCard
                  label="Binge Sessions"
                  value={isLoading ? '...' : (metricsData?.admin?.interestingMetrics?.totalBingeSessions || 0)}
                  icon={<FireIcon className="w-6 h-6" />}
                  delay={0.15}
                />
              </div>
            </PageSection>

            {/* Top Row: Top Items + Watch Velocity side by side */}
            <PageSection delay={0.25}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Most Watched Section */}
                <Card padding="lg">
                  <div className="flex items-center justify-between mb-6">
                                      <div className="flex items-center gap-3">
                                        <TrophyIcon className="w-6 h-6" />
                                        <h3 className="text-lg font-semibold font-display text-default">Most Watched</h3>
                                      </div>
                                    </div>
                                    {metricsData?.admin?.topItems ? (
                                      <TopItemsSection
                                        key={period} // Only force reset when period changes
                                        movies={metricsData.admin.topItems.movies}
                                        series={metricsData.admin.topItems.series}
                                      />
                                    ) : (
                                      <div className="text-center py-8 text-sm text-muted">No top items data available</div>
                                    )}
                                  </Card>
                    
                                  {/* Binge Watches Section */}
                                  <Card padding="lg">
                                    <div className="flex items-center justify-between mb-6">
                                      <div className="flex items-center gap-3">
                                        <FireIcon className="w-6 h-6" />
                                        <h3 className="text-lg font-semibold font-display text-default">Binge Watches</h3>
                                      </div>
                                    </div>
                                    {metricsData?.admin?.watchVelocity ? (
                                      <BingeWatchesSection 
                                        key={period}
                                        items={metricsData.admin.watchVelocity} 
                                      />
                                    ) : (
                                      <div className="text-center py-8 text-sm text-muted">No binge watch data available</div>
                                    )}
                                  </Card>
                                </div>
                              </PageSection>
            {/* Second Row: Engagement Patterns + Content Breakdown side by side */}
            <PageSection delay={0.3}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Engagement Patterns */}
                <Card padding="lg">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-semibold font-display text-default">Engagement Patterns</h3>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">Avg: {metricsData?.admin?.engagement?.averageSessionMinutes || 0} min</Badge>
                      <Badge variant="secondary">Binge: {metricsData?.admin?.engagement?.bingeSessions || 0}</Badge>
                    </div>
                  </div>
                  {metricsData?.admin?.engagement && (
                    <HourlyHeatmap
                      hourlyActivity={metricsData.admin.engagement.hourlyActivity}
                      peakHour={metricsData.admin.engagement.peakHour}
                    />
                  )}
                </Card>

                {/* Content Breakdown */}
                <Card padding="lg" className="flex flex-col">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className="text-lg font-semibold font-display text-default">Content Breakdown</h3>
                      <p className="text-sm text-muted">Movies vs Series</p>
                    </div>
                  </div>
                  <div className="h-40 md:h-64">
                    {isLoading ? (
                      <div className="flex items-center justify-center h-full">
                        <div className="flex items-center gap-2 text-sm text-muted">
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          <span>Loading...</span>
                        </div>
                      </div>
                    ) : error ? (
                      <div className="flex items-center justify-center h-full text-sm text-muted">
                        Failed to load data
                      </div>
                    ) : contentBreakdownData.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full text-sm text-muted">
                        <p className="mb-2">No watch activity data</p>
                        <p className="text-xs opacity-70">
                          {metricsData?.watchActivity?.byDay 
                            ? "No activity in selected period" 
                            : "Loading data..."}
                        </p>
                      </div>
                    ) : (
                      <ContentBreakdownChart data={contentBreakdownData} />
                    )}
                  </div>
                  {/* Legend */}
                  <div className="flex items-center justify-center gap-6 mt-4 pt-4 border-t border-default">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ background: 'var(--color-chart-1)' }} />
                      <span className="text-sm text-muted">Movies</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ background: 'var(--color-chart-2)' }} />
                      <span className="text-sm text-muted">Series</span>
                    </div>
                  </div>
                </Card>
              </div>
            </PageSection>
          </div>
        )}

        {/* Admin Tab - All Admin Sections */}
        {viewMode === 'admin' && (
          <div className="space-y-6">
            {/* Stats Grid for Admin Tab */}
            <PageSection className="mb-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Most Active Hour"
                  value={isLoading ? '...' : `${metricsData?.admin?.interestingMetrics?.mostActiveHour || 0}:00`}
                  icon={<ClockIcon className="w-6 h-6" />}
                  delay={0}
                />
                <StatCard
                  label="Weekend Watching"
                  value={isLoading ? '...' : `${(metricsData?.admin?.interestingMetrics?.weekendWatchPercentage || 0).toFixed(1)}%`}
                  icon={<CalendarIcon className="w-6 h-6" />}
                  delay={0.05}
                />
                <StatCard
                  label="Completion Rate"
                  value={isLoading ? '...' : `${(metricsData?.admin?.interestingMetrics?.completionRate || 0).toFixed(1)}%`}
                  icon={<ChartBarIcon className="w-6 h-6" />}
                  delay={0.1}
                />
                <StatCard
                  label="Avg Session"
                  value={isLoading ? '...' : formatMinutes(Math.round(metricsData?.admin?.interestingMetrics?.avgSessionDuration || 0))}
                  icon={<PlayIcon className="w-6 h-6" />}
                  delay={0.15}
                />
              </div>
            </PageSection>

            {/* User Joins Over Time Chart */}
            {metricsData?.userJoins?.byDay && metricsData.userJoins.byDay.length > 0 && (
              <PageSection delay={0.22}>
                <Card padding="lg">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className="text-lg font-semibold font-display text-default">User Joins Over Time</h3>
                      <p className="text-sm text-muted">New user signups by day</p>
                    </div>
                    <Badge variant="primary">
                      <UsersIcon className="w-4 h-4 mr-1" />
                      {metricsData.userJoins.byDay.reduce((sum, day) => sum + day.count, 0)} Total
                    </Badge>
                  </div>
                  <div className="h-40 md:h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={metricsData.userJoins.byDay}>
                        <defs>
                          <linearGradient id="colorUserJoins" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--color-chart-3)" stopOpacity={0.4} />
                            <stop offset="95%" stopColor="var(--color-chart-3)" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis 
                          dataKey="date" 
                          stroke="#64748b" 
                          fontSize={12}
                          tickFormatter={(value) => {
                            const date = new Date(value);
                            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
                          }}
                        />
                        <YAxis stroke="#64748b" fontSize={12} />
                        <Tooltip 
                          contentStyle={TOOLTIP_STYLE} 
                          labelStyle={TOOLTIP_LABEL_STYLE}
                          labelFormatter={(value: any) => {
                            const date = new Date(value);
                            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
                          }}
                          formatter={(value) => [`${value} user${Number(value) !== 1 ? 's' : ''}`, 'New Signups']}
                        />
                        <Area
                          type="monotone"
                          dataKey="count"
                          stroke="var(--color-chart-3)"
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#colorUserJoins)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              </PageSection>
            )}

            {/* Top Row: Lifecycle + At-Risk side by side */}
            <PageSection delay={0.25}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* User Lifecycle Section */}
                <Card padding="lg">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-semibold font-display text-default">User Lifecycle</h3>
                    <Badge variant="primary">Retention</Badge>
                  </div>
                  {metricsData?.admin?.userLifecycle && (
                    <UserLifecycleCard
                      lifecycle={metricsData.admin.userLifecycle}
                      userJoins={metricsData.userJoins?.byDay || []}
                    />
                  )}
                </Card>

                {/* At-Risk Users Section */}
                <Card padding="lg">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <ExclamationTriangleIcon className="w-6 h-6" />
                      <h3 className="text-lg font-semibold font-display text-default">At-Risk Users</h3>
                    </div>
                    <Badge>
                      {metricsData?.admin?.userLifecycle?.criticalRisk?.length || 0} Critical,{' '}
                      {metricsData?.admin?.userLifecycle?.atRisk?.length || 0} Warning
                    </Badge>
                  </div>
                  {metricsData?.admin?.userLifecycle && (
                    <AtRiskUsersTable
                      atRiskUsers={metricsData.admin.userLifecycle.atRisk}
                      criticalUsers={metricsData.admin.userLifecycle.criticalRisk}
                      onUserClick={setSelectedUser}
                    />
                  )}
                </Card>
              </div>
            </PageSection>

            {/* Server Health Section - Full width */}
            <PageSection delay={0.3}>
              <Card padding="lg">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <ServerIcon className="w-6 h-6 text-primary" />
                    <h3 className="text-lg font-semibold font-display text-default">Server Health</h3>
                  </div>
                  <Badge 
                    variant={
                      metricsData?.admin?.serverHealth?.status === 'healthy' 
                        ? 'success' 
                        : metricsData?.admin?.serverHealth?.status === 'warning'
                        ? 'warning'
                        : 'error'
                    }
                  >
                    {metricsData?.admin?.serverHealth?.status?.toUpperCase() || 'UNKNOWN'}
                  </Badge>
                </div>
                {metricsData?.admin?.serverHealth && (
                  <ServerHealthDashboard
                    status={metricsData.admin.serverHealth.status}
                    checks={metricsData.admin.serverHealth.checks}
                    metrics={metricsData.admin.serverHealth.metrics}
                  />
                )}
              </Card>
            </PageSection>

            {/* Addon Performance Section - Full width */}
            <PageSection delay={0.35}>
              <Card padding="lg">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <PuzzlePieceIcon className="w-6 h-6 text-secondary" />
                    <h3 className="text-lg font-semibold font-display text-default">Addon Performance</h3>
                  </div>
                  <Badge variant="secondary">
                    {metricsData?.admin?.addonAnalytics?.totalAddons || 0} Addons
                  </Badge>
                </div>
                {metricsData?.admin?.addonAnalytics && (
                  <AddonPerformanceCard
                    totalAddons={metricsData.admin.addonAnalytics.totalAddons}
                    activeAddons={metricsData.admin.addonAnalytics.activeAddons}
                    topAddons={metricsData.admin.addonAnalytics.topAddons}
                    byResource={metricsData.admin.addonAnalytics.byResource}
                  />
                )}
              </Card>
            </PageSection>
          </div>
        )}

        {viewMode === 'health' && (
          healthLoading ? (
            <PageSection>
              <div className="h-24 rounded-xl bg-surface-hover animate-pulse mb-6" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[...Array(4)].map((_, i) => <div key={i} className="h-40 rounded-xl bg-surface-hover animate-pulse" />)}
              </div>
            </PageSection>
          ) : !healthData ? (
            <PageSection>
              <Card padding="lg" className="text-center">
                <ExclamationTriangleIcon className="w-10 h-10 mx-auto text-warning mb-3" />
                <p className="text-sm text-muted">Couldn&apos;t load health status.</p>
              </Card>
            </PageSection>
          ) : (
            <>
              <PageSection className="mb-6">
                <div className="flex justify-end mb-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<ArrowPathIcon className={`w-4 h-4 ${healthRefreshing ? 'animate-spin' : ''}`} />}
                    onClick={() => loadHealth(true)}
                    disabled={healthRefreshing}
                  >
                    Refresh
                  </Button>
                </div>
                <Card
                  padding="lg"
                  className={healthData.overall === 'healthy' ? 'border-success/30' : 'border-warning/30'}
                  style={{
                    background: healthData.overall === 'healthy'
                      ? 'linear-gradient(120deg, rgba(34,197,94,0.10) 0%, transparent 60%)'
                      : 'linear-gradient(120deg, rgba(234,179,8,0.12) 0%, transparent 60%)',
                  }}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 ${healthData.overall === 'healthy' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
                      {healthData.overall === 'healthy' ? <CheckCircleIcon className="w-8 h-8" /> : <ExclamationTriangleIcon className="w-8 h-8" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-xl font-bold font-display text-default">
                        {healthData.overall === 'healthy' ? 'Everything is running smoothly' : 'Something needs attention'}
                      </h2>
                      <p className="text-sm text-muted">
                        Last checked {healthTimeAgo(healthData.checkedAt)}
                        {healthData.overall !== 'healthy' && ' — see the cards below for what to fix.'}
                      </p>
                    </div>
                  </div>
                </Card>
              </PageSection>

              <PageSection>
                {/* Masonry (CSS columns), not a grid - these cards vary a lot
                    in height (Addons' uptime list, the incident timeline),
                    and a strict 2-col grid sizes every row to its tallest
                    cell, which left large dead gaps under the shorter card
                    in that row. break-inside-avoid-column keeps each card
                    from being split across the column break. */}
                <div className="columns-1 md:columns-2 gap-4">
                  <div className="mb-4 break-inside-avoid-column">
                  <HealthCheckCard
                    icon={<ArrowsRightLeftIcon className="w-5 h-5" />}
                    title="Sync"
                    ok={healthData.sync.driftCount === 0}
                    summary={`${healthData.sync.usersTracked} user${healthData.sync.usersTracked !== 1 ? 's' : ''} tracked`}
                  >
                    {healthData.sync.driftCount > 0 ? (
                      <div>
                        {healthData.sync.drifted.map((d, i) => (
                          <HealthIssueRow key={i} title={d.title} detail={d.body} meta={healthTimeAgo(d.since)} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-subtle">No accounts have drifted from their group&apos;s addons.</p>
                    )}
                  </HealthCheckCard>
                  </div>

                  <div className="mb-4 break-inside-avoid-column">
                  <HealthCheckCard
                    icon={<PuzzlePieceIcon className="w-5 h-5" />}
                    title="Addons"
                    ok={healthData.addons.offlineCount === 0}
                    summary={`${healthData.addons.checked}/${healthData.addons.total} checked`}
                  >
                    {healthData.addons.offlineCount > 0 ? (
                      <div>
                        {healthData.addons.offline.map((a) => (
                          <HealthIssueRow key={a.id} title={a.name} detail={a.error} meta={healthTimeAgo(a.lastChecked)} onIgnore={() => toggleAddonIgnored(a.id, true)} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-subtle">All addon manifests are reachable.</p>
                    )}
                    <HealthIgnoredList items={healthData.addons.ignored} onUnignore={(id) => toggleAddonIgnored(id, false)} />
                    {healthData.addons.uptime.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-default">
                        <p className="text-[10px] uppercase tracking-wide text-subtle mb-1.5">Uptime</p>
                        <div className="space-y-1">
                          {healthData.addons.uptime.map((a) => (
                            <div key={a.id} className="flex items-center justify-between gap-2 text-xs">
                              <span className="text-default truncate">{a.name}</span>
                              <span className={`flex-shrink-0 font-medium ${a.uptime30d < 99 ? 'text-warning' : 'text-subtle'}`}>
                                {a.uptime7d.toFixed(1)}% (7d) · {a.uptime30d.toFixed(1)}% (30d)
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </HealthCheckCard>
                  </div>

                  <div className="mb-4 break-inside-avoid-column">
                  <HealthCheckCard
                    icon={<ShieldCheckIcon className="w-5 h-5" />}
                    title="Vault"
                    ok={healthData.vault.failingCount === 0 && healthData.vault.expiringCount === 0}
                    summary={`${healthData.vault.total} credential${healthData.vault.total !== 1 ? 's' : ''} tracked`}
                  >
                    {healthData.vault.failingCount > 0 || healthData.vault.expiringCount > 0 ? (
                      <div>
                        {healthData.vault.failing.map((v) => (
                          <HealthIssueRow key={`f-${v.id}`} title={v.name} detail={v.message || 'Check failed'} meta={healthTimeAgo(v.lastChecked)} onIgnore={() => toggleVaultIgnored(v.id, true)} />
                        ))}
                        {healthData.vault.expiring.map((v) => (
                          <HealthIssueRow key={`e-${v.id}`} title={v.name} detail="Expiring soon" meta={new Date(v.expiresAt).toLocaleDateString()} onIgnore={() => toggleVaultIgnored(v.id, true)} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-subtle">All credentials are passing checks with no upcoming expiry.</p>
                    )}
                    <HealthIgnoredList items={healthData.vault.ignored} onUnignore={(id) => toggleVaultIgnored(id, false)} />
                  </HealthCheckCard>
                  </div>

                  <div className="mb-4 break-inside-avoid-column">
                  <HealthCheckCard
                    icon={<SignalIcon className="w-5 h-5" />}
                    title="Proxy"
                    ok={!healthData.proxy.configured ? null : healthData.proxy.ok}
                    summary={!healthData.proxy.configured ? 'Not configured' : `Last poll ${healthTimeAgo(healthData.proxy.at)}`}
                  >
                    {!healthData.proxy.configured ? (
                      <p className="text-xs text-subtle">AIOStreams proxy isn&apos;t configured on this instance.</p>
                    ) : healthData.proxy.ok === false ? (
                      <HealthIssueRow title="Proxy stats unreachable" detail={healthData.proxy.error} meta={healthTimeAgo(healthData.proxy.at)} />
                    ) : (
                      <p className="text-xs text-subtle">Now Playing polling is reaching AIOStreams normally.</p>
                    )}
                  </HealthCheckCard>
                  </div>

                  <div className="mb-4 break-inside-avoid-column">
                  <HealthCheckCard
                    icon={<TagIcon className="w-5 h-5" />}
                    title="Version"
                    ok={!healthData.version.updateAvailable}
                    summary={`Running ${healthData.version.running}`}
                  >
                    {healthData.version.updateAvailable ? (
                      <HealthIssueRow title={`Update available: ${healthData.version.latestRelease}`} detail="A newer stable release has been published" />
                    ) : (
                      <p className="text-xs text-subtle">
                        {healthData.version.latestRelease
                          ? `Up to date with the latest stable release (${healthData.version.latestRelease}).`
                          : "Running the latest build - couldn't reach GitHub to check for a newer stable release."}
                      </p>
                    )}
                  </HealthCheckCard>
                  </div>

                  {/* Unified incident timeline: every offline/online addon
                      transition plus every vault/proxy health notification,
                      in one feed - answers "when did this actually start"
                      without digging through three separate places. */}
                  {healthData.timeline.length > 0 && (
                    <div className="mb-4 break-inside-avoid-column">
                    <Card padding="lg">
                      <div className="flex items-center gap-2.5 mb-3">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
                          <ClockIcon className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-default">Incident timeline</h3>
                          <p className="text-xs text-muted">Addon, Vault, and Proxy health events, most recent first</p>
                        </div>
                      </div>
                      <div className="space-y-0 max-h-64 overflow-y-auto">
                        {healthData.timeline.map((entry) => (
                          <div key={entry.id} className="flex items-start gap-3 py-2 border-t border-default first:border-t-0 first:pt-0">
                            <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${entry.status === 'up' ? 'bg-success' : 'bg-error'}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm text-default truncate">{entry.title}</p>
                                <span className="text-xs text-subtle flex-shrink-0" title={new Date(entry.at).toLocaleString()}>{healthTimeAgo(entry.at)}</span>
                              </div>
                              {entry.detail && <p className="text-xs text-muted truncate">{entry.detail}</p>}
                            </div>
                            <Badge variant="default" size="sm" className="flex-shrink-0 capitalize">{entry.source}</Badge>
                          </div>
                        ))}
                      </div>
                    </Card>
                  )}
                </div>

                {healthData.mismatchCount > 0 && (
                  <Card padding="md" className="mt-4 border-warning/30">
                    <div className="flex items-center gap-2">
                      <ExclamationTriangleIcon className="w-4 h-4 text-warning flex-shrink-0" />
                      <p className="text-sm text-default">
                        {healthData.mismatchCount} title{healthData.mismatchCount !== 1 ? 's' : ''} streamed but not recorded by any connected account — see the notification bell for details.
                      </p>
                    </div>
                  </Card>
                )}
              </PageSection>

              {/* Database storage - renders nothing in public/Postgres mode
                  or before there's enough history to chart, see
                  DbStorageCard. Lives here rather than Tasks since it's
                  monitoring-only, same as the rest of this tab. */}
              <PageSection delay={0.4}>
                <DbStorageCard />
              </PageSection>
            </>
          )
        )}
      </div>
      </div>
    </Wrapper>
  );
}
