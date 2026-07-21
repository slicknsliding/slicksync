'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api } from '@/lib/api';

interface NotificationsDataContextValue {
  pendingRequests: any[];
  acceptedRequests: any[];
  recentWatchActivity: any[];
  recentNowPlaying: any[];
  removePendingRequest: (id: string) => void;
}

const defaultContextValue: NotificationsDataContextValue = {
  pendingRequests: [],
  acceptedRequests: [],
  recentWatchActivity: [],
  recentNowPlaying: [],
  removePendingRequest: () => {},
};

const NotificationsDataContext = createContext<NotificationsDataContextValue>(defaultContextValue);

// Owns the notifications bell's polling (invite requests + recent watch
// activity), mounted once here in AdminClientLayout rather than inside
// NotificationsDropdown itself. The bell has two possible render locations
// (Header vs NebulaTopbar/NebulaPageHeading, and within Nebula a further
// mobile/desktop split - see NebulaTopbar.tsx) that each only resolve their
// real value after a post-hydration effect (layoutMode from localStorage,
// isMobile from matchMedia), so the bell component itself mounts and
// unmounts multiple times in the first render passes of a single page load
// as those settle. Fetching from inside the bell meant every one of those
// transient mounts fired its own copy of both requests - confirmed 3x
// (getInvitations + getMetrics) on a single real page load. Fetching here
// instead fixes that at the source: this provider mounts exactly once per
// admin session (AdminClientLayout doesn't remount on navigation or on
// either of those toggles), regardless of how many times the bell itself
// remounts underneath it.
export function NotificationsDataProvider({ children }: { children: ReactNode }) {
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [acceptedRequests, setAcceptedRequests] = useState<any[]>([]);
  const [recentWatchActivity, setRecentWatchActivity] = useState<any[]>([]);
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

  const removePendingRequest = (id: string) => {
    setPendingRequests(prev => prev.filter(r => r.id !== id));
  };

  return (
    <NotificationsDataContext.Provider
      value={{ pendingRequests, acceptedRequests, recentWatchActivity, recentNowPlaying, removePendingRequest }}
    >
      {children}
    </NotificationsDataContext.Provider>
  );
}

export function useNotificationsData() {
  return useContext(NotificationsDataContext);
}
