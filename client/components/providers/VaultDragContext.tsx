'use client';

import { createContext, useContext, useRef, useCallback, ReactNode } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';

interface VaultDragContextType {
  // Vault page calls this on mount to register its own drop-handling logic —
  // the layout-level DndContext calls whichever handler is currently registered.
  registerDragEndHandler: (handler: ((event: DragEndEvent) => void) | null) => void;
  dragEndHandlerRef: React.MutableRefObject<((event: DragEndEvent) => void) | null>;
}

const VaultDragContext = createContext<VaultDragContextType | null>(null);

export function VaultDragProvider({ children }: { children: ReactNode }) {
  const dragEndHandlerRef = useRef<((event: DragEndEvent) => void) | null>(null);

  const registerDragEndHandler = useCallback((handler: ((event: DragEndEvent) => void) | null) => {
    dragEndHandlerRef.current = handler;
  }, []);

  return (
    <VaultDragContext.Provider value={{ registerDragEndHandler, dragEndHandlerRef }}>
      {children}
    </VaultDragContext.Provider>
  );
}

export function useVaultDrag() {
  const ctx = useContext(VaultDragContext);
  if (!ctx) throw new Error('useVaultDrag must be used within VaultDragProvider');
  return ctx;
}

// Fixed droppable id for the Sidebar's Addons nav link
export const SIDEBAR_ADDONS_DROPZONE_ID = 'sidebar-addons-dropzone';
