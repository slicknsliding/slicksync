'use client';

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
  RectangleStackIcon,
} from '@heroicons/react/24/outline';
import { TopbarActions } from '@/components/layout/TopbarActions';
import { PanelSwitcher } from './PanelSwitcher';
import { api } from '@/lib/api';
import { useMobileMenu } from '@/app/(admin)/AdminClientLayout';
import { NebulaBar, type NebulaNavSection } from './NebulaBar';

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
// Sidebar's third group (System: Tasks/Settings/Themes/Changelog) is
// deliberately NOT here - those live only in the account dropdown
// (PanelSwitcher) now, since the topbar has no room to spare and that
// dropdown is already the natural "everything about this admin session" spot.
const NEBULA_NAV_SECTIONS: NebulaNavSection[] = [
  {
    id: 'overview',
    items: [
      { href: '/', label: 'Dashboard', icon: HomeIcon },
      { href: '/activity', label: 'Activity', icon: ClockIcon },
      { href: '/metrics', label: 'Metrics', icon: ChartBarIcon },
      { href: '/users', label: 'Users', icon: UsersIcon },
      { href: '/groups', label: 'Groups', icon: UserGroupIcon },
    ],
  },
  {
    id: 'management',
    items: [
      { href: '/discover', label: 'Discover', icon: MagnifyingGlassIcon },
      { href: '/catalogs', label: 'Catalogs', icon: RectangleStackIcon },
      { href: '/addons', label: 'Addons', icon: PuzzlePieceIcon },
      { href: '/vault', label: 'Vault', icon: ShieldCheckIcon },
      { href: '/invitations', label: 'Invitations', icon: EnvelopeIcon },
    ],
  },
];

/** The admin pages' bar: their nav rows, and the admin account button. */
export function NebulaTopbar() {
  // Reuses the same open/close state Original layout's Sidebar drawer
  // already gets from AdminClientLayout - the two never render at once.
  const menu = useMobileMenu();
  // Mirrors Sidebar.tsx's own account-info fetch - Nebula's topbar had no
  // equivalent of the sidebar's bottom "Administrator" panel switcher at
  // all, so there was no way to see who's logged in, switch to the User
  // panel, or log out from this layout.
  const [accountInfo, setAccountInfo] = useState<{ username?: string; email?: string | null; uuid?: string | null; linkedProvider?: 'stremio' | 'nuvio' | null; avatarUrl?: string | null } | null>(null);
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
          linkedProvider: stats.linkedProvider || null,
          avatarUrl: stats.avatarUrl || null,
        });
      })
      .catch(() => {});
  }, [isPublicInstance]);

  // Ends the session on the server too (api.logout) - dropping the local
  // token alone left the cookies, and so the session, alive.
  const handleLogout = async () => {
    await api.logout();
    window.location.href = '/login?mode=admin';
  };

  return (
    <NebulaBar
      sections={NEBULA_NAV_SECTIONS}
      homeHref="/"
      menu={menu}
      account={<PanelSwitcher mode="admin" userInfo={accountInfo} onLogout={handleLogout} variant="compact" align="left" />}
    />
  );
}

// Each page's title row - the title at the left, page-specific controls (Sync
// All, a period picker, a group filter, etc.) at the right of the same line,
// then the command palette and notifications at the far right. The title is
// where the eye starts, and the buttons stay in the same place from page to
// page. Not in the shared topbar above, which has no room to spare once you
// account for every page's differing actions. flex-wrap so the controls drop
// to their own line below the title on a narrow screen rather than fighting
// it for space. Notifications and the command palette live here on every
// screen size - there is deliberately no second copy anywhere else, so
// there's exactly one bell mounted and no way for the two platforms to drift
// apart in what the cluster contains or where it sits.
export function NebulaPageHeading({
  title,
  subtitle,
  actions,
  stats,
  leading,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Compact inline KPI strip (see NebulaHeaderStats) - drops to its own row
      under the title and actions, left-aligned, since it can't share a row
      with both without crowding - a page-specific opt-in replacement for a
      full NebulaStatCard grid when the stats are secondary context, not
      the page's main content (see the Addons page for the first use). */
  stats?: ReactNode;
  /** Content just before the title (e.g. a "Back" button). Opt-in per page
      rather than folded into `actions`, since a back control reads as "leave
      this page" and belongs on the opposite side from Rename/Delete/the bell,
      not bunched in with them. */
  leading?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
        {leading && <div className="flex items-center">{leading}</div>}
        <div className="min-w-0">
          <h1 className="text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.12] tracking-tight font-bold font-display mb-1 text-default">{title}</h1>
          {subtitle && <p className="text-sm text-muted max-w-2xl">{subtitle}</p>}
        </div>
      </div>
      {/* Full width on a phone so the controls sit under the title with the
          palette and bell at the right edge: the bell's dropdown opens
          leftward from itself, so it must never end up packed at the start of
          a line, where it would run off the left edge of the screen.
          md:w-auto hugs the content in the same row as the title. */}
      <div className="flex items-center gap-2 flex-wrap w-full md:w-auto md:justify-end">
        {actions}
        <div className="ml-auto">
          <TopbarActions />
        </div>
      </div>
      {stats && (
        <div className="w-full flex md:justify-start">
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
    // On a phone, an even full-width row of three - the same as the stat row
    // on Users and Groups - rather than cards shrunk to their text.
    <div className="w-full grid grid-cols-3 gap-2 md:w-auto md:flex md:items-center md:gap-4">
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
    // Phone: the number sits beside the icon and the label gets the tile's
    // whole width underneath (three tiles in a row left it ~45px, so labels
    // were cut). From md up: icon on the left, number over label.
    <div className={`${NEBULA_GLASS_CLASS} p-2.5 sm:p-3 md:p-5 flex flex-col md:flex-row md:items-center gap-1.5 md:gap-4 min-w-0`} style={nebulaGlassStyle}>
      <NebulaGlassStripe />
      <div className="contents md:hidden">
        <div className="flex items-center gap-2 min-w-0">
          {icon && (
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{
                background: isPrimary ? 'var(--color-primary-muted)' : 'var(--color-secondary-muted)',
                color: isPrimary ? 'var(--color-primary)' : 'var(--color-secondary)',
              }}
            >
              {icon}
            </div>
          )}
          <p className="text-lg font-bold font-display text-default leading-none truncate">{value}</p>
        </div>
        <p className="text-[11px] leading-tight text-muted">{label}</p>
      </div>
      {icon && (
        <div
          className="hidden md:flex w-11 h-11 rounded-xl items-center justify-center shrink-0"
          style={{
            background: isPrimary ? 'var(--color-primary-muted)' : 'var(--color-secondary-muted)',
            color: isPrimary ? 'var(--color-primary)' : 'var(--color-secondary)',
          }}
        >
          {icon}
        </div>
      )}
      <div className="hidden md:block min-w-0">
        <p className="text-3xl font-bold font-display text-default leading-none truncate">{value}</p>
        <p className="text-sm text-muted mt-1 truncate">{label}</p>
      </div>
    </div>
  );
}
