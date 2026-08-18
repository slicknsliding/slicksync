'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { SparklesIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { ONBOARDING_COMPLETED_KEY, WHATS_NEW_LAST_SEEN_KEY as LAST_SEEN_KEY } from '@/lib/onboardingStorage';

interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
}

// Keeps existing installs aware of new features as they ship, rather than
// requiring someone to remember to check /changelog on their own. Compares
// changelog.json's newest entry against what this browser has already
// dismissed (localStorage, not server-side - "have I seen this" is a
// per-browser concern, not something worth an account-level schema field
// for). Silent when there's nothing new, or on first-ever visit (a fresh
// install has nothing to catch up on, and the onboarding wizard covers
// that case instead).
export function WhatsNewBanner() {
  const [entry, setEntry] = useState<ChangelogEntry | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Onboarding not finished yet means this is a first-ever visit still
    // mid-wizard (which covers "what's new" itself as one of its own
    // steps) - showing this banner on top of that read as cluttered and
    // redundant (confirmed live: both rendered at once on a fresh visit).
    // Finishing the wizard seeds LAST_SEEN_KEY to the current version
    // anyway, so there's nothing for this banner to show right after
    // onboarding completes either - it only ever fires for a RETURNING
    // visit where a newer version shipped since.
    if (!localStorage.getItem(ONBOARDING_COMPLETED_KEY)) return;
    fetch('/changelog.json')
      .then((r) => r.json())
      .then((data: ChangelogEntry[]) => {
        if (!Array.isArray(data) || data.length === 0) return;
        const latest = data[0];
        const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
        if (lastSeen === latest.version) return;
        setEntry(latest);
      })
      .catch(() => {});
  }, []);

  if (!entry || dismissed) return null;

  const handleDismiss = () => {
    localStorage.setItem(LAST_SEEN_KEY, entry.version);
    setDismissed(true);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.96 }}
        transition={{ duration: 0.2 }}
        // Compact corner card, not a page-spanning bar - opposite corner
        // from react-hot-toast's bottom-right so the two never stack, and
        // a fixed w-80 (not "100% minus a margin") so it stays a small
        // card even on a phone instead of reading as a full-width banner.
        className="fixed bottom-5 left-4 z-[90] w-80 max-w-[calc(100vw-2rem)]"
      >
        <div
          className="relative overflow-hidden rounded-2xl shadow-xl"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
        >
          <div className="h-[3px] w-full" style={{ background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }} />
          <button
            onClick={handleDismiss}
            className="absolute top-2.5 right-2.5 w-6 h-6 rounded-full flex items-center justify-center transition-colors"
            style={{ color: 'var(--color-textMuted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surfaceHover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            title="Dismiss"
            aria-label="Dismiss"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
          <div className="p-4 pr-9">
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--color-primary-muted)' }}>
                <SparklesIcon className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-primary)' }}>New · v{entry.version}</p>
              </div>
            </div>
            <p className="text-sm font-medium text-default leading-snug mb-3">{entry.title}</p>
            <Link
              href="/changelog"
              onClick={handleDismiss}
              className="inline-flex items-center text-xs font-semibold"
              style={{ color: 'var(--color-primary)' }}
            >
              See what's new →
            </Link>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
