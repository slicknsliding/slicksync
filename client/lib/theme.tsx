'use client';

import { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { api } from '@/lib/api';

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

// Fonts the user can pick from in "Build your own theme". All preloaded in
// layout.tsx so switching is instant with no FOUT. `null`/'default' = use the
// theme's built-in display font (currently Space Grotesk / Outfit).
export const FONT_OPTIONS = [
  { id: 'default', label: 'Default (Space Grotesk)', family: null },
  { id: 'outfit', label: 'Outfit', family: '"Outfit", system-ui, sans-serif' },
  { id: 'inter', label: 'Inter', family: '"Inter", system-ui, sans-serif' },
  { id: 'roboto', label: 'Roboto', family: '"Roboto", system-ui, sans-serif' },
  { id: 'poppins', label: 'Poppins', family: '"Poppins", system-ui, sans-serif' },
  { id: 'playfair', label: 'Playfair Display', family: '"Playfair Display", Georgia, serif' },
] as const;
export type FontId = (typeof FONT_OPTIONS)[number]['id'];

// A user-built theme: an existing theme for the structural colors (bg,
// surface, borders, status) plus custom primary/secondary accents, and
// optional text-color and display-font overrides. Applying it sets the base
// theme's class (so every structural variable loads) then overrides the
// accent/text/font pieces inline, deriving the -hover (lightened) and -muted
// (translucent) shades so the whole app recolors consistently.
export interface CustomTheme {
  base: ThemeId;
  primary: string;
  secondary: string;
  text?: string | null;
  fontDisplay?: FontId | null;
}

const CUSTOM_THEME_STORAGE_KEY = 'slicksync-custom-theme';
const DEFAULT_CUSTOM_THEME: CustomTheme = { base: 'nebula', primary: '#8b7ec8', secondary: '#5fd4c4', text: null, fontDisplay: 'default' };

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

function fontFamilyFor(id: FontId | null | undefined): string | null {
  if (!id || id === 'default') return null;
  return FONT_OPTIONS.find((f) => f.id === id)?.family || null;
}

// The variables a custom theme may override on top of its base class.
// Font vars match the ones actually consumed by the app: --font-space-grotesk
// is what Tailwind's `font-display` class resolves to (headings), and
// --font-outfit is what globals.css sets on <body> (running text). Changing
// one font swaps both so the whole UI shifts to it consistently.
const OVERRIDE_VARS = [
  '--color-primary', '--color-primary-hover', '--color-primary-muted', '--color-primaryMuted',
  '--color-secondary', '--color-secondary-muted', '--color-secondaryMuted',
  '--color-chart-1', '--color-chart-2',
  '--color-text',
  '--font-space-grotesk', '--font-outfit',
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
  if (custom.text) el.style.setProperty('--color-text', custom.text);
  else el.style.removeProperty('--color-text');
  const family = fontFamilyFor(custom.fontDisplay);
  if (family) {
    el.style.setProperty('--font-space-grotesk', family);
    el.style.setProperty('--font-outfit', family);
  } else {
    el.style.removeProperty('--font-space-grotesk');
    el.style.removeProperty('--font-outfit');
  }
}

function clearCustomTheme(el: HTMLElement) {
  for (const v of OVERRIDE_VARS) el.style.removeProperty(v);
}

interface ThemeContextValue {
  themeId: ThemeId;
  setTheme: (id: ThemeId) => void;
  hideSensitive: boolean;
  toggleHideSensitive: () => void;
  isCustom: boolean;
  customTheme: CustomTheme;
  applyCustom: (c: CustomTheme) => void;
  previewCustom: (c: CustomTheme) => void;
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
  // ids, but isn't in themeIds (so the built-in picker doesn't list it) —
  // when active, the custom config drives the actual colors.
  const [themeId, setThemeId] = useState<ThemeId | 'custom'>('nebula');
  const [customTheme, setCustomTheme] = useState<CustomTheme>(DEFAULT_CUSTOM_THEME);
  const [hideSensitive, setHideSensitive] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Suppress the sync-to-server effect when hydrating from server response
  // (or from the first localStorage load), otherwise we'd echo the server's
  // own value back to it on every mount.
  const skipNextSaveRef = useRef(true);

  // Initial load: 1) hydrate from localStorage synchronously (avoids
  // flash-of-wrong-theme), 2) fetch the account-scoped preference from the
  // server and reconcile. Cross-device sync comes from step 2 winning.
  useEffect(() => {
    const savedTheme = localStorage.getItem('slicksync-theme');
    let savedCustom = DEFAULT_CUSTOM_THEME;
    try {
      const raw = localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && themeIds.includes(parsed.base) && typeof parsed.primary === 'string' && typeof parsed.secondary === 'string') {
          savedCustom = { ...DEFAULT_CUSTOM_THEME, ...parsed };
        }
      }
    } catch {}

    const savedHideSensitive = localStorage.getItem('slicksync-hide-sensitive') === 'true';
    const initialTheme: ThemeId | 'custom' = savedTheme === 'custom' ? 'custom' : (savedTheme && themeIds.includes(savedTheme as ThemeId) ? (savedTheme as ThemeId) : 'nebula');
    setCustomTheme(savedCustom);
    setThemeId(initialTheme);
    setHideSensitive(savedHideSensitive);
    if (initialTheme === 'custom') applyCustomTheme(document.documentElement, savedCustom);
    else document.documentElement.className = initialTheme;
    setMounted(true);

    // Reconcile with the server-stored account preference. This is what makes
    // a change on one device show up on another — the server value wins on
    // mount, then any local change round-trips back through PUT.
    api.getThemePref()
      .then((r) => {
        const pref = r?.themePref;
        if (!pref || typeof pref !== 'object') return;
        if (pref.themeId === 'custom' && pref.custom && themeIds.includes(pref.custom.base as ThemeId)) {
          const merged: CustomTheme = {
            base: pref.custom.base as ThemeId,
            primary: pref.custom.primary,
            secondary: pref.custom.secondary,
            text: pref.custom.text || null,
            fontDisplay: (pref.custom.fontDisplay as FontId) || 'default',
          };
          skipNextSaveRef.current = true;
          setCustomTheme(merged);
          setThemeId('custom');
        } else if (typeof pref.themeId === 'string' && themeIds.includes(pref.themeId as ThemeId)) {
          skipNextSaveRef.current = true;
          setThemeId(pref.themeId as ThemeId);
        }
      })
      .catch(() => {}); // offline / not signed in — keep local value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply theme when changed (local mirror still in localStorage for fast
  // hydration on the next page load).
  useEffect(() => {
    if (!mounted) return;
    if (themeId === 'custom') {
      applyCustomTheme(document.documentElement, customTheme);
    } else {
      clearCustomTheme(document.documentElement);
      document.documentElement.className = themeId;
    }
    localStorage.setItem('slicksync-theme', themeId);

    // Push to server so other devices pick this up on their next mount.
    // Skip the first echo after a server load / initial mount so we don't
    // uselessly re-write the same value.
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    const pref = themeId === 'custom'
      ? { themeId: 'custom', custom: customTheme }
      : { themeId };
    api.saveThemePref(pref).catch(() => {}); // best-effort; local UI already reflects the change
  }, [themeId, customTheme, mounted]);

  // Save hideSensitive preference (device-local; not synced — a per-device
  // privacy toggle shouldn't cross to a shared account view).
  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem('slicksync-hide-sensitive', String(hideSensitive));
  }, [hideSensitive, mounted]);

  const setTheme = (id: ThemeId) => {
    if (themeIds.includes(id)) setThemeId(id);
  };

  const applyCustom = (c: CustomTheme) => {
    setCustomTheme(c);
    localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(c));
    setThemeId('custom');
  };

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

  const toggleHideSensitive = () => setHideSensitive((prev) => !prev);

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
