'use client';

import { useState, useEffect, createContext, useContext, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { PageContainer } from "@/components/layout/PageContainer";
import { useLayoutMode, isNebulaEligiblePath } from "@/lib/layout-mode";
import { DndContext, DragOverlay, closestCenter } from "@/components/ui/DragSortable";
import { useSortableSensors } from "@/components/ui/DragSortable";
import { pointerWithin } from "@dnd-kit/core";
import { VaultDragProvider, useVaultDrag } from "@/components/providers/VaultDragContext";
import { NotificationsDataProvider } from "@/components/providers/NotificationsDataProvider";
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

// Lives inside VaultDragProvider so it can read the currently-registered
// drag-end handler (set by whichever page has draggable items — currently
// only the Vault page) and hands the event off to it.
function LayoutDndWrapper({ children }: { children: ReactNode }) {
  const sensors = useSortableSensors();
  const { dragEndHandlerRef } = useVaultDrag();
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    const label = (event.active.data.current as any)?.label;
    setActiveLabel(typeof label === 'string' ? label : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveLabel(null);
    dragEndHandlerRef.current?.(event);
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

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isMobileMenuOpen]);

  const handleOpen = () => setIsMobileMenuOpen(true);
  const handleClose = () => setIsMobileMenuOpen(false);

  return (
    <MobileMenuContext.Provider value={{ isOpen: isMobileMenuOpen, onOpen: handleOpen, onClose: handleClose }}>
      <NotificationsDataProvider>
        <VaultDragProvider>
          <LayoutDndWrapper>
            <div className="relative min-h-screen">
              {!useNebulaChrome && (
                <Sidebar
                  isOpen={isMobileMenuOpen}
                  onClose={handleClose}
                />
              )}
              <PageContainer noSidebarOffset={useNebulaChrome}>
                {children}
              </PageContainer>
            </div>
          </LayoutDndWrapper>
        </VaultDragProvider>
      </NotificationsDataProvider>
    </MobileMenuContext.Provider>
  );
}
