'use client';

import { motion } from 'framer-motion';
import { ReactNode } from 'react';
import { PageContainer } from '@/components/layout/PageContainer';

interface UserPageContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * Page container for a person's own pages: the admin pages' own container
 * and background under the shared top bar (PersonTopbar), with the content
 * as wide as the bar so the two line up.
 */
export function UserPageContainer({ children, className }: UserPageContainerProps) {
  return (
    <PageContainer noSidebarOffset className={className}>
      <div className="mx-auto" style={{ maxWidth: 'min(120rem, 92vw)' }}>
        {children}
      </div>
    </PageContainer>
  );
}

// Page header component for user pages
interface UserPageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function UserPageHeader({ title, subtitle, actions }: UserPageHeaderProps) {
  // No menu button here any more - the top bar above carries the navigation.
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-between mb-6 gap-4"
    >
      <div className="flex items-center gap-3 min-w-0">
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
