'use client';

import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface PageContainerProps {
  children: ReactNode;
  className?: string;
  // Set by AdminClientLayout when Nebula layout mode is rendering its own
  // top-nav chrome instead of the sidebar for this page - without this, the
  // page content would still be offset by the sidebar's width even though
  // nothing is actually reserving that space.
  noSidebarOffset?: boolean;
}

export function PageContainer({ children, className, noSidebarOffset }: PageContainerProps) {
  const offsetClass = noSidebarOffset ? '' : 'ml-0 md:ml-60';
  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className={`${offsetClass} min-h-screen ${className || ''}`}
      style={{ background: 'var(--color-bg)' }}
    >
      {/* Background gradient - Nebula gets a smooth diagonal wash (purple
          bleeding down from the top-left, secondary color up from the
          bottom-right, matching the layout's own namesake and the original
          concept mockup) instead of the two small static corner blobs every
          other page uses. animate-aurora-drift is defined in globals.css
          and slowly shifts the gradient's position for a "transitioning"
          feel, already gated behind prefers-reduced-motion there. */}
      <div className={`fixed inset-0 ${offsetClass} pointer-events-none overflow-hidden`}>
        {noSidebarOffset ? (
          <div
            className="absolute inset-0 opacity-50 animate-aurora-drift"
            style={{
              backgroundImage:
                'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 65%, transparent) 0%, transparent 45%, transparent 55%, color-mix(in srgb, var(--color-secondary) 65%, transparent) 100%)',
              backgroundSize: '180% 180%',
            }}
          />
        ) : (
          <>
            <div
              className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full blur-[120px] opacity-30"
              style={{ background: 'var(--color-primaryMuted)' }}
            />
            <div
              className="absolute -bottom-40 -left-40 w-[400px] h-[400px] rounded-full blur-[100px] opacity-20"
              style={{ background: 'var(--color-secondaryMuted)' }}
            />
          </>
        )}
      </div>

      {/* Content */}
      <div className="relative">
        {children}
      </div>
    </motion.main>
  );
}

// Page section with animation
interface PageSectionProps {
  children: ReactNode;
  delay?: number;
  className?: string;
}

export function PageSection({ children, delay = 0, className }: PageSectionProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay }}
      className={className}
    >
      {children}
    </motion.section>
  );
}

// Staggered list container - only animates on first mount
interface StaggerContainerProps {
  children: ReactNode;
  className?: string;
}

export function StaggerContainer({ children, className }: StaggerContainerProps) {
  return (
    <div className={className}>
      {children}
    </div>
  );
}

// Stagger item - uses layout animation for smooth reordering
interface StaggerItemProps {
  children: ReactNode;
  className?: string;
}

export function StaggerItem({ children, className }: StaggerItemProps) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
