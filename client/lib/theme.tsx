'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

// Theme IDs
export const themeIds = ['slick', 'velvet', 'nebula', 'midnight', 'ember', 'nord', 'verdant', 'slate', 'rose', 'daylight'] as const;
export type ThemeId = (typeof themeIds)[number];

// Theme metadata for UI (settings page, etc.)
export const themeMeta: Record<ThemeId, { 
  name: string; 
  description: string; 
  preview: string;
  colors: { bg: string; surface: string; primary: string; secondary: string };
}> = {
  slick: {
    name: 'Slick',
    description: 'Soft violet with muted teal accents',
    preview: '#8b7ec8',
    colors: { bg: '#050308', surface: '#0c0812', primary: '#8b7ec8', secondary: '#5fd4c4' },
  },
  velvet: {
    name: 'Velvet',
    description: 'Deep plum with dusty rose-gold accents',
    preview: '#b8869e',
    colors: { bg: '#170f14', surface: '#241820', primary: '#b8869e', secondary: '#d4a574' },
  },
  nebula: {
    name: 'Nebula',
    description: 'Deep blue-black with violet-to-cyan accents',
    preview: '#8b7ec8',
    colors: { bg: '#0d1117', surface: '#1c2128', primary: '#8b7ec8', secondary: '#5fd4c4' },
  },
  midnight: {
    name: 'Midnight',
    description: 'Deep blue-black with warm amber accents',
    preview: '#f0a500',
    colors: { bg: '#0d1117', surface: '#1c2128', primary: '#f0a500', secondary: '#d4a500' },
  },
  ember: {
    name: 'Ember',
    description: 'Charcoal warmth with fiery accents',
    preview: '#ff5722',
    colors: { bg: '#1a1615', surface: '#292420', primary: '#ff5722', secondary: '#ffab40' },
  },
  nord: {
    name: 'Nord',
    description: 'Arctic cool with icy blue tones',
    preview: '#88c0d0',
    colors: { bg: '#2e3440', surface: '#3b4252', primary: '#88c0d0', secondary: '#81a1c1' },
  },
  verdant: {
    name: 'Verdant',
    description: 'Deep forest with emerald greens',
    preview: '#4caf50',
    colors: { bg: '#0f1a14', surface: '#1a2a1e', primary: '#4caf50', secondary: '#26a69a' },
  },
  slate: {
    name: 'Slate',
    description: 'Minimal grayscale with blue accents',
    preview: '#3b82f6',
    colors: { bg: '#18181b', surface: '#27272a', primary: '#3b82f6', secondary: '#60a5fa' },
  },
  rose: {
    name: 'Rose',
    description: 'Elegant dark with rose gold',
    preview: '#f472b6',
    colors: { bg: '#1c1618', surface: '#2a2124', primary: '#f472b6', secondary: '#ec4899' },
  },
  daylight: {
    name: 'Daylight',
    description: 'Light theme with soft neutrals and blue accents',
    preview: '#2563eb',
    colors: { bg: '#f3f4f6', surface: '#ffffff', primary: '#2563eb', secondary: '#3b82f6' },
  },
};

// A user-built theme: an existing theme for the structural colors (bg,
// surface, text, borders, status) plus custom primary/secondary accents.
// Applying it sets the base theme's class (so every structural variable
// loads) and then overrides only the accent variables inline, deriving the
// -hover (lightened) and -muted (translucent) shades so the whole app
// recolors consistently without the user having to pick a dozen values.
export interface CustomTheme {
  base: ThemeId;
  primary: string;
  secondary: string;
}

const CUSTOM_THEME_STORAGE_KEY = 'slicksync-custom-theme';
const DEFAULT_CUSTOM_THEME: CustomTheme = { base: 'nebula', primary: '#8b7ec8', secondary: '#5fd4c4' };

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function lighten(hex: string, amount = 0.15): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const up = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[up(rgb.r), up(rgb.g), up(rgb.b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

// The accent variables a custom theme overrides on top of its base class.
const ACCENT_OVERRIDE_VARS = [
  '--color-primary', '--color-primary-hover', '--color-primary-muted', '--color-primaryMuted',
  '--color-secondary', '--color-secondary-muted', '--color-secondaryMuted',
  '--color-chart-1', '--color-chart-2',
];

function applyCustomTheme(el: HTMLElement, custom: CustomTheme) {
  el.className = custom.base; // structural vars come from the base theme's block
  el.style.setProperty('--color-primary', custom.primary);
  el.style.setProperty('--color-primary-hover', lighten(custom.primary));
  el.style.setProperty('--color-primary-muted', rgba(custom.primary, 0.15));
  el.style.setProperty('--color-primaryMuted', rgba(custom.primary, 0.15));
  el.style.setProperty('--color-secondary', custom.secondary);
  el.style.setProperty('--color-secondary-muted', rgba(custom.secondary, 0.15));
  el.style.setProperty('--color-secondaryMuted', rgba(custom.secondary, 0.15));
  el.style.setProperty('--color-chart-1', custom.primary);
  el.style.setProperty('--color-chart-2', custom.secondary);
}

function clearCustomTheme(el: HTMLElement) {
  for (const v of ACCENT_OVERRIDE_VARS) el.style.removeProperty(v);
}

interface ThemeContextValue {
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;
  hideSensitive: boolean;
  toggleHideSensitive: () => void;
  // Custom theme: `isCustom` is true when the user's own theme is active.
  // `customTheme` is the saved config; `applyCustom` previews+persists a new
  // one (and switches to it); `previewCustom` applies without persisting (for
  // the live builder), reverted by re-applying the active theme.
  isCustom: boolean;
  customTheme: CustomTheme;
  applyCustom: (c: CustomTheme) => void;
  previewCustom: (c: CustomTheme) => void;
  // Re-applies whatever theme is actually active, discarding any live
  // preview overrides (used by the builder's "reset preview").
  cancelPreview: () => void;
}

const defaultContextValue: ThemeContextValue = {
  themeId: 'nebula',
  setTheme: () => {},
  hideSensitive: false,
  toggleHideSensitive: () => {},
  isCustom: false,
  customTheme: DEFAULT_CUSTOM_THEME,
  applyCustom: () => {},
  previewCustom: () => {},
  cancelPreview: () => {},
};

const ThemeContext = createContext<ThemeContextValue>(defaultContextValue);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // 'custom' is stored in the same 'slicksync-theme' key as the built-in
  // ids, but isn't in themeIds (so the built-in picker doesn't list it) -
  // when active, the custom config in its own key drives the actual colors.
  const [themeId, setThemeId] = useState<ThemeId | 'custom'>('nebula');
  const [customTheme, setCustomTheme] = useState<CustomTheme>(DEFAULT_CUSTOM_THEME);
  const [hideSensitive, setHideSensitive] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Load saved theme and settings on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('slicksync-theme');
    let savedCustom = DEFAULT_CUSTOM_THEME;
    try {
      const raw = localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && themeIds.includes(parsed.base) && typeof parsed.primary === 'string' && typeof parsed.secondary === 'string') {
          savedCustom = parsed;
        }
      }
    } catch {}
    setCustomTheme(savedCustom);

    const savedHideSensitive = localStorage.getItem('slicksync-hide-sensitive') === 'true';
    const initial: ThemeId | 'custom' = savedTheme === 'custom' ? 'custom' : (savedTheme && themeIds.includes(savedTheme as ThemeId) ? (savedTheme as ThemeId) : 'nebula');
    setThemeId(initial);
    setHideSensitive(savedHideSensitive);
    if (initial === 'custom') applyCustomTheme(document.documentElement, savedCustom);
    else document.documentElement.className = initial;
    setMounted(true);
  }, []);

  // Apply theme when changed
  useEffect(() => {
    if (!mounted) return;
    if (themeId === 'custom') {
      applyCustomTheme(document.documentElement, customTheme);
    } else {
      clearCustomTheme(document.documentElement);
      document.documentElement.className = themeId;
    }
    localStorage.setItem('slicksync-theme', themeId);
  }, [themeId, customTheme, mounted]);

  // Save hideSensitive preference
  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem('slicksync-hide-sensitive', String(hideSensitive));
  }, [hideSensitive, mounted]);

  const setTheme = (id: ThemeId) => {
    if (themeIds.includes(id)) {
      setThemeId(id);
    }
  };

  // Persist a new custom theme and switch to it.
  const applyCustom = (c: CustomTheme) => {
    setCustomTheme(c);
    localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(c));
    setThemeId('custom');
  };

  // Live-preview without persisting - used by the builder while dragging
  // color pickers. cancelPreview (or applyCustom) restores state.
  const previewCustom = (c: CustomTheme) => {
    applyCustomTheme(document.documentElement, c);
  };

  const cancelPreview = () => {
    if (themeId === 'custom') {
      applyCustomTheme(document.documentElement, customTheme);
    } else {
      clearCustomTheme(document.documentElement);
      document.documentElement.className = themeId;
    }
  };

  const toggleHideSensitive = () => {
    setHideSensitive(prev => !prev);
  };

  return (
    <ThemeContext.Provider value={{
      themeId: themeId as ThemeId,
      setTheme,
      hideSensitive,
      toggleHideSensitive,
      isCustom: themeId === 'custom',
      customTheme,
      applyCustom,
      previewCustom,
      cancelPreview,
    }}>
      <div style={{ visibility: mounted ? 'visible' : 'hidden' }}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
