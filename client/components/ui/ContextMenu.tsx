'use client';

import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

interface ContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  children: React.ReactNode;
}

export function ContextMenu({ isOpen, position, onClose, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Close on scroll - but not while typing in a box inside the menu: a
    // phone's keyboard opening scrolls the page.
    const handleScroll = () => {
      if (menuRef.current && menuRef.current.contains(document.activeElement)) return;
      onClose();
    };

    // From the next tick: a menu opened by a click (a button, not a
    // right-click) is drawn while that click is still on its way up to the
    // window, which would count it as a click outside and close it at once.
    const t = setTimeout(() => {
      window.addEventListener('click', handleClick);
      window.addEventListener('contextmenu', handleClick); // Close if right-clicking elsewhere
      window.addEventListener('scroll', handleScroll, true);
    }, 0);

    return () => {
      clearTimeout(t);
      window.removeEventListener('click', handleClick);
      window.removeEventListener('contextmenu', handleClick);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, onClose]);

  // Adjust position to keep within viewport
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // Kept whole on screen, and again whenever the menu changes size (a confirm
  // step inside it makes it taller): near the right edge it moves left, near
  // the bottom it opens upwards from the click, and it never goes past any
  // edge. Taller than the screen, it scrolls inside (maxHeight below).
  const fit = useCallback(() => {
    const el = menuRef.current;
    if (!el) return;
    const pad = 10;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    // Its real size - the opening animation scales it, which the on-screen
    // box would include.
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let { x, y } = position;
    if (x + width > vw - pad) x = position.x - width >= pad ? position.x - width : vw - width - pad;
    if (y + height > vh - pad) y = position.y - height >= pad ? position.y - height : vh - height - pad;
    x = Math.min(x, vw - width - pad);
    y = Math.min(y, vh - height - pad);
    setAdjustedPosition({ x: Math.max(pad, x), y: Math.max(pad, y) });
  }, [position]);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- placed before paint, measured from the drawn menu
    if (!isOpen) { setAdjustedPosition(position); return; }
    fit();
    const el = menuRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen, position, fit]);

  if (!isOpen) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.1 }}
        style={{
          position: 'fixed',
          top: adjustedPosition.y,
          left: adjustedPosition.x,
          zIndex: 9999, // High z-index to be on top of everything
          maxHeight: 'calc(100vh - 20px)',
          overflowY: 'auto',
        }}
        // Options a step bigger than body text in every menu (15px, more room,
        // 18px icons) - set here so all of them stay alike.
        className="popup-panel min-w-[180px] py-1.5 rounded-xl [&_button]:text-[15px] [&_button]:py-2.5 [&_button>svg]:w-[18px] [&_button>svg]:h-[18px]"
        onClick={(e) => e.stopPropagation()} // Prevent click from bubbling
        onContextMenu={(e) => e.preventDefault()} // Prevent native context menu on the menu itself
      >
        {children}
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

// Only one context/quick-action menu should ever be open at a time, but every
// useContextMenu() call site (one per poster card, per user row, etc.) has
// its own independent isOpen state with no shared awareness of the others.
// Confirmed real bug: right-clicking a second card on Users/Discover/
// Dashboard (Continue Watching, Coming Up) left BOTH menus open at once.
// The existing "close on click/contextmenu elsewhere" listener in
// ContextMenu above can't fix this on its own either - handleContextMenu
// below calls preventDefault+stopPropagation on the triggering event, which
// stops it from ever bubbling up to a DIFFERENT (already-open) menu's
// window-level listener, so that menu never even sees the event that should
// have closed it. This module-level registry is the actual fix: opening a
// menu explicitly closes whichever other one is currently open first.
let activeMenu: { id: object; close: () => void } | null = null;

// Helper hook for elements that trigger the menu
export function useContextMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const idRef = useRef({});
  // Some consumers (Discover's poster grid, Dashboard's Continue Watching/
  // Coming Up rows) don't render this hook's own `isOpen` directly - they
  // lift a single "which item owns the open menu" value to a shared parent
  // instead, so the menu they actually show is driven by that, not this
  // hook's internal state. For those, closing THIS hook's isOpen does
  // nothing visible. setExternalClose lets such a consumer register its
  // real close function (the one that actually clears the lifted state) so
  // the cross-instance registry below closes the right thing. Plain ref
  // write - safe to call unconditionally every render.
  const externalCloseRef = useRef<(() => void) | null>(null);
  const setExternalClose = (fn: (() => void) | null) => { externalCloseRef.current = fn; };

  const close = () => {
    setIsOpen(false);
    if (activeMenu?.id === idRef.current) activeMenu = null;
  };

  const handleContextMenu = (e: React.MouseEvent | React.TouchEvent | Event, x?: number, y?: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeMenu && activeMenu.id !== idRef.current) activeMenu.close();
    const targetX = x ?? (e as React.MouseEvent).clientX;
    const targetY = y ?? (e as React.MouseEvent).clientY;
    setPosition({ x: targetX, y: targetY });
    setIsOpen(true);
    activeMenu = { id: idRef.current, close: () => (externalCloseRef.current ?? close)() };
  };

  return {
    isOpen,
    position,
    handleContextMenu,
    close,
    setIsOpen, // Expose setter if manual control is needed
    setExternalClose,
  };
}
