'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, useMotionValue, useTransform, AnimatePresence } from 'framer-motion';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Button } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import { api, User, WatchPartySession, WatchPartyItem } from '@/lib/api';
import { buildStremioAppUrl, buildNuvioAppUrl } from '@/lib/appLinks';
import {
  HandThumbUpIcon, HandThumbDownIcon, FilmIcon, TvIcon, ArrowLeftIcon,
  CheckCircleIcon, ClockIcon, PlayIcon,
} from '@heroicons/react/24/outline';

const POLL_MS = 3000;
const SWIPE_THRESHOLD = 120;
const identityKey = (id: string) => `slicksync-watchparty-identity-${id}`;

function SwipeCard({
  item, onVote, isTop, exitDirection,
}: {
  item: WatchPartyItem;
  onVote: (vote: boolean) => void;
  isTop: boolean;
  // Set by the parent the instant a vote is committed (drag OR button), so
  // the fling-off animation always matches the actual vote - reading the
  // drag position alone (x.get()) is always 0 for a button-click vote,
  // which made a "Yes" click visually fling left like a "Pass".
  exitDirection: 1 | -1;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-12, 12]);
  const yesOpacity = useTransform(x, [20, 120], [0, 1]);
  const noOpacity = useTransform(x, [-120, -20], [1, 0]);

  return (
    <motion.div
      className="absolute inset-0"
      style={{ x, rotate, zIndex: isTop ? 10 : 1 }}
      drag={isTop ? 'x' : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.9}
      onDragEnd={(_, info) => {
        if (info.offset.x > SWIPE_THRESHOLD) onVote(true);
        else if (info.offset.x < -SWIPE_THRESHOLD) onVote(false);
      }}
      initial={{ scale: isTop ? 1 : 0.95, opacity: isTop ? 1 : 0.6, y: isTop ? 0 : 12 }}
      animate={{ scale: isTop ? 1 : 0.95, opacity: isTop ? 1 : 0.6, y: isTop ? 0 : 12 }}
      exit={{ x: exitDirection * 400, opacity: 0, transition: { duration: 0.25 } }}
    >
      <Card padding="none" className="w-full h-full overflow-hidden relative select-none">
        {item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.poster} alt="" className="w-full h-full object-cover pointer-events-none" draggable={false} />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-surface-hover">
            {item.type === 'series' ? <TvIcon className="w-16 h-16 text-subtle" /> : <FilmIcon className="w-16 h-16 text-subtle" />}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/85 via-black/40 to-transparent">
          <p className="text-white font-semibold text-lg leading-tight">{item.name}</p>
          {item.year && <p className="text-white/70 text-sm">{item.year}</p>}
        </div>
        {isTop && (
          <>
            <motion.div style={{ opacity: yesOpacity }} className="absolute top-6 left-6 px-3 py-1.5 rounded-lg border-4 border-success text-success font-bold text-xl -rotate-12 bg-black/30">
              YES
            </motion.div>
            <motion.div style={{ opacity: noOpacity }} className="absolute top-6 right-6 px-3 py-1.5 rounded-lg border-4 border-error text-error font-bold text-xl rotate-12 bg-black/30">
              PASS
            </motion.div>
          </>
        )}
      </Card>
    </motion.div>
  );
}

export default function WatchPartySessionPage() {
  const { layoutMode } = useLayoutMode();
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;

  const [session, setSession] = useState<WatchPartySession | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [localIndex, setLocalIndex] = useState(0);
  const [matched, setMatched] = useState<WatchPartyItem | null>(null);
  const votingRef = useRef(false);
  // Per-item exit direction (1 = flung right/yes, -1 = flung left/pass) so a
  // voted card's fling-off animation always matches the actual vote,
  // regardless of whether it was dragged or committed via the buttons.
  const [exitDirections, setExitDirections] = useState<Record<string, 1 | -1>>({});
  // The swipe queue, frozen once per claimed identity - NOT recomputed live
  // from session.votedItemsByUser. It used to be a useMemo reactive to the
  // session, which broke under the 3s background poll: the instant a vote
  // landed server-side and a poll refetch came back, the just-voted item
  // dropped out of the filtered list, shifting every remaining item's index
  // down by one - but localIndex (a plain offset into that array) had no way
  // to know the shift happened, so the next card silently skipped an
  // unvoted title entirely (confirmed live: the counter jumped 24 -> 22
  // after a single vote, not 23). Freezing the queue at claim time and only
  // ever advancing via localIndex fixes it; a page reload correctly
  // re-seeds from the server's current voted set, so resuming later still
  // works.
  const [queue, setQueue] = useState<WatchPartyItem[]>([]);
  const [queueReady, setQueueReady] = useState(false);
  const seededForUserRef = useRef<string | null>(null);

  const load = useCallback(() => {
    api.getWatchParty(sessionId)
      .then((s) => {
        setSession(s);
        if (s.status === 'matched' && s.matchedItem) setMatched(s.matchedItem);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    api.getUsers().then(setUsers).catch(() => {});
    load();
  }, [load]);

  // Claim identity from localStorage once the session (and its participant
  // list) is known.
  useEffect(() => {
    if (!session) return;
    const saved = localStorage.getItem(identityKey(sessionId));
    if (saved && session.participantIds.includes(saved)) setMyUserId(saved);
  }, [session, sessionId]);

  // Poll for match/progress while active and identity is claimed - catches a
  // match completed by someone ELSE'S vote while I'm still on a different card.
  useEffect(() => {
    if (!myUserId || !session || session.status !== 'active' || matched) return;
    const t = setInterval(() => {
      api.getWatchParty(sessionId).then((s) => {
        setSession(s);
        if (s.status === 'matched' && s.matchedItem) setMatched(s.matchedItem);
      }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [myUserId, session, sessionId, matched]);

  const claimIdentity = (userId: string) => {
    localStorage.setItem(identityKey(sessionId), userId);
    setMyUserId(userId);
    setLocalIndex(0);
  };

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u.username])), [users]);

  // Seed the queue exactly once per claimed identity (see the comment on the
  // queue state above for why this can't be a live-reactive useMemo).
  useEffect(() => {
    if (!session || !myUserId) return;
    if (seededForUserRef.current === myUserId) return;
    const voted = new Set(session.votedItemsByUser[myUserId] || []);
    setQueue(session.candidates.filter((c) => !voted.has(c.id)));
    setLocalIndex(0);
    setQueueReady(true);
    seededForUserRef.current = myUserId;
  }, [session, myUserId]);

  const handleVote = async (vote: boolean) => {
    if (!session || !myUserId || votingRef.current) return;
    const item = queue[localIndex];
    if (!item) return;
    votingRef.current = true;
    setExitDirections((prev) => ({ ...prev, [item.id]: vote ? 1 : -1 }));
    try {
      const res = await api.voteWatchParty(sessionId, myUserId, item.id, vote);
      if (res.matched && res.item) {
        setMatched(res.item);
      } else {
        setLocalIndex((i) => i + 1);
      }
    } catch {
      toast.error('Vote failed to save - try again');
    } finally {
      votingRef.current = false;
    }
  };

  const heading = { title: 'Watch Party', subtitle: session ? session.participantIds.map((id) => userMap.get(id) || '?').join(' vs. ') : '' };

  const backButton = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={() => router.push('/watch-party')}>
      Back
    </Button>
  );

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header title={<Breadcrumbs items={[{ label: 'Watch Party', href: '/watch-party' }, { label: 'Session' }]} className="text-xl font-semibold" />} subtitle={heading.subtitle} actions={backButton} />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '32rem' } : { maxWidth: '32rem', margin: '0 auto' }}>
        {layoutMode === 'nebula' && <NebulaPageHeading title={heading.title} subtitle={heading.subtitle} actions={backButton} />}

        {loading ? (
          <div className="aspect-[2/3] rounded-xl bg-surface-hover animate-pulse" />
        ) : notFound || !session ? (
          <PageSection>
            <Card padding="lg" className="text-center">
              <p className="text-sm text-muted">This session doesn&apos;t exist.</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => router.push('/watch-party')}>Back to Watch Party</Button>
            </Card>
          </PageSection>
        ) : matched ? (
          <PageSection>
            <Card padding="lg" className="text-center border-success/30" style={{ background: 'linear-gradient(160deg, rgba(34,197,94,0.12) 0%, transparent 70%)' }}>
              <CheckCircleIcon className="w-12 h-12 mx-auto text-success mb-3" />
              <h2 className="text-xl font-bold font-display text-default mb-1">Everyone agreed!</h2>
              <p className="text-sm text-muted mb-4">Tonight&apos;s pick:</p>
              <div className="w-40 mx-auto mb-4 rounded-lg overflow-hidden aspect-[2/3] bg-surface-hover">
                {matched.poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={matched.poster} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    {matched.type === 'series' ? <TvIcon className="w-10 h-10 text-subtle" /> : <FilmIcon className="w-10 h-10 text-subtle" />}
                  </div>
                )}
              </div>
              <p className="text-lg font-semibold text-default mb-4">{matched.name}</p>
              <div className="flex items-center justify-center gap-2 flex-wrap">
                <a href={buildStremioAppUrl(matched.id, matched.type)} className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5" style={{ background: 'rgba(167, 139, 250, 0.15)', color: 'rgb(196, 181, 253)', border: '1px solid rgba(167, 139, 250, 0.25)' }}>
                  <PlayIcon className="w-4 h-4" /> Open in Stremio
                </a>
                <a href={buildNuvioAppUrl(matched.id, matched.type)} className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5" style={{ background: 'linear-gradient(115deg, rgba(56, 89, 158, 0.22) 0%, rgba(56, 89, 158, 0.22) 50%, rgba(255, 152, 0, 0.10) 50%, rgba(255, 152, 0, 0.10) 100%)', color: 'rgb(186, 208, 240)', border: '1px solid rgba(255, 152, 0, 0.18)' }}>
                  <PlayIcon className="w-4 h-4" /> Open in Nuvio
                </a>
              </div>
            </Card>
          </PageSection>
        ) : !myUserId ? (
          <PageSection>
            <Card padding="lg" className="text-center">
              <h3 className="text-base font-semibold text-default mb-1">Who are you?</h3>
              <p className="text-xs text-muted mb-4">Pick your name to start swiping on this device.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {session.participantIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => claimIdentity(id)}
                    className="px-4 py-2.5 rounded-lg text-sm font-medium bg-surface-hover text-default hover:bg-primary/20 hover:text-primary transition-colors"
                  >
                    {userMap.get(id) || id}
                  </button>
                ))}
              </div>
            </Card>
          </PageSection>
        ) : !queueReady ? (
          <div className="aspect-[2/3] rounded-xl bg-surface-hover animate-pulse" />
        ) : queue.length === 0 || localIndex >= queue.length ? (
          <PageSection>
            <Card padding="lg" className="text-center">
              <ClockIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
              <p className="text-sm font-medium text-default">You&apos;re all caught up</p>
              <p className="text-xs text-muted mt-1">Waiting on the others to finish swiping…</p>
            </Card>
          </PageSection>
        ) : (
          <div>
            <div className="relative w-full aspect-[2/3] mb-4">
              <AnimatePresence>
                {queue.slice(localIndex, localIndex + 2).reverse().map((item, i, arr) => (
                  <SwipeCard
                    key={item.id}
                    item={item}
                    isTop={i === arr.length - 1}
                    onVote={handleVote}
                    exitDirection={exitDirections[item.id] ?? 1}
                  />
                ))}
              </AnimatePresence>
            </div>
            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => handleVote(false)}
                className="w-14 h-14 rounded-full flex items-center justify-center bg-surface-hover text-error hover:bg-error/15 transition-colors"
                title="Pass"
              >
                <HandThumbDownIcon className="w-6 h-6" />
              </button>
              <button
                type="button"
                onClick={() => handleVote(true)}
                className="w-14 h-14 rounded-full flex items-center justify-center bg-surface-hover text-success hover:bg-success/15 transition-colors"
                title="Yes"
              >
                <HandThumbUpIcon className="w-6 h-6" />
              </button>
            </div>
            <p className="text-center text-xs text-subtle mt-3">
              Swiping as <span className="text-default font-medium">{userMap.get(myUserId) || myUserId}</span> · {queue.length - localIndex} left
            </p>
          </div>
        )}
      </div>
      </div>
    </>
  );
}
