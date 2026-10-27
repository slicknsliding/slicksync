'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  ClockIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline';
import { useUserAuth, useUserAuthHeaders } from '@/lib/hooks/useUserAuth';
import { ProfileAvatar } from '@/components/user/NuvioProfileSwitcher';
import { ContinueWatchingRow } from '@/components/user/ContinueWatchingRow';
import { userActivity, userSync, UserActivityData, AtRiskStatus, getOwnScreenTime } from '@/lib/user-api';
import { MoonIcon as PausedMoonIcon, PauseCircleIcon as PausedIcon } from '@heroicons/react/24/outline';
import { providerTypeLabel } from '@/lib/providers';
import { NowPlayingBanner } from '@/components/user/home/NowPlayingBanner';
import { UpcomingSection } from '@/components/user/home/UpcomingSection';
import { HomeNumbers } from '@/components/user/home/HomeNumbers';
import { RecentAndMost } from '@/components/user/home/RecentAndMost';
import { useDefaultViewMode } from '@/lib/viewMode';

export default function UserHomePage() {
  const { userId, userInfo, provider } = useUserAuth();
  const providerLabel = providerTypeLabel(provider);
  const { authKey, isReady } = useUserAuthHeaders();
  // Grid or list, as picked under Themes (phones are always grid).
  const { viewMode } = useDefaultViewMode();
  // Paused by a daily limit or bedtime: said at the top, so an empty stream
  // list in their app has its reason here. Looked at again every minute.
  const [paused, setPaused] = useState<{ untilLabel: string; reason: 'limit' | 'bedtime' } | null>(null);
  useEffect(() => {
    if (!isReady || !userId || !authKey) return;
    let stopped = false;
    const look = () => getOwnScreenTime(userId, authKey).then((r) => { if (!stopped) setPaused(r.paused); }).catch(() => {});
    look();
    const timer = setInterval(look, 60 * 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [userId, authKey, isReady]);
  
  const [activityData, setActivityData] = useState<UserActivityData | null>(null);
  const [atRiskStatus, setAtRiskStatus] = useState<AtRiskStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Fetch activity data and at-risk status
  useEffect(() => {
    if (!isReady || !userId) return;

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        // Fetch activity and risk status in parallel, but handle failures gracefully
        const [activityResult, riskResult] = await Promise.allSettled([
          userActivity.getActivity(userId, authKey || undefined),
          userSync.getAtRiskStatus(userId, authKey || undefined),
        ]);
        
        if (activityResult.status === 'fulfilled') {
          setActivityData(activityResult.value);
        } else {
          console.error('Failed to load activity:', activityResult.reason);
          // Set error only if activity fails - this is the main data
          setError(activityResult.reason?.message || 'Failed to load activity data');
        }
        
        if (riskResult.status === 'fulfilled') {
          setAtRiskStatus(riskResult.value);
        } else {
          console.error('Failed to load risk status:', riskResult.reason);
          // Don't set error for risk status - it's optional
        }
      } catch (err: any) {
        console.error('Failed to load data:', err);
        setError(err?.message || 'Failed to load data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [userId, authKey, isReady]);

  // Handle sync
  const handleSync = async () => {
    if (!userId || syncing) return;
    
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await userSync.sync(userId, authKey || undefined);
      setSyncMessage(result.success ? 'Sync completed!' : result.message || 'Sync failed');
      
      // Refresh at-risk status after sync
      const riskStatus = await userSync.getAtRiskStatus(userId, authKey || undefined);
      setAtRiskStatus(riskStatus);
    } catch (err: any) {
      setSyncMessage(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
      // Clear message after 3 seconds
      setTimeout(() => setSyncMessage(null), 3000);
    }
  };

  // Get risk badge color and icon
  const getRiskBadge = () => {
    if (!atRiskStatus) return null;
    
    if (atRiskStatus.riskLevel === 'critical') {
      return {
        color: 'var(--color-error)',
        bg: 'var(--color-error-muted)',
        icon: <ExclamationCircleIcon className="w-4 h-4" />,
        text: 'At Risk',
      };
    }
    if (atRiskStatus.riskLevel === 'warning') {
      return {
        color: 'var(--color-warning)',
        bg: 'var(--color-warning-muted)',
        icon: <ExclamationTriangleIcon className="w-4 h-4" />,
        text: 'Warning',
      };
    }
    return {
      color: 'var(--color-success)',
      bg: 'var(--color-success-muted)',
      icon: <CheckCircleIcon className="w-4 h-4" />,
      text: 'Healthy',
    };
  };

  const riskBadge = getRiskBadge();
  const stats = activityData?.stats;

  return (
    <div className="p-4 sm:p-8">
      {/* Hello, their picture, health, group and Sync Now. */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center gap-4 mb-6">
        {/* Their picture; a Nuvio login with several profiles makes it the button that switches between them. */}
        <ProfileAvatar className="w-12 h-12 sm:w-14 sm:h-14 shrink-0" />
        <div className="flex-1 min-w-0">
          <h1 className="text-[22px] sm:text-[28px] font-bold leading-tight break-words" style={{ color: 'var(--color-text)' }}>
            Hello, {userInfo?.username || 'there'}
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {riskBadge && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium" style={{ background: riskBadge.bg, color: riskBadge.color }} title={atRiskStatus?.riskReason || undefined}>
                {riskBadge.icon}
                {riskBadge.text}
              </span>
            )}
            {userInfo?.groupName && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Group: {userInfo.groupName}</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-full font-medium whitespace-nowrap transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--color-primary)', color: 'white' }}
          >
            <ArrowPathIcon className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
            <span>{syncing ? 'Syncing...' : 'Sync Now'}</span>
          </button>
          {syncMessage && (
            <p className={`text-xs ${syncMessage.includes('completed') ? 'text-success' : 'text-error'}`}>{syncMessage}</p>
          )}
        </div>
      </motion.div>

      {paused && (
        <div
          role="status"
          className="mb-6 rounded-xl px-4 py-3 flex items-center gap-3 border border-warning/40"
          style={{ background: 'var(--color-warning-muted)' }}
        >
          {paused.reason === 'bedtime'
            ? <PausedMoonIcon className="w-5 h-5 shrink-0 text-warning" />
            : <PausedIcon className="w-5 h-5 shrink-0 text-warning" />}
          <p className="text-sm text-warning min-w-0">
            {paused.reason === 'bedtime'
              ? `Bedtime - streaming is back at ${paused.untilLabel}.`
              : `That's today's watching - streaming is back at ${paused.untilLabel}.`}
          </p>
        </div>
      )}

      {/* What is on right now, first: the reason most people open this page. */}
      {activityData?.nowPlaying?.[0] && (
        <NowPlayingBanner row={activityData.nowPlaying[0]} provider={provider} profileLabel={activityData.profileLabel} />
      )}

      {/* Partly-watched shows and films, theirs only; hides itself when there are none. */}
      <ContinueWatchingRow view={viewMode} />

      <UpcomingSection view={viewMode} />

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div
            className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent' }}
          />
        </div>
      )}

      {!loading && error && (
        <div className="p-6 rounded-xl text-center" style={{ background: 'var(--color-error-muted)', border: '1px solid var(--color-error)' }}>
          <ExclamationCircleIcon className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--color-error)' }} />
          <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--color-error)' }}>Failed to load activity data</h3>
          <p className="text-sm mb-4" style={{ color: 'var(--color-text-muted)' }}>{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg font-medium transition-all hover:opacity-90"
            style={{ background: 'var(--color-primary)', color: 'white' }}
          >
            Try Again
          </button>
        </div>
      )}

      {!loading && !error && stats && (
        <>
          <HomeNumbers stats={stats} byDay={activityData?.watchTimeByDay || []} />
          <RecentAndMost
            recent={activityData?.recentlyWatched || []}
            most={activityData?.mostWatchedList || (activityData?.mostWatched ? [activityData.mostWatched] : [])}
            provider={provider}
          />
        </>
      )}

      {!loading && !error && !stats && (
        <div className="text-center py-20">
          <ClockIcon className="w-16 h-16 mx-auto mb-4" style={{ color: 'var(--color-text-subtle)' }} />
          <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--color-text)' }}>No activity data yet</h3>
          <p style={{ color: 'var(--color-text-muted)' }}>Start watching content on {providerLabel} to see your stats here</p>
        </div>
      )}
    </div>
  );
}
