'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { NotificationsDropdown } from '@/components/ui/NotificationsDropdown';

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
];

export function NebulaTopbar({ actions }: { actions?: ReactNode }) {
  const pathname = usePathname();

  return (
    <div
      className="mx-4 mt-4 md:mx-6 md:mt-6 rounded-3xl p-4"
      style={{
        background: 'color-mix(in srgb, var(--color-surface) 70%, transparent)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid var(--color-surfaceBorder)',
      }}
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 mb-3">
        <span aria-hidden />
        <Link href="/" className="flex items-center gap-2.5 justify-center">
          <div
            className="w-8 h-8 rounded-lg flex-shrink-0"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))',
              boxShadow: '0 0 16px var(--color-primary-muted)',
            }}
          />
          <b className="text-lg tracking-tight text-default whitespace-nowrap">SlickSync</b>
        </Link>
        <div className="flex items-center gap-2 justify-self-end">
          <NotificationsDropdown activities={[]} inviteHistory={[]} taskHistory={[]} />
          {actions}
        </div>
      </div>
      <nav
        className="flex flex-wrap gap-1 pt-3"
        style={{ borderTop: '1px solid var(--color-surfaceBorder)' }}
      >
        {NEBULA_NAV_LINKS.map((link) => {
          const isActive = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className="text-xs font-semibold px-3 py-1.5 rounded-full transition-colors whitespace-nowrap"
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
