'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { FilmIcon, FireIcon, ClockIcon } from '@heroicons/react/24/outline';
import { Avatar } from '@/components/ui';

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

  useEffect(() => {
    if (!slug) return;
    fetch(`${API_BASE}/users/public-stats/${encodeURIComponent(slug)}`)
      .then(async (res) => {
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

  if (notFound || !stats) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--color-bg)' }}>
        <div className="text-center">
          <h1 className="text-xl font-semibold mb-2" style={{ color: 'var(--color-text)' }}>This stats page isn't available</h1>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>The link may have been disabled by its owner.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 px-4" style={{ background: 'var(--color-bg)' }}>
      <div className="max-w-2xl mx-auto">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center text-center mb-10">
          <Avatar name={stats.username} src={stats.avatarUrl || undefined} colorIndex={stats.colorIndex ?? undefined} size="lg" />
          <h1 className="text-2xl font-bold font-display mt-4" style={{ color: 'var(--color-text)' }}>{stats.username}'s Watch Stats</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>Powered by SlickSync</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="grid grid-cols-3 gap-3 mb-8"
        >
          {[
            { label: 'Hours watched', value: stats.totalWatchHours.toLocaleString(), icon: <ClockIcon className="w-5 h-5" /> },
            { label: 'Titles watched', value: stats.totalTitles.toLocaleString(), icon: <FilmIcon className="w-5 h-5" /> },
            { label: 'Day streak', value: stats.streak.toLocaleString(), icon: <FireIcon className="w-5 h-5" /> },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-xl p-4 text-center"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
            >
              <div className="flex justify-center mb-2" style={{ color: 'var(--color-primary)' }}>{s.icon}</div>
              <p className="text-xl font-bold font-display" style={{ color: 'var(--color-text)' }}>{s.value}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{s.label}</p>
            </div>
          ))}
        </motion.div>

        {stats.topTitles.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-text)' }}>Top Watched</h2>
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-3">
              {stats.topTitles.map((t, i) => (
                <div key={`${t.name}-${i}`} className="space-y-1.5">
                  <div
                    className="aspect-[2/3] rounded-lg overflow-hidden"
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
                  <p className="text-[11px] leading-tight truncate" style={{ color: 'var(--color-text-muted)' }} title={t.name}>{t.name}</p>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
