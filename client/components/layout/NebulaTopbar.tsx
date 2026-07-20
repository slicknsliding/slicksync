'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
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
const NEBULA_NAV_LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/discover', label: 'Discover' },
  { href: '/activity', label: 'Activity' },
  { href: '/metrics', label: 'Metrics' },
  { href: '/users', label: 'Users' },
  { href: '/groups', label: 'Groups' },
  { href: '/addons', label: 'Addons' },
  { href: '/vault', label: 'Vault' },
  { href: '/invitations', label: 'Invitations' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/settings', label: 'Settings' },
  { href: '/changelog', label: 'Changelog' },
];

export function NebulaTopbar({ actions }: { actions?: ReactNode }) {
  const pathname = usePathname();
  // Mirrors Sidebar.tsx's own account-info fetch - Nebula's topbar had no
  // equivalent of the sidebar's bottom "Administrator" panel switcher at
  // all, so there was no way to see who's logged in, switch to the User
  // panel, or log out from this layout.
  const [accountInfo, setAccountInfo] = useState<{ username?: string; email?: string; uuid?: string | null } | null>(null);
  const isPublicInstance = (process.env.NEXT_PUBLIC_INSTANCE_TYPE || 'private') === 'public';

  useEffect(() => {
    api.getAccountStats()
      .then((stats) => {
        const uuid = (stats as any).uuid || null;
        const email = (stats as any).email || null;
        setAccountInfo({
          username: isPublicInstance ? (uuid || email || 'Admin') : 'Administrator',
          email,
          uuid,
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
          here since this sits at the BOTTOM of the screen. */}
      <div className="fixed bottom-4 left-4 md:bottom-6 md:left-6 z-40">
        <div
          className="rounded-2xl p-1.5"
          style={{
            background: 'color-mix(in srgb, var(--color-surface) 80%, transparent)',
            backdropFilter: 'blur(18px)',
            WebkitBackdropFilter: 'blur(18px)',
            border: '1px solid var(--color-surfaceBorder)',
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
          border: '1px solid var(--color-surfaceBorder)',
        }}
      >
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 mb-4">
          <span aria-hidden />
          <Link href="/" className="flex items-center gap-4 justify-center">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))',
                boxShadow: '0 8px 28px -6px var(--color-primary)',
              }}
            >
              <SlickSyncLogo className="w-11 h-11" />
            </div>
            <b
              className="text-4xl font-bold font-display tracking-tight whitespace-nowrap"
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
          <div className="flex items-center gap-2 justify-self-end">
            <NotificationsDropdown activities={[]} inviteHistory={[]} taskHistory={[]} />
            {actions}
          </div>
        </div>
        <nav
          className="flex flex-wrap justify-center gap-2 pt-4"
          style={{ borderTop: '1px solid var(--color-surfaceBorder)' }}
        >
          {NEBULA_NAV_LINKS.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-semibold px-4 py-2 rounded-full transition-colors whitespace-nowrap"
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
                {link.label}
              </Link>
            );
          })}
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
export const nebulaGlassStyle: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--color-surface) 66%, transparent)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  border: '1px solid var(--color-surfaceBorder)',
};

export function NebulaGlassStripe() {
  return (
    <div
      className="absolute top-0 left-0 right-0 h-[2px]"
      style={{ background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))' }}
    />
  );
}
