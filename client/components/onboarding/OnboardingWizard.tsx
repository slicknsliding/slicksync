'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';
import {
  UsersIcon, PuzzlePieceIcon, EnvelopeIcon, SparklesIcon, CommandLineIcon,
  CheckIcon, ArrowRightIcon, ArrowLeftIcon, XMarkIcon, ShieldCheckIcon,
  PlayCircleIcon, RectangleStackIcon, BookOpenIcon,
} from '@heroicons/react/24/outline';
import {
  ONBOARDING_COMPLETED_KEY as COMPLETED_KEY,
  ONBOARDING_OPEN_EVENT as REOPEN_EVENT,
  ONBOARDING_RESUME_EVENT,
  ONBOARDING_VISIBILITY_EVENT,
  getPausedOnboardingStep,
  setPausedOnboardingStep,
  clearPausedOnboardingStep,
  completeOnboarding,
  restartOnboarding,
} from '@/lib/onboardingStorage';

// Lets any other component (Settings' "Replay welcome tour" link, for one)
// reopen the wizard from scratch without needing to lift its state up or
// clear localStorage first - a plain DOM event keeps this decoupled from
// wherever the wizard happens to be mounted.
export function openOnboardingWizard() {
  window.dispatchEvent(new Event(REOPEN_EVENT));
}

// Each step is deliberately more than one sentence: the first version of
// this wizard was a single line per screen, which read as marketing rather
// than orientation and left people clicking Next without learning anything.
// `bullets` carry the concrete facts, `helpId` links to the full guide for
// anyone who wants the detail now rather than later.
interface Step {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  // Short label under the progress bar - tells you where you are without
  // having to re-read the heading.
  label: string;
  title: string;
  body: React.ReactNode;
  bullets?: string[];
  helpId?: string;
  href?: string;
  actionLabel?: string;
}

const STEPS: Step[] = [
  {
    icon: SparklesIcon,
    label: 'Welcome',
    title: 'Welcome to SlickSync',
    body: 'One dashboard for your household\'s Stremio and Nuvio accounts - addons, credentials, watch history, and live playback, all kept in sync.',
    bullets: [
      'Nuvio is a full second provider here, not an afterthought - both work everywhere.',
      'Nothing is required beyond adding one account; every integration below is optional.',
      'This tour takes about a minute, and you can replay it any time from Settings.',
    ],
    helpId: 'what-is-slicksync',
  },
  {
    icon: UsersIcon,
    label: 'Accounts',
    title: 'Connect your first account',
    body: 'Add a Stremio or Nuvio account to manage. Every profile on it syncs, not just the primary one.',
    bullets: [
      'Stremio uses email/password; Nuvio also supports a QR / device-code login.',
      'One person with both a Stremio and a Nuvio account can be merged into a single identity later - with a preview first and a full undo.',
      'Sync is two-way aware: SlickSync reads each provider\'s own state rather than assuming it owns it.',
    ],
    helpId: 'add-nuvio-account',
    href: '/users',
    actionLabel: 'Go to Users',
  },
  {
    icon: PuzzlePieceIcon,
    label: 'Addons',
    title: 'Bring in your addons',
    body: 'Import the addons you already use, then tag, reorder, and assign them to users or groups instead of repeating yourself per account.',
    bullets: [
      'Drag to reorder, drag to protect, or drag onto a colour-coded tag.',
      'Protected addons are never removed by a sync - useful for the one addon that keeps disappearing.',
      'Addon Snapshots save a named addon set you can deploy onto any user or group later.',
    ],
    helpId: 'protected-addons',
    href: '/addons',
    actionLabel: 'Go to Addons',
  },
  {
    icon: ShieldCheckIcon,
    label: 'Vault',
    title: 'Keep your credentials in the Vault',
    body: 'Real-Debrid, TorBox, Newznab, and the rest live in an encrypted Vault that actively checks whether they still work - rather than you finding out mid-stream.',
    bullets: [
      'Encrypted at rest, with real health checks against each provider\'s own API.',
      'Tracks cost and billing cycle, then projects a 90-day renewal and spend forecast.',
      'Shows live debrid usage - active downloads and premium days remaining - on the card.',
    ],
    helpId: 'vault-add-credential',
    href: '/vault',
    actionLabel: 'Go to Vault',
  },
  {
    icon: PlayCircleIcon,
    label: 'Tracking',
    title: 'Watch tracking, explained',
    body: 'SlickSync runs two independent signals on purpose, because neither one alone can see everything.',
    bullets: [
      'Live Now Playing comes from the AIOStreams proxy - real-time presence, gone the moment playback stops.',
      'History and watch time come from each provider\'s own library - the permanent record, including usenet, which the proxy can\'t see.',
      'That\'s why Now Playing can be empty while History fills in normally. It\'s two different systems, not a bug.',
    ],
    helpId: 'now-playing-empty',
  },
  {
    icon: RectangleStackIcon,
    label: 'Catalogs',
    title: 'Build catalogs and collections',
    body: 'Named lists of titles you can build by hand, import from a URL, or describe in plain English - plus a full manager for Nuvio\'s own home-screen collections.',
    bullets: [
      'Import from an MDBList or TMDb URL, or describe what you want ("90s horror") and review what it suggests.',
      'Content Rating turns a catalog into an enforced allowlist - useful for a genuinely kid-safe list.',
      'Nuvio Collections lets you build the folders the Nuvio app actually shows, without hand-editing them in the app.',
    ],
    helpId: 'catalog-create',
    href: '/catalogs',
    actionLabel: 'Go to Catalogs',
  },
  {
    icon: EnvelopeIcon,
    label: 'Invite',
    title: 'Invite your household',
    body: 'Send an invite link so everyone else connects their own account, instead of you collecting their passwords.',
    bullets: [
      'They connect their own provider account themselves - you never handle their credentials.',
      'Each person can opt out of their own notifications or set a personal Discord webhook.',
      'Anyone can export or delete their own data from their user portal without needing an admin.',
    ],
    helpId: 'invite-household',
    href: '/invitations',
    actionLabel: 'Go to Invitations',
  },
  {
    icon: SparklesIcon,
    label: 'What\'s new',
    title: 'What\'s different from the original Syncio fork',
    // Height capped in vh rather than a fixed rem: this is the longest step
    // by far, and a fixed cap either wastes space on a tall window or
    // overflows the modal on a short one.
    body: (
      <div className="max-h-[min(22rem,45vh)] overflow-y-auto pr-1 -mr-1">
        {[
          {
            group: 'Providers & Vault',
            lines: [
              'Nuvio as a full second provider alongside Stremio, plus optional SIMKL sync',
              'Encrypted credential Vault with real active health-checks, expiry alerts, and cost tracking',
            ],
          },
          {
            group: 'Watch tracking & Discover',
            lines: [
              'SlickTrax: built-in watchlist, rewatch tracking, and "For You" recommendations - no external service',
              'Live Now Playing, resume-on-another-device links, and true completion tracking',
              'Taste Profiles, Year in Review, Airing Calendar, and TMDb-powered "More Like This"',
            ],
          },
          {
            group: 'Catalogs & Nuvio Collections',
            lines: [
              'Named catalogs from an MDBList/TMDb URL, with content-rating allowlists and auto-refresh',
              'Full Nuvio Collections manager - templates, cover art, community covers, drag reorder',
              'Export catalogs to MDBList or SIMKL, or import from Trakt/Letterboxd/IMDb',
            ],
          },
          {
            group: 'Automation & alerts',
            lines: [
              'Webhook + time/event-based Automation rules, and a renewal calendar with spend forecasts',
              'Native push + in-app bell, digest mode, and per-user Discord opt-out',
              'A Trakt-compatible scrobble API so third-party players can write into SlickTrax',
            ],
          },
          {
            group: 'Personalization & admin',
            lines: [
              'Build-your-own themes (colors, fonts, radius) with export/import share codes',
              'A public shareable stats page, command palette (Ctrl+K), and TV/D-pad mode',
              'System Health board, backup/restore, addon templates, and opt-in 2FA/SSO',
            ],
          },
        ].map(({ group, lines }) => (
          <div key={group} className="mb-3 last:mb-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-primary)' }}>{group}</p>
            <ul className="text-sm space-y-1.5">
              {lines.map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <CheckIcon className="w-3.5 h-3.5 mt-1 shrink-0" style={{ color: 'var(--color-primary)' }} />
                  <span className="text-muted">{line}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    ),
    helpId: 'what-is-slicksync',
  },
  {
    icon: CommandLineIcon,
    label: 'Finding help',
    title: 'Ctrl+K is how you find everything',
    body: (
      <>
        Press <Kbd>Ctrl</Kbd>+<Kbd>K</Kbd> (or <Kbd>⌘K</Kbd> on Mac) anywhere to jump straight to a page, user,
        addon, or catalog - or just ask how to do something and get a real answer.
      </>
    ),
    bullets: [
      'Typing a question searches a built-in guide covering every page and setting - no AI key needed.',
      'Picking a result opens the full guide, with step-by-step instructions and the gotchas worth knowing.',
      'The whole library is browsable any time from the Guides page.',
    ],
    helpId: 'command-palette',
    href: '/guides',
    actionLabel: 'Open Guides',
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded text-xs font-mono" style={{ background: 'var(--color-subtle)' }}>
      {children}
    </kbd>
  );
}

export function OnboardingWizard() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (localStorage.getItem(COMPLETED_KEY)) return;
    // Deliberately do NOT auto-reopen when a tour is paused. They clicked
    // through to a page to actually look at something; popping the modal
    // back over it the moment they arrive is exactly what makes tours
    // annoying. The topbar chip offers to resume and lets them pick when.
    if (getPausedOnboardingStep() !== null) return;
    setIsOpen(true);
  }, []);

  useEffect(() => {
    const reopen = () => {
      // Full restart: clears the completed flag too, so the tour is
      // genuinely unfinished again rather than reopening while still
      // recorded as done.
      restartOnboarding();
      setStep(0);
      setIsOpen(true);
    };
    const resumeAtPaused = () => {
      const paused = getPausedOnboardingStep();
      clearPausedOnboardingStep();
      setStep(paused !== null && paused < STEPS.length ? paused : 0);
      setIsOpen(true);
    };
    window.addEventListener(REOPEN_EVENT, reopen);
    window.addEventListener(ONBOARDING_RESUME_EVENT, resumeAtPaused);
    return () => {
      window.removeEventListener(REOPEN_EVENT, reopen);
      window.removeEventListener(ONBOARDING_RESUME_EVENT, resumeAtPaused);
    };
  }, []);

  // Reaching the end of the tour genuinely finishes it - no prompt after.
  const finish = () => {
    completeOnboarding();
    setIsOpen(false);
  };

  // Closing with the X (or Escape) is "not right now", NOT a dismissal:
  // the tour stays unfinished and the topbar prompt keeps offering it until
  // that prompt's own X is used. Remembers the step so picking it back up
  // doesn't restart from the beginning.
  const closeForNow = () => {
    setPausedOnboardingStep(step);
    setIsOpen(false);
  };

  const goNext = () => {
    if (step < STEPS.length - 1) setStep((s) => s + 1);
    else finish();
  };

  const goBack = () => setStep((s) => Math.max(0, s - 1));

  // Leaving via a step's own link is a pause, not a finish - remember where
  // we were so they can pick the tour back up from the topbar chip on the
  // page they land on, instead of it being marked done and needing a
  // restart from Settings.
  const goTo = (href: string) => {
    setPausedOnboardingStep(step);
    setIsOpen(false);
    router.push(href);
  };

  // Tell the topbar prompt whether the modal is currently up, so the two
  // never show at once.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(ONBOARDING_VISIBILITY_EVENT, { detail: { open: isOpen } })
    );
  }, [isOpen]);

  // Lock the page behind the modal. Without this the backdrop scrolls under
  // the wizard as soon as the pointer leaves it, which reads as the tour
  // having lost its place. Compensating the scrollbar's width with padding
  // keeps the page from visibly jumping sideways the moment it locks -
  // hiding overflow reclaims that space otherwise.
  useEffect(() => {
    if (!isOpen) return;
    const { body, documentElement: html } = document;
    const prev = {
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
      htmlOverflow: html.style.overflow,
    };
    const scrollbarWidth = window.innerWidth - html.clientWidth;
    // Has to be set on <html> as well as <body>: this page's scrolling
    // element is documentElement, so locking body alone left the background
    // still scrolling (confirmed live - overflow read as "hidden" while the
    // page happily scrolled to 1483px underneath).
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      const current = parseFloat(getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${current + scrollbarWidth}px`;
    }
    return () => {
      html.style.overflow = prev.htmlOverflow;
      body.style.overflow = prev.bodyOverflow;
      body.style.paddingRight = prev.bodyPaddingRight;
    };
  }, [isOpen]);

  // Arrow keys move between steps, so the whole tour is usable without
  // reaching for the mouse (and on TV, where there isn't one).
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeForNow(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, step]);

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;
  const progress = ((step + 1) / STEPS.length) * 100;

  // The resume affordance lives in the topbar next to the notification
  // bell (see ResumeTourChip), not here - a corner popover was easy to
  // miss, and the bell row is where people already look for app state.
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] w-full px-4"
            // maxWidth has to be an inline style, NOT a Tailwind max-w-*
            // class: globals.css has an unlayered `* { max-width: 100vw }`
            // rule which beats any layered utility class regardless of
            // specificity, so max-w-lg was silently doing nothing and this
            // modal stretched to the full viewport width on a desktop
            // monitor (confirmed live 2026-08-20).
            style={{ maxWidth: 'min(42rem, 100%)' }}
          >
            <div
              className="rounded-2xl overflow-hidden shadow-2xl"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
            >
              {/* Accent stripe - same primary→secondary gradient the Nebula
                  panels use, so the wizard reads as part of the app rather
                  than a generic modal bolted on top. */}
              <div
                className="h-1 w-full"
                style={{ background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }}
              />

              <div className="relative p-6 pt-5">
                {/* Skip sits absolutely in the corner so the header block
                    below can be genuinely centred rather than centred-ish
                    around a button on one side. */}
                <button
                  onClick={closeForNow}
                  title="Close for now - you can pick this back up from the topbar"
                  aria-label="Close the tour for now"
                  className="absolute top-4 right-4 p-1.5 rounded-lg transition-colors hover:bg-surface-hover"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <XMarkIcon className="w-5 h-5" />
                </button>

                {/* Centred header: icon, where-you-are, title, intro. The
                    intro paragraph is centred with it; the bullets below
                    stay left-aligned, since centring a list makes every
                    line start at a different x and is genuinely harder to
                    scan. */}
                <div className="flex flex-col items-center text-center px-2">
                  <div
                    className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3"
                    style={{ background: 'var(--color-primary-muted)' }}
                  >
                    <Icon className="w-6 h-6" style={{ color: 'var(--color-primary)' }} />
                  </div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] mb-1" style={{ color: 'var(--color-primary)' }}>
                    {current.label}
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {'  ·  '}Step {step + 1} of {STEPS.length}
                    </span>
                  </p>
                  <h2 className="text-xl font-bold font-display text-default mb-2 text-balance">{current.title}</h2>
                  <div className="text-sm text-muted leading-relaxed">{current.body}</div>
                </div>

                {current.bullets && current.bullets.length > 0 && (
                  <ul className="mt-5 space-y-2.5 rounded-xl p-4" style={{ background: 'var(--color-bg-muted)' }}>
                    {current.bullets.map((b) => (
                      <li key={b} className="flex items-start gap-2.5">
                        <CheckIcon className="w-3.5 h-3.5 mt-[3px] shrink-0" style={{ color: 'var(--color-primary)' }} />
                        <span className="text-sm leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {current.helpId && (
                  <div className="flex justify-center mt-4">
                    <button
                      onClick={() => goTo(`/guides/${current.helpId}`)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium transition-opacity hover:opacity-80"
                      style={{ color: 'var(--color-secondary)' }}
                    >
                      <BookOpenIcon className="w-3.5 h-3.5" />
                      Read the full guide
                    </button>
                  </div>
                )}

                {/* Progress bar - a continuous bar reads more clearly at a
                    glance than a row of dots once there are this many
                    steps, and the dots became unreadably small. */}
                <div className="mt-6 mb-5">
                  <div className="h-1 w-full rounded-full overflow-hidden" style={{ background: 'var(--color-surface-border)' }}>
                    <motion.div
                      className="h-full rounded-full"
                      initial={false}
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.3 }}
                      style={{ background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {step > 0 && (
                    <button
                      onClick={goBack}
                      title="Back"
                      aria-label="Back"
                      className="p-2.5 rounded-lg transition-opacity hover:opacity-90 shrink-0"
                      style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)', border: '1px solid var(--color-surface-border)' }}
                    >
                      <ArrowLeftIcon className="w-4 h-4" />
                    </button>
                  )}
                  {current.href && (
                    <button
                      onClick={() => goTo(current.href!)}
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
                    {isLast ? 'Get started' : 'Next'}
                    {!isLast && <ArrowRightIcon className="w-4 h-4" />}
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
