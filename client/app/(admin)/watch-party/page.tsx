'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Button } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import { api, User, WatchPartySessionSummary } from '@/lib/api';
import { FireIcon, UserGroupIcon, CheckCircleIcon, PlayIcon } from '@heroicons/react/24/outline';

// "What should we watch tonight" swipe-off. Pick who's playing (existing
// SlickSync Users - the household's tracked profiles, same list Taste
// Profiles/leaderboards use), start a session, then share the session's URL
// with everyone playing - each person opens it on their own device and
// claims their name (no per-device login exists in this app, so identity is
// just "which name did you tap" per browser tab, persisted in localStorage).

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export default function WatchPartyPage() {
  const { layoutMode } = useLayoutMode();
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [sessions, setSessions] = useState<WatchPartySessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([api.getUsers(), api.getWatchPartySessions()])
      .then(([u, s]) => { setUsers(u); setSessions(s); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const userMap = new Map(users.map((u) => [u.id, u.username]));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleStart = async () => {
    if (selected.size < 2) { toast.error('Pick at least 2 people'); return; }
    setCreating(true);
    try {
      const ids = [...selected];
      const session = await api.createWatchParty(ids[0], ids);
      router.push(`/watch-party/${session.id}`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to start');
    } finally {
      setCreating(false);
    }
  };

  const heading = { title: 'Watch Party', subtitle: 'Swipe together, agree on something to watch tonight.' };

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header title={<Breadcrumbs items={[{ label: 'Watch Party' }]} className="text-xl font-semibold" />} subtitle={heading.subtitle} />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '56rem' } : undefined}>
        {layoutMode === 'nebula' && <NebulaPageHeading title={heading.title} subtitle={heading.subtitle} />}

        <PageSection className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-2 mb-1">
              <FireIcon className="w-5 h-5 text-primary" />
              <h3 className="text-base font-semibold font-display text-default">Who&apos;s playing?</h3>
            </div>
            <p className="text-xs text-muted mb-4">Pick everyone joining tonight - each person swipes on their own device.</p>

            {!loaded ? (
              <div className="flex flex-wrap gap-2">
                {[...Array(4)].map((_, i) => <div key={i} className="h-10 w-28 rounded-lg bg-surface-hover animate-pulse" />)}
              </div>
            ) : users.length === 0 ? (
              <p className="text-sm text-muted">No users yet - add some on the Users page first.</p>
            ) : (
              <div className="flex flex-wrap gap-2 mb-5">
                {users.map((u) => {
                  const active = selected.has(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => toggle(u.id)}
                      className={`px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        active ? 'bg-primary text-white border-primary' : 'bg-surface-hover text-default border-transparent hover:border-primary/30'
                      }`}
                    >
                      {u.username}
                    </button>
                  );
                })}
              </div>
            )}

            <Button
              variant="primary"
              leftIcon={<FireIcon className="w-4 h-4" />}
              onClick={handleStart}
              disabled={selected.size < 2 || creating}
            >
              {creating ? 'Building tonight’s picks…' : `Start swiping (${selected.size} playing)`}
            </Button>
          </Card>
        </PageSection>

        {sessions.length > 0 && (
          <PageSection>
            <div className="flex items-center gap-2 mb-3">
              <UserGroupIcon className="w-5 h-5 text-primary" />
              <h3 className="text-base font-semibold font-display text-default">Recent sessions</h3>
            </div>
            <div className="space-y-2">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => router.push(`/watch-party/${s.id}`)}
                  className="w-full flex items-center gap-3 p-3 rounded-lg bg-surface-hover hover:bg-surface-hover/70 transition-colors text-left"
                >
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${s.status === 'matched' ? 'bg-success/15 text-success' : s.status === 'ended' ? 'bg-surface text-subtle' : 'bg-primary/10 text-primary'}`}>
                    {s.status === 'matched' ? <CheckCircleIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-default truncate">
                      {s.participantIds.map((id) => userMap.get(id) || '?').join(', ')}
                    </p>
                    <p className="text-xs text-muted">
                      {s.status === 'matched' && s.matchedItem ? `Matched on ${s.matchedItem.name}` : s.status === 'ended' ? 'Ended' : 'Still deciding'} · {timeAgo(s.createdAt)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </PageSection>
        )}
      </div>
      </div>
    </>
  );
}
