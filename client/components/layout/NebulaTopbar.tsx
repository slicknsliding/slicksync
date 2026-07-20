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

export function NebulaTopbar({ actions }: { actions?: ReactNode }) {
  const pathname = usePathname();
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
      {/* Account/profile access, fixed bottom-left - mirrors where the
          sidebar's own "Administrator" panel switcher lives in Current mode
          (bottom of the nav), rather than sitting in the topbar's action
          row up top. dropdownPosition="up" (the default) is correct again
          here since this sits at the BOTTOM of the screen.
          Desktop only (hidden below md): on a short mobile page (few stat
          cards, no scrolling needed) this fixed-position button sat right on
          top of whatever content happened to render at that same
          bottom-left screen position - there's no page-content padding that
          reliably clears a viewport-fixed element across every page's
          differing content height. Below md it moves into the top row
          instead (see the mobile-only trigger further down), which is
          proper document flow and can never overlap anything. */}
      <div className="hidden md:block fixed bottom-4 left-4 md:bottom-6 md:left-6 z-40">
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
        {/* Stacked (logo row, then actions row) on mobile instead of one
            1fr/auto/1fr grid row - squeezing the logo plus bell + a page
            action + the account button all onto one row never fit on a
            phone regardless of how far each individual piece got shrunk,
            since a wordmark, an icon button, and a page-specific control
            (some pages pass a whole <select>) all have their own minimum
            width that can't shrink further without becoming unreadable or
            unusable. Each row gets the FULL width to itself below md, so
            there's no contention at all; reverts to the original single-row
            grid from md up, where there's genuine room. */}
        <div className="flex flex-col md:grid md:grid-cols-[1fr_auto_1fr] items-center gap-2 mb-4">
          <span aria-hidden className="hidden md:block" />
          <Link href="/" className="flex items-center gap-2 md:gap-4 justify-center min-w-0 md:order-2">
            {/* Smaller on mobile - even with its own row now, full desktop
                size read as oversized on a phone-width screen. */}
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
          <div className="flex items-center justify-center flex-wrap gap-2 md:justify-self-end md:order-3">
            <NotificationsDropdown activities={[]} inviteHistory={[]} taskHistory={[]} />
            {actions}
            {/* Mobile-only counterpart to the fixed bottom-left button above
                (hidden below md there) - sits in normal document flow here,
                so it can never overlap page content the way a viewport-fixed
                element could on a short page. Last in this row (not first)
                so it sits flush against the true right edge of the screen,
                same edge assumption the bottom-left trigger relies on -
                align="right" (the default) anchors the dropdown's right edge
                to the TRIGGER's right edge and extends leftward, which only
                stays on-screen on a narrow viewport when that edge is close
                to the real screen edge. dropdownPosition="down" since this
                is in the TOP row, not the bottom. */}
            <div className="md:hidden">
              <PanelSwitcher
                mode="admin"
                userInfo={accountInfo}
                onLogout={handleLogout}
                variant="compact"
                dropdownPosition="down"
              />
            </div>
          </div>
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
            // its own line) - a horizontal swipe reads far better than that.
            // justify-start (the default), not -center, so a row wider than
            // the viewport starts flush left with its overflow predictably
            // off to the right, rather than centering the overflow and
            // hiding an equal, unreachable-feeling sliver on both edges.
            <div
              key={section.id}
              className="flex flex-nowrap items-center gap-2 w-full overflow-x-auto no-scrollbar px-1 -mx-1"
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
