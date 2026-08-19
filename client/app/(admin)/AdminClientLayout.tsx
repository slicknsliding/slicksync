'use client';

import { useState, useEffect, createContext, useContext, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { AdminAuthGate } from "@/components/layout/AdminAuthGate";
import { NebulaTopbar } from "@/components/layout/NebulaTopbar";
import { PageContainer } from "@/components/layout/PageContainer";
import { useLayoutMode, isNebulaEligiblePath } from "@/lib/layout-mode";
import { DndContext, DragOverlay, closestCenter } from "@/components/ui/DragSortable";
import { useSortableSensors } from "@/components/ui/DragSortable";
import { pointerWithin } from "@dnd-kit/core";
import { VaultDragProvider, useVaultDrag } from "@/components/providers/VaultDragContext";
import { TVBackButton } from "@/components/tv/TVBackButton";
import { CommandPalette } from "@/components/ui/CommandPalette";
import { useIsTV } from "@/lib/hooks/useIsTV";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import type { DragStartEvent, DragEndEvent, CollisionDetection } from "@dnd-kit/core";

interface MobileMenuContextType {
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}

const MobileMenuContext = createContext<MobileMenuContextType>({
  isOpen: false,
  onOpen: () => {},
  onClose: () => {},
});

export function useMobileMenu() {
  return useContext(MobileMenuContext);
}

// closestCenter compares the DRAGGED ITEM's own rect-center to each droppable's
// center — fine for reordering same-sized cards, but wrong for dropping a card
// onto a small, distant target like a category tab or the sidebar link, since
// the card's center can be far from where the cursor actually is. pointerWithin
// checks the literal cursor position instead, which is what "whatever tab I'm
// hovering over should light up" actually needs. Try pointer-precision first,
// fall back to closestCenter only when the pointer isn't over anything (the
// gap-between-cards case during reordering).
const dragCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  return closestCenter(args);
};

// Lives inside VaultDragProvider so it can read every currently-registered
// drag-end handler (set by whichever page(s) have draggable items - a
// detail page can have more than one list registered at once, see
// VaultDragContext's own comment) and hands the event to all of them.
function LayoutDndWrapper({ children }: { children: ReactNode }) {
  const sensors = useSortableSensors();
  const { dragEndHandlersRef } = useVaultDrag();
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    const label = (event.active.data.current as any)?.label;
    setActiveLabel(typeof label === 'string' ? label : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveLabel(null);
    dragEndHandlersRef.current.forEach((handler) => handler(event));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={dragCollisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {children}
      <DragOverlay>
        {activeLabel ? (
          <div className="px-4 py-2 rounded-xl shadow-lg text-sm font-medium" style={{ background: 'var(--color-primary)', color: '#fff' }}>
            {activeLabel}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Admin layout with sidebar navigation
 * 
 * All admin pages (dashboard, users, groups, etc.) use this layout.
 * Each page uses useMobileMenu() hook to get the menu open function for the Header.
 */
export default function AdminClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const pathname = usePathname();
  const { layoutMode } = useLayoutMode();
  const isTV = useIsTV();
  // Dashboard/Activity render their own top-nav chrome in Nebula mode, so
  // the shared sidebar (and the content offset that reserves space for it)
  // needs to get out of the way on exactly those two routes - every other
  // page keeps the sidebar regardless of this setting, since there's no
  // Nebula version of them to switch to.
  const useNebulaChrome = layoutMode === 'nebula' && isNebulaEligiblePath(pathname);

  // Close mobile menu on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  // Prevent body scroll when mobile menu is open - but only for Original's
  // actual full-screen overlay drawer (Sidebar), where locking scroll behind
  // the backdrop is the whole point. Nebula's mobile nav is an inline
  // dropdown that expands within the already-sticky topbar, not an overlay -
  // locking body scroll there broke position: sticky instead (confirmed:
  // opening the dropdown while scrolled down made the sticky nav appear to
  // vanish until scrolling all the way back to top). Sticky's "stuck"
  // behavior depends on a scrollable ancestor chain up to the real viewport;
  // freezing that chain out from under it mid-scroll is what caused it.
  //
  // `overflow: hidden` alone doesn't actually stop background touch-scroll
  // on iOS Safari - it's a well-known gap, iOS keeps scrolling the page
  // underneath regardless. Confirmed live: with the drawer open, scrolling
  // the sidebar's own nav list didn't work at all - the touch was scrolling
  // the body behind it instead. `position: fixed` on the body (with the
  // current scroll offset preserved via `top`, then restored via
  // `window.scrollTo` on close) is the standard robust fix - it genuinely
  // removes the body from the scroll chain instead of just asking it not to
  // scroll.
  useEffect(() => {
    if (isMobileMenuOpen && !useNebulaChrome) {
      const scrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.overflow = '';
        window.scrollTo(0, scrollY);
      };
    }
    document.body.style.overflow = 'unset';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isMobileMenuOpen, useNebulaChrome]);

  const handleOpen = () => setIsMobileMenuOpen(true);
  const handleClose = () => setIsMobileMenuOpen(false);

  return (
    <AdminAuthGate>
      <MobileMenuContext.Provider value={{ isOpen: isMobileMenuOpen, onOpen: handleOpen, onClose: handleClose }}>
        <TVBackButton />
        {/* No keyboard on a D-pad-only TV interface - a floating Ctrl+K
            hint/shortcut makes no sense there. */}
        {!isTV && <CommandPalette />}
        {!isTV && <OnboardingWizard />}
        <VaultDragProvider>
          <LayoutDndWrapper>
            <div className="relative min-h-screen">
              {!useNebulaChrome && (
                <Sidebar
                  isOpen={isMobileMenuOpen}
                  onClose={handleClose}
                />
              )}
              {/* Hoisted here (not rendered per-page) so it persists across
                  Nebula-eligible route changes instead of fully unmounting and
                  remounting on every navigation - it previously lived inside
                  each of 16 individual page.tsx files, which meant every click
                  between them tore down and rebuilt NebulaTopbar from scratch:
                  re-fetching account stats, replaying its entrance stagger
                  animations, and resetting scroll-collapse state
                  (isScrolled/mobileNavOpen) back to expanded even if you'd just
                  scrolled it collapsed. Confirmed as a real contributor to
                  mobile feeling laggy/glitchy switching pages, not just a
                  guess - NebulaTopbar takes no props, so it's exactly as safe
                  hoisted here as Sidebar already is. Gated on the same
                  useNebulaChrome flag Sidebar uses (isNebulaEligiblePath),
                  which matches 1:1 with the paths that used to render it
                  themselves. */}
              {useNebulaChrome && <NebulaTopbar />}
              <PageContainer noSidebarOffset={useNebulaChrome}>
                {children}
              </PageContainer>
            </div>
          </LayoutDndWrapper>
        </VaultDragProvider>
      </MobileMenuContext.Provider>
    </AdminAuthGate>
  );
}
