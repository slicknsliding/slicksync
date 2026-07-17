'use client';

import { motion } from 'framer-motion';
import { ReactNode } from 'react';
import { Bars3Icon } from '@heroicons/react/24/outline';
import { useUserMobileMenu } from '@/lib/hooks/useUserMobileMenu';

interface UserPageContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * Page container for user panel with sidebar offset
 */
export function UserPageContainer({ children, className }: UserPageContainerProps) {
  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className={`ml-0 md:ml-60 min-h-screen ${className || ''}`}
      style={{ background: 'var(--color-bg)' }}
    >
      {/* Subtle background gradient */}
      <div className="fixed inset-0 ml-0 md:ml-60 pointer-events-none overflow-hidden">
        <div 
          className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full blur-[120px] opacity-30"
          style={{ background: 'var(--color-primaryMuted)' }}
        />
        <div 
          className="absolute -bottom-40 -left-40 w-[400px] h-[400px] rounded-full blur-[100px] opacity-20"
          style={{ background: 'var(--color-secondaryMuted)' }}
        />
      </div>

      {/* Content */}
      <div className="relative">
        {children}
      </div>
    </motion.main>
  );
}

// Page header component for user pages
interface UserPageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function UserPageHeader({ title, subtitle, actions }: UserPageHeaderProps) {
  const { onOpen } = useUserMobileMenu();

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-between mb-6 gap-4"
    >
      <div className="flex items-center gap-3 min-w-0">
        {/* Hamburger - only show on mobile */}
        <button
          onClick={onOpen}
          className="md:hidden p-2 -ml-2 rounded-lg hover:bg-surface-hover transition-colors shrink-0"
          aria-label="Open menu"
        >
          <Bars3Icon className="w-6 h-6 text-default" />
        </button>

        <div className="min-w-0">
          <h1
            className="text-2xl font-bold font-display truncate"
            style={{ color: 'var(--color-text)' }}
          >
            {title}
          </h1>
          {subtitle && (
            <p
              className="text-sm mt-1"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-3 shrink-0">{actions}</div>}
    </motion.div>
  );
}
