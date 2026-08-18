'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import {
  UsersIcon, PuzzlePieceIcon, EnvelopeIcon, SparklesIcon, CommandLineIcon,
  CheckIcon, ArrowRightIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { WHATS_NEW_LAST_SEEN_KEY } from './WhatsNewBanner';

const COMPLETED_KEY = 'slicksync-onboarding-completed';

// A step's own href is optional - clicking "Take me there" closes the
// wizard and navigates; steps with no action (the welcome/tips/finish
// steps) just advance.
interface Step {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  title: string;
  body: React.ReactNode;
  href?: string;
  actionLabel?: string;
}

const STEPS: Step[] = [
  {
    icon: SparklesIcon,
    title: 'Welcome to SlickSync',
    body: 'One dashboard for your household\'s Stremio and Nuvio accounts - addons, credentials, watch history, and live playback, all kept in sync.',
  },
  {
    icon: UsersIcon,
    title: 'Connect your first account',
    body: 'Add a Stremio or Nuvio account to manage - every profile syncs, not just the primary one.',
    href: '/users',
    actionLabel: 'Go to Users',
  },
  {
    icon: PuzzlePieceIcon,
    title: 'Add your addons',
    body: 'Bring in the addons you already use, tag and reorder them, and assign them to users or groups.',
    href: '/addons',
    actionLabel: 'Go to Addons',
  },
  {
    icon: EnvelopeIcon,
    title: 'Invite your household',
    body: 'Send an invite link so everyone else can connect their own account without you doing it for them.',
    href: '/invitations',
    actionLabel: 'Go to Invitations',
  },
  {
    icon: SparklesIcon,
    title: 'What\'s different from the original Syncio fork',
    body: (
      <ul className="text-sm space-y-1.5 mt-1">
        {[
          'SlickTrax: a built-in Trakt alternative - watchlist, For You recommendations, rewatch tracking, no external service',
          'Content Rating: a real allowlist that keeps a catalog enforced to a policy, not just a one-time filter',
          'Vault: real active-checks against your actual providers, expiry alerts, and now live usage + auto-remove for debrid services',
          'AI Services: natural-language catalog building, verified on save, with live model lists from your own provider',
          'Automation: webhook actions and time/event-based triggers for your own rules',
          'System Health, Year in Review, Taste Profiles, and a lot more under Metrics',
        ].map((line) => (
          <li key={line} className="flex items-start gap-2">
            <CheckIcon className="w-3.5 h-3.5 mt-1 shrink-0" style={{ color: 'var(--color-primary)' }} />
            <span className="text-muted">{line}</span>
          </li>
        ))}
      </ul>
    ),
  },
  {
    icon: CommandLineIcon,
    title: 'Tip: the command palette',
    body: (
      <>
        Press <kbd className="px-1.5 py-0.5 rounded text-xs font-mono" style={{ background: 'var(--color-subtle)' }}>Ctrl</kbd>+<kbd className="px-1.5 py-0.5 rounded text-xs font-mono" style={{ background: 'var(--color-subtle)' }}>K</kbd> (or <kbd className="px-1.5 py-0.5 rounded text-xs font-mono" style={{ background: 'var(--color-subtle)' }}>⌘K</kbd> on Mac) anywhere to jump straight to a page, user, addon, or catalog - or ask a question.
      </>
    ),
  },
];

export function OnboardingWizard() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!localStorage.getItem(COMPLETED_KEY)) setIsOpen(true);
  }, []);

  const finish = () => {
    localStorage.setItem(COMPLETED_KEY, '1');
    // A fresh install has nothing to "catch up" on - seed the What's New
    // banner's own tracking so it doesn't fire immediately after onboarding
    // finishes. Best-effort; if this fetch fails the banner just shows once
    // on the next visit instead, which is harmless.
    fetch('/changelog.json')
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data) && data[0]?.version) localStorage.setItem(WHATS_NEW_LAST_SEEN_KEY, data[0].version); })
      .catch(() => {})
      .finally(() => setIsOpen(false));
  };

  const goNext = () => {
    if (step < STEPS.length - 1) setStep((s) => s + 1);
    else finish();
  };

  const current = STEPS[step];
  const Icon = current.icon;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/60"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] w-full max-w-md mx-4"
          >
            <div className="rounded-2xl overflow-hidden shadow-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}>
              <div className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--color-primary-muted)' }}>
                    <Icon className="w-5 h-5" style={{ color: 'var(--color-primary)' }} />
                  </div>
                  <button onClick={finish} title="Skip" style={{ color: 'var(--color-textMuted)' }}>
                    <XMarkIcon className="w-5 h-5" />
                  </button>
                </div>

                <h2 className="text-lg font-bold font-display text-default mb-2">{current.title}</h2>
                <div className="text-sm text-muted leading-relaxed">{current.body}</div>

                <div className="flex items-center gap-1.5 mt-6 mb-5">
                  {STEPS.map((_, i) => (
                    <div
                      key={i}
                      className="h-1 rounded-full transition-all"
                      style={{ width: i === step ? 20 : 6, background: i <= step ? 'var(--color-primary)' : 'var(--color-surface-border)' }}
                    />
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  {current.href && (
                    <button
                      onClick={() => { finish(); router.push(current.href!); }}
                      className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-center transition-opacity hover:opacity-90"
                      style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text)', border: '1px solid var(--color-surface-border)' }}
                    >
                      {current.actionLabel}
                    </button>
                  )}
                  <button
                    onClick={goNext}
                    className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium transition-opacity hover:opacity-90"
                    style={{ background: 'var(--color-primary)', color: 'var(--color-bg)' }}
                  >
                    {step < STEPS.length - 1 ? 'Next' : 'Get started'}
                    {step < STEPS.length - 1 && <ArrowRightIcon className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
