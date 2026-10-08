'use client';

// The Nebula top bar, shared by the admin pages (NebulaTopbar) and a person's
// own pages (components/user/PersonTopbar): logo, rows of nav pills that
// collapse behind a hamburger once scrolled, and the account button fixed
// bottom-left. Each caller passes its own rows, home address, open/closed
// state for the collapsed nav, and account button - so the two bars can't
// drift apart. Colors come from the active theme's CSS variables.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ComponentType, Fragment, ReactNode, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { SlickSyncLogo } from '@/components/ui/SlickSyncLogo';
import { ScrollRow } from '@/components/ui/ScrollRow';

// Matches Sidebar.tsx's isItemActive exactly - a sub-route (e.g.
// /catalogs/[id] or /catalogs/nuvio-collections) should keep its parent nav
// item ("Catalogs") lit up too, not just an exact pathname match. "/" stays
// exact-only or every route would light up Dashboard.
function isNavItemActive(pathname: string, href: string, homeHref = '/') {
  if (href === homeHref) return pathname === homeHref;
  return pathname === href || pathname.startsWith(href + '/');
}

export type NebulaNavSection = {
  id: string;
  items: { href: string; label: string; icon: ComponentType<{ className?: string }> }[];
};

/**
 * The Nebula top bar itself - logo, rows of nav pills that collapse behind a
 * hamburger once scrolled, and the account button fixed bottom-left - shared
 * by the admin pages (NebulaTopbar below) and a person's own pages
 * (components/user/PersonTopbar), so the two can't drift apart. Each passes
 * its own nav rows, home address, open/closed state for the collapsed nav,
 * and account button.
 */
export function NebulaBar({
  sections,
  homeHref,
  menu,
  account,
}: {
  sections: NebulaNavSection[];
  homeHref: string;
  menu: { isOpen: boolean; onOpen: () => void; onClose: () => void };
  account: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isTV = useIsTV();
  // Reuses the same open/close state Original layout's Sidebar drawer
  // already gets from AdminClientLayout - the two never render at once
  // (Sidebar is hidden on exactly the pages that render this component
  // instead), so there's no conflict, just one shared "is the mobile nav
  // open" flag instead of a second one. Previously the nav rows rendered
  // inline unconditionally on every screen size, which meant two full rows
  // of pills permanently eating space above the fold on a phone, worse
  // once the topbar went sticky - now collapsed behind the hamburger on
  // mobile, same pattern Original layout already uses.
  const { isOpen: mobileNavOpen, onOpen: openMobileNav, onClose: closeMobileNav } = menu;
  // Desktop: nav shows inline at the top of the page same as always, but
  // collapses behind the same hamburger mobile uses once you scroll down -
  // a permanently-pinned full nav row the whole time you scroll read as
  // clutter (the original ask behind the mobile collapse applies here too,
  // it just took a sticky nav for anyone to notice on desktop). Threshold
  // above 0 so it doesn't flicker right at the top from sub-pixel scroll.
  // Not tracked at all on TV - see the navVisible/hamburger comments below
  // for why TV never collapses the nav in the first place; no reason to
  // even listen for scroll events (which fire constantly there as a side
  // effect of D-pad focus movement, not user intent) if nothing reads them.
  const [isScrolled, setIsScrolled] = useState(false);
  useEffect(() => {
    if (isTV) return;
    // Two thresholds, not one. A single cutoff (the old `scrollY > 24`)
    // oscillates right at the boundary: collapsing hides the nav rows, the
    // document gets SHORTER, the browser clamps scrollY back down, that
    // re-crosses the same cutoff, the nav expands, the document grows, and
    // round it goes - felt as the bar getting "stuck" fighting itself while
    // you scroll away from the top. The gap between the two thresholds is
    // wider than the height the collapse removes, so crossing one can never
    // bounce you back across the other. rAF-coalesced so a fast wheel flick
    // sets state once per frame, not once per scroll event.
    // Gap must exceed the nav rows' full height (~100px on desktop) so a
    // collapse-induced scroll clamp can never land back past the expand
    // threshold - the earlier 96/12 pair did not clear that bar. Scroll
    // anchoring, the other half of the bounce, is disabled in globals.css.
    const COLLAPSE_AT = 160;
    const EXPAND_AT = 8;
    let collapsed = window.scrollY > COLLAPSE_AT;
    let raf = 0;
    setIsScrolled(collapsed);
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const y = window.scrollY;
        const next = collapsed ? y > EXPAND_AT : y > COLLAPSE_AT;
        if (next !== collapsed) {
          collapsed = next;
          setIsScrolled(next);
        }
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', onScroll); };
  }, [isTV]);
  // Scrolling back to top should always reveal the full nav again, even if
  // it was left open from a scrolled-down state - closing here means
  // navVisible's `!isScrolled` branch below doesn't have to fight a stale
  // "open" flag once the collapse condition itself goes away.
  useEffect(() => {
    if (!isScrolled) closeMobileNav();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScrolled]);

  return (
    <>
      {/* Account/profile access, fixed bottom-left, on every viewport size -
          mirrors where the sidebar's own "Administrator" panel switcher
          lives in Current mode (bottom of the nav). Deliberately
          viewport-fixed (not part of the page's own scrolling content) so
          it stays reachable while scrolling, the same way Current's sidebar
          version always stays on screen. An earlier attempt moved this into
          the top row specifically on mobile to dodge a content-overlap bug
          on short pages, but that traded away the "always there" behavior
          this is for - reverted. dropdownPosition="up" (the default) is
          correct since this sits at the BOTTOM of the screen. */}
      <div className="fixed bottom-4 left-4 md:bottom-6 md:left-6 z-40 flex flex-col items-start gap-2">
        {/* TorBox referral used to float here as its own pill above the
            panel switcher - needed its own size/position pass on every
            layout and viewport, and still read inconsistently across
            deployments (different builds landing on different versions of
            that positioning). Moved into the panel switcher's own dropdown
            ("System" group, alongside Tasks/Settings/Themes/Changelog) - one
            stable spot instead of a floating badge. */}
        <div
          className="rounded-2xl p-1.5"
          style={{
            background: 'color-mix(in srgb, var(--color-surface) 80%, transparent)',
            backdropFilter: 'blur(18px)',
            WebkitBackdropFilter: 'blur(18px)',
            border: '1px solid var(--color-surface-border)',
            boxShadow: '0 8px 24px -8px rgba(0,0,0,0.5)',
          }}
        >
          {account}
        </div>
      </div>
    {/* Sticky, not the page's own scrolling content - previously scrolled
        away with everything else, so reaching another page (or even
        Movies/Series, Watchlist, etc. on Discover) meant scrolling all the
        way back to the top first. z-30 keeps it under the account switcher
        (z-40, fixed bottom-left) and under the bell's own dropdown (z-50)
        so neither gets covered. No background on this wrapper - only the
        inner rounded card has one (with its own blur), so scrolled content
        stays visible through the padding gaps around it instead of being
        hidden behind a solid block. */}
    {/* data-nebula-topbar: TopbarActions measures this element's bottom edge
        to know when the page heading has scrolled under the nav, which is
        when its cluster docks in the logo row. Read at scroll time rather
        than hardcoded because this bar's height changes - it collapses its
        nav links into a hamburger once scrolled. */}
    <div
      data-nebula-topbar
      className={isTV ? 'px-4 pt-2 pb-2 sticky top-0 z-30' : 'px-4 pt-4 md:px-6 md:pt-6 pb-4 sticky top-0 z-30'}
    >
      {/* Caps the bar so it reads as a floating island on wide desktop
          viewports instead of stretching edge-to-edge into empty space -
          but scales with the viewport (min() against 92vw) instead of a
          flat 72rem, which left most of a real wide monitor's width
          unused and, worse, paradoxically made grid cards elsewhere in the
          app NARROWER at full window width than at half-width (Tailwind's
          grid-cols-N breakpoints key off viewport width, not this capped
          container's actual width, so a wider viewport was picking a
          higher column count within the exact same ~72rem box). Set
          inline, not via the max-w-6xl class - globals.css has a global
          `* { max-width: 100vw }` (unlayered, so it beats ANY Tailwind
          utility class regardless of specificity per the CSS Cascade
          Layers spec) that silently no-ops every max-w-* class in the
          app. An inline style always wins over both. */}
      <div
        className={isTV ? 'mx-auto rounded-2xl p-2' : 'mx-auto rounded-3xl p-5 md:p-6'}
        style={{
          maxWidth: 'min(120rem, 92vw)',
          background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)',
          backdropFilter: 'blur(18px)',
          WebkitBackdropFilter: 'blur(18px)',
          border: '1px solid var(--color-surface-border)',
        }}
      >
        {/* Just the centered logo now - notifications and any page-specific
            controls (Sync All, period pickers, etc.) moved out of here and
            onto each page's own title row instead (see NebulaPageHeading
            below), matching where Current's own Header component puts them.
            That also means this row no longer has to fit a bell, a page
            action, and the account button alongside the wordmark, which
            never reliably worked on a phone regardless of how far each
            piece got shrunk - it's just the logo now, so nothing to shrink
            for or stack rows over on any screen size.
            TV: forced to the md: breakpoint by the fixed 1920px viewport
            (useTVViewport), so without an explicit override this rendered
            at full desktop size - logo, wordmark, padding, both nav rows -
            permanently pinned at the top. Confirmed live: read as "hard to
            see anything, in the way" while browsing. Compact sizing here is
            TV-only and independent of the D-pad reachability fix (scroll-
            padding-top in TVPageProvider) - this is purely about how much
            screen real estate the bar eats, not whether focus can reach it. */}
        {/* data-nebula-logo-row: TopbarActions docks the command palette and
            bell inside this row, at the far end from the hamburger, once the
            page heading scrolls past, instead of floating them over the page
            under the bar. */}
        <div data-nebula-logo-row className={isTV ? 'relative flex items-center justify-center gap-2 mb-1.5' : 'relative flex items-center justify-center gap-2 md:gap-4 mb-4'}>
          {/* Hamburger - never on TV (nav is always shown inline there
              instead, see navVisible below); on mobile AND desktop alike,
              only once scrolled - nav shows inline at the top of the page
              on both, same as Original layout's Sidebar toggle icon/shared
              open state. Previously mobile was hamburger-only regardless of
              scroll position, unlike desktop's "visible at top, hides on
              scroll" - confirmed as an explicit inconsistency to fix, not a
              deliberate design choice. Absolutely positioned so the logo
              stays genuinely centered either way, rather than the
              hamburger's own width pushing it off-center. */}
          {!isTV && isScrolled && (
            <button
              onClick={() => (mobileNavOpen ? closeMobileNav() : openMobileNav())}
              className="absolute left-0 p-2 rounded-lg hover:bg-surface-hover transition-colors"
              aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileNavOpen}
            >
              {mobileNavOpen ? (
                <XMarkIcon className="w-6 h-6" style={{ color: 'var(--color-text)' }} />
              ) : (
                <Bars3Icon className="w-6 h-6" style={{ color: 'var(--color-text)' }} />
              )}
            </button>
          )}
          <Link href={homeHref} className={isTV ? 'flex items-center gap-2 justify-center min-w-0' : 'flex items-center gap-2 md:gap-4 justify-center min-w-0'}>
            <div
              className={isTV ? 'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0' : 'w-10 h-10 md:w-16 md:h-16 rounded-2xl flex items-center justify-center flex-shrink-0'}
              style={{
                background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))',
                boxShadow: '0 8px 28px -6px var(--color-primary)',
              }}
            >
              <SlickSyncLogo className={isTV ? 'w-4 h-4' : 'w-7 h-7 md:w-11 md:h-11'} />
            </div>
            <b
              className={isTV ? 'text-sm font-bold font-display tracking-tight whitespace-nowrap' : 'text-xl md:text-4xl font-bold font-display tracking-tight whitespace-nowrap'}
              style={{
                background: 'linear-gradient(135deg, var(--color-text) 0%, var(--color-primary) 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              SlickSync
            </b>
          </Link>
        </div>
        {/* TV: always shown inline, collapse behavior disabled entirely -
            confirmed live this was actively broken on a real TV. Scrolling
            there only ever happens as a side effect of TVFocusable's
            scrollIntoView when D-pad focus moves, never a deliberate user
            gesture, so treating any scroll as "collapse the nav" collapsed
            it constantly during ordinary navigation - and since the
            hamburger button itself was never wired as D-pad-focusable,
            once collapsed there was no way to reach it with a remote at
            all. The collapse/expand DOM churn (AnimatePresence mounting
            and unmounting the whole nav) also looked like it was fighting
            TVPageProvider's focus tracking, causing the "snaps back to
            top" symptom. Mobile and desktop now share the exact same rule:
            shown inline while at the top of the page, collapses behind the
            hamburger once scrolled, regardless of viewport size. */}
        {(() => {
          const navVisible = isTV ? true : (isScrolled ? mobileNavOpen : true);
          return (
            <AnimatePresence initial={false}>
              {navVisible && (
                <motion.nav
                  initial={isScrolled ? { height: 0, opacity: 0 } : false}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  className={isTV ? 'flex flex-col items-center gap-1 pt-1.5 overflow-hidden' : 'flex flex-col items-center gap-3 pt-4 overflow-hidden'}
                  style={{ borderTop: '1px solid var(--color-surface-border)' }}
                >
                  {sections.map((section) => (
            // Each section is its own row, same as Sidebar.tsx's vertical
            // stack of groups - spacing alone marks the grouping, no text
            // label above either row. flex-nowrap + overflow-x-auto instead
            // of flex-wrap: on a narrow phone width, wrapping split a row of
            // 4-5 pills across 2-3 uneven lines (one item stranded alone on
            // its own line) - a swipeable row reads far better than that.
            // nebula-nav-row (globals.css) centers the row when it fits
            // (desktop, and most phones for the 4-item Overview row) but
            // falls back to start-alignment when it overflows, so every
            // item stays reachable by swiping right - see that rule's own
            // comment for why this can't be a Tailwind justify-* class.
            <ScrollRow
              key={section.id}
              className={isTV ? 'flex flex-nowrap items-center gap-1.5 w-full px-1 -mx-1 nebula-nav-row' : 'flex flex-nowrap items-center gap-2 w-full px-1 -mx-1 nebula-nav-row'}
            >
              {section.items.map((link) => {
                const isActive = isNavItemActive(pathname, link.href, homeHref);
                const Icon = link.icon;
                const navLink = (
                  <Link
                    href={link.href}
                    tabIndex={isTV ? -1 : undefined}
                    onClick={closeMobileNav}
                    className={isTV ? 'nav-item-hover-pill flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap' : 'nav-item-hover-pill flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-full whitespace-nowrap'}
                    style={
                      isActive
                        ? {
                            color: '#fff',
                            background:
                              'linear-gradient(90deg, color-mix(in srgb, var(--color-primary) 55%, transparent), color-mix(in srgb, var(--color-secondary) 30%, transparent))',
                            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 40%, transparent)',
                          }
                        : { color: 'var(--color-text-muted)' }
                    }
                  >
                    <Icon className={isTV ? 'w-3.5 h-3.5 shrink-0' : 'w-4 h-4 shrink-0'} />
                    {link.label}
                  </Link>
                );
                // This row previously had no D-pad wiring at all - Up out of
                // a page's own TV content had nowhere to go, which is why
                // switching pages (or getting back to one) was impossible on
                // an actual TV. onEnterPress navigates imperatively since
                // Norigin fires a synthetic "press", not a real click the
                // anchor's own href would otherwise handle.
                // Keyed on pathname too (not just href) so every link gets a
                // brand-new DOM node on each route change, not just a
                // restyle of the same persistent one. Confirmed live
                // (Firefox, desktop): after hoisting this whole component to
                // persist across navigation (previously remounted fresh on
                // every page - see the component's own top-level comment),
                // several previously-clicked pills stayed visually "active"
                // at once instead of just the current page - a real Firefox
                // quirk where a persistent element's :hover doesn't always
                // get re-evaluated when its own styling changes without a
                // fresh native mousemove. A pointer-events toggle attempted
                // first wasn't reliable enough. Forcing a fresh element per
                // navigation sidesteps the whole class of "stale browser-
                // internal state survives because the DOM node survives"
                // bug outright, rather than trying to name every event that
                // could trigger it.
                return isTV ? (
                  <TVFocusable key={`${link.href}-${pathname}`} onEnterPress={() => router.push(link.href)}>
                    {navLink}
                  </TVFocusable>
                ) : (
                  <Fragment key={`${link.href}-${pathname}`}>{navLink}</Fragment>
                );
              })}
            </ScrollRow>
          ))}
                </motion.nav>
              )}
            </AnimatePresence>
          );
        })()}
      </div>
    </div>
    </>
  );
}
