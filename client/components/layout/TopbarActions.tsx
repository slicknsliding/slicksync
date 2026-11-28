'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { NotificationsDropdown, FLOATING_ICON_STYLE } from '@/components/ui/NotificationsDropdown';
import { WizardBooksIcon } from '@/components/ui/icons/WizardBooksIcon';
import { ResumeTourIcon } from '@/components/ui/icons/ResumeTourIcon';
import { openCommandPalette } from '@/lib/commandPaletteBus';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { ACCOUNT_MENU_EVENT } from './PanelSwitcher';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';
import { ONBOARDING_STEP_TITLES } from '@/components/onboarding/OnboardingWizard';
import {
  isOnboardingUnfinished,
  getPausedOnboardingStep,
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
  /** Extra classes on the cluster's own box (a page heading placing it). */
  className?: string;
}

// Gap between the bottom of the sticky nav bar and the pinned cluster.
const FLOAT_GAP = 8;
// Fallback pin position for layouts with no `data-nebula-topbar` bar to
// measure against (the sidebar Header, which has its own fixed chrome).
const FALLBACK_FLOAT_TOP = 12;
// Wherever there is a Nebula bar, the cluster docks INSIDE its logo row,
// at the far end from the hamburger, rather than floating under it: the
// floating pair sat over the page's own controls - a person's pills, the
// Users Add button, Discover's Show and Sort - and clicks meant for them hit
// the bell instead. Phones first, then the PC too, in the same spot.
// Docked, how far the cluster sits in from the bar card's right edge: into
// the card's padding, so it isn't crowding the centred logo.
const DOCK_EDGE_INSET = 8;
// Docked beside the account picture (account in the bar): the gap left between
// the cluster and it.
const DOCK_END_GAP = 4;

// The topbar's right-hand cluster: command palette, then notifications, and
// while the welcome tour is unfinished, a "Resume tour" button before them.
// That one is an ordinary third button with a dot on it: pressing it opens a
// small pop-up saying where the tour was left, with Resume tour and Don't
// show again. It used to be a glowing chip laid over the other two, which
// hid search and the bell on a computer, covered a page's own buttons on a
// phone and hung off the screen where the cluster sits on the left. A TV
// still gets that chip: it is one remote stop there, with nothing to open.
//
// Renders the same on every screen size. Mobile briefly hid the command
// palette here, back when its bell lived in a separate fixed corner pill
// too tight to fit both; that pill is gone and the two platforms now share
// one cluster in one place, so there's no per-platform variant to keep in
// sync.
//
// The cluster sits inline in the page heading at rest, then docks inside
// the sticky nav's logo row once that spot scrolls past (or, in the sidebar
// layout, which has no such row, pins itself near the top). Without this it
// scrolled away entirely, which mattered most on mobile: there's no Ctrl+K
// on a phone, so this button is the only way into the command palette, and
// on a long page (Discover's infinite scroll especially) it was unreachable
// without scrolling all the way back to the top.
export function TopbarActions({
  activities,
  inviteHistory,
  taskHistory,
  className,
}: TopbarActionsProps) {
  // Shown for the whole time the tour is unfinished - not only after it was
  // paused via one of its own links - and stays until the prompt's own X
  // dismisses it for good.
  const [unfinished, setUnfinished] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  // TV: the prompt sits where the account menu opens and would cover a row
  // of it, so it steps aside while that menu is open.
  const isTV = useIsTV();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setAccountMenuOpen(!!(e as CustomEvent).detail);
    window.addEventListener(ACCOUNT_MENU_EVENT, on);
    return () => window.removeEventListener(ACCOUNT_MENU_EVENT, on);
  }, []);
  const showPrompt = unfinished && !wizardOpen && !(isTV && accountMenuOpen);
  // A TV keeps the floating chip; everything else gets the button in the row.
  const showChip = showPrompt && isTV;
  const wantFlag = showPrompt && !isTV;
  // The step the tour was left on, for the pop-up's one line.
  const [pausedStep, setPausedStep] = useState<number | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const flagRef = useRef<HTMLButtonElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  // Read inside measure(), which is deliberately dependency-free so the
  // scroll listener is attached once and never torn down/re-attached. A ref
  // lets that stable callback still see the current value.
  const showPromptRef = useRef(showChip);
  // Holds the cluster's place in the page-heading flow. Keeping a
  // same-sized box here is what stops the heading row from collapsing (and
  // everything beside it jumping sideways) the moment the buttons leave the
  // flow to pin themselves.
  const placeholderRef = useRef<HTMLDivElement>(null);
  // The buttons themselves - inline or pinned. The resume prompt tracks
  // THIS, not the placeholder, so it follows the buttons while they're
  // pinned instead of sitting over an empty gap up the page.
  const buttonsRef = useRef<HTMLDivElement>(null);
  // docked: inside the bar's logo row (phones) rather than floating under it.
  // room: docked, whether a third button fits there beside the other two.
  const [pinned, setPinned] = useState<{ top: number; right: number; docked: boolean; room: boolean } | null>(null);
  // The bar keeps a place for two buttons. Where a third would land on the
  // logo or the links (a phone, the one-row bar), the tour button waits at
  // the top of the page instead: it is back as soon as the buttons are.
  const showFlag = wantFlag && !(pinned?.docked && !pinned.room);
  // The pop-up goes with its button (the tour opened, or it was dismissed).
  if (!showFlag && tourOpen) setTourOpen(false);
  const wantFlagRef = useRef(wantFlag);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    const sync = () => {
      setUnfinished(isOnboardingUnfinished());
      setPausedStep(getPausedOnboardingStep());
    };
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
      // Centred on the logo row, near the bar card's right edge.
      const row = document.querySelector('[data-nebula-logo-row]');
      const rr = row?.getBoundingClientRect();
      const card = row?.parentElement?.getBoundingClientRect();
      // With the account in the bar, dock just left of it instead.
      const end = row?.querySelector('[data-nebula-end]')?.getBoundingClientRect();
      const edge = end && end.width > 0
        ? end.left - DOCK_END_GAP
        : card ? card.right - DOCK_EDGE_INSET : rr?.right ?? 0;
      // A fixed element's `right` counts from the page's visible width, which
      // excludes a desktop-style scrollbar; innerWidth would include it and
      // shift the buttons left by the scrollbar's width.
      const viewW = document.documentElement.clientWidth;
      // Would a third button, left of search and the bell, lie on anything
      // else in the row? Only worked out while the tour button is wanted.
      let room = true;
      if (rr && row && wantFlagRef.current) {
        const unit = (buttonsRef.current?.lastElementChild?.getBoundingClientRect().width ?? 36) + 2;
        const right = edge - 2 * unit;
        const left = right - unit - 6;
        room = !Array.from(row.children).some((child) => {
          if (child.hasAttribute('data-nebula-end')) return false;
          const b = child.getBoundingClientRect();
          return b.width > 0 && b.right > left && b.left < right;
        });
      }
      const next = rr
        ? { top: Math.round(rr.top + (rr.height - natural.height) / 2), right: Math.max(Math.round(viewW - edge), 0), docked: true, room }
        : { top: floatTop, right: Math.max(viewW - natural.right, 0), docked: false, room };
      setSize((prev) =>
        prev && prev.width === natural.width && prev.height === natural.height
          ? prev
          : { width: natural.width, height: natural.height }
      );
      setPinned((prev) => (prev && prev.top === next.top && prev.right === next.right && prev.docked === next.docked && prev.room === next.room ? prev : next));
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
      right: Math.max(document.documentElement.clientWidth - r.right, 12),
    };
    setAnchor((prev) =>
      prev && prev.top === nextAnchor.top && prev.right === nextAnchor.right ? prev : nextAnchor
    );
  }, []);

  // Keep the ref current and re-measure on the transition, so the prompt
  // gets an anchor the moment it appears rather than on the next scroll.
  useEffect(() => {
    showPromptRef.current = showChip;
    measure();
  }, [showChip, measure]);

  // The box that holds the buttons' place is measured while they are still in
  // the page. When the tour button comes or goes while they are pinned, that
  // box is one button out, and the pinned row then lies over whatever sits
  // beside it (the Original layout's own header buttons). So for one pass,
  // before anything is painted, they go back into the page to be measured
  // again, and measure() pins them straight back.
  const [flagWas, setFlagWas] = useState(wantFlag);
  if (flagWas !== wantFlag) {
    setFlagWas(wantFlag);
    setPinned(null);
  }
  useLayoutEffect(() => {
    wantFlagRef.current = wantFlag;
    measure();
  }, [wantFlag, measure]);

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
    // The row the buttons sit in also changes with no scroll and no window
    // resize: a page's own buttons arrive and the row wraps, putting this
    // box on a second line. Pinned by then, the buttons stayed where the
    // first line was, on top of those buttons (the Original layout's Users
    // header, Sync All). Only that move to or from another line is acted on.
    const holder = placeholderRef.current;
    const row = holder?.parentElement;
    const onOtherLine = () => !!holder && !!row && holder.getBoundingClientRect().top - row.getBoundingClientRect().top >= holder.offsetHeight;
    let wrapped = onOtherLine();
    const rowWatch = row && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const now = onOtherLine();
          if (now === wrapped) return;
          wrapped = now;
          onChange();
        })
      : null;
    if (row) rowWatch?.observe(row);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onChange, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onChange);
      rowWatch?.disconnect();
    };
  }, [measure]);

  const resume = () => {
    setTourOpen(false);
    window.dispatchEvent(new Event(ONBOARDING_RESUME_EVENT));
  };
  // TV: each of these is a remote stop; OK does what a click does.
  const stop = (node: React.ReactNode, onEnter: () => void) => (isTV ? <TVFocusable className="inline-flex rounded-lg" onEnterPress={onEnter}>{node}</TVFocusable> : node);

  // This is the real dismissal - the wizard's own X is only "not now".
  const dismiss = () => {
    setTourOpen(false);
    completeOnboarding();
  };

  // "You stopped at step 4 of 9: Keep your credentials in the Vault."
  const stoppedTitle = pausedStep !== null ? ONBOARDING_STEP_TITLES[pausedStep] : undefined;
  const stoppedAt = stoppedTitle
    ? `You stopped at step ${(pausedStep as number) + 1} of ${ONBOARDING_STEP_TITLES.length}: ${stoppedTitle}.`
    : 'You have not finished the tour yet.';

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
      {stop(<button
        onClick={resume}
        tabIndex={isTV ? -1 : undefined}
        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-opacity hover:opacity-90"
        style={{ background: 'var(--color-primary)', color: 'var(--color-bg)' }}
      >
        Resume tour
      </button>, resume)}
      {stop(<button
        onClick={dismiss}
        tabIndex={isTV ? -1 : undefined}
        title="Dismiss - don't show this again"
        aria-label="Dismiss the tour"
        className="shrink-0 p-1 rounded-lg transition-colors hover:bg-surface-hover"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <XMarkIcon className="w-4 h-4" />
      </button>, dismiss)}
    </div>
  );

  // Floating over scrolling content (pinned under the bar, not docked in it)
  // is when the icons would be unreadable against posters and cards - so
  // each gets its own round backdrop then. Docked in the bar they sit on the
  // bar's own surface and look as they do inline.
  const floating = !!pinned && !pinned.docked;

  const buttons = (
    <div
      ref={buttonsRef}
      // Floating, each button is a little bigger than in the row. With the
      // tour button they sit closer, so the three reach no further past
      // their box than the two do.
      className={`flex items-center ${floating ? (showFlag ? 'gap-1' : 'gap-2') : 'gap-0.5'}`}
      // Above the bar (z-30) so docked buttons show on it.
      style={pinned ? { position: 'fixed', top: pinned.top, right: pinned.right, zIndex: 35 } : undefined}
    >
      {/* The same box as its two neighbours, in the accent color with a dot,
          so it reads as "something of yours is waiting here". data-tip, not
          title: the tooltip would otherwise come back over the open pop-up. */}
      {showFlag && (
        <button
          ref={flagRef}
          type="button"
          onClick={() => setTourOpen((o) => !o)}
          data-tip={tourOpen ? undefined : 'Resume tour'}
          aria-label="Resume tour"
          aria-haspopup="dialog"
          aria-expanded={tourOpen}
          className={`relative p-2 transition-colors ${floating ? 'rounded-full' : 'rounded-lg hov-surface'}`}
          style={{ color: 'var(--color-primary)', ...(floating ? FLOATING_ICON_STYLE : {}) }}
        >
          <ResumeTourIcon className="w-5 h-5" />
          <span
            aria-hidden
            className="absolute top-1 right-1 w-2 h-2 rounded-full"
            style={{ background: 'var(--color-primary)', boxShadow: `0 0 0 2px var(${pinned ? '--color-surface' : '--color-bg'})` }}
          />
        </button>
      )}

      {/* Styled to match NotificationsDropdown's bell exactly - same
          padding, radius, muted colour and hover treatment - so the two
          read as one pair of peer controls rather than a button next to
          an icon. */}
      {stop(<button
        onClick={openCommandPalette}
        tabIndex={isTV ? -1 : undefined}
        title="Search, jump to a page, or ask how to do something (Ctrl+K)"
        aria-label="Open the command palette"
        className={`p-2 transition-colors ${floating ? 'rounded-full' : 'rounded-lg hov-surface'}`}
        style={{ color: 'var(--color-text-muted)', ...(floating ? FLOATING_ICON_STYLE : {}) }}
      >
        <WizardBooksIcon className="w-5 h-5" />
      </button>, openCommandPalette)}

      <NotificationsDropdown
        floating={floating}
        activities={activities}
        inviteHistory={inviteHistory}
        taskHistory={taskHistory}
      />
    </div>
  );

  return (
    <div
      ref={placeholderRef}
      className={`relative flex items-center justify-end ${className ?? ''}`}
      // Reserves the vacated space only while pinned, so the heading row
      // keeps its shape instead of reflowing as you scroll past.
      style={pinned && size ? { width: size.width, height: size.height } : undefined}
    >
      {buttons}

      {/* Opens from the button and points at it; closes on Escape, a press
          anywhere else, or either of its own buttons. */}
      {showFlag && tourOpen && (
        <AnchoredPopup
          anchorRef={flagRef}
          onClose={() => setTourOpen(false)}
          title="Pick the tour back up"
          width={292}
          align="end"
          caret
          closeButton={false}
          initialFocusRef={resumeRef}
        >
          <p className="mt-1 text-[13px] leading-snug text-muted">{stoppedAt}</p>
          <div className="mt-3 flex items-center gap-1.5">
            <button
              ref={resumeRef}
              type="button"
              onClick={resume}
              className="h-[34px] px-3.5 rounded-[10px] text-[13px] font-semibold whitespace-nowrap transition-opacity hover:opacity-90"
              style={{ background: 'var(--color-primary)', color: 'var(--color-bg)' }}
            >
              Resume tour
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="h-[34px] px-2.5 rounded-[10px] text-[13px] font-medium whitespace-nowrap text-muted hover:text-default hover:bg-surface-hover transition-colors"
            >
              Don&rsquo;t show again
            </button>
          </div>
        </AnchoredPopup>
      )}

      {/* TV only. Prompt itself is portaled as position:fixed - it has to
          escape the heading row, which is normal page content and scrolls
          away, and it has to sit over BOTH buttons wherever they currently
          are (inline or pinned), which is why it tracks buttonsRef.
          The showPrompt check gates the PORTAL, not a child inside an
          AnimatePresence: with AnimatePresence the exit animation ran to
          opacity:0 but the node was never unmounted, leaving an invisible
          element still intercepting clicks on the bell underneath it
          (confirmed live 2026-08-21 - isConnected:true at opacity:0). An
          entry-only animation that reliably unmounts beats a 160ms fade
          that strands a click-blocker on the page.
          It goes into the page's own layer (app/layout.tsx), not onto body:
          on body it stayed bright in front of every open window and of
          search-everything. In the layer it is above the bar (30) and the
          pinned buttons (35), and under anything that covers the page. */}
      {mounted && anchor && showChip && createPortal(
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.16 }}
          style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 36 }}
        >
          {promptCard}
        </motion.div>,
        document.querySelector('[data-app-layer]') ?? document.body
      )}
    </div>
  );
}
