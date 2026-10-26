'use client';

// The Nebula top bar, shared by the admin pages (NebulaTopbar) and a person's
// own pages (components/user/PersonTopbar): one row with the logo, the links
// and the account picture at the right end. Under 1280px wide (and on a wide
// screen once you have scrolled) the links sit behind a menu button instead.
// Each caller passes its own rows, home address, open/closed state for that
// menu, and account button - so the two bars can't drift apart. Where the
// account button sits (in the bar, or floating bottom-left) is the person's
// choice in Settings -> Themes; colors come from the active theme's CSS
// variables.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ComponentType, Fragment, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { AccountPlacementContext, useAccountPlacement } from '@/lib/layout-mode';
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
 * The Nebula top bar itself, shared by the admin pages (NebulaTopbar) and a
 * person's own pages (components/user/PersonTopbar), so the two can't drift
 * apart. Each passes its own nav rows, home address, open/closed state for
 * the menu, and account button.
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
  const reduceMotion = useReducedMotion();
  const navId = useId();
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // The bar is the top-bar layout's; its account choice is the Top Navi one
  // (a person's own pages always use this bar too). TV is always 'bar'.
  const placement = useAccountPlacement('nebula');
  // Reuses the same open/close state Original layout's Sidebar drawer
  // already gets from AdminClientLayout - the two never render at once
  // (Sidebar is hidden on exactly the pages that render this component
  // instead), so there's no conflict, just one shared "is the menu
  // open" flag instead of a second one.
  const { isOpen: menuOpen, onOpen: openMenu, onClose: closeMenu } = menu;
  // Wide screens: links sit inline in the bar at the top of the page, and
  // collapse behind the menu button once you scroll down - a permanently-
  // pinned full set of links the whole time you scroll read as clutter.
  // Narrower than 1280px the links are behind the button at every scroll
  // position; that part is CSS (min-[1280px]), not state, so the bar is right
  // on the very first paint instead of showing every link for a frame on a
  // phone. Not tracked at all on TV - nav is always inline there, and scroll
  // events fire constantly as a side effect of D-pad focus movement, not
  // user intent, so there is nothing to read them for.
  const [isScrolled, setIsScrolled] = useState(false);
  useEffect(() => {
    if (isTV) return;
    // Two thresholds, not one. A single cutoff oscillates right at the
    // boundary: the bar changes, the document height changes, the browser
    // clamps scrollY back down, that re-crosses the same cutoff, and round it
    // goes - felt as the bar getting "stuck" fighting itself while you scroll
    // away from the top. The gap between the two thresholds is wider than
    // anything a change can move, so crossing one can never bounce you back
    // across the other. rAF-coalesced so a fast wheel flick sets state once
    // per frame, not once per scroll event. Scroll anchoring, the other half
    // of the bounce, is disabled in globals.css.
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
  // Scrolling back to top should always reveal the inline links again, even
  // if the menu was left open from a scrolled-down state.
  useEffect(() => {
    if (!isScrolled) closeMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScrolled]);

  // While the menu is open: Escape closes it and hands focus back to its
  // button, and so does a press anywhere outside the bar. pointerdown, not
  // mousedown - iOS Safari sends no mouse events for a tap on something that
  // isn't itself clickable.
  useEffect(() => {
    if (!menuOpen || isTV) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      closeMenu();
      menuButtonRef.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen, isTV, closeMenu]);

  const showInline = isTV || !isScrolled;
  // Menu button: always under 1280px, and on a wide screen once scrolled.
  const showMenuButton = !isTV;

  // This row previously had no D-pad wiring at all - Up out of a page's own
  // TV content had nowhere to go, which is why switching pages (or getting
  // back to one) was impossible on an actual TV. onEnterPress navigates
  // imperatively since Norigin fires a synthetic "press", not a real click
  // the anchor's own href would otherwise handle.
  // Keyed on pathname too (not just href) so every link gets a brand-new DOM
  // node on each route change, not just a restyle of the same persistent
  // one. Confirmed live (Firefox, desktop): with the bar persisting across
  // navigation, several previously-clicked pills stayed visually "active" at
  // once instead of just the current page - a real Firefox quirk where a
  // persistent element's :hover doesn't always get re-evaluated when its own
  // styling changes without a fresh native mousemove. Forcing a fresh element
  // per navigation sidesteps the whole class of "stale browser-internal state
  // survives because the DOM node survives" bug outright.
  const renderLink = (link: NebulaNavSection['items'][number], size: 'inline' | 'menu' | 'tv') => {
    const isActive = isNavItemActive(pathname, link.href, homeHref);
    const Icon = link.icon;
    const sizeClass =
      size === 'tv' ? 'gap-1 text-xs px-2.5 py-1'
      : size === 'menu' ? 'gap-2 text-sm px-4 py-2.5 min-h-11'
      : 'gap-1.5 text-[13px] px-3 py-2 min-h-10';
    const iconClass =
      size === 'tv' ? 'w-3.5 h-3.5 shrink-0'
      : size === 'menu' ? 'w-4 h-4 shrink-0'
      // Narrower than ~1536px the ten links need the room more than the icons.
      : 'w-4 h-4 shrink-0 hidden min-[1536px]:block';
    const navLink = (
      <Link
        href={link.href}
        tabIndex={isTV ? -1 : undefined}
        onClick={closeMenu}
        aria-current={isActive ? 'page' : undefined}
        className={`nav-item-hover-pill flex items-center font-semibold rounded-full whitespace-nowrap ${sizeClass} ${isActive ? 'text-primary bg-primary-muted' : 'text-muted'}`}
      >
        <Icon className={iconClass} />
        {link.label}
      </Link>
    );
    return isTV ? (
      <TVFocusable key={`${link.href}-${pathname}`} onEnterPress={() => router.push(link.href)}>
        {navLink}
      </TVFocusable>
    ) : (
      <Fragment key={`${link.href}-${pathname}`}>{navLink}</Fragment>
    );
  };

  return (
    <AccountPlacementContext.Provider value={placement}>
      {/* Choice B: the account pill floats bottom-left on every viewport
          size, over the page (not part of its scrolling content) so it stays
          reachable while scrolling. Solid surface - there is nothing for a
          blur to show but the page scrolling past. dropdownPosition="up" is
          correct since this sits at the BOTTOM of the screen. */}
      {placement === 'float' && (
        <div className="fixed bottom-4 left-4 md:bottom-6 md:left-6 z-40 flex flex-col items-start gap-2">
          <div
            className="rounded-2xl p-1.5"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-surface-border)',
              boxShadow: '0 8px 24px -8px rgba(0,0,0,0.5)',
            }}
          >
            {account}
          </div>
        </div>
      )}
      {/* Sticky, not the page's own scrolling content - previously scrolled
          away with everything else, so reaching another page meant scrolling
          all the way back to the top first. z-30 keeps it under the floating
          account pill (z-40) and under the bell's own dropdown (z-50) so
          neither gets covered. No background on this wrapper - only the
          inner rounded card has one (with its own blur), so scrolled content
          stays visible through the padding gaps around it.
          data-nebula-topbar: TopbarActions measures this element's bottom
          edge to know when the page heading has scrolled under the bar,
          which is when its cluster docks in the row. Read at scroll time
          rather than hardcoded because the bar's height changes when its
          menu opens. */}
      <header
        ref={headerRef}
        data-nebula-topbar
        className={isTV ? 'px-4 pt-2 pb-2 sticky top-0 z-30' : 'px-4 py-3 md:px-6 md:py-4 sticky top-0 z-30'}
      >
        {/* Caps the bar so it reads as a floating island on wide desktop
            viewports instead of stretching edge-to-edge into empty space -
            but scales with the viewport (min() against 92vw) instead of a
            flat width. Set inline, not via a max-w-* class - globals.css has a
            global `* { max-width: 100vw }` (unlayered, so it beats ANY
            Tailwind utility class) that silently no-ops every max-w-* class
            in the app. An inline style always wins over both. */}
        <div
          // nebula-bar-panel: solid on touch screens (globals.css), where the blur is off.
          className={isTV ? 'nebula-bar-panel mx-auto rounded-2xl px-3 py-1.5' : 'nebula-bar-panel mx-auto rounded-[22px] py-2 pl-3 pr-2 md:pl-4 md:pr-3'}
          style={{
            maxWidth: 'min(120rem, 92vw)',
            background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)',
            backdropFilter: 'blur(18px)',
            WebkitBackdropFilter: 'blur(18px)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          {/* data-nebula-logo-row: the one row - TopbarActions docks the
              command palette and bell inside it, just left of
              data-nebula-end (menu button + account), once the page heading
              scrolls past and the inline links are gone. */}
          <div data-nebula-logo-row className={isTV ? 'relative flex items-center gap-3' : 'relative flex items-center gap-3 md:gap-4'}>
            <Link
              href={homeHref}
              aria-label="SlickSync home"
              className={isTV ? 'flex items-center gap-2 min-w-0 shrink-0' : 'flex items-center gap-2.5 min-w-0 shrink-0'}
            >
              <div
                className={isTV ? 'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0' : 'w-9 h-9 md:w-10 md:h-10 rounded-xl flex items-center justify-center flex-shrink-0'}
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))',
                  boxShadow: '0 6px 18px -6px var(--color-primary)',
                }}
              >
                <SlickSyncLogo className={isTV ? 'w-4 h-4' : 'w-6 h-6 md:w-7 md:h-7'} />
              </div>
              <b
                className={isTV ? 'text-sm font-bold font-display tracking-tight whitespace-nowrap' : 'text-lg md:text-xl font-bold font-display tracking-tight whitespace-nowrap'}
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

            {/* Inline links. data-nebula-inline-nav lets TopbarActions tell
                whether they are showing (it only docks once they are not).
                Hidden under 1280px by CSS; TV always shows them. */}
            {showInline && (
              <nav
                data-nebula-inline-nav
                aria-label="Main navigation"
                className={`${isTV ? 'flex' : 'hidden min-[1280px]:flex'} min-w-0 flex-1`}
              >
                <ScrollRow
                  className={`flex flex-nowrap items-center ${isTV ? 'gap-1' : 'gap-0.5'} w-full min-w-0 px-1 -mx-1 [justify-content:safe_flex-end]`}
                >
                  {sections.flatMap((section) => section.items).map((link) => renderLink(link, isTV ? 'tv' : 'inline'))}
                </ScrollRow>
              </nav>
            )}

            <div data-nebula-end className="ml-auto flex items-center gap-1 shrink-0">
              {/* Menu button - never on TV (links are always inline there).
                  On a wide screen it only appears once the inline links have
                  collapsed. */}
              {showMenuButton && (
                <button
                  ref={menuButtonRef}
                  type="button"
                  onClick={() => (menuOpen ? closeMenu() : openMenu())}
                  className={`${isScrolled ? '' : 'min-[1280px]:hidden'} p-2.5 rounded-xl hover:bg-surface-hover transition-colors`}
                  aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                  aria-expanded={menuOpen}
                  aria-controls={navId}
                >
                  {menuOpen ? (
                    <XMarkIcon className="w-6 h-6" style={{ color: 'var(--color-text)' }} />
                  ) : (
                    <Bars3Icon className="w-6 h-6" style={{ color: 'var(--color-text)' }} />
                  )}
                </button>
              )}
              {placement === 'bar' && <div data-nebula-account>{account}</div>}
            </div>
          </div>

          {/* The menu: every link, opened from the button. Fades in - it does
              not animate its height, which kept a stale measured value across
              a reload or hydration and left the panel the wrong size. Under
              1280px always, on a wide screen only once scrolled (otherwise the
              links are inline above). */}
          <AnimatePresence initial={false}>
            {menuOpen && !isTV && (
              <motion.nav
                id={navId}
                aria-label="Main navigation"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.15, ease: 'easeOut' }}
                className={isScrolled ? '' : 'min-[1280px]:hidden'}
              >
                <div
                  className="flex flex-col gap-3 mt-2 pt-3 max-h-[calc(100dvh-7rem)] overflow-y-auto"
                  style={{ borderTop: '1px solid var(--color-surface-border)' }}
                >
                  {sections.map((section) => (
                    <div key={section.id} className="flex flex-wrap gap-1.5">
                      {section.items.map((link) => renderLink(link, 'menu'))}
                    </div>
                  ))}
                </div>
              </motion.nav>
            )}
          </AnimatePresence>
        </div>
      </header>
    </AccountPlacementContext.Provider>
  );
}
