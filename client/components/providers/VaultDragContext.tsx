'use client';

import { createContext, useContext, useRef, useCallback, ReactNode } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';

interface VaultDragContextType {
  // A page with exactly one reorderable collection (Vault, Addons, Users,
  // Groups) registers its own drop-handling logic here on mount - the
  // layout-level DndContext calls every currently-registered handler.
  // Deliberately a SET, not a single slot: a detail page (User/Group/Addon)
  // can have TWO independent DraggableLists mounted at once (e.g. Group
  // Addons + Account Addons), each needing its own handler active
  // simultaneously - a single-slot ref meant only the most-recently-mounted
  // list's handler ever ran, silently breaking the other one. Safe to call
  // every registered handler for every drag event: each handler already
  // looks up active.id/over.id in ITS OWN items array via findIndex and
  // no-ops (returns early) if not found, so a handler belonging to a
  // different list is naturally a no-op rather than acting on the wrong
  // data. Returns an unregister function instead of requiring a separate
  // registerDragEndHandler(null) call, since removing a SPECIFIC handler
  // from a set (not "the" handler) needs a reference to what to remove.
  registerDragEndHandler: (handler: (event: DragEndEvent) => void) => () => void;
  dragEndHandlersRef: React.MutableRefObject<Set<(event: DragEndEvent) => void>>;
}

const VaultDragContext = createContext<VaultDragContextType | null>(null);

export function VaultDragProvider({ children }: { children: ReactNode }) {
  const dragEndHandlersRef = useRef<Set<(event: DragEndEvent) => void>>(new Set());

  const registerDragEndHandler = useCallback((handler: (event: DragEndEvent) => void) => {
    dragEndHandlersRef.current.add(handler);
    return () => { dragEndHandlersRef.current.delete(handler); };
  }, []);

  return (
    <VaultDragContext.Provider value={{ registerDragEndHandler, dragEndHandlersRef }}>
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
