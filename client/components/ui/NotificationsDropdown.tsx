'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { BellIcon, XMarkIcon, CheckCircleIcon, EnvelopeIcon, UsersIcon, PuzzlePieceIcon, ClockIcon, UserPlusIcon, CheckIcon, SparklesIcon, ArrowPathIcon, LockClosedIcon, ExclamationTriangleIcon, ArrowUpCircleIcon, MegaphoneIcon, DevicePhoneMobileIcon, PhotoIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Avatar } from '@/components/ui';
import { startAdaptivePoll } from '@/lib/adaptivePoll';
import { api, type BellState } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { SwipeToDismiss } from '@/components/ui/SwipeToDismiss';
import { useCoarsePointer } from '@/lib/hooks/useCoarsePointer';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { useTVModal } from '@/components/tv/useTVModal';
import { usePageDesign } from '@/lib/arrange';
import { NotificationsPanelV2 } from '@/components/v2/NotificationsV2';
import { fxOn } from '@/lib/effects';
import { TwoStepButton } from '@/components/ui/TwoStepButton';
import { useUnreadTitle } from '@/lib/hooks/useUnreadTitle';
import { useNotifySound } from '@/lib/arrange';
import { armSound, playSound } from '@/lib/notifySound';

interface NotificationItem {
  id: string;
  type: 'activity' | 'invite' | 'task' | 'user' | 'request' | 'episode' | 'addon' | 'sync' | 'vault' | 'mismatch' | 'update' | 'announcement' | 'device' | 'recap';
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
  poster?: string;
  data?: any;
}

interface NotificationsDropdownProps {
  // Optional - self-fetched real activity/invite data (see the effects
  // below) covers everything today. These stay accepted and merged in
  // case a future caller has cheaper data already in hand (e.g. a page
  // that already fetched metrics for its own use), so nothing needs to
  // change here if that gets wired up later.
  activities?: any[];
  inviteHistory?: any[];
  taskHistory?: any[];
  /** While the topbar buttons float over the page: the bell gets its own round
   *  backdrop so it stays readable over posters (see TopbarActions). */
  floating?: boolean;
}

/** Each floating topbar icon's own round backdrop - shared with TopbarActions.
 *  Solid: an opaque surface reads over any poster, and there is nothing
 *  worth blurring behind a 40px circle. */
export const FLOATING_ICON_STYLE: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-surface-border)',
  boxShadow: '0 8px 24px -8px rgba(0,0,0,0.5)',
};

// The bell remounts with the page header on every navigation, and each of
// its sources arrives on its own schedule (stored notifications after a short
// stagger, alerts straight away). Starting each one empty made the count drop
// to whatever landed first and climb back - 18, then 1, then 18 - on every
// page change. Each source now starts from what it last held this session;
// a sign-out reloads the page, so nothing carries over between accounts.
const lastKnown: Record<string, any[]> = {};
type ListUpdate = any[] | ((prev: any[]) => any[]);
function useRememberedList(key: string): [any[], (next: ListUpdate) => void] {
  const [value, setValue] = useState<any[]>(() => lastKnown[key] || []);
  const set = useCallback((next: ListUpdate) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      lastKnown[key] = resolved;
      return resolved;
    });
  }, [key]);
  return [value, set];
}

// When each feed was last fetched. Pages with their own header mount a new
// bell on every visit; one that fetched moments ago shows what it has (above)
// instead of asking again, and its poll carries on from there.
const fetchedAt: Record<string, number> = {};
const fetchedRecently = (key: string, ms = 30000) => Date.now() - (fetchedAt[key] || 0) < ms;

const DISMISSED_STORAGE_KEY = 'notifications-dismissed-ids';
const READ_STORAGE_KEY = 'notifications-read-ids';
// The account's last Clear (server time) this device has already applied.
const SERVER_CLEAR_KEY = 'notifications-server-cleared';

export function NotificationsDropdown({ activities = [], inviteHistory = [], taskHistory = [], floating = false }: NotificationsDropdownProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // TV: the open panel keeps the remote inside it; Back closes it.
  const tvPanelRef = useRef<HTMLDivElement | null>(null);
  const [lastChecked, setLastChecked] = useState<Date>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('notifications-last-checked');
      return stored ? new Date(stored) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default to 7 days ago
    }
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  });
  // Set only by Clear all. Stored bell notifications made before it stay
  // hidden even if a poll that started before the clear lands after it.
  const [clearedBefore, setClearedBefore] = useState<Date | null>(() => {
    if (typeof window === 'undefined') return null;
    const at = new Date(localStorage.getItem('notifications-cleared-before') || '');
    return Number.isNaN(at.getTime()) ? null : at;
  });

  // Phones swipe a row left to dismiss it instead of the X. Not TVs: a remote
  // can't swipe, so they keep the button.
  const coarse = useCoarsePointer();
  const isTV = useIsTV();
  useTVModal(isTV && isOpen, tvPanelRef, () => setIsOpen(false));
  const swipeToDismiss = coarse && !isTV;
  // v2 (Themes → Page design): Today and Earlier, an icon per kind, links in
  // the foot; a bottom sheet on a phone. TV keeps Classic.
  const { design } = usePageDesign();
  const v2 = design === 'v2' && !isTV;

  // IDs individually dismissed via the per-row X button (or a swipe) - kept separate
  // from lastChecked (which hides everything at once) so dismissing one
  // notification doesn't also hide unrelated newer ones.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const stored = localStorage.getItem(DISMISSED_STORAGE_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const persistDismissedIds = (next: Set<string>) => {
    setDismissedIds(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(Array.from(next)));
    }
  };

  const handleDismiss = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    dismissOne(id);
  };

  // From the row (state updater, not the rendered set): a swipe finishes its
  // slide-out animation a moment after it starts, and another row may have
  // been dismissed in between.
  const dismissOne = (id: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev).add(id);
      if (typeof window !== 'undefined') {
        localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      }
      return next;
    });
    // Persisted bell notifications (id prefixed "stored-") are dismissed
    // server-side, so they don't just reappear on the next poll; the ones the
    // bell builds itself go to the account's list, so every device drops them.
    if (id.startsWith('stored-')) {
      const realId = id.slice('stored-'.length);
      api.dismissNotifications([realId]).catch(() => {});
    } else {
      saveBellState({ dismiss: [id] });
    }
  };

  // Which notifications have been marked read - separate from dismissedIds
  // (which removes a row entirely) and from lastChecked (which controls
  // what's in the window at all, not whether something already in it has
  // been seen). "Mark all read" should un-highlight everything currently
  // visible without making it disappear - that needs its own persisted set.
  const [readIds, setReadIds] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const stored = localStorage.getItem(READ_STORAGE_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const persistReadIds = (next: Set<string>) => {
    setReadIds(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(Array.from(next)));
    }
  };

  // The same bell on every device: Clear, dismissals and reads are saved to
  // the account (server/utils/bellState.js) and read back with the bell. A
  // Clear made anywhere since the last one this device saw replaces what is
  // here; otherwise the two are joined. localStorage stays as the cache that
  // shows the right thing before the first answer comes back.
  const applyBellState = useCallback((s: BellState | null | undefined) => {
    if (!s || typeof window === 'undefined') return;
    const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } };
    const at = s.clearedBefore ? new Date(s.clearedBefore) : null;
    let seen = NaN;
    try { seen = new Date(localStorage.getItem(SERVER_CLEAR_KEY) || '').getTime(); } catch { /* storage blocked */ }
    if (at && !Number.isNaN(at.getTime()) && (Number.isNaN(seen) || at.getTime() > seen)) {
      const iso = at.toISOString();
      save(SERVER_CLEAR_KEY, iso);
      save('notifications-last-checked', iso);
      save('notifications-cleared-before', iso);
      save(DISMISSED_STORAGE_KEY, JSON.stringify(s.dismissed));
      save(READ_STORAGE_KEY, JSON.stringify(s.read));
      setLastChecked(at);
      setClearedBefore(at);
      setDismissedIds(new Set(s.dismissed));
      setReadIds(new Set(s.read));
      return;
    }
    const join = (key: string) => (prev: Set<string>) => {
      const add = (key === DISMISSED_STORAGE_KEY ? s.dismissed : s.read).filter((id) => !prev.has(id));
      if (add.length === 0) return prev;
      const next = new Set([...prev, ...add]);
      save(key, JSON.stringify(Array.from(next)));
      return next;
    };
    setDismissedIds(join(DISMISSED_STORAGE_KEY));
    setReadIds(join(READ_STORAGE_KEY));
  }, []);
  const saveBellState = (change: { dismiss?: string[]; read?: string[] }) => {
    api.updateBellState(change).catch(() => {});
  };

  // Where tapping a notification should land. Stored bell notifications
  // (activity/sync/invite/vault/task/proxy/update) already carry a real
  // url from the server (notificationStore.js's createNotification) -
  // episode/addon items are built client-side from their own dedicated
  // tables and never had one, so they get a sensible fixed fallback
  // instead. 'request'/'user' rows have their own Accept/Reject buttons
  // and navigating away on a stray tap would be actively unhelpful.
  const getNotificationUrl = (n: NotificationItem): string | null => {
    // Rewrites a stale url baked into an already-persisted notification row
    // from before a route moved - the server-side generator was fixed, but
    // that only affects notifications created from here on; anything
    // already in the table (and anyone's local read/dismissed state keyed
    // off it) still has the old value.
    if (n.data?.url === '/health') return '/metrics?tab=health';
    if (n.data?.url) return n.data.url;
    switch (n.type) {
      case 'addon': return '/addons';
      case 'episode': return '/';
      case 'mismatch': return '/activity';
      default: return null;
    }
  };

  const handleNotificationClick = (notification: NotificationItem) => {
    const url = getNotificationUrl(notification);
    if (!url) return;
    persistReadIds(new Set(readIds).add(notification.id));
    saveBellState({ read: [notification.id] });
    setIsOpen(false);
    router.push(url);
  };

  const [pendingRequests, setPendingRequests] = useRememberedList('pendingRequests');
  // Accepted invite requests, from the same fetch as pendingRequests below -
  // this IS "real" inviteHistory, no separate endpoint needed. Merged with
  // any inviteHistory passed in via props.
  const [acceptedRequests, setAcceptedRequests] = useRememberedList('acceptedRequests');

  // Persistent bell notifications (notifications table) - the durable event
  // store written from the SAME dispatch path as push/Discord
  // (notificationStore.js). This replaces the old approach of re-deriving
  // watch activity live from the metrics snapshot, which could never
  // represent a discrete "started/finished watching" event and left the bell
  // empty for proxy-only or mismatched-account watches even though push and
  // Discord both fired. Watch, sync, vault, invite and mismatch events all
  // flow through here; episode/addon alerts keep their own sources below.
  const [storedNotifications, setStoredNotifications] = useRememberedList('storedNotifications');
  useEffect(() => {
    const fetchStored = async () => {
      // Skip while the tab isn't the one on screen - a backgrounded Safari
      // tab has no reason to keep firing this every 30s, and the interval
      // itself catches back up on its own next tick once it's visible again.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      api.getBellState().then(applyBellState).catch(() => {});
      try {
        fetchedAt.stored = Date.now();
        setStoredNotifications(await api.getNotifications());
      } catch {
        // Endpoint may not exist yet on an older backend - stay silent.
      }
    };
    // Straight away, not after the delay below: a Clear made on another
    // device should be in place before the badge shows a count.
    if (!fetchedRecently('stored')) api.getBellState().then(applyBellState).catch(() => {});
    const initialDelay = fetchedRecently('stored') ? undefined : setTimeout(fetchStored, 200 + Math.random() * 600);
    const stopPoll = startAdaptivePoll(fetchStored, 30000, 180000);
    // SSE accelerant: a server-side notification refetches the bell right
    // now instead of on the next tick. Polling above stays as the fallback.
    const onLive = () => { fetchStored(); };
    window.addEventListener('slicksync:live-notification', onLive);
    return () => { clearTimeout(initialDelay); stopPoll(); window.removeEventListener('slicksync:live-notification', onLive); };
  }, [applyBellState]);

  // Fetch pending + accepted invite requests
  useEffect(() => {
    const fetchRequests = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        // One small read of just the requests the bell shows.
        fetchedAt.requests = Date.now();
        const { pending, accepted } = await api.getInvitationBell();
        setPendingRequests(pending);
        setAcceptedRequests(accepted);
      } catch (e) {
        console.error('Failed to fetch pending requests', e);
      }
    };

    // Small random delay on the very first fetch only (not the recurring
    // poll, to keep the 30s cadence predictable) - this component mounts
    // once per session now (persists across navigation, see NebulaTopbar),
    // so its own initial fetch only ever collides with a page's own mount
    // fetch on first load. Spreads that one moment out a little rather than
    // firing in the exact same tick as everything else - the per-endpoint
    // dedupe/cache in api.ts covers repeat calls to these same two
    // endpoints, but a fresh page load fires plenty of genuinely different
    // endpoints too, which that cache can't help with.
    const initialDelay = fetchedRecently('requests') ? undefined : setTimeout(fetchRequests, 200 + Math.random() * 600);
    const stopPoll = startAdaptivePoll(fetchRequests, 30000, 180000);
    return () => { clearTimeout(initialDelay); stopPoll(); };
  }, []);

  // (Watch activity is no longer re-derived from the metrics snapshot here -
  // it now comes through storedNotifications above, as discrete persisted
  // events written at the moment they happen, so a "started/finished
  // watching" event shows in the bell the same way it reaches push/Discord.)

  // New-episode alerts (fired server-side by the episodeAlerts poller when a
  // show someone here watches gets a newly-released episode). Server polls
  // Cinemeta every 6h, so a 5min client refresh is plenty.
  const [episodeAlerts, setEpisodeAlerts] = useRememberedList('episodeAlerts');
  useEffect(() => {
    const fetchAlerts = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        fetchedAt.episodes = Date.now();
        setEpisodeAlerts(await api.getEpisodeAlerts());
      } catch {
        // Endpoint may not exist yet on an older backend - stay silent.
      }
    };
    if (!fetchedRecently('episodes', 5 * 60 * 1000)) fetchAlerts();
    const interval = setInterval(fetchAlerts, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Addon online<->offline alerts (fired server-side by addonHealthCheck.js
  // when a primary addon goes down - and getGroupAddons silently diverts
  // groups to its backup - or comes back). Same cadence as episode alerts.
  const [addonHealthAlerts, setAddonHealthAlerts] = useRememberedList('addonHealthAlerts');
  useEffect(() => {
    const fetchAddonAlerts = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        fetchedAt.addons = Date.now();
        setAddonHealthAlerts(await api.getAddonHealthAlerts());
      } catch {
        // Endpoint may not exist yet on an older backend - stay silent.
      }
    };
    if (!fetchedRecently('addons', 5 * 60 * 1000)) fetchAddonAlerts();
    const interval = setInterval(fetchAddonAlerts, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleAcceptRequest = async (e: React.MouseEvent, reqId: string) => {
    e.stopPropagation();
    try {
      await api.acceptInviteRequest(reqId);
      toast.success('Request accepted');
      setPendingRequests(prev => prev.filter(r => r.id !== reqId));
    } catch (err: any) {
      toast.error(err.message || 'Failed to accept request');
    }
  };

  const handleRejectRequest = async (e: React.MouseEvent, reqId: string) => {
    e.stopPropagation();
    try {
      await api.rejectInviteRequest(reqId);
      toast.success('Request rejected');
      setPendingRequests(prev => prev.filter(r => r.id !== reqId));
    } catch (err: any) {
      toast.error(err.message || 'Failed to reject request');
    }
  };

  // Only the optional `activities` prop now (empty by default) - real watch
  // activity comes through storedNotifications instead. Kept so a future
  // caller passing pre-fetched activity data still works unchanged.
  const combinedActivities = useMemo(() => {
    return [...activities];
  }, [activities]);

  const combinedInviteHistory = useMemo(() => {
    const fromAccepted = acceptedRequests.map((req) => ({
      id: req.id,
      action: 'used',
      userName: req.username || req.email,
      groupName: req.groupName || 'a group',
      timestamp: req.respondedAt || req.createdAt,
    }));
    return [...inviteHistory, ...fromAccepted];
  }, [inviteHistory, acceptedRequests]);

  // Generate notifications from activities, invites, and tasks since last checked
  const notifications = useMemo(() => {
    const items: NotificationItem[] = [];

    // Add pending requests (ALWAYS show these, regardless of last checked)
    pendingRequests.forEach((req) => {
      items.push({
        id: `req-${req.id}`,
        type: 'request',
        title: 'Access Request',
        message: `${req.username} requested access via ${req.invitationName}`,
        timestamp: new Date(req.createdAt),
        read: false,
        data: req
      });
    });

    // Persistent bell notifications (watch/sync/vault/invite/mismatch). These
    // carry server-side read state; readIds is layered on top only as an
    // optimistic client override so "Mark all read" reflects instantly before
    // the next poll. The lastChecked window doesn't apply - these are already
    // time-bounded by the server query and cleared via server-side delete;
    // only what came before the last Clear all is held back.
    storedNotifications
      .filter((n) => !clearedBefore || new Date(n.createdAt) > clearedBefore)
      .forEach((n) => {
        const id = `stored-${n.id}`;
        items.push({
          id,
          type: n.type,
          title: n.title,
          message: n.body,
          timestamp: new Date(n.createdAt),
          read: n.read || readIds.has(id),
          poster: n.poster || undefined,
          data: { url: n.url },
        });
      });

    // Add recent activities
    combinedActivities
      .filter((activity) => new Date(activity.timestamp) > lastChecked)
      .slice(0, 5)
      .forEach((activity) => {
        const id = `activity-${activity.id}`;
        items.push({
          id,
          type: 'activity',
          title: `${activity.userName} ${activity.type === 'watch' ? 'is watching' : activity.type === 'complete' ? 'completed' : 'synced'}`,
          message: activity.contentName,
          timestamp: new Date(activity.timestamp),
          read: readIds.has(id),
          poster: activity.poster,
        });
      });

    // Add recent invite uses
    combinedInviteHistory
      .filter((invite) => invite.action === 'used' && new Date(invite.timestamp) > lastChecked)
      .slice(0, 3)
      .forEach((invite) => {
        const id = `invite-${invite.id}`;
        items.push({
          id,
          type: 'invite',
          title: 'Invite used',
          message: `${invite.userName || 'Someone'} joined ${invite.groupName}`,
          timestamp: new Date(invite.timestamp),
          read: readIds.has(id),
        });
      });

    // Add recent task completions
    taskHistory
      .filter((task) => new Date(task.timestamp) > lastChecked && task.status === 'success')
      .slice(0, 3)
      .forEach((task) => {
        const id = `task-${task.id}`;
        items.push({
          id,
          type: 'task',
          title: 'Task completed',
          message: `${task.type.replace('_', ' ')} completed successfully`,
          timestamp: new Date(task.timestamp),
          read: readIds.has(id),
        });
      });

    // New-episode alerts - a show someone here watches got a new episode
    episodeAlerts
      .filter((alert) => new Date(alert.createdAt) > lastChecked)
      .slice(0, 5)
      .forEach((alert) => {
        const epLabel = `S${String(alert.season).padStart(2, '0')}E${String(alert.episode).padStart(2, '0')}`;
        const id = `episode-${alert.id}`;
        items.push({
          id,
          type: 'episode',
          title: `New episode: ${alert.showName}`,
          message: `${epLabel}${alert.title ? ` · ${alert.title}` : ''} is out`,
          timestamp: new Date(alert.createdAt),
          read: readIds.has(id),
          poster: alert.poster || undefined,
        });
      });

    // Addon health alerts - a primary addon went offline (backup took over)
    // or came back.
    addonHealthAlerts
      .filter((alert) => new Date(alert.createdAt) > lastChecked)
      .slice(0, 5)
      .forEach((alert) => {
        const groupsLabel = `${alert.groupCount} group${alert.groupCount === 1 ? '' : 's'}`;
        const message = alert.event === 'online'
          ? (alert.backupAddonName && alert.groupCount > 0 ? `Switched ${groupsLabel} back to ${alert.addonName}` : `${alert.addonName} is reachable again`)
          : (alert.backupAddonName && alert.groupCount > 0 ? `Switched ${groupsLabel} to backup ${alert.backupAddonName}` : `${alert.groupCount > 0 ? `${groupsLabel} affected` : 'Not assigned to any group'}, no backup configured`);
        const id = `addon-health-${alert.id}`;
        items.push({
          id,
          type: 'addon',
          title: alert.event === 'online' ? `✅ ${alert.addonName} is back online` : `⚠️ ${alert.addonName} went offline`,
          message,
          timestamp: new Date(alert.createdAt),
          read: readIds.has(id),
          // Deep-link to the addon the alert is actually about. Without this
          // it fell through to the generic `case 'addon'` below and dropped
          // you on the full Addons list, which doesn't say which addon went
          // down or why - you had to find it yourself.
          ...(alert.addonId ? { data: { url: `/addons/${alert.addonId}` } } : {}),
        });
      });

    // Sort by timestamp, most recent first, then drop anything individually
    // dismissed via the per-row X button or a swipe.
    return items
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .filter((item) => !dismissedIds.has(item.id));
  }, [combinedActivities, combinedInviteHistory, taskHistory, episodeAlerts, addonHealthAlerts, storedNotifications, clearedBefore, lastChecked, pendingRequests, dismissedIds, readIds]);

  const unreadCount = notifications.filter(n => !n.read).length;

  // The same count in the browser tab: "(3) SlickSync". This is the one place
  // that does it; the v2 panel only draws the list.
  useUnreadTitle(unreadCount);

  // Mirror the unread count onto the installed app's icon (OS Badging API,
  // Chromium + iOS 16.4+ installed PWAs). Browsers without it just skip -
  // the accessor itself can throw on some, hence the try/catch rather than
  // a plain feature check. The service worker sets a bare dot when a push
  // arrives while the app is closed; this corrects it to the real number
  // the moment the app opens.
  useEffect(() => {
    try {
      const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      if (unreadCount > 0) nav.setAppBadge?.(unreadCount)?.catch(() => {});
      else nav.clearAppBadge?.()?.catch(() => {});
    } catch { /* badging unsupported */ }
  }, [unreadCount]);

  // Un-highlights every currently-visible notification without removing it -
  // rows stay in the list (still scrollable/readable), just lose the unread
  // styling and no longer count toward the bell's dot. Distinct from Clear,
  // which actually empties the list.
  const handleMarkAllRead = () => {
    const next = new Set(readIds);
    notifications.forEach((n) => next.add(n.id));
    persistReadIds(next);
    // Persist read state server-side for the stored subset so it stays read
    // across devices / reloads, not just in this browser's localStorage; the
    // rest go to the account's read list.
    api.markNotificationsRead().catch(() => {});
    const built = notifications.map((n) => n.id).filter((id) => !id.startsWith('stored-'));
    if (built.length > 0) saveBellState({ read: built });
  };

  // Classic's Clear (Effects → Clearing lists): the rows sweep away, then
  // "All clear" stands in the open bell. v2's panel does its own.
  const [sweeping, setSweeping] = useState(false);
  const [justCleared, setJustCleared] = useState(false);
  const sweepTimer = useRef<number | null>(null);
  useEffect(() => () => { if (sweepTimer.current) window.clearTimeout(sweepTimer.current); }, []);
  const clearWithSweep = () => {
    if (isTV || !fxOn('clear')) { handleClearAll(); return; }
    if (sweeping) return;
    setSweeping(true);
    sweepTimer.current = window.setTimeout(() => {
      setSweeping(false);
      setJustCleared(true);
      handleClearAll(true);
    }, Math.min(notifications.length, 8) * 45 + 200);
  };

  // "Cleared - Undo": the server puts back the stored rows and the bell's
  // state; this puts back what this device kept (the window, dismissed and
  // read lists) and reads the stored rows again.
  const offerUndoClear = (trashId: string, before: { lastChecked: Date; clearedBefore: Date | null; dismissed: Set<string>; read: Set<string>; seen: string | null }) => {
    toast.success('Notifications cleared', {
      line: 'Back for 30 days from Tasks → Trash',
      actions: [{
        label: 'Undo',
        onClick: async () => {
          try {
            await api.restoreFromTrash(trashId);
            const save = (key: string, value: string | null) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage blocked */ } };
            save('notifications-last-checked', before.lastChecked.toISOString());
            save('notifications-cleared-before', before.clearedBefore ? before.clearedBefore.toISOString() : null);
            save(SERVER_CLEAR_KEY, before.seen);
            setLastChecked(before.lastChecked);
            setClearedBefore(before.clearedBefore);
            persistDismissedIds(before.dismissed);
            persistReadIds(before.read);
            setJustCleared(false);
            try { setStoredNotifications(await api.getNotifications()); } catch { /* the next poll brings them back */ }
            toast.success('Notifications are back');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not bring the notifications back');
          }
        },
      }],
      duration: 8000,
    });
  };

  const handleClearAll = (stay?: boolean) => {
    // What Undo puts back on this device (the server holds the rows).
    const before = {
      lastChecked,
      clearedBefore,
      dismissed: new Set(dismissedIds),
      read: new Set(readIds),
      seen: (() => { try { return localStorage.getItem(SERVER_CLEAR_KEY); } catch { return null; } })(),
    };
    const now = new Date();
    setLastChecked(now);
    setClearedBefore(now);
    if (typeof window !== 'undefined') {
      localStorage.setItem('notifications-last-checked', now.toISOString());
      localStorage.setItem('notifications-cleared-before', now.toISOString());
    }
    // Nothing before `now` will ever be shown again anyway (see the
    // lastChecked filter above), so the individually-dismissed and
    // marked-read sets can both be reset too instead of accumulating
    // indefinitely.
    persistDismissedIds(new Set());
    persistReadIds(new Set());
    // The lastChecked window hides the derived sources (episode/addon/etc.);
    // stored bell notifications aren't windowed, so Clear empties them
    // server-side (and locally) too. The account keeps the time of the
    // Clear, so every other device clears with it; the answer carries the
    // server's own time, which replaces this device's clock.
    setStoredNotifications([]);
    api.clearBell()
      .then((res) => {
        applyBellState(res.state);
        if (res.trashId) offerUndoClear(res.trashId, before);
      })
      .catch(() => {
        // Could not be held for Undo: Clear still goes through, without one.
        api.updateBellState({ clearAll: true }).then(applyBellState).catch(() => {});
      });
    // The v2 bell shows "All clear" and stays open; anything else closes.
    if (stay !== true) setIsOpen(false);
  };

  const getNotificationIcon = (type: NotificationItem['type']) => {
    switch (type) {
      case 'activity':
        return <ClockIcon className="w-4 h-4" />;
      case 'invite':
        return <EnvelopeIcon className="w-4 h-4" />;
      case 'task':
        return <CheckCircleIcon className="w-4 h-4" />;
      case 'user':
        return <UsersIcon className="w-4 h-4" />;
      case 'request':
        return <UserPlusIcon className="w-4 h-4" />;
      case 'episode':
        return <SparklesIcon className="w-4 h-4" />;
      case 'addon':
        return <PuzzlePieceIcon className="w-4 h-4" />;
      case 'sync':
        return <ArrowPathIcon className="w-4 h-4" />;
      case 'vault':
        return <LockClosedIcon className="w-4 h-4" />;
      case 'mismatch':
        return <ExclamationTriangleIcon className="w-4 h-4" />;
      case 'update':
        return <ArrowUpCircleIcon className="w-4 h-4" />;
      case 'announcement':
        return <MegaphoneIcon className="w-4 h-4" />;
      case 'device':
        return <DevicePhoneMobileIcon className="w-4 h-4" />;
      case 'recap':
        return <PhotoIcon className="w-4 h-4" />;
    }
  };

  const formatNotificationTime = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    return `${diffDays}d ago`;
  };

  // Close on click outside + Escape
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const withinDropdown = containerRef.current?.contains(target);
      const withinButton = buttonRef.current?.contains(target);
      if (!withinDropdown && !withinButton) {
        setIsOpen(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('touchstart', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('touchstart', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen]);

  // Effects → Bell nudge: the bell rocks once and the count pops in when a
  // notification arrives while this page is open. The count the page opened
  // with, and counts going down, do nothing. `nudge` alternates between two
  // names for the same motion, so each arrival plays it again.
  const [countSeen, setCountSeen] = useState<number | null>(null);
  // Not in the first seconds: the bell's sources arrive one by one as the page
  // opens, and each one raises the count.
  const [settled, setSettled] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSettled(true), 5000); return () => clearTimeout(t); }, []);
  const [nudge, setNudge] = useState<'' | 'a' | 'b'>('');
  // The same moment plays the notification sound (Settings → Notifications).
  const { sound } = useNotifySound();
  const heard = useRef<number | null>(null);
  const soundOn = sound.on;
  useEffect(() => (soundOn ? armSound() : undefined), [soundOn]);
  useEffect(() => {
    const was = heard.current;
    heard.current = unreadCount;
    if (settled && was !== null && unreadCount > was && sound.on) playSound(sound.kind, sound.volume);
  }, [unreadCount, settled, sound]);
  if (countSeen !== unreadCount) {
    setCountSeen(unreadCount);
    if (settled && countSeen !== null && unreadCount > countSeen && !isOpen && fxOn('bell')) setNudge(nudge === 'a' ? 'b' : 'a');
  }
  const bell = (
      <motion.button
        ref={buttonRef}
        tabIndex={isTV ? -1 : undefined}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className={`relative p-2 transition-colors ${floating ? 'rounded-full' : 'rounded-lg hov-surface'}${nudge ? ` fx-bell-${nudge}` : ''}`}
        style={{ color: 'var(--color-text-muted)', ...(floating ? FLOATING_ICON_STYLE : {}) }}
        aria-label="Notifications"
      >
        <BellIcon className="w-5 h-5" />
        {unreadCount > 0 && (
          // Count badge, not just a presence dot - "something's waiting" and
          // "eleven things are waiting" are different amounts of urgency.
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[9px] font-bold leading-none"
            style={{ background: 'var(--color-primary-solid)', color: '#fff' }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </motion.button>
  );

  return (
    <div className="relative" ref={containerRef}>
      {isTV ? <TVFocusable className="inline-flex rounded-lg" onEnterPress={() => setIsOpen((o) => !o)}>{bell}</TVFocusable> : bell}

      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <div
              className={v2 ? 'fixed inset-0 z-[55] max-sm:bg-black/50' : 'fixed inset-0 z-40'}
              onClick={() => setIsOpen(false)}
            />
            
            {/* Dropdown */}
            <motion.div
              ref={tvPanelRef}
              initial={{ opacity: 0, scale: 0.95, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -10 }}
              transition={{ duration: 0.15 }}
              className={v2 ? 'fixed inset-x-0 bottom-0 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 z-[60] sm:w-[440px]' : 'absolute right-0 top-full mt-2 z-50 w-80'}
              style={v2 ? { maxWidth: '100vw' } : { maxWidth: 'calc(100vw - 2rem)' }}
            >
              {/* Small caret pointing up at the bell that opened this, so
                  the panel reads unambiguously as "a popup from that
                  button" rather than something else on the page having
                  changed. It can't avoid overlapping nearby page content on
                  some pages (e.g. Activity's centered Watch/Tasks/Invites/
                  Proxy tab row sits right where this needs to drop, and a
                  320px-wide panel has nowhere to go that dodges it) - same
                  transient-overlay behavior most notification bells have
                  (closes on outside click, nothing underneath is altered),
                  but making the connection to its trigger obvious matters
                  more here than it would if there were room to avoid the
                  overlap entirely. Rendered before the panel div (not
                  after) so the panel's own background naturally covers its
                  bottom half, same trick as any CSS speech-bubble tail. */}
              {!v2 && <div
                className="popup-caret absolute -top-1 right-4 w-3 h-3 rotate-45 border-l border-t"
                style={{ background: 'var(--color-surface)' }}
              />}
              {/* Plain div, not <Card> - Card's Nebula mode auto-applies a
                  55%-opacity translucent background meant for content
                  sitting on the page's own background. That reads fine
                  embedded in page content, but this panel is a floating
                  overlay that can sit on top of anything (poster grids,
                  colorful content) - 55% opacity there was hard to read,
                  worst on mobile where it's now fixed over live page
                  content. Solid, high-opacity background regardless of
                  layout mode - a floating overlay always needs strong
                  contrast, that's not a Nebula-vs-Current distinction. */}
              {v2 ? (
                <NotificationsPanelV2
                  items={notifications}
                  icon={(t) => getNotificationIcon(t as NotificationItem['type'])}
                  when={formatNotificationTime}
                  canOpen={(n) => !!getNotificationUrl(n as NotificationItem)}
                  swipe={swipeToDismiss}
                  tv={isTV}
                  onOpen={(n) => handleNotificationClick(n as NotificationItem)}
                  onDismiss={dismissOne}
                  onAccept={handleAcceptRequest}
                  onReject={handleRejectRequest}
                  onMarkAll={handleMarkAllRead}
                  onClear={handleClearAll}
                  onSettings={() => {
                    setIsOpen(false);
                    router.push('/settings?highlight=Activity%20notifications');
                    window.dispatchEvent(new CustomEvent('slicksync:settings-highlight', { detail: 'Activity notifications' }));
                  }}
                  onActivity={() => { setIsOpen(false); router.push('/activity'); }}
                />
              ) : (
              <div
                className="popup-panel max-h-[500px] flex flex-col rounded-2xl overflow-hidden"
              >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-default">
                  <h3 className="text-sm font-semibold text-default">Notifications</h3>
                  {notifications.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleMarkAllRead}
                        className="text-xs"
                      >
                        Mark all read
                      </Button>
                      <TwoStepButton
                        onConfirm={clearWithSweep}
                        label="Clear"
                        armedLabel="Clear?"
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted hover:text-default hover:bg-surface-hover transition-colors"
                      />
                    </div>
                  )}
                </div>

                {/* Notifications list */}
                <div className="overflow-y-auto max-h-[400px]">
                  {notifications.length === 0 && justCleared ? (
                    <div className="fx-allclear p-8 text-center" role="status">
                      <div className="fx-tick mx-auto mb-2.5 grid place-items-center rounded-full" style={{ width: 46, height: 46, background: 'color-mix(in srgb, var(--color-success, #22c55e) 18%, transparent)' }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-success, #22c55e)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                      </div>
                      <p className="text-sm font-semibold text-default">All clear</p>
                    </div>
                  ) : notifications.length === 0 ? (
                    <EmptyState tight art="bell" title="No new notifications" line="New episodes, sync results and alerts land here." />
                  ) : (
                    // Rows set in from the panel's edge and rounded, like
                    // the options in other menus; the one you are on lights
                    // with the menu highlight (data-mh-item).
                    <div className="flex flex-col gap-1.5 p-1.5">
                      {notifications.map((notification, rowIndex) => (
                        <div key={notification.id} className={sweeping ? 'fx-sweep' : undefined} style={sweeping ? { animationDelay: `${Math.min(rowIndex, 8) * 45}ms` } : undefined}>
                        <SwipeToDismiss
                          enabled={swipeToDismiss && notification.type !== 'request'}
                          onDismiss={() => dismissOne(notification.id)}
                          className="rounded-[14px]"
                        >
                        <motion.div
                          data-mh-item=""
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          onClick={() => handleNotificationClick(notification)}
                          // A TV remote stops on each row; OK opens it. The
                          // press stops here: the panel closes before it is
                          // over, and the page's remote would take it next.
                          tabIndex={isTV ? 0 : undefined}
                          onKeyDown={isTV ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); e.stopPropagation(); handleNotificationClick(notification); } } : undefined}
                          className={`p-4 rounded-[14px] hover:bg-surface-hover transition-colors duration-500 ${getNotificationUrl(notification) ? 'cursor-pointer' : ''} ${notification.read ? 'notif-read' : 'notif-lit'}`}
                          // Lit/read look is a class pair (see globals.css) so it
                          // fades via transition-colors and survives recolouring extensions.
                        >
                          <div className="flex flex-col gap-3">
                            <div className="flex items-start gap-3">
                              <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 mt-2 transition-colors duration-500 ${notification.read ? 'notif-dot-read' : 'notif-dot-lit'}`}
                                aria-hidden="true"
                              />
                              {notification.poster ? (
                                <div className="w-10 h-14 rounded-lg overflow-hidden shrink-0 bg-surface border border-default">
                                  <img
                                    src={notification.poster}
                                    alt={notification.message}
                                    className="w-full h-full object-cover"
                                    onError={(e) => {
                                      // If image fails, just hide it (we'll fall back to icon)
                                      (e.currentTarget.parentElement as HTMLElement | null)?.remove();
                                    }}
                                  />
                                </div>
                              ) : notification.type === 'request' && notification.data ? (
                                <Avatar
                                  name={notification.data.username || notification.data.email || 'User'}
                                  email={notification.data.email}
                                  size="sm"
                                />
                              ) : (
                                <div className={`p-1.5 rounded-lg flex-shrink-0 ${
                                  notification.type === 'request' ? 'bg-primary/10 text-primary' : 'bg-primary-muted text-primary'
                                }`}>
                                  {getNotificationIcon(notification.type)}
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                {/* line-clamp, not truncate. This panel is
                                    w-80, and after the unread dot, the icon
                                    and the dismiss button, a single-line
                                    ellipsis cut most titles mid-word - an
                                    addon alert read "AIOMetadata (slicknsli..."
                                    with the actual event (went offline / back
                                    online) never visible. Wrapping to two
                                    lines fits the whole thing while still
                                    bounding how tall one row can get.
                                    Three, not two: at 2 an unusually long
                                    addon name pushed the event itself
                                    ('went offline') onto a third line and
                                    clipped it - measured cutting the last
                                    two characters off a 44-character name,
                                    which loses the one word that matters.
                                    Short titles are unaffected; the clamp
                                    only caps, it doesn't reserve height. */}
                                <p className="text-sm font-medium text-default line-clamp-3 break-words">{notification.title}</p>
                                <p className="text-xs text-muted mt-0.5 line-clamp-2 break-words">{notification.message}</p>
                                <p className="text-xs text-subtle mt-1">{formatNotificationTime(notification.timestamp)}</p>
                              </div>
                              {/* Pending requests already clear themselves
                                  from the list via Accept/Reject below - an
                                  extra dismiss button there would let one
                                  get hidden without ever being acted on.
                                  On a phone the row is swiped away instead. */}
                              {notification.type !== 'request' && !swipeToDismiss && (
                                <button
                                  type="button"
                                  onClick={(e) => handleDismiss(e, notification.id)}
                                  className="p-1 rounded-md shrink-0 text-subtle hover:text-default hover:bg-surface transition-colors"
                                  aria-label="Dismiss notification"
                                  title="Dismiss"
                                >
                                  <XMarkIcon className="w-4 h-4" />
                                </button>
                              )}
                            </div>

                            {/* Actions for requests */}
                            {notification.type === 'request' && notification.data && (
                              <div className="flex items-center gap-2 pl-10">
                                <Button
                                  size="sm"
                                  variant="primary"
                                  onClick={(e) => handleAcceptRequest(e, notification.data.id)}
                                  className="h-7 text-xs px-3"
                                >
                                  Accept
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={(e) => handleRejectRequest(e, notification.data.id)}
                                  className="h-7 text-xs px-3"
                                >
                                  Reject
                                </Button>
                              </div>
                            )}
                          </div>
                        </motion.div>
                        </SwipeToDismiss>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}