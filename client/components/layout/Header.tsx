'use client';

import { motion } from 'framer-motion';
import { BellIcon, MagnifyingGlassIcon, Bars3Icon } from '@heroicons/react/24/outline';
import { Avatar } from '../ui/Avatar';
import { NotificationsDropdown } from '../ui/NotificationsDropdown';
import { useMobileMenu } from '@/app/(admin)/AdminClientLayout';

interface HeaderProps {
  title: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
  // Rendered in the left grid column, opposite `actions` - the title stays
  // centered either way (see the 3-column grid comment below). Mirrors
  // NebulaPageHeading's own `leading` prop for the same reason: a control
  // that reads as "go somewhere else" (a back button, or an unrelated
  // entry point like Nuvio Collections on the Catalogs page) belongs on
  // the opposite side from page-specific actions like Rename/Delete/Save.
  leading?: React.ReactNode;
  activities?: any[];
  inviteHistory?: any[];
  taskHistory?: any[];
  onMenuClick?: () => void;
  isMobileMenuOpen?: boolean;
}

export function Header({
  title,
  subtitle,
  actions,
  leading,
  activities = [],
  inviteHistory = [],
  taskHistory = [],
  onMenuClick: onMenuClickProp,
  isMobileMenuOpen: isMobileMenuOpenProp
}: HeaderProps) {
  const { onOpen: onMenuClickContext, isOpen: isMobileMenuOpenContext } = useMobileMenu();
  
  // Use provided props or fall back to context
  const onMenuClick = onMenuClickProp || onMenuClickContext;
  const isMobileMenuOpen = isMobileMenuOpenProp !== undefined ? isMobileMenuOpenProp : isMobileMenuOpenContext;

  const INSTANCE_TYPE = (process.env.NEXT_PUBLIC_INSTANCE_TYPE || 'private') as 'public' | 'private';

  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="sticky top-0 z-30"
      style={{
        background: 'color-mix(in srgb, var(--color-bg) 80%, transparent)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid transparent',
        borderImage: 'linear-gradient(90deg, var(--color-primary-muted), transparent 60%) 1',
      }}
    >
      {/* Desktop uses a 3-column grid so the page title sits centered in the
          middle column while the right section (notifications + actions) stays
          right-aligned in the last column. Mobile keeps the flex layout so the
          hamburger and title flow tight on the left - flex-wrap (harmless at
          md+ since display switches to grid there) lets the right section
          drop to its own row below the title instead of squeezing or
          overflowing when a page passes several action buttons. Safe to grow
          taller here since this header is position:sticky, not fixed - it
          stays in normal document flow, so page content below it reflows
          around whatever height it ends up at instead of getting covered. */}
      <div className="px-4 md:px-6 lg:px-8 py-3 md:py-4 flex items-center justify-between gap-x-4 gap-y-2 flex-wrap md:grid md:grid-cols-[1fr_auto_1fr]">
        {/* Leading - left column, opposite `actions`. Empty when not passed,
            so every existing page (no leading) renders exactly as before. */}
        {leading ? (
          <div className="flex items-center md:col-start-1 md:justify-self-start order-first md:order-none">
            {leading}
          </div>
        ) : null}

        {/* Mobile Menu Button & Title section */}
        <div className="flex items-center gap-3 md:col-start-2 md:justify-self-center md:text-center">
          {/* Hamburger - only show on mobile */}
          <button
            onClick={onMenuClick}
            className="md:hidden p-2 -ml-2 rounded-lg hover:bg-surface-hover transition-colors"
            aria-label="Open menu"
          >
            <Bars3Icon className="w-6 h-6 text-default" />
          </button>

          <div>
            <motion.h1
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
              className="text-xl md:text-2xl font-bold font-display tracking-tight"
              style={{
                background: 'linear-gradient(135deg, var(--color-text) 0%, var(--color-primary) 120%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              {title}
            </motion.h1>
            {subtitle ? (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="text-sm mt-0.5 hidden sm:block"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {subtitle}
              </motion.p>
            ) : null}
          </div>
        </div>

        {/* Right section. Actions render BEFORE the bell so on mobile the
            bell sits flush to the screen's right edge — its dropdown anchors
            `right-0` off the bell, and if the bell isn't at the true right
            edge the dropdown extends left off-screen (dropdown is ~320px wide,
            so even a small offset shoves its left edge past 0). */}
        <div className="flex items-center gap-2 md:gap-3 flex-wrap justify-end w-full md:w-auto md:col-start-3 md:justify-self-end">
          {/* Actions - w-full on mobile is load-bearing: flex-wrap only
              engages once this div's own width is bounded, same reasoning
              as NebulaPageHeading's actions container (see that file for
              the fuller writeup of why an unbounded flex child won't wrap
              on its own). */}
          {actions ? (
            <div
              className="flex items-center gap-2 pr-3 flex-wrap"
              style={{ borderRight: '1px solid var(--color-surface-border)' }}
            >
              {actions}
            </div>
          ) : null}

          {/* Notifications — always last so its dropdown fits within the screen */}
          <NotificationsDropdown
            activities={activities}
            inviteHistory={inviteHistory}
            taskHistory={taskHistory}
          />
        </div>
      </div>
    </motion.header>
  );
}

// Breadcrumbs component
interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav className={`flex items-center gap-2 ${className || 'text-sm'}`} style={{ color: 'var(--color-text-muted)' }}>
      {items.map((item, index) => (
        <motion.div
          key={index}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.05 }}
          className="flex items-center gap-2"
        >
          {index > 0 && <span style={{ color: 'var(--color-text-subtle)' }}>/</span>}
          {item.href ? (
            <a
              href={item.href}
              className="transition-colors hover:text-[var(--color-text)]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {item.label}
            </a>
          ) : (
            <span style={{ color: 'var(--color-text)' }}>{item.label}</span>
          )}
        </motion.div>
      ))}
    </nav>
  );
}
