'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { FilmIcon } from '@heroicons/react/24/outline';
import { Avatar } from '@/components/ui';
import { PubFrame, PubOutcome } from '@/components/v2/PublicV2';
import { V2Numbers } from '@/components/v2/V2Detail';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

interface PublicStats {
  username: string;
  avatarUrl: string | null;
  colorIndex: number | null;
  totalWatchHours: number;
  totalTitles: number;
  streak: number;
  topTitles: Array<{ name: string; poster: string | null }>;
}

// Genuinely public, unauthenticated - no session, no cookie, no auth header.
// The slug in the URL IS the access control (server/routes/users.js's GET
// /users/public-stats/:slug): a random unguessable token, not a real id, and
// the endpoint only ever returns the small curated set of fields this page
// renders - never email, provider details, or anything else on the account.
export default function PublicStatsPage() {
  const params = useParams();
  const slug = params?.slug as string;
  const [stats, setStats] = useState<PublicStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Asked too often from this address - not the same thing as a link that is off.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!slug) return;
    fetch(`${API_BASE}/users/public-stats/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (res.status === 429) { setBusy(true); return; }
        if (!res.ok) { setNotFound(true); return; }
        const data = await res.json();
        setStats(data);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg)' }}>
        <div className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin" style={{ color: 'var(--color-primary)' }} />
      </div>
    );
  }

  if (busy) {
    return (
      <PubFrame>
        <PubOutcome tone="warn" title="Try again in a moment">
          This page has been opened a lot in the last minute.
        </PubOutcome>
      </PubFrame>
    );
  }

  if (notFound || !stats) {
    return (
      <PubFrame>
        <PubOutcome tone="off" title="This stats page isn’t available">
          The link may have been disabled by its owner.
        </PubOutcome>
      </PubFrame>
    );
  }

  return (
    <PubFrame>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center text-center mb-5">
        <Avatar name={stats.username} src={stats.avatarUrl || undefined} colorIndex={stats.colorIndex ?? undefined} size="lg" />
        <h1 className="text-2xl font-bold font-display mt-3" style={{ color: 'var(--color-text)' }}>{stats.username}</h1>
        <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>on SlickSync</p>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="mb-7">
        <V2Numbers
          items={[
            { label: 'Hours watched', value: stats.totalWatchHours.toLocaleString() },
            { label: 'Titles', value: stats.totalTitles.toLocaleString() },
            { label: 'Day streak', value: stats.streak.toLocaleString() },
          ]}
        />
      </motion.div>

      {stats.topTitles.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <h2 className="text-[15px] font-semibold mb-3" style={{ color: 'var(--color-text)' }}>Most watched</h2>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
            {stats.topTitles.map((t, i) => (
              <div key={`${t.name}-${i}`} className="space-y-1.5">
                <div
                  className="aspect-[2/3] rounded-xl overflow-hidden"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
                >
                  {t.poster ? (
                    <img src={t.poster} alt={t.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <FilmIcon className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} />
                    </div>
                  )}
                </div>
                <p className="text-[12px] leading-tight truncate" style={{ color: 'var(--color-text-muted)' }} title={t.name}>{t.name}</p>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </PubFrame>
  );
}
