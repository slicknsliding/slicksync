'use client';

import { useState, useEffect, createContext, useContext, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { PageContainer } from "@/components/layout/PageContainer";
import { DndContext, DragOverlay, closestCenter } from "@/components/ui/DragSortable";
import { useSortableSensors } from "@/components/ui/DragSortable";
import { VaultDragProvider, useVaultDrag } from "@/components/providers/VaultDragContext";
import type { DragStartEvent, DragEndEvent } from "@dnd-kit/core";

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
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
      <VaultDragProvider>
        <LayoutDndWrapper>
          <div className="relative min-h-screen">
            <Sidebar 
              isOpen={isMobileMenuOpen} 
              onClose={handleClose} 
            />
            <PageContainer>
              {children}
            </PageContainer>
          </div>
        </LayoutDndWrapper>
      </VaultDragProvider>
    </MobileMenuContext.Provider>
  );
}
