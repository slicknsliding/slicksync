'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BellIcon, XMarkIcon, CheckCircleIcon, EnvelopeIcon, UsersIcon, PuzzlePieceIcon, ClockIcon, UserPlusIcon, CheckIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Avatar } from '@/components/ui';
import { api } from '@/lib/api';
import { toast } from '@/components/ui/Toast';

interface NotificationItem {
  id: string;
  type: 'activity' | 'invite' | 'task' | 'user' | 'request' | 'episode' | 'addon';
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
}

const DISMISSED_STORAGE_KEY = 'notifications-dismissed-ids';
const READ_STORAGE_KEY = 'notifications-read-ids';

export function NotificationsDropdown({ activities = [], inviteHistory = [], taskHistory = [] }: NotificationsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [lastChecked, setLastChecked] = useState<Date>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('notifications-last-checked');
      return stored ? new Date(stored) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default to 7 days ago
    }
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  });

  // IDs individually dismissed via the per-row X button - kept separate
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
    persistDismissedIds(new Set(dismissedIds).add(id));
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

  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  // Accepted invite requests, from the same fetch as pendingRequests below -
  // this IS "real" inviteHistory, no separate endpoint needed. Merged with
  // any inviteHistory passed in via props.
  const [acceptedRequests, setAcceptedRequests] = useState<any[]>([]);
  // Recent watch activity, from the same cached metrics endpoint the
  // Activity/Dashboard pages use (server-side cache refreshed every 5
  // minutes by activityMonitor.js, so polling this here is cheap). Merged
  // with any activities passed in via props.
  const [recentWatchActivity, setRecentWatchActivity] = useState<any[]>([]);
  // Live "now playing" sessions, from the same metrics response. Discord
  // gets an instant "started watching" ping from the proxy pipeline (see
  // CLAUDE.md), but nothing ever fed that event into this bell - it only
  // ever showed completed watches. Each entry keeps a stable id/timestamp
  // (session start) across polls, so it surfaces once and sticks until
  // marked read/dismissed rather than re-notifying every 30s.
  const [recentNowPlaying, setRecentNowPlaying] = useState<any[]>([]);

  // Fetch pending + accepted invite requests
  useEffect(() => {
    const fetchRequests = async () => {
      try {
        const invitations = await api.getInvitations();
        const allRequests: any[] = [];

        for (const inv of invitations) {
          const invName = inv.name || inv.code || inv.inviteCode || 'Invitation';
          const groupName = (inv as any).groupName || 'a group';
          if (inv.requests && Array.isArray(inv.requests)) {
            allRequests.push(...inv.requests.map((req: any) => ({
              ...req,
              invitationName: invName,
              groupName,
            })));
          } else {
            try {
              const reqs = await api.getInvitationRequests(inv.id);
              if (Array.isArray(reqs)) {
                allRequests.push(...reqs.map((req: any) => ({
                  ...req,
                  invitationName: invName,
                  groupName,
                })));
              }
            } catch {
              // Ignore errors
            }
          }
        }

        setPendingRequests(allRequests.filter((r: any) => r.status === 'pending'));
        setAcceptedRequests(allRequests.filter((r: any) => r.status === 'accepted'));
      } catch (e) {
        console.error('Failed to fetch pending requests', e);
      }
    };

    fetchRequests();
    // Poll every 30 seconds
    const interval = setInterval(fetchRequests, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch recent watch activity for the "activity" notification type
  useEffect(() => {
    const fetchActivity = async () => {
      try {
        const metrics = await api.getMetrics('30d');
        setRecentWatchActivity(metrics.recentActivity || []);
        setRecentNowPlaying(metrics.nowPlaying || []);
      } catch (e) {
        console.error('Failed to fetch recent activity for notifications', e);
      }
    };

    fetchActivity();
    const interval = setInterval(fetchActivity, 30000);
    return () => clearInterval(interval);
  }, []);

  // New-episode alerts (fired server-side by the episodeAlerts poller when a
  // show someone here watches gets a newly-released episode). Server polls
  // Cinemeta every 6h, so a 5min client refresh is plenty.
  const [episodeAlerts, setEpisodeAlerts] = useState<any[]>([]);
  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        setEpisodeAlerts(await api.getEpisodeAlerts());
      } catch {
        // Endpoint may not exist yet on an older backend - stay silent.
      }
    };
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Addon online<->offline alerts (fired server-side by addonHealthCheck.js
  // when a primary addon goes down - and getGroupAddons silently diverts
  // groups to its backup - or comes back). Same cadence as episode alerts.
  const [addonHealthAlerts, setAddonHealthAlerts] = useState<any[]>([]);
  useEffect(() => {
    const fetchAddonAlerts = async () => {
      try {
        setAddonHealthAlerts(await api.getAddonHealthAlerts());
      } catch {
        // Endpoint may not exist yet on an older backend - stay silent.
      }
    };
    fetchAddonAlerts();
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

  // Real recent-activity feed, mapped to the shape the block below expects.
  // metrics.recentActivity's own shape (see MetricsData in lib/api.ts) is
  // {user: {username}, item: {name, poster}, watchedAt, ...} - flatten that
  // out rather than pass it through raw, so this component's own shape
  // doesn't leak metrics-API details into ITS callers via the activities prop.
  const combinedActivities = useMemo(() => {
    const fromMetrics = recentWatchActivity.map((entry) => ({
      id: `${entry.user?.id}-${entry.item?.id}-${entry.watchedAt}`,
      userName: entry.user?.username || 'Someone',
      type: 'complete',
      contentName: entry.item?.name || 'something',
      timestamp: entry.watchedAt,
      poster: entry.item?.poster,
    }));
    const fromNowPlaying = recentNowPlaying.map((np) => ({
      id: `now-playing-${np.user?.id}-${np.item?.id}-${np.videoId || ''}`,
      userName: np.user?.username || 'Someone',
      type: 'watch',
      contentName: np.item?.name || 'something',
      timestamp: np.watchedAtTimestamp || np.watchedAt,
      poster: np.item?.poster,
    }));
    return [...activities, ...fromMetrics, ...fromNowPlaying];
  }, [activities, recentWatchActivity, recentNowPlaying]);

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
        });
      });

    // Sort by timestamp, most recent first, then drop anything individually
    // dismissed via the per-row X button.
    return items
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .filter((item) => !dismissedIds.has(item.id));
  }, [combinedActivities, combinedInviteHistory, taskHistory, episodeAlerts, addonHealthAlerts, lastChecked, pendingRequests, dismissedIds, readIds]);

  const unreadCount = notifications.filter(n => !n.read).length;

  // Un-highlights every currently-visible notification without removing it -
  // rows stay in the list (still scrollable/readable), just lose the unread
  // styling and no longer count toward the bell's dot. Distinct from Clear,
  // which actually empties the list.
  const handleMarkAllRead = () => {
    const next = new Set(readIds);
    notifications.forEach((n) => next.add(n.id));
    persistReadIds(next);
  };

  const handleClearAll = () => {
    const now = new Date();
    setLastChecked(now);
    if (typeof window !== 'undefined') {
      localStorage.setItem('notifications-last-checked', now.toISOString());
    }
    // Nothing before `now` will ever be shown again anyway (see the
    // lastChecked filter above), so the individually-dismissed and
    // marked-read sets can both be reset too instead of accumulating
    // indefinitely.
    persistDismissedIds(new Set());
    persistReadIds(new Set());
    setIsOpen(false);
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

  return (
    <div className="relative" ref={containerRef}>
      <motion.button
        ref={buttonRef}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 rounded-lg transition-colors"
        style={{ color: 'var(--color-textMuted)' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-surfaceHover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
        aria-label="Notifications"
      >
        <BellIcon className="w-5 h-5" />
        {unreadCount > 0 && (
          <span 
            className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
            style={{ background: 'var(--color-primary)' }}
          />
        )}
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            />
            
            {/* Dropdown */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -10 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full mt-2 z-50 w-80 max-w-[calc(100vw-2rem)]"
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
              <div
                className="absolute -top-1 right-4 w-3 h-3 rotate-45 border-l border-t border-default"
                style={{ background: 'var(--color-surface)' }}
              />
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
              <div
                className="shadow-xl border border-default max-h-[500px] flex flex-col rounded-2xl overflow-hidden"
                style={{ background: 'var(--color-surface)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
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
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleClearAll}
                        className="text-xs"
                      >
                        Clear
                      </Button>
                    </div>
                  )}
                </div>

                {/* Notifications list */}
                <div className="overflow-y-auto max-h-[400px]">
                  {notifications.length === 0 ? (
                    <div className="p-8 text-center">
                      <BellIcon className="w-8 h-8 mx-auto mb-2 text-subtle" />
                      <p className="text-sm text-muted">No new notifications</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-default">
                      {notifications.map((notification) => (
                        <motion.div
                          key={notification.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="p-4 hover:bg-surface-hover transition-colors cursor-pointer"
                          style={notification.read ? undefined : { background: 'var(--color-primary-muted)' }}
                        >
                          <div className="flex flex-col gap-3">
                            <div className="flex items-start gap-3">
                              <span
                                className="w-1.5 h-1.5 rounded-full shrink-0 mt-2"
                                style={{ background: notification.read ? 'transparent' : 'var(--color-primary)' }}
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
                                <p className="text-sm font-medium text-default truncate">{notification.title}</p>
                                <p className="text-xs text-muted mt-0.5 truncate">{notification.message}</p>
                                <p className="text-xs text-subtle mt-1">{formatNotificationTime(notification.timestamp)}</p>
                              </div>
                              {/* Pending requests already clear themselves
                                  from the list via Accept/Reject below - an
                                  extra dismiss button there would let one
                                  get hidden without ever being acted on. */}
                              {notification.type !== 'request' && (
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
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}