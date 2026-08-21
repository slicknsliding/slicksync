'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { NotificationsDropdown } from '@/components/ui/NotificationsDropdown';
import { WizardBooksIcon } from '@/components/ui/icons/WizardBooksIcon';
import { ResumeTourIcon } from '@/components/ui/icons/ResumeTourIcon';
import { openCommandPalette } from '@/components/ui/CommandPalette';
import {
  isOnboardingUnfinished,
  completeOnboarding,
  ONBOARDING_PAUSED_CHANGED_EVENT,
  ONBOARDING_RESUME_EVENT,
  ONBOARDING_VISIBILITY_EVENT,
} from '@/lib/onboardingStorage';

interface TopbarActionsProps {
  // Only the sidebar Header passes these through; the Nebula copy renders
  // the bell with no preloaded data, same as before.
  activities?: any[];
  inviteHistory?: any[];
  taskHistory?: any[];
}

// Gap between the bottom of the sticky nav bar and the pinned cluster.
const FLOAT_GAP = 8;
// Fallback pin position for layouts with no `data-nebula-topbar` bar to
// measure against (the sidebar Header, which has its own fixed chrome).
const FALLBACK_FLOAT_TOP = 12;

// The topbar's right-hand cluster: command palette, then notifications.
// Grouped into one component because the resume-tour prompt deliberately
// sits ON TOP of both of them - it has to be dismissed before either can
// be clicked, which only works if they share a positioning context.
//
// Renders the same on every screen size. Mobile briefly hid the command
// palette here, back when its bell lived in a separate fixed corner pill
// too tight to fit both; that pill is gone and the two platforms now share
// one cluster in one place, so there's no per-platform variant to keep in
// sync.
//
// The cluster sits inline in the page heading at rest, then pins itself
// just under the sticky nav once that spot scrolls past. Without this it
// scrolled away entirely, which mattered most on mobile: there's no Ctrl+K
// on a phone, so this button is the only way into the command palette, and
// on a long page (Discover's infinite scroll especially) it was unreachable
// without scrolling all the way back to the top.
export function TopbarActions({
  activities,
  inviteHistory,
  taskHistory,
}: TopbarActionsProps) {
  // Shown for the whole time the tour is unfinished - not only after it was
  // paused via one of its own links - and stays until the prompt's own X
  // dismisses it for good.
  const [unfinished, setUnfinished] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const showPrompt = unfinished && !wizardOpen;
  // Read inside measure(), which is deliberately dependency-free so the
  // scroll listener is attached once and never torn down/re-attached. A ref
  // lets that stable callback still see the current value.
  const showPromptRef = useRef(showPrompt);
  // Holds the cluster's place in the page-heading flow. Keeping a
  // same-sized box here is what stops the heading row from collapsing (and
  // everything beside it jumping sideways) the moment the buttons leave the
  // flow to pin themselves.
  const placeholderRef = useRef<HTMLDivElement>(null);
  // The buttons themselves - inline or pinned. The resume prompt tracks
  // THIS, not the placeholder, so it follows the buttons while they're
  // pinned instead of sitting over an empty gap up the page.
  const buttonsRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState<{ top: number; right: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
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

  // Decides pinned vs inline, and re-measures the prompt's anchor. Both are
  // driven off the placeholder, which stays in normal flow and so always
  // reports where the cluster WOULD be - the pinned buttons can't be used
  // for that, since once they're fixed their own rect stops moving and the
  // condition to unpin could never become true again.
  const measure = useCallback(() => {
    const holder = placeholderRef.current;
    if (!holder) return;
    const natural = holder.getBoundingClientRect();

    // Measured every time rather than cached: this bar collapses its nav
    // links into a hamburger once scrolled, so its height genuinely
    // changes between the top of the page and everywhere else.
    const bar = document.querySelector('[data-nebula-topbar]');
    const floatTop = bar
      ? bar.getBoundingClientRect().bottom + FLOAT_GAP
      : FALLBACK_FLOAT_TOP;

    // Every setState below is guarded on the value actually changing. This
    // runs on each scroll frame, and returning a fresh object each time
    // would re-render the whole cluster (and the bell's subtree) for the
    // entire length of a scroll even when nothing moved.
    if (natural.top < floatTop) {
      const next = { top: floatTop, right: Math.max(window.innerWidth - natural.right, 0) };
      setSize((prev) =>
        prev && prev.width === natural.width && prev.height === natural.height
          ? prev
          : { width: natural.width, height: natural.height }
      );
      setPinned((prev) => (prev && prev.top === next.top && prev.right === next.right ? prev : next));
    } else {
      setPinned((prev) => (prev === null ? prev : null));
    }

    // Only the prompt uses this, and it's the expensive half (a second
    // getBoundingClientRect per frame), so skip it entirely when there's no
    // prompt on screen to position.
    if (!showPromptRef.current) return;
    const target = buttonsRef.current ?? holder;
    const r = target.getBoundingClientRect();
    const nextAnchor = {
      top: Math.max(r.top, 12),
      right: Math.max(window.innerWidth - r.right, 12),
    };
    setAnchor((prev) =>
      prev && prev.top === nextAnchor.top && prev.right === nextAnchor.right ? prev : nextAnchor
    );
  }, []);

  // Keep the ref current and re-measure on the transition, so the prompt
  // gets an anchor the moment it appears rather than on the next scroll.
  useEffect(() => {
    showPromptRef.current = showPrompt;
    measure();
  }, [showPrompt, measure]);

  useEffect(() => {
    measure();
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // capture:true so this still fires for scrolls inside nested scroll
    // containers, not just the window.
    window.addEventListener('scroll', onChange, { passive: true, capture: true });
    window.addEventListener('resize', onChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onChange, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onChange);
    };
  }, [measure]);

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
      <ResumeTourIcon className="w-6 h-6 shrink-0" style={{ color: 'var(--color-primary)' }} />
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

  const buttons = (
    <div
      ref={buttonsRef}
      className="flex items-center gap-0.5"
      style={
        pinned
          ? {
              position: 'fixed',
              top: pinned.top,
              right: pinned.right,
              zIndex: 35,
              // Only while pinned: inline it sits on the page background and
              // needs nothing, but pinned it floats over scrolling content
              // and would otherwise be unreadable against posters and cards.
              background: 'color-mix(in srgb, var(--color-surface) 80%, transparent)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              border: '1px solid var(--color-surface-border)',
              boxShadow: '0 8px 24px -8px rgba(0,0,0,0.5)',
              borderRadius: '0.75rem',
              padding: '0.125rem',
            }
          : undefined
      }
    >
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
    </div>
  );

  return (
    <div
      ref={placeholderRef}
      className="relative flex items-center justify-end"
      // Reserves the vacated space only while pinned, so the heading row
      // keeps its shape instead of reflowing as you scroll past.
      style={pinned && size ? { width: size.width, height: size.height } : undefined}
    >
      {buttons}

      {/* Prompt itself is portaled to <body> as position:fixed - it has to
          escape the heading row, which is normal page content and scrolls
          away, and it has to sit over BOTH buttons wherever they currently
          are (inline or pinned), which is why it tracks buttonsRef.
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
