'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { NotificationsDropdown } from '@/components/ui/NotificationsDropdown';
import { WizardBooksIcon } from '@/components/ui/icons/WizardBooksIcon';
import { openCommandPalette } from '@/components/ui/CommandPalette';
import {
  isOnboardingUnfinished,
  completeOnboarding,
  ONBOARDING_PAUSED_CHANGED_EVENT,
  ONBOARDING_RESUME_EVENT,
  ONBOARDING_VISIBILITY_EVENT,
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
  // Shown for the whole time the tour is unfinished - not only after it was
  // paused via one of its own links - and stays until the prompt's own X
  // dismisses it for good.
  const [unfinished, setUnfinished] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const showPrompt = unfinished && !wizardOpen;
  const clusterRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    const sync = () => setUnfinished(isOnboardingUnfinished());
    sync();
    const onVisibility = (e: Event) => {
      setWizardOpen(Boolean((e as CustomEvent<{ open: boolean }>).detail?.open));
      sync();
    };
    // The topbar persists across client-side navigation and never
    // remounts, so it needs explicit signals to re-read.
    window.addEventListener(ONBOARDING_PAUSED_CHANGED_EVENT, sync);
    window.addEventListener(ONBOARDING_VISIBILITY_EVENT, onVisibility);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(ONBOARDING_PAUSED_CHANGED_EVENT, sync);
      window.removeEventListener(ONBOARDING_VISIBILITY_EVENT, onVisibility);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // The prompt is position:fixed and tracks this cluster, rather than being
  // absolutely positioned inside it. That's because only SOME of the places
  // this renders are sticky - Nebula's page heading scrolls away with the
  // page, so an absolute overlay would scroll off with it. Tracking the
  // cluster keeps the prompt sitting exactly over the two buttons while
  // they're on screen, and the top clamp pins it to the viewport once they
  // scroll past, so it stays reachable wherever you are on a long page.
  const measure = useCallback(() => {
    const el = clusterRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({
      top: Math.max(r.top, 12),
      right: Math.max(window.innerWidth - r.right, 12),
    });
  }, []);

  useEffect(() => {
    if (!showPrompt) return;
    measure();
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onChange, { passive: true, capture: true });
    window.addEventListener('resize', onChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onChange, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onChange);
    };
  }, [showPrompt, measure]);

  const resume = () => window.dispatchEvent(new Event(ONBOARDING_RESUME_EVENT));

  // This X is the real dismissal - the wizard's own X is only "not now".
  const dismiss = () => completeOnboarding();

  const promptCard = (
    <div
      className="flex items-center gap-2 rounded-xl py-1.5 pl-2 pr-1.5"
      style={{
        background: 'var(--color-surface)',
        border: '1px solid color-mix(in srgb, var(--color-primary) 45%, transparent)',
        boxShadow: '0 10px 30px -8px rgba(0,0,0,0.6), 0 0 0 3px color-mix(in srgb, var(--color-primary) 18%, transparent)',
      }}
    >
      <WizardBooksIcon className="w-6 h-6 shrink-0" style={{ color: 'var(--color-primary)' }} />
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
  );

  return (
    <div ref={clusterRef} className="relative flex items-center gap-0.5">
      {/* Styled to match NotificationsDropdown's bell exactly - same
          padding, radius, muted colour and hover treatment - so the two
          read as one pair of peer controls rather than a button next to
          an icon. */}
      <button
        onClick={openCommandPalette}
        title="Search, jump to a page, or ask how to do something (Ctrl+K)"
        aria-label="Open the command palette"
        className="p-2 rounded-lg transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <WizardBooksIcon className="w-5 h-5" />
      </button>

      <NotificationsDropdown
        activities={activities}
        inviteHistory={inviteHistory}
        taskHistory={taskHistory}
      />

      {/* Prompt itself is portaled to <body> as position:fixed - see the
          measure() comment above for why it can't just be absolute here.
          The showPrompt check gates the PORTAL, not a child inside an
          AnimatePresence: with AnimatePresence the exit animation ran to
          opacity:0 but the node was never unmounted, leaving an invisible
          element still intercepting clicks on the bell underneath it
          (confirmed live 2026-08-21 - isConnected:true at opacity:0). An
          entry-only animation that reliably unmounts beats a 160ms fade
          that strands a click-blocker on the page. */}
      {mounted && anchor && showPrompt && createPortal(
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.16 }}
          style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 60 }}
        >
          {promptCard}
        </motion.div>,
        document.body
      )}
    </div>
  );
}
