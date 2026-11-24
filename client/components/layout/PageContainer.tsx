'use client';

import { motion } from 'framer-motion';
import { ReactNode, useRef } from 'react';
import { useListEffect } from '@/lib/effects';

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
      initial={false} // shown at once - no fade on every page open
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className={`${offsetClass} min-h-screen ${className || ''}`}
      style={{ background: 'var(--color-bg)' }}
    >
      {/* Background gradient - Nebula gets a soft spotlight glow pooling in
          each corner (purple top-left, secondary color bottom-right,
          matching the layout's own namesake and the approved concept
          mockup) instead of the two small static corner blobs every other
          page uses. Two earlier attempts at a diagonal linear-gradient
          "wash" both had one color stop go invisible under certain
          conditions (an oversized backgroundSize could push it off-screen
          entirely) - large blurred radial blobs with a gentle transform-only
          float (translate + scale, gated behind prefers-reduced-motion in
          globals.css) can't have that failure mode, since they're always
          anchored by their own position/size regardless of animation
          frame. */}
      <div className={`fixed inset-0 ${offsetClass} pointer-events-none overflow-hidden`}>
        {noSidebarOffset ? (
          <>
            {/* opacity-55/50 against the full-strength (non-muted) accent
                color looked fine for Nebula's own cool violet, but a
                screen-recording pass found it reads as a genuine blinding
                flare for warm/saturated themes (Midnight's amber, Ember's
                red-orange) - confirmed frame-by-frame that this is NOT the
                sync/lag bug fixed earlier (logo, divider, and glow all
                change in perfect lockstep, no stale color) - the same
                opacity just doesn't scale the same way across hues this
                different. Dropped well below Current layout's already-safe
                30/20 (which also uses the *muted* variant, not full
                strength) since Nebula's blobs are 500-560px vs Current's
                400-500px and this is the more visually dominant layout.

                A 4th report (switching quickly through several themes, esp.
                custom -> built-in) showed the glow hard-cutting to the new
                hue the instant --color-primary changes, while everything
                else (checkmark, cards) updates in step - not a lag, a real
                jarring flash, worse the further apart two themes' hues are.
                The background-color transition (.glow in globals.css, all four
                blobs, both layouts) is the fix: eases the swap instead of
                snapping it, and as a side effect smooths over any leftover
                one-frame Firefox compositor lag on this blurred, animated
                layer specifically (blur filters get their own compositor
                path) without another forceRepaint()-style hack. */}
            {/* Drawn without a blur filter - see .glow in globals.css. */}
            <div className="glow glow-nebula-a animate-float-slow" />
            <div className="glow glow-nebula-b animate-float-slow-reverse" />
          </>
        ) : (
          <>
            <div className="glow glow-corner-a" />
            <div className="glow glow-corner-b" />
          </>
        )}
      </div>

      {/* Content */}
      <div className="relative" data-page-content="">
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
      initial={false} // at once, not one section after another
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
  // Effects → Removing and putting back: the rows left behind glide over, and one that returns gets a ring.
  const box = useRef<HTMLDivElement>(null);
  useListEffect(box, true);
  return (
    <div ref={box} className={className}>
      {children}
    </div>
  );
}

// Stagger item - the wrapper around individual rows/cards in most lists.
interface StaggerItemProps {
  children: ReactNode;
  className?: string;
  /** Opt in to Framer's layout animation, which smoothly slides siblings
      when an item is reordered or removed.
     
      Off by default, and that default is load-bearing. `layout` makes
      Framer measure EVERY element carrying it on any layout change
      anywhere in the tree, then animate each one. This component wraps
      every row on a dozen pages, so on a list of any real size a single
      unrelated change - closing a modal, a filter toggling, a route
      transition - turned into hundreds of getBoundingClientRect calls plus
      hundreds of concurrent animations. On desktop that reads as a stutter;
      on an iPhone it's a multi-second freeze, and it got steadily worse as
      more list pages were added.
     
      Turn it on only for a list that genuinely reorders in place AND is
      short. Note that it actively fights dnd-kit, which applies its own
      transforms to the same element during a drag. */
  animateLayout?: boolean;
}

export function StaggerItem({ children, className, animateLayout = false }: StaggerItemProps) {
  return (
    <motion.div
      layout={animateLayout}
      initial={false} // at once; the exit below still plays when a row is removed
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
