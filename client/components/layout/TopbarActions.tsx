'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { NotificationsDropdown } from '@/components/ui/NotificationsDropdown';
import { WizardBooksIcon } from '@/components/ui/icons/WizardBooksIcon';
import { openCommandPalette } from '@/components/ui/CommandPalette';
import {
  getPausedOnboardingStep,
  ONBOARDING_PAUSED_CHANGED_EVENT,
  ONBOARDING_RESUME_EVENT,
  ONBOARDING_COMPLETED_KEY,
  clearPausedOnboardingStep,
} from '@/lib/onboardingStorage';

interface TopbarActionsProps {
  // Only the sidebar Header passes these through; the Nebula copies render
  // the bell with no preloaded data, same as before.
  activities?: any[];
  inviteHistory?: any[];
  taskHistory?: any[];
}

// The topbar's right-hand cluster: command palette, then notifications.
// Grouped into one component because the resume-tour prompt deliberately
// sits ON TOP of both of them - it has to be dismissed before either can
// be clicked, which only works if they share a positioning context.
export function TopbarActions({ activities, inviteHistory, taskHistory }: TopbarActionsProps) {
  const [pausedStep, setPausedStep] = useState<number | null>(null);

  useEffect(() => {
    const sync = () => setPausedStep(getPausedOnboardingStep());
    sync();
    // The topbar persists across client-side navigation and never
    // remounts, so it needs an explicit signal to re-read.
    window.addEventListener(ONBOARDING_PAUSED_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(ONBOARDING_PAUSED_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const resume = () => window.dispatchEvent(new Event(ONBOARDING_RESUME_EVENT));

  const dismiss = () => {
    try {
      localStorage.setItem(ONBOARDING_COMPLETED_KEY, '1');
    } catch { /* private-mode Safari; the clear below still fires the event */ }
    clearPausedOnboardingStep();
  };

  return (
    <div className="relative flex items-center gap-0.5">
      <button
        onClick={openCommandPalette}
        title="Search, jump to a page, or ask how to do something (Ctrl+K)"
        aria-label="Open the command palette"
        className="p-2 rounded-lg transition-colors hover:bg-surface-hover"
      >
        <WizardBooksIcon className="w-6 h-6" />
      </button>

      <NotificationsDropdown
        activities={activities}
        inviteHistory={inviteHistory}
        taskHistory={taskHistory}
      />

      {/* Resume-tour prompt, deliberately covering the two buttons above.
          Anchored to this cluster's right edge so it sits directly over
          them rather than floating somewhere unrelated - you have to deal
          with it before reaching the bell or the palette, which is the
          point: a half-finished setup tour shouldn't be easy to forget. */}
      <AnimatePresence>
        {pausedStep !== null && (
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -4 }}
            transition={{ duration: 0.16 }}
            className="absolute top-0 right-0 z-50"
          >
            <div
              className="flex items-center gap-2 rounded-xl shadow-2xl py-1.5 pl-2 pr-1.5"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 45%, transparent)',
                boxShadow: '0 10px 30px -8px rgba(0,0,0,0.6), 0 0 0 3px color-mix(in srgb, var(--color-primary) 18%, transparent)',
              }}
            >
              <WizardBooksIcon className="w-7 h-7 shrink-0" />
              <button
                onClick={resume}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-opacity hover:opacity-90"
                style={{ background: 'var(--color-primary)', color: 'var(--color-bg)' }}
              >
                Resume tour
              </button>
              <button
                onClick={dismiss}
                title="Dismiss - don't show this again"
                aria-label="Dismiss the tour"
                className="shrink-0 p-1 rounded-lg transition-colors hover:bg-surface-hover"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <XMarkIcon className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
