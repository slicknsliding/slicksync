'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useArrangement } from '@/lib/arrange';

type ViewMode = 'grid' | 'list';

const STORAGE_KEY = 'slicksync-default-view-mode';

function isMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 768;
}

export function getStoredViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'grid';
  // Always use grid on mobile
  if (isMobile()) return 'grid';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'grid' || stored === 'list') return stored;
  return 'grid';
}

export function setStoredViewMode(mode: ViewMode): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, mode);
}

/** A page's own key for its grid/list choice: its first path segment (/users, /addons). */
function pageKeyOf(pathname: string | null) {
  const seg = (pathname || '/').split('/').filter(Boolean)[0];
  return seg ? `/${seg}` : '/';
}

/**
 * Grid or list. Each admin page remembers its own choice (saved to the
 * account, so Users can be a grid while Addons is a list); a page with no
 * choice of its own uses the default from Themes. `{ global: true }` reads and
 * sets that default itself. Phones are always grid.
 */
export function useDefaultViewMode(opts: { global?: boolean } = {}) {
  const pageKey = pageKeyOf(usePathname());
  const { arrangement, update, active } = useArrangement();
  const perPage = active && !opts.global;
  const pageChoice = perPage ? arrangement.views?.[pageKey] : undefined;
  const [viewModeState, setViewMode] = useState<ViewMode>('grid');
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setViewMode(getStoredViewMode());
    setIsLoaded(true);
  }, []);

  // Force grid on mobile when window resizes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    const handleResize = () => {
      if (isMobile() && viewModeState !== 'grid') {
        setViewMode('grid');
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [viewModeState]);

  const toggleViewMode = useCallback(() => {
    // Don't allow list view on mobile
    if (isMobile()) return;
    
    setViewMode(prev => {
      const newMode = prev === 'grid' ? 'list' : 'grid';
      setStoredViewMode(newMode);
      return newMode;
    });
  }, []);

  const setViewModeDirect = useCallback((mode: ViewMode) => {
    // Don't allow list view on mobile
    if (isMobile()) {
      setViewMode('grid');
      return;
    }
    setViewMode(mode);
    if (perPage) {
      update((prev) => ({ ...prev, views: { ...(prev.views || {}), [pageKey]: mode } }));
      return;
    }
    setStoredViewMode(mode);
  }, [perPage, pageKey, update]);

  const viewMode: ViewMode = pageChoice && isLoaded && !isMobile() ? pageChoice : viewModeState;

  return {
    viewMode,
    setViewMode: setViewModeDirect,
    toggleViewMode,
    isLoaded,
  };
}