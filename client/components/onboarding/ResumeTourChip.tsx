'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SparklesIcon } from '@heroicons/react/24/outline';
import {
  getPausedOnboardingStep,
  ONBOARDING_PAUSED_CHANGED_EVENT,
  ONBOARDING_RESUME_EVENT,
} from '@/lib/onboardingStorage';

// Sits next to the notification bell so a half-finished tour is visible
// where people already look for app-level status, rather than tucked in a
// bottom corner. Renders nothing at all unless a tour is actually paused,
// so it costs no space in the normal case.
export function ResumeTourChip() {
  const [pausedStep, setPausedStep] = useState<number | null>(null);

  useEffect(() => {
    const sync = () => setPausedStep(getPausedOnboardingStep());
    sync();
    // The topbar persists across client-side navigation and never
    // remounts, so it needs the explicit signal to re-read.
    window.addEventListener(ONBOARDING_PAUSED_CHANGED_EVENT, sync);
    // Covers the tour being finished in another tab.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(ONBOARDING_PAUSED_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const resume = () => {
    window.dispatchEvent(new Event(ONBOARDING_RESUME_EVENT));
  };

  return (
    <AnimatePresence>
      {pausedStep !== null && (
        <motion.button
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          onClick={resume}
          title="Pick the welcome tour back up where you left off"
          aria-label="Resume the welcome tour"
          className="flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium transition-opacity hover:opacity-90 shrink-0"
          style={{
            background: 'var(--color-primary-muted)',
            color: 'var(--color-primary)',
            border: '1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)',
          }}
        >
          <SparklesIcon className="w-4 h-4 shrink-0" />
          {/* Label drops on very narrow screens so it never crowds the bell
              - the icon plus its tooltip still carry the meaning. */}
          <span className="hidden sm:inline whitespace-nowrap">Resume tour</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
