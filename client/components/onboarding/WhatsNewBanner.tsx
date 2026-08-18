'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { SparklesIcon, XMarkIcon } from '@heroicons/react/24/outline';

const LAST_SEEN_KEY = 'slicksync-last-seen-changelog';

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
    fetch('/changelog.json')
      .then((r) => r.json())
      .then((data: ChangelogEntry[]) => {
        if (!Array.isArray(data) || data.length === 0) return;
        const latest = data[0];
        const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
        // No stored value at all means this is either a first-ever visit
        // (onboarding wizard's job, not this) or a pre-existing install from
        // before this feature shipped - only the latter should actually see
        // the banner. onboarding-completed already distinguishes them: a
        // fresh install sets last-seen-changelog itself on completion (see
        // OnboardingWizard), so reaching here with no stored value at all
        // means an existing install that predates this feature.
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
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -16 }}
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[90] w-[calc(100%-2rem)] max-w-md"
      >
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
        >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--color-primary-muted)' }}>
            <SparklesIcon className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-default">New in v{entry.version}</p>
            <p className="text-xs text-muted truncate">{entry.title}</p>
          </div>
          <Link
            href="/changelog"
            onClick={handleDismiss}
            className="text-xs font-medium shrink-0"
            style={{ color: 'var(--color-primary)' }}
          >
            See what's new
          </Link>
          <button onClick={handleDismiss} className="shrink-0" title="Dismiss">
            <XMarkIcon className="w-4 h-4" style={{ color: 'var(--color-textMuted)' }} />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export { LAST_SEEN_KEY as WHATS_NEW_LAST_SEEN_KEY };
