'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import {
  HomeIcon,
  MagnifyingGlassIcon,
  ClockIcon,
  ChartBarIcon,
  UsersIcon,
  UserGroupIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  EnvelopeIcon,
} from '@heroicons/react/24/outline';
import { NotificationsDropdown } from '@/components/ui/NotificationsDropdown';
import { PanelSwitcher } from './PanelSwitcher';
import { SlickSyncLogo } from '@/components/ui/SlickSyncLogo';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

// Replaces the sidebar for pages rendering Nebula layout mode (see
// lib/layout-mode.tsx's NEBULA_ELIGIBLE_PATHS) - brand sits on its own row
// above the nav, not inline with it, matching the approved concept mockup.
// Colors come from the active Theme's CSS variables, not hardcoded hex, so
// this looks right regardless of which color theme is selected - layout and
// color are independent settings.
// Overview / Management groups mirror Sidebar.tsx's navigationSections and
// its per-item icons - kept in sync manually since one is a flat pill row
// and the other a vertical list, too different to share a single data
// structure cleanly. No group labels ("Overview"/"Management" text) - just
// the two rows of icon+label pills, spacing alone marks the grouping.
// Sidebar's third group (System: Tasks/Settings/Changelog) is deliberately
// NOT here - those three live only in the account dropdown (PanelSwitcher)
// now, since the topbar has no room to spare and that dropdown is already
// the natural "everything about this admin session" spot.
const NEBULA_NAV_SECTIONS = [
  {
    id: 'overview',
    items: [
      { href: '/', label: 'Dashboard', icon: HomeIcon },
      { href: '/discover', label: 'Discover', icon: MagnifyingGlassIcon },
      { href: '/activity', label: 'Activity', icon: ClockIcon },
      { href: '/metrics', label: 'Metrics', icon: ChartBarIcon },
    ],
  },
  {
    id: 'management',
    items: [
      { href: '/users', label: 'Users', icon: UsersIcon },
      { href: '/groups', label: 'Groups', icon: UserGroupIcon },
      { href: '/addons', label: 'Addons', icon: PuzzlePieceIcon },
      { href: '/vault', label: 'Vault', icon: ShieldCheckIcon },
      { href: '/invitations', label: 'Invitations', icon: EnvelopeIcon },
    ],
  },
];

export function NebulaTopbar() {
  const pathname = usePathname();
  // Gates which of the two possible NotificationsDropdown locations (fixed
  // top-right here vs inline in NebulaPageHeading's actions row) actually
  // mounts the component - see the comment on that div below for why a
  // second location exists at all. Deliberately a real conditional render,
  // not a CSS hidden/block toggle: a CSS-hidden instance still fully mounts
  // and runs its own polling effects (api.getInvitations, api.getMetrics),
  // so two CSS-toggled copies meant every page silently doubled those
  // requests. Only one instance actually exists in the DOM at a time now.
  const isMobile = useIsMobile();
  // Mirrors Sidebar.tsx's own account-info fetch - Nebula's topbar had no
  // equivalent of the sidebar's bottom "Administrator" panel switcher at
  // all, so there was no way to see who's logged in, switch to the User
  // panel, or log out from this layout.
  const [accountInfo, setAccountInfo] = useState<{ username?: string; email?: string | null; uuid?: string | null; avatarUrl?: string | null } | null>(null);
  const isPublicInstance = (process.env.NEXT_PUBLIC_INSTANCE_TYPE || 'private') === 'public';

  useEffect(() => {
    api.getAccountStats()
      .then((stats) => {
        const uuid = stats.uuid || null;
        const email = stats.email || null;
        setAccountInfo({
          username: isPublicInstance ? (uuid || email || 'Admin') : 'Administrator',
          email,
          uuid,
          avatarUrl: stats.avatarUrl || null,
        });
      })
      .catch(() => {});
  }, [isPublicInstance]);

  const handleLogout = () => {
    localStorage.removeItem('slicksync-admin-token');
    window.location.href = '/login?mode=admin';
  };

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
      <div className="fixed bottom-4 left-4 md:bottom-6 md:left-6 z-40">
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
          <PanelSwitcher
            mode="admin"
            userInfo={accountInfo}
            onLogout={handleLogout}
            variant="compact"
            align="left"
          />
        </div>
      </div>
      {/* Notifications, fixed top-right, mobile only - the desktop copy
          lives in NebulaPageHeading's actions row as before, which never
          had this problem. Used to live inside each page's own title row on
          every screen size, but that row wraps onto its own line on a
          narrow phone whenever it doesn't fit next to the title, and a
          wrapped line with only one flex item lands at the line's start
          (left edge) rather than the right - stranding the bell near the
          left edge while its dropdown panel (anchored `right-0` off itself)
          shot off past the left edge of the screen, effectively invisible.
          Fixed to a real screen corner on mobile instead of page-content
          flow, so its position can't depend on what else a given page's
          action row happens to wrap around. */}
      {isMobile && (
        <div className="fixed top-4 right-4 z-40">
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
            <NotificationsDropdown />
          </div>
        </div>
      )}
    <div className="px-4 pt-4 md:px-6 md:pt-6">
      {/* Caps the bar at 72rem so it reads as a floating island on wide
          desktop viewports instead of stretching edge-to-edge into empty
          space. Set inline, not via the max-w-6xl class - globals.css has a
          global `* { max-width: 100vw }` (unlayered, so it beats ANY
          Tailwind utility class regardless of specificity per the CSS
          Cascade Layers spec) that silently no-ops every max-w-* class in
          the app. An inline style always wins over both. */}
      <div
        className="mx-auto rounded-3xl p-5 md:p-6"
        style={{
          maxWidth: '72rem',
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
            for or stack rows over on any screen size. */}
        <div className="flex items-center justify-center gap-2 md:gap-4 mb-4">
          <Link href="/" className="flex items-center gap-2 md:gap-4 justify-center min-w-0">
            <div
              className="w-10 h-10 md:w-16 md:h-16 rounded-2xl flex items-center justify-center flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))',
                boxShadow: '0 8px 28px -6px var(--color-primary)',
              }}
            >
              <SlickSyncLogo className="w-7 h-7 md:w-11 md:h-11" />
            </div>
            <b
              className="text-xl md:text-4xl font-bold font-display tracking-tight whitespace-nowrap"
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
        <nav
          className="flex flex-col items-center gap-3 pt-4"
          style={{ borderTop: '1px solid var(--color-surface-border)' }}
        >
          {NEBULA_NAV_SECTIONS.map((section) => (
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
            <div
              key={section.id}
              className="flex flex-nowrap items-center gap-2 w-full overflow-x-auto no-scrollbar px-1 -mx-1 nebula-nav-row"
            >
              {section.items.map((link) => {
                const isActive = pathname === link.href;
                const Icon = link.icon;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="nav-item-hover-pill flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-full whitespace-nowrap"
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
                    <Icon className="w-4 h-4 shrink-0" />
                    {link.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </div>
    </div>
    </>
  );
}

// Each page's title row - page-specific controls (Sync All, a period
// picker, a group filter, etc.) live here now, to the right of the title,
// the same spot Current's own <Header> puts its actions - not in the shared
// topbar above, which has no room to spare once you account for every
// page's differing actions, and whose own crowding fixes kept getting
// undone by the fact that content was living in the wrong place to begin
// with. flex-wrap so actions drop to their own line below the title on a
// narrow screen rather than fighting it for space. Notifications stays here
// on desktop (gated by the same useIsMobile() check as NebulaTopbar's fixed
// copy, so exactly one of the two ever actually mounts - not a CSS
// hidden/block toggle, which would mount both and double their polling),
// but not on mobile, in favor of a fixed top-right copy in NebulaTopbar
// above - see that component for why; desktop never had that problem so it
// keeps its original spot.
export function NebulaPageHeading({
  title,
  subtitle,
  actions,
  stats,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Compact inline KPI strip (see NebulaHeaderStats) - sits centered
      between the title and actions on desktop (where justify-between
      naturally puts a 3rd flex child), drops to its own full-width
      centered row below them on mobile since it can't share a row with
      both without crowding - a page-specific opt-in replacement for a
      full NebulaStatCard grid when the stats are secondary context, not
      the page's main content (see the Addons page for the first use). */
  stats?: ReactNode;
}) {
  const isMobile = useIsMobile();
  return (
    <div className="mb-6 flex items-start justify-between gap-x-4 gap-y-3 flex-wrap">
      <div className="order-1">
        <h1 className="text-2xl font-bold font-display mb-1 text-default">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2 flex-wrap order-2 md:order-3">
        {/* Desktop only - mobile gets a fixed top-right copy in NebulaTopbar
            instead (see above for why). */}
        {!isMobile && <NotificationsDropdown />}
        {actions}
      </div>
      {stats && (
        <div className="order-3 md:order-2 w-full md:w-auto flex justify-center">
          {stats}
        </div>
      )}
    </div>
  );
}

// Compact inline KPI strip for NebulaPageHeading's `stats` slot - a row of
// separate NebulaCompactStatCards with a gap between them (same individual-
// card look Groups/Users use in their own stat row), not one shared pill.
// An earlier version used one continuous box with divide-x border lines
// between segments, which read as visually different from - and less
// polished than - the separate-card look everywhere else Nebula's compact
// stats show up.
export function NebulaHeaderStats({
  stats,
}: {
  stats: Array<{ label: string; value: string | number; icon?: ReactNode }>;
}) {
  return (
    <div className="flex items-center gap-2 md:gap-4">
      {stats.map((s, i) => (
        <NebulaCompactStatCard key={s.label} label={s.label} value={s.value} icon={s.icon} colorIndex={i} />
      ))}
    </div>
  );
}

// Shared glass-panel treatment for Nebula-layout cards - gradient top-stripe
// accent (same idea Current's own stat cards already use), translucent
// blurred background. A plain className string, not a component, so callers
// can still control their own padding/layout freely.
export const NEBULA_GLASS_CLASS = 'relative rounded-2xl overflow-hidden';
// 55% opacity (was 66%) - on a long page (e.g. Activity's Watch tab with
// many stacked date-group panels, confirmed 7000px+ tall with real history)
// the corner background glow is `position: fixed`, so it's always present
// at the current viewport's corners regardless of scroll - but panels
// covering nearly the full viewport width left very little exposed
// background for it to show through, and what did reach through a panel
// was further muted by backdropFilter's own blur on top of the glow's
// already-blurred (110px) source. Letting more of the panel go through
// keeps the glow visibly present behind content instead of reading as
// having disappeared once scrolled past the first screenful.
export const nebulaGlassStyle: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--color-surface) 55%, transparent)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  border: '1px solid var(--color-surface-border)',
};

export function NebulaGlassStripe() {
  return (
    <div
      className="absolute top-0 left-0 right-0 h-[2px]"
      style={{ background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }}
    />
  );
}

// Nebula's stat-card equivalent of Current mode's <StatCard> - same
// label/value/icon shape, so other pages can swap between the two based on
// layoutMode without restructuring the surrounding grid. Icon color
// alternates primary/secondary by index so a row of these doesn't read as
// one flat block of a single hue.
export function NebulaStatCard({
  label,
  value,
  icon,
  colorIndex = 0,
}: {
  label: string;
  value: string | number;
  icon?: ReactNode;
  colorIndex?: number;
}) {
  const isPrimary = colorIndex % 2 === 0;
  return (
    <div className={`${NEBULA_GLASS_CLASS} p-5 flex items-center justify-between`} style={nebulaGlassStyle}>
      <NebulaGlassStripe />
      <div>
        <p className="text-sm text-muted mb-1">{label}</p>
        <p className="text-2xl font-bold text-default">{value}</p>
      </div>
      {icon && (
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: isPrimary ? 'var(--color-primary-muted)' : 'var(--color-secondary-muted)',
            color: isPrimary ? 'var(--color-primary)' : 'var(--color-secondary)',
          }}
        >
          {icon}
        </div>
      )}
    </div>
  );
}

// Smaller variant of NebulaStatCard - same glass card + icon-badge
// language, scaled down on mobile so 3-4 of them fit comfortably in one row
// instead of stacking full-width/full-height one per row (the full-size
// NebulaStatCard's p-5 padding and 44px icon badge only really work at 1-2
// per row on a phone; forcing that into 3 columns crammed the icon and
// padding into most of a card's width, leaving barely anything for the
// number). From md up, scales to match Dashboard's own Groups/Addons stat
// cards exactly (p-5, 44px icon, text-3xl value) per explicit request -
// "smaller" was specifically about mobile and the previous full-width-per-
// card layout, not about reading small on desktop too. Built for
// Groups/Users/Metrics.
export function NebulaCompactStatCard({
  label,
  value,
  icon,
  colorIndex = 0,
}: {
  label: string;
  value: string | number;
  icon?: ReactNode;
  colorIndex?: number;
}) {
  const isPrimary = colorIndex % 2 === 0;
  return (
    <div className={`${NEBULA_GLASS_CLASS} p-2.5 sm:p-3 md:p-5 flex items-center gap-2 md:gap-4 min-w-0`} style={nebulaGlassStyle}>
      <NebulaGlassStripe />
      {icon && (
        <div
          className="w-8 h-8 md:w-11 md:h-11 rounded-lg md:rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: isPrimary ? 'var(--color-primary-muted)' : 'var(--color-secondary-muted)',
            color: isPrimary ? 'var(--color-primary)' : 'var(--color-secondary)',
          }}
        >
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-base sm:text-lg md:text-3xl font-bold font-display text-default leading-none truncate">{value}</p>
        <p className="text-[10px] md:text-sm text-muted mt-1 truncate">{label}</p>
      </div>
    </div>
  );
}
