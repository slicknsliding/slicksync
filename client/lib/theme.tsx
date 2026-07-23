'use client';

import { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { api } from '@/lib/api';

// Theme IDs
export const themeIds = ['nebula', 'slick', 'velvet', 'midnight', 'ember', 'nord', 'verdant', 'slate', 'rose', 'daylight'] as const;
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

// Each built-in theme's own text/textMuted/bgMuted/border/success/error
// values, mirroring globals.css (border's real value is translucent rgba —
// approximated here as an opaque hex since <input type="color"> can't
// represent alpha; it's just a starting point for the picker, not what
// actually renders when left unset). Used by Build-your-own-theme so
// picking a different Base updates every optional override's seed color to
// match THAT theme, instead of one generic seed regardless of base.
export const THEME_REAL_COLORS: Record<ThemeId, {
  text: string; textMuted: string; bgMuted: string; border: string; success: string; error: string;
}> = {
  slick: { text: '#f0edf7', textMuted: '#ab9dc4', bgMuted: '#100b1a', border: '#c4b5d8', success: '#34d399', error: '#fb7185' },
  velvet: { text: '#f5eef0', textMuted: '#c3a3ae', bgMuted: '#2a1e2a', border: '#d4a574', success: '#34d399', error: '#fb7185' },
  nebula: { text: '#f0f6fc', textMuted: '#8b949e', bgMuted: '#21262d', border: '#f0f6fc', success: '#3fb950', error: '#f85149' },
  midnight: { text: '#f0f6fc', textMuted: '#8b949e', bgMuted: '#21262d', border: '#f0f6fc', success: '#3fb950', error: '#f85149' },
  ember: { text: '#ffeee3', textMuted: '#a69b94', bgMuted: '#2d2825', border: '#ffede3', success: '#66bb6a', error: '#ef5350' },
  nord: { text: '#eceff4', textMuted: '#d8dee9', bgMuted: '#434c5e', border: '#eceff4', success: '#a3be8c', error: '#bf616a' },
  verdant: { text: '#e8f5e9', textMuted: '#a5c4ac', bgMuted: '#1e2e22', border: '#c8e6d2', success: '#4caf50', error: '#e57373' },
  slate: { text: '#fafafa', textMuted: '#a1a1aa', bgMuted: '#2d2d31', border: '#fafafa', success: '#22c55e', error: '#ef4444' },
  rose: { text: '#fce7ed', textMuted: '#c4a3ab', bgMuted: '#302528', border: '#ffe6eb', success: '#4ade80', error: '#fb7185' },
  daylight: { text: '#111827', textMuted: '#4b5563', bgMuted: '#e2e8f0', border: '#0f172a', success: '#16a34a', error: '#dc2626' },
};

// Fonts the user can pick from in "Build your own theme". All preloaded in
// layout.tsx so switching is instant with no FOUT. Deliberately spans very
// different aesthetics so no two picks read as "basically the same font."
export const FONT_OPTIONS = [
  { id: 'default', label: 'Default (Space Grotesk)', family: null },
  { id: 'poppins', label: 'Poppins — rounded sans', family: '"Poppins", system-ui, sans-serif' },
  { id: 'merriweather', label: 'Merriweather — classic serif', family: '"Merriweather", Georgia, serif' },
  { id: 'playfair', label: 'Playfair Display — elegant serif', family: '"Playfair Display", Georgia, serif' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono — monospace', family: '"JetBrains Mono", ui-monospace, monospace' },
  { id: 'bungee', label: 'Bungee — poster display', family: '"Bungee", "Space Grotesk", sans-serif' },
  { id: 'bangers', label: 'Bangers — comic display', family: '"Bangers", cursive' },
  { id: 'press-start', label: 'Press Start 2P — retro pixel', family: '"Press Start 2P", ui-monospace, monospace' },
  { id: 'permanent-marker', label: 'Permanent Marker — bold handwritten', family: '"Permanent Marker", cursive' },
  { id: 'luckiest-guy', label: 'Luckiest Guy — graffiti', family: '"Luckiest Guy", "Bungee", cursive' },
  { id: 'orbitron', label: 'Orbitron — sci-fi', family: '"Orbitron", "Space Grotesk", sans-serif' },
] as const;
export type FontId = (typeof FONT_OPTIONS)[number]['id'];

// Border-radius scale presets. Each maps to the four --radius-* CSS vars the
// app's Tailwind config resolves against, so picking a preset globally scales
// how "rounded" every card, input, and container reads. `default` clears the
// override so the base theme's own scale wins.
export const RADIUS_PRESETS = {
  default: null, // no override — use base theme's scale (sm=6, md=10, lg=14, xl=20)
  square: { sm: '0px', md: '2px', lg: '4px', xl: '6px' },
  rounded: { sm: '10px', md: '14px', lg: '20px', xl: '28px' },
  extra: { sm: '14px', md: '20px', lg: '28px', xl: '36px' },
} as const;
export type RadiusId = keyof typeof RADIUS_PRESETS;
export const RADIUS_LABELS: Record<RadiusId, string> = {
  default: 'Standard',
  square: 'Square',
  rounded: 'Rounded',
  extra: 'Extra rounded',
};

// Global text-size scale. Tailwind's type scale (and most spacing) is
// rem-based, so scaling the root font-size scales body copy, headings, and
// most UI chrome together in one move rather than requiring a per-element
// override system.
export const TEXT_SCALE_PRESETS = {
  default: null, // 16px root — no override
  small: '87.5%', // 14px
  large: '112.5%', // 18px
  xlarge: '125%', // 20px
} as const;
export type TextScaleId = keyof typeof TEXT_SCALE_PRESETS;
export const TEXT_SCALE_LABELS: Record<TextScaleId, string> = {
  default: 'Default',
  small: 'Small',
  large: 'Large',
  xlarge: 'Extra large',
};
// Numeric form of the same scale, for callers (the theme-builder preview
// mockup) that need to size individual elements rather than set a root
// font-size percentage.
export const TEXT_SCALE_FACTORS: Record<TextScaleId, number> = {
  default: 1,
  small: 0.875,
  large: 1.125,
  xlarge: 1.25,
};

// A user-built theme config: base id + overrides. Applying it uses the base
// theme's className for structural vars, then overrides accent/text/font
// pieces inline, deriving -hover (lightened) and -muted (translucent) shades.
export interface CustomTheme {
  base: ThemeId;
  primary: string;
  secondary: string;
  // Optional overrides on top of the base theme. All fall back to the base's
  // own values when null/undefined — the builder writes null explicitly when
  // the user clears a picker so we know to remove the override rather than
  // just leave a stale value applied.
  text?: string | null;         // --color-text (main body/heading text)
  textMuted?: string | null;    // --color-text-muted (secondary text, labels)
  background?: string | null;   // --color-bg (page background)
  surface?: string | null;      // --color-surface (cards, panels)
  bgMuted?: string | null;      // --color-bg-muted (subtle-section fill)
  border?: string | null;       // --color-surface-border (card edges)
  success?: string | null;      // --color-success (health-check dots, success badges/toasts)
  error?: string | null;        // --color-error (error badges/toasts, destructive actions)
  fontDisplay?: FontId | null;  // display + body font
  radius?: RadiusId | null;     // global "roundness" preset
  textScale?: TextScaleId | null; // global text-size preset
  progressBar?: string | null;  // Continue Watching's resume progress bar fill — overrides the default primary→secondary gradient with a flat color
}

// A saved user-built theme, with its own id and display name so it can sit
// alongside the built-ins in the picker AND be deleted individually.
export interface SavedCustomTheme extends CustomTheme {
  id: string;   // 'custom_<random>'
  name: string; // human display name, e.g. "My purple"
}

const CUSTOM_THEMES_STORAGE_KEY = 'slicksync-custom-themes';
const LEGACY_CUSTOM_THEME_STORAGE_KEY = 'slicksync-custom-theme'; // pre-v1.25 single-slot
const DEFAULT_CUSTOM: CustomTheme = { base: 'nebula', primary: '#8b7ec8', secondary: '#5fd4c4', text: null, fontDisplay: 'default' };

function randomId(): string {
  return `custom_${Math.random().toString(36).slice(2, 10)}`;
}

// Every theme id currently valid (built-ins + this device's known customs).
export function isBuiltInThemeId(id: string): id is ThemeId {
  return (themeIds as readonly string[]).includes(id);
}
export function isCustomThemeId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('custom_');
}

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

// Vars a custom theme may override on top of its base class. Font vars match
// what the app actually consumes (`--font-space-grotesk` = Tailwind's
// `font-display`, `--font-outfit` = body's default) so swapping one font
// changes both headings AND body text consistently.
const OVERRIDE_VARS = [
  '--color-primary', '--color-primary-hover', '--color-primary-muted', '--color-primaryMuted',
  '--color-secondary', '--color-secondary-muted', '--color-secondaryMuted',
  '--color-chart-1', '--color-chart-2',
  '--color-progress',
  '--color-success', '--color-success-muted', '--color-successMuted',
  '--color-error', '--color-error-muted', '--color-errorMuted',
  '--color-text', '--color-text-muted',
  '--color-bg', '--color-bg-muted',
  '--color-surface', '--color-surface-border',
  '--font-space-grotesk', '--font-outfit',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
  'font-size',
];

function applyCustomTheme(el: HTMLElement, custom: CustomTheme) {
  el.className = custom.base;
  el.style.setProperty('--color-primary', custom.primary);
  el.style.setProperty('--color-primary-hover', lighten(custom.primary));
  el.style.setProperty('--color-primary-muted', rgba(custom.primary, 0.15));
  el.style.setProperty('--color-primaryMuted', rgba(custom.primary, 0.15));
  el.style.setProperty('--color-secondary', custom.secondary);
  el.style.setProperty('--color-secondary-muted', rgba(custom.secondary, 0.15));
  el.style.setProperty('--color-secondaryMuted', rgba(custom.secondary, 0.15));
  el.style.setProperty('--color-chart-1', custom.primary);
  el.style.setProperty('--color-chart-2', custom.secondary);
  if (custom.progressBar) el.style.setProperty('--color-progress', custom.progressBar);
  else el.style.removeProperty('--color-progress');
  if (custom.success) {
    el.style.setProperty('--color-success', custom.success);
    el.style.setProperty('--color-success-muted', rgba(custom.success, 0.15));
    el.style.setProperty('--color-successMuted', rgba(custom.success, 0.15));
  } else {
    el.style.removeProperty('--color-success');
    el.style.removeProperty('--color-success-muted');
    el.style.removeProperty('--color-successMuted');
  }
  if (custom.error) {
    el.style.setProperty('--color-error', custom.error);
    el.style.setProperty('--color-error-muted', rgba(custom.error, 0.15));
    el.style.setProperty('--color-errorMuted', rgba(custom.error, 0.15));
  } else {
    el.style.removeProperty('--color-error');
    el.style.removeProperty('--color-error-muted');
    el.style.removeProperty('--color-errorMuted');
  }
  if (custom.text) el.style.setProperty('--color-text', custom.text);
  else el.style.removeProperty('--color-text');
  if (custom.textMuted) el.style.setProperty('--color-text-muted', custom.textMuted);
  else el.style.removeProperty('--color-text-muted');
  if (custom.background) el.style.setProperty('--color-bg', custom.background);
  else el.style.removeProperty('--color-bg');
  if (custom.bgMuted) el.style.setProperty('--color-bg-muted', custom.bgMuted);
  else el.style.removeProperty('--color-bg-muted');
  if (custom.surface) el.style.setProperty('--color-surface', custom.surface);
  else el.style.removeProperty('--color-surface');
  if (custom.border) el.style.setProperty('--color-surface-border', custom.border);
  else el.style.removeProperty('--color-surface-border');

  const family = fontFamilyFor(custom.fontDisplay);
  if (family) {
    el.style.setProperty('--font-space-grotesk', family);
    el.style.setProperty('--font-outfit', family);
  } else {
    el.style.removeProperty('--font-space-grotesk');
    el.style.removeProperty('--font-outfit');
  }

  // Radius preset — scales the whole --radius-* var family. `default` leaves
  // the base theme's scale untouched (which uses sm=6/md=10/lg=14/xl=20).
  const radiusScale = custom.radius ? RADIUS_PRESETS[custom.radius] : null;
  if (radiusScale) {
    el.style.setProperty('--radius-sm', radiusScale.sm);
    el.style.setProperty('--radius-md', radiusScale.md);
    el.style.setProperty('--radius-lg', radiusScale.lg);
    el.style.setProperty('--radius-xl', radiusScale.xl);
  } else {
    el.style.removeProperty('--radius-sm');
    el.style.removeProperty('--radius-md');
    el.style.removeProperty('--radius-lg');
    el.style.removeProperty('--radius-xl');
  }

  // Text-size preset — scales the root font-size, which the app's rem-based
  // type (and most spacing) inherits from. `default`/unset leaves the
  // browser default (16px) in place.
  const scale = custom.textScale ? TEXT_SCALE_PRESETS[custom.textScale] : null;
  if (scale) el.style.setProperty('font-size', scale);
  else el.style.removeProperty('font-size');
}

function clearCustomTheme(el: HTMLElement) {
  for (const v of OVERRIDE_VARS) el.style.removeProperty(v);
}

// The theme-picker's background glow blobs (PageContainer.tsx) are heavily
// blurred + transform-animated, which Firefox puts on their own GPU
// compositor layer. Custom-property-only changes on documentElement don't
// reliably repaint that layer in the same frame as the rest of the page -
// switching themes quickly could leave the glow showing a stale color (or
// briefly nothing) indefinitely, until something else forced a full
// repaint (a resize, or a hard refresh - which is exactly the workaround
// users found). Reading offsetHeight forces the browser to synchronously
// flush layout/paint right here, so no layer can be left stale.
function forceRepaint() {
  void document.documentElement.offsetHeight;
}

// Migrates the pre-v1.25 single-slot localStorage shape into the list shape.
// Returns { savedList, migratedActiveId } — the latter is set when the user's
// active theme was the old sentinel `'custom'` and needs to be re-pointed at
// the migrated entry's new id.
function migrateLegacyLocalStorage(): { savedList: SavedCustomTheme[]; migratedActiveId: string | null } {
  try {
    const rawList = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    if (rawList) {
      const parsed = JSON.parse(rawList);
      if (Array.isArray(parsed)) return { savedList: parsed.filter(isValidSavedCustom), migratedActiveId: null };
    }
    const rawLegacy = localStorage.getItem(LEGACY_CUSTOM_THEME_STORAGE_KEY);
    if (!rawLegacy) return { savedList: [], migratedActiveId: null };
    const parsed = JSON.parse(rawLegacy);
    if (!parsed || !themeIds.includes(parsed.base) || typeof parsed.primary !== 'string' || typeof parsed.secondary !== 'string') {
      return { savedList: [], migratedActiveId: null };
    }
    const migrated: SavedCustomTheme = {
      id: randomId(),
      name: 'My theme',
      base: parsed.base,
      primary: parsed.primary,
      secondary: parsed.secondary,
      text: typeof parsed.text === 'string' ? parsed.text : null,
      textMuted: null,
      background: null,
      surface: null,
      bgMuted: null,
      border: null,
      progressBar: null,
      success: null,
      error: null,
      fontDisplay: (parsed.fontDisplay as FontId) || 'default',
      radius: 'default',
      textScale: 'default',
    };
    return { savedList: [migrated], migratedActiveId: migrated.id };
  } catch {
    return { savedList: [], migratedActiveId: null };
  }
}

function isValidSavedCustom(x: unknown): x is SavedCustomTheme {
  if (!x || typeof x !== 'object') return false;
  const t = x as SavedCustomTheme;
  return typeof t.id === 'string' && typeof t.name === 'string'
    && themeIds.includes(t.base) && typeof t.primary === 'string' && typeof t.secondary === 'string';
}

// Server payload shape ↔ local shape. Server accepts either the new list
// shape { themeId, customThemes } or the legacy single-slot shape.
type ServerThemePref = {
  themeId?: string;
  customThemes?: SavedCustomTheme[];
  // legacy
  custom?: CustomTheme;
};

interface ThemeContextValue {
  themeId: string; // built-in id OR 'custom_<...>'
  setTheme: (id: string) => void;
  hideSensitive: boolean;
  toggleHideSensitive: () => void;

  savedCustomThemes: SavedCustomTheme[];
  activeCustomTheme: SavedCustomTheme | null;
  isCustom: boolean; // convenience: activeCustomTheme != null

  /** Save a new custom theme with an auto-generated id; returns the new id. */
  saveCustomTheme: (config: CustomTheme, name: string) => string;
  /** Update the theme with the given id (in place). */
  updateCustomTheme: (id: string, config: CustomTheme, name?: string) => void;
  /** Delete a saved custom theme; if active, reverts to Nebula. */
  deleteCustomTheme: (id: string) => void;

  /** Live-preview a config without persisting (for the builder). */
  previewCustom: (c: CustomTheme) => void;
  /** Discard the live preview and reapply whatever's actually active. */
  cancelPreview: () => void;
}

const defaultContextValue: ThemeContextValue = {
  themeId: 'nebula',
  setTheme: () => {},
  hideSensitive: false,
  toggleHideSensitive: () => {},
  savedCustomThemes: [],
  activeCustomTheme: null,
  isCustom: false,
  saveCustomTheme: () => '',
  updateCustomTheme: () => {},
  deleteCustomTheme: () => {},
  previewCustom: () => {},
  cancelPreview: () => {},
};

const ThemeContext = createContext<ThemeContextValue>(defaultContextValue);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState<string>('nebula');
  const [savedCustomThemes, setSavedCustomThemes] = useState<SavedCustomTheme[]>([]);
  const [hideSensitive, setHideSensitive] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Suppress the sync-to-server effect on the initial hydrate and after every
  // server load — otherwise we'd echo the server's own value back to it.
  const skipNextSaveRef = useRef(true);

  const activeCustomTheme = savedCustomThemes.find((t) => t.id === themeId) || null;

  // Initial load: hydrate from localStorage synchronously (no FOUT), then
  // fetch the account-scoped preference from the server and reconcile.
  useEffect(() => {
    const { savedList, migratedActiveId } = migrateLegacyLocalStorage();
    setSavedCustomThemes(savedList);

    const savedTheme = localStorage.getItem('slicksync-theme');
    let initial: string = 'nebula';
    if (savedTheme === 'custom' && migratedActiveId) {
      initial = migratedActiveId; // legacy hydration
    } else if (savedTheme && (isBuiltInThemeId(savedTheme) || savedList.some((t) => t.id === savedTheme))) {
      initial = savedTheme;
    }
    setThemeIdState(initial);

    const savedHideSensitive = localStorage.getItem('slicksync-hide-sensitive') === 'true';
    setHideSensitive(savedHideSensitive);

    const active = savedList.find((t) => t.id === initial);
    if (active) applyCustomTheme(document.documentElement, active);
    else if (isBuiltInThemeId(initial)) document.documentElement.className = initial;
    setMounted(true);

    // Reconcile with the server pref — this is what makes a change on one
    // device show up on another.
    api.getThemePref()
      .then((r) => {
        const pref = (r?.themePref || null) as ServerThemePref | null;
        if (!pref) return;
        let list: SavedCustomTheme[] = [];
        let nextActive: string | null = null;
        if (Array.isArray(pref.customThemes)) {
          list = pref.customThemes.filter(isValidSavedCustom);
        } else if (pref.custom && typeof pref.custom === 'object') {
          // Legacy server shape — migrate on the fly, same as localStorage.
          const migrated: SavedCustomTheme = {
            id: randomId(), name: 'My theme',
            base: pref.custom.base, primary: pref.custom.primary, secondary: pref.custom.secondary,
            text: pref.custom.text || null,
            textMuted: null,
            background: null,
            surface: null,
            bgMuted: null,
            border: null,
            progressBar: null,
            success: null,
            error: null,
            fontDisplay: (pref.custom.fontDisplay as FontId) || 'default',
            radius: 'default',
            textScale: 'default',
          };
          if (isValidSavedCustom(migrated)) { list = [migrated]; if (pref.themeId === 'custom') nextActive = migrated.id; }
        }
        if (nextActive === null && typeof pref.themeId === 'string' && (isBuiltInThemeId(pref.themeId) || list.some((t) => t.id === pref.themeId))) {
          nextActive = pref.themeId;
        }
        if (list.length > 0 || nextActive) {
          skipNextSaveRef.current = true;
          setSavedCustomThemes(list);
          if (nextActive) setThemeIdState(nextActive);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Applies whichever theme `id` resolves to (a saved custom, a built-in, or
  // neither) straight to the DOM. Pulled out of the effect below so setTheme
  // can call it directly and unconditionally — see setTheme's comment for
  // why that matters. Returns false when `id` didn't resolve to anything
  // (caller falls back to Nebula).
  const applyThemeForId = (id: string, list: SavedCustomTheme[]): boolean => {
    const active = list.find((t) => t.id === id);
    if (active) {
      applyCustomTheme(document.documentElement, active);
      forceRepaint();
      return true;
    }
    if (isBuiltInThemeId(id)) {
      clearCustomTheme(document.documentElement);
      document.documentElement.className = id;
      forceRepaint();
      return true;
    }
    return false;
  };

  // Apply theme + persist locally + sync to server whenever the effective
  // theme (id or the active custom's config) changes.
  useEffect(() => {
    if (!mounted) return;
    if (!applyThemeForId(themeId, savedCustomThemes)) {
      // themeId points to a custom that no longer exists (e.g. deleted on
      // another device); fall back to Nebula.
      clearCustomTheme(document.documentElement);
      document.documentElement.className = 'nebula';
      setThemeIdState('nebula');
      return;
    }

    localStorage.setItem('slicksync-theme', themeId);
    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(savedCustomThemes));

    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    api.saveThemePref({ themeId, customThemes: savedCustomThemes }).catch(() => {});
  }, [themeId, savedCustomThemes, mounted]);

  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem('slicksync-hide-sensitive', String(hideSensitive));
  }, [hideSensitive, mounted]);

  const setTheme = (id: string) => {
    if (isBuiltInThemeId(id) || savedCustomThemes.some((t) => t.id === id)) {
      // Apply straight to the DOM here, not just via setThemeIdState below.
      // React bails out of re-rendering (and therefore skips the effect
      // above) when the new value is identical to the current state - which
      // matters because previewCustom() mutates the DOM directly, entirely
      // outside this state. Re-selecting the theme you're already "on" (an
      // easy thing to do while going back and forth between a live builder
      // preview and a saved theme) would otherwise leave that stale preview
      // stuck on screen until a hard refresh remounts this provider and
      // re-derives the DOM fresh from localStorage. Applying unconditionally
      // here makes the reset work regardless of whether themeId "changes."
      applyThemeForId(id, savedCustomThemes);
      setThemeIdState(id);
    }
  };

  const saveCustomTheme = (config: CustomTheme, name: string): string => {
    const trimmed = name.trim() || `Custom theme ${savedCustomThemes.length + 1}`;
    const id = randomId();
    const entry: SavedCustomTheme = {
      id, name: trimmed,
      base: config.base, primary: config.primary, secondary: config.secondary,
      text: config.text || null,
      textMuted: config.textMuted || null,
      background: config.background || null,
      surface: config.surface || null,
      bgMuted: config.bgMuted || null,
      border: config.border || null,
      progressBar: config.progressBar || null,
      success: config.success || null,
      error: config.error || null,
      fontDisplay: config.fontDisplay || 'default',
      radius: config.radius || 'default',
      textScale: config.textScale || 'default',
    };
    setSavedCustomThemes((prev) => [...prev, entry]);
    setThemeIdState(id); // auto-switch to the newly-created theme
    return id;
  };

  const updateCustomTheme = (id: string, config: CustomTheme, name?: string) => {
    setSavedCustomThemes((prev) => prev.map((t) => t.id === id ? {
      ...t,
      base: config.base,
      primary: config.primary,
      secondary: config.secondary,
      text: config.text || null,
      textMuted: config.textMuted || null,
      background: config.background || null,
      surface: config.surface || null,
      bgMuted: config.bgMuted || null,
      border: config.border || null,
      progressBar: config.progressBar || null,
      success: config.success || null,
      error: config.error || null,
      fontDisplay: config.fontDisplay || 'default',
      radius: config.radius || 'default',
      textScale: config.textScale || 'default',
      name: name?.trim() || t.name,
    } : t));
    // If it's the active theme, re-apply immediately so the change shows
    // without waiting for the next effect tick (the effect will still fire).
    if (themeId === id) {
      const merged: CustomTheme = {
        ...config,
        text: config.text || null,
        textMuted: config.textMuted || null,
        background: config.background || null,
        surface: config.surface || null,
        bgMuted: config.bgMuted || null,
        border: config.border || null,
        progressBar: config.progressBar || null,
        success: config.success || null,
        error: config.error || null,
        fontDisplay: config.fontDisplay || 'default',
        radius: config.radius || 'default',
        textScale: config.textScale || 'default',
      };
      applyCustomTheme(document.documentElement, merged);
      forceRepaint();
    }
  };

  const deleteCustomTheme = (id: string) => {
    setSavedCustomThemes((prev) => prev.filter((t) => t.id !== id));
    if (themeId === id) setThemeIdState('nebula');
  };

  const previewCustom = (c: CustomTheme) => {
    applyCustomTheme(document.documentElement, c);
    forceRepaint();
  };

  const cancelPreview = () => {
    const active = savedCustomThemes.find((t) => t.id === themeId);
    if (active) {
      applyCustomTheme(document.documentElement, active);
      forceRepaint();
    } else if (isBuiltInThemeId(themeId)) {
      clearCustomTheme(document.documentElement);
      document.documentElement.className = themeId;
      forceRepaint();
    }
  };

  const toggleHideSensitive = () => setHideSensitive((prev) => !prev);

  return (
    <ThemeContext.Provider value={{
      themeId,
      setTheme,
      hideSensitive,
      toggleHideSensitive,
      savedCustomThemes,
      activeCustomTheme,
      isCustom: activeCustomTheme != null,
      saveCustomTheme,
      updateCustomTheme,
      deleteCustomTheme,
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
