'use client';

import { useState, useEffect, useRef, memo } from 'react';
import { motion } from 'framer-motion';
import { Header } from '@/components/layout/Header';
import { NebulaTopbar, NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { Button, Card, Badge, ConfirmModal } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import {
  useTheme, themeMeta, themeIds, ThemeId, FONT_OPTIONS, FontId, CustomTheme, SavedCustomTheme,
  RADIUS_PRESETS, RADIUS_LABELS, RadiusId, TEXT_SCALE_PRESETS, TEXT_SCALE_LABELS, TEXT_SCALE_FACTORS, TextScaleId,
  THEME_REAL_COLORS,
} from '@/lib/theme';
import { useLayoutMode, layoutModeMeta, layoutModeIds, LayoutModeId } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import {
  PaintBrushIcon,
  SwatchIcon,
  CheckIcon,
  TrashIcon,
  SparklesIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';

// Memoized theme card component
const ThemeCard = memo(function ThemeCard({
  themeId,
  meta,
  isSelected,
  onSelect,
}: {
  themeId: ThemeId;
  meta: typeof themeMeta[ThemeId];
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { colors } = meta;

  return (
    <motion.button
      whileHover={{ scale: 1.02, y: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onSelect}
      className={`relative p-3 rounded-xl border-2 transition-all text-left w-full card ${
        isSelected ? 'border-primary bg-primary-muted' : 'border-default'
      }`}
    >
      {isSelected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center bg-primary">
          <CheckIcon className="w-3 h-3 text-default" style={{ color: 'var(--color-bg)' }} />
        </div>
      )}

      {/* Theme preview - mini mockup */}
      <div
        className="w-full h-20 rounded-lg mb-2 overflow-hidden border border-default"
        style={{ backgroundColor: colors.bg }}
      >
        {/* Mini sidebar */}
        <div className="flex h-full">
          <div
            className="w-8 h-full flex flex-col gap-1 p-1.5"
            style={{ backgroundColor: colors.surface }}
          >
            <div
              className="w-full h-1.5 rounded-full"
              style={{ backgroundColor: colors.primary }}
            />
            <div
              className="w-full h-1 rounded-full opacity-30"
              style={{ backgroundColor: '#fff' }}
            />
            <div
              className="w-full h-1 rounded-full opacity-30"
              style={{ backgroundColor: '#fff' }}
            />
          </div>
          {/* Mini content area */}
          <div className="flex-1 p-2 flex flex-col gap-1.5">
            {/* Header bar */}
            <div
              className="w-12 h-1.5 rounded-full opacity-40"
              style={{ backgroundColor: '#fff' }}
            />
            {/* Cards row */}
            <div className="flex gap-1 mt-1">
              <div
                className="w-6 h-6 rounded"
                style={{ backgroundColor: colors.surface }}
              />
              <div
                className="w-6 h-6 rounded"
                style={{ backgroundColor: colors.surface }}
              />
              <div
                className="w-6 h-6 rounded"
                style={{ backgroundColor: colors.primary, opacity: 0.3 }}
              />
            </div>
            {/* Button */}
            <div
              className="w-8 h-2 rounded mt-auto"
              style={{ backgroundColor: colors.primary }}
            />
          </div>
        </div>
      </div>

      {/* Color swatches */}
      <div className="flex gap-1 mb-2">
        <div
          className="w-4 h-4 rounded-full border border-white/10"
          style={{ backgroundColor: colors.bg }}
          title="Background"
        />
        <div
          className="w-4 h-4 rounded-full border border-white/10"
          style={{ backgroundColor: colors.surface }}
          title="Surface"
        />
        <div
          className="w-4 h-4 rounded-full border border-white/10"
          style={{ backgroundColor: colors.primary }}
          title="Primary"
        />
        <div
          className="w-4 h-4 rounded-full border border-white/10"
          style={{ backgroundColor: colors.secondary }}
          title="Secondary"
        />
      </div>

      <p className="font-medium text-sm text-default">
        {meta.name}
      </p>
      <p className="text-xs text-muted">
        {meta.description}
      </p>
    </motion.button>
  );
});

// Same visual card shape as ThemeCard, but takes a user-created SavedCustomTheme
// (which has no themeMeta entry) and adds a delete affordance in the corner —
// built-in themes shouldn't ever be deletable, so this is a separate component
// rather than a `deletable?` prop on ThemeCard.
const CustomThemeCard = memo(function CustomThemeCard({
  theme,
  isSelected,
  onSelect,
  onDelete,
}: {
  theme: SavedCustomTheme;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  // Derive the base theme's structural colors for the mini-mockup preview so
  // the card visually resembles the built-in one it's based on.
  const base = themeMeta[theme.base];
  return (
    <motion.button
      whileHover={{ scale: 1.02, y: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onSelect}
      className={`relative p-3 rounded-xl border-2 transition-all text-left w-full card ${
        isSelected ? 'border-primary bg-primary-muted' : 'border-default'
      }`}
    >
      {isSelected && (
        <div className="absolute top-2 right-8 w-5 h-5 rounded-full flex items-center justify-center bg-primary">
          <CheckIcon className="w-3 h-3" style={{ color: 'var(--color-bg)' }} />
        </div>
      )}
      {/* Delete — stopPropagation so a delete-click doesn't ALSO select the
          theme on its way to being removed. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        aria-label={`Delete ${theme.name}`}
        title={`Delete ${theme.name}`}
        className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center bg-surface-hover hover:bg-red-500/70 hover:text-white text-muted transition-colors"
      >
        <TrashIcon className="w-3 h-3" />
      </button>

      {/* Mini mockup — reuses the base theme's structural colors but paints
          the accents from the custom's own primary/secondary. */}
      <div
        className="w-full h-20 rounded-lg mb-2 overflow-hidden border border-default"
        style={{ backgroundColor: base.colors.bg }}
      >
        <div className="flex h-full">
          <div className="w-8 h-full flex flex-col gap-1 p-1.5" style={{ backgroundColor: base.colors.surface }}>
            <div className="w-full h-1.5 rounded-full" style={{ backgroundColor: theme.primary }} />
            <div className="w-full h-1 rounded-full opacity-30" style={{ backgroundColor: '#fff' }} />
            <div className="w-full h-1 rounded-full opacity-30" style={{ backgroundColor: '#fff' }} />
          </div>
          <div className="flex-1 p-2 flex flex-col gap-1.5">
            <div className="w-12 h-1.5 rounded-full opacity-40" style={{ backgroundColor: '#fff' }} />
            <div className="flex gap-1 mt-1">
              <div className="w-6 h-6 rounded" style={{ backgroundColor: base.colors.surface }} />
              <div className="w-6 h-6 rounded" style={{ backgroundColor: base.colors.surface }} />
              <div className="w-6 h-6 rounded" style={{ backgroundColor: theme.primary, opacity: 0.3 }} />
            </div>
            <div className="w-8 h-2 rounded mt-auto" style={{ background: `linear-gradient(90deg, ${theme.primary}, ${theme.secondary})` }} />
          </div>
        </div>
      </div>

      <div className="flex gap-1 mb-2">
        <div className="w-4 h-4 rounded-full border border-white/10" style={{ backgroundColor: base.colors.bg }} title="Background (from base)" />
        <div className="w-4 h-4 rounded-full border border-white/10" style={{ backgroundColor: base.colors.surface }} title="Surface (from base)" />
        <div className="w-4 h-4 rounded-full border border-white/10" style={{ backgroundColor: theme.primary }} title="Primary" />
        <div className="w-4 h-4 rounded-full border border-white/10" style={{ backgroundColor: theme.secondary }} title="Secondary" />
      </div>

      <p className="font-medium text-sm text-default truncate">{theme.name}</p>
      <p className="text-xs text-muted">Custom · based on {base.name}</p>
    </motion.button>
  );
});

// The Build-your-own theme's color-override inputs all follow the same shape:
// a color picker seeded with a fallback when there's no override, a hex label,
// and a "reset" affordance to clear the override back to the base theme's own
// value. Extracted so adding a new override is one JSX line, not thirty.
const ColorOverride = memo(function ColorOverride({
  label,
  value,
  seed,
  onSet,
  onClear,
}: {
  label: string;
  value: string;
  seed: string;
  onSet: (v: string) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-2 text-muted">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || seed}
          onChange={(e) => onSet(e.target.value)}
          className="w-12 h-10 rounded-lg cursor-pointer border border-default bg-transparent p-0.5"
        />
        {value ? (
          <>
            <span className="text-xs font-mono text-muted uppercase">{value}</span>
            <button
              type="button"
              onClick={onClear}
              className="text-[11px] text-muted hover:text-default transition-colors"
              title="Clear override — use the base theme's own value"
            >
              reset
            </button>
          </>
        ) : (
          <span className="text-[11px] text-muted italic">using base</span>
        )}
      </div>
    </div>
  );
});

// The base theme's own corner scale, used as the preview mockup's fallback
// when the builder's radius preset is 'default' (RADIUS_PRESETS['default']
// is null there, meaning "don't override" — the mockup still needs a value
// to render with).
const BASE_RADIUS_PX = { sm: '6px', md: '10px', lg: '14px', xl: '20px' };

// Resolves the builder's overrides against its base theme's own palette, so
// the preview mockup always has something sensible to show for fields the
// user hasn't touched yet — same fallback semantics as what applyCustomTheme
// does to the real page, just computed locally so the mockup doesn't depend
// on document.documentElement having already re-rendered.
function resolvePreviewPalette(base: ThemeId, o: {
  primary: string; secondary: string; text: string; textMuted: string;
  background: string; surface: string; bgMuted: string; border: string;
  progressBar: string; success: string; error: string;
}) {
  const meta = themeMeta[base].colors;
  const real = THEME_REAL_COLORS[base];
  return {
    bg: o.background || meta.bg,
    surface: o.surface || meta.surface,
    bgMuted: o.bgMuted || real.bgMuted,
    border: o.border || real.border,
    text: o.text || real.text,
    textMuted: o.textMuted || real.textMuted,
    primary: o.primary || meta.primary,
    secondary: o.secondary || meta.secondary,
    success: o.success || real.success,
    error: o.error || real.error,
    // No fallback constant here — a blank override means "keep the default
    // primary→secondary gradient," which the caller renders itself.
    progressBar: o.progressBar || null,
  };
}

// Layout mode card - structure preview only (sidebar-vs-topbar), not colors,
// since layout mode is orthogonal to the Theme setting and should read as
// "shape," not "another color choice."
const LayoutModeCard = memo(function LayoutModeCard({
  layoutId,
  isSelected,
  onSelect,
}: {
  layoutId: LayoutModeId;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const meta = layoutModeMeta[layoutId];

  return (
    <motion.button
      whileHover={{ scale: 1.02, y: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onSelect}
      className={`relative p-3 rounded-xl border-2 transition-all text-left w-full card ${
        isSelected ? 'border-primary bg-primary-muted' : 'border-default'
      }`}
    >
      {isSelected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center bg-primary">
          <CheckIcon className="w-3 h-3" style={{ color: 'var(--color-bg)' }} />
        </div>
      )}

      <div
        className="w-full h-20 rounded-lg mb-2 overflow-hidden border border-default"
        style={{ backgroundColor: 'var(--color-bg)' }}
      >
        {layoutId === 'current' ? (
          <div className="flex h-full">
            <div className="w-8 h-full flex flex-col gap-1 p-1.5" style={{ backgroundColor: 'var(--color-surface)' }}>
              <div className="w-full h-1.5 rounded-full" style={{ backgroundColor: 'var(--color-primary)' }} />
              <div className="w-full h-1 rounded-full opacity-30 bg-white" />
              <div className="w-full h-1 rounded-full opacity-30 bg-white" />
            </div>
            <div className="flex-1 p-2 flex flex-col gap-1.5">
              <div className="flex gap-1">
                <div className="w-6 h-6 rounded" style={{ backgroundColor: 'var(--color-surface)' }} />
                <div className="w-6 h-6 rounded" style={{ backgroundColor: 'var(--color-surface)' }} />
              </div>
              <div className="flex-1 rounded mt-1" style={{ backgroundColor: 'var(--color-surface)' }} />
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col p-1.5 gap-1.5">
            <div
              className="h-4 rounded-full flex items-center justify-center gap-0.5"
              style={{ backgroundColor: 'var(--color-surface)' }}
            >
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))' }} />
              <div className="w-4 h-1 rounded-full opacity-40 bg-white" />
            </div>
            <div className="flex-1 flex gap-1">
              <div className="flex-1 rounded-lg" style={{ backgroundColor: 'var(--color-surface)', opacity: 0.8 }} />
              <div className="w-6 rounded-lg" style={{ backgroundColor: 'var(--color-surface)', opacity: 0.5 }} />
              <div className="w-6 rounded-lg" style={{ backgroundColor: 'var(--color-surface)', opacity: 0.5 }} />
            </div>
          </div>
        )}
      </div>

      <p className="font-medium text-sm text-default">
        {meta.name}
      </p>
      <p className="text-xs text-muted">
        {meta.description}
      </p>
    </motion.button>
  );
});

export default function ThemesPage() {
  const {
    themeId, setTheme,
    isCustom, activeCustomTheme, savedCustomThemes,
    saveCustomTheme, updateCustomTheme, deleteCustomTheme,
    previewCustom, cancelPreview,
  } = useTheme();
  const { layoutMode, setLayoutMode } = useLayoutMode();
  // Confirmation modal for deleting a saved custom theme.
  const [pendingDelete, setPendingDelete] = useState<SavedCustomTheme | null>(null);

  // Custom-theme builder working state. When a custom is active, seed from it
  // (so the builder shows what you're currently using); otherwise fresh defaults.
  const [builderName, setBuilderName] = useState<string>(activeCustomTheme?.name || '');
  const [builderBase, setBuilderBase] = useState<ThemeId>(activeCustomTheme?.base || 'nebula');
  const [builderPrimary, setBuilderPrimary] = useState(activeCustomTheme?.primary || '#8b7ec8');
  const [builderSecondary, setBuilderSecondary] = useState(activeCustomTheme?.secondary || '#5fd4c4');
  // All below are optional: null/'default' means "use the base theme's own
  // value". A concrete value overrides on top.
  const [builderText, setBuilderText] = useState<string>(activeCustomTheme?.text || '');
  const [builderTextMuted, setBuilderTextMuted] = useState<string>(activeCustomTheme?.textMuted || '');
  const [builderBackground, setBuilderBackground] = useState<string>(activeCustomTheme?.background || '');
  const [builderSurface, setBuilderSurface] = useState<string>(activeCustomTheme?.surface || '');
  const [builderBgMuted, setBuilderBgMuted] = useState<string>(activeCustomTheme?.bgMuted || '');
  const [builderBorder, setBuilderBorder] = useState<string>(activeCustomTheme?.border || '');
  const [builderProgressBar, setBuilderProgressBar] = useState<string>(activeCustomTheme?.progressBar || '');
  const [builderSuccess, setBuilderSuccess] = useState<string>(activeCustomTheme?.success || '');
  const [builderError, setBuilderError] = useState<string>(activeCustomTheme?.error || '');
  const [builderFont, setBuilderFont] = useState<FontId>((activeCustomTheme?.fontDisplay as FontId) || 'default');
  const [builderRadius, setBuilderRadius] = useState<RadiusId>((activeCustomTheme?.radius as RadiusId) || 'default');
  const [builderTextScale, setBuilderTextScale] = useState<TextScaleId>((activeCustomTheme?.textScale as TextScaleId) || 'default');
  // Assemble the current builder state into a CustomTheme so every change site
  // can call `previewCustom(buildDraft())` without repeating every field.
  const buildDraft = (): CustomTheme => ({
    base: builderBase,
    primary: builderPrimary,
    secondary: builderSecondary,
    text: builderText.trim() ? builderText.trim() : null,
    textMuted: builderTextMuted.trim() ? builderTextMuted.trim() : null,
    background: builderBackground.trim() ? builderBackground.trim() : null,
    surface: builderSurface.trim() ? builderSurface.trim() : null,
    bgMuted: builderBgMuted.trim() ? builderBgMuted.trim() : null,
    border: builderBorder.trim() ? builderBorder.trim() : null,
    progressBar: builderProgressBar.trim() ? builderProgressBar.trim() : null,
    success: builderSuccess.trim() ? builderSuccess.trim() : null,
    error: builderError.trim() ? builderError.trim() : null,
    fontDisplay: builderFont,
    radius: builderRadius,
    textScale: builderTextScale,
  });
  // Re-seed the builder when the active custom theme changes out from under
  // it (cross-device sync, or the user selects a different custom to edit).
  useEffect(() => {
    setBuilderName(activeCustomTheme?.name || '');
    setBuilderBase(activeCustomTheme?.base || 'nebula');
    setBuilderPrimary(activeCustomTheme?.primary || '#8b7ec8');
    setBuilderSecondary(activeCustomTheme?.secondary || '#5fd4c4');
    setBuilderText(activeCustomTheme?.text || '');
    setBuilderTextMuted(activeCustomTheme?.textMuted || '');
    setBuilderBackground(activeCustomTheme?.background || '');
    setBuilderSurface(activeCustomTheme?.surface || '');
    setBuilderBgMuted(activeCustomTheme?.bgMuted || '');
    setBuilderBorder(activeCustomTheme?.border || '');
    setBuilderProgressBar(activeCustomTheme?.progressBar || '');
    setBuilderSuccess(activeCustomTheme?.success || '');
    setBuilderError(activeCustomTheme?.error || '');
    setBuilderFont((activeCustomTheme?.fontDisplay as FontId) || 'default');
    setBuilderRadius((activeCustomTheme?.radius as RadiusId) || 'default');
    setBuilderTextScale((activeCustomTheme?.textScale as TextScaleId) || 'default');
  }, [activeCustomTheme]);
  // Revert any unsaved live preview when leaving this page (a saved theme is
  // a no-op here since cancelPreview just re-applies whatever's active). Kept
  // in a ref so the unmount cleanup uses the latest active-theme state, not a
  // stale closure from first render.
  const cancelPreviewRef = useRef(cancelPreview);
  cancelPreviewRef.current = cancelPreview;
  useEffect(() => () => cancelPreviewRef.current(), []);

  return (
    <>
      {layoutMode === 'nebula' ? (
        <NebulaTopbar />
      ) : (
        <Header
          title="Themes"
          subtitle="Pick a built-in theme, or build your own"
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-6 lg:p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : 'max-w-4xl'} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
      {layoutMode === 'nebula' && (
        <NebulaPageHeading title="Themes" subtitle="Pick a built-in theme, or build your own" />
      )}

        {/* Theme Selection */}
        <PageSection className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <PaintBrushIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Theme</h3>
                <p className="text-xs text-muted">Choose your preferred color scheme</p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {themeIds.map((id) => (
                <ThemeCard
                  key={id}
                  themeId={id}
                  meta={themeMeta[id]}
                  isSelected={themeId === id}
                  onSelect={() => setTheme(id)}
                />
              ))}
              {/* User-created themes rendered alongside the built-ins, with a
                  delete button. Built-ins are never deletable. */}
              {savedCustomThemes.map((t) => (
                <CustomThemeCard
                  key={t.id}
                  theme={t}
                  isSelected={themeId === t.id}
                  onSelect={() => setTheme(t.id)}
                  onDelete={() => setPendingDelete(t)}
                />
              ))}
            </div>
          </Card>
        </PageSection>

        {/* Layout - structure, independent of Theme's color choice. Scoped
            to Dashboard + Activity today; other pages are unaffected. */}
        <PageSection delay={0.05} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <Squares2X2Icon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Layout</h3>
                <p className="text-xs text-muted">Choose how Dashboard and Activity are arranged</p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {layoutModeIds.map((id) => (
                <LayoutModeCard
                  key={id}
                  layoutId={id}
                  isSelected={layoutMode === id}
                  onSelect={() => setLayoutMode(id)}
                />
              ))}
            </div>
          </Card>
        </PageSection>

        {/* Custom Theme builder - pick your own accent colors on top of any
            base theme's structure, live-preview, and save. */}
        <PageSection delay={0.1} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-secondary-muted">
                <SwatchIcon className="w-5 h-5 text-secondary" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold font-display text-default">Build your own theme</h3>
                <p className="text-xs text-muted">Pick a base for the background &amp; text, then your own accent colors. Preview updates live.</p>
              </div>
              {isCustom && <Badge variant="success" size="sm">Active</Badge>}
            </div>

            <div className="space-y-4">
              {/* Live mockup — a small "app screenshot" rendered with the
                  builder's own resolved colors/font/radius/text-scale: brand
                  mark + wordmark, a stat row, the real Continue Watching
                  progress bar, tag pills, body copy, and buttons + a toggle.
                  Deliberately samples a bit of everything the builder
                  controls, not just accents, so nothing is a surprise once
                  it's applied for real. Independent of
                  document.documentElement so it's accurate even mid-drag on a
                  color input. */}
              <div>
                <label className="block text-xs font-medium mb-2 text-muted">Preview</label>
                {(() => {
                  const p = resolvePreviewPalette(builderBase, {
                    primary: builderPrimary, secondary: builderSecondary,
                    text: builderText, textMuted: builderTextMuted,
                    background: builderBackground, surface: builderSurface,
                    bgMuted: builderBgMuted, border: builderBorder,
                    progressBar: builderProgressBar, success: builderSuccess, error: builderError,
                  });
                  const radiusScale = builderRadius !== 'default' ? RADIUS_PRESETS[builderRadius] : null;
                  const rLg = radiusScale?.lg || BASE_RADIUS_PX.lg;
                  const rMd = radiusScale?.md || BASE_RADIUS_PX.md;
                  const rSm = radiusScale?.sm || BASE_RADIUS_PX.sm;
                  const fontFamily = FONT_OPTIONS.find((f) => f.id === builderFont)?.family || undefined;
                  const scale = TEXT_SCALE_FACTORS[builderTextScale];
                  const progressFill = p.progressBar || `linear-gradient(90deg, ${p.primary}, ${p.secondary})`;
                  const progressAccent = p.progressBar || p.primary;
                  return (
                    <>
                      <div
                        className="relative overflow-hidden"
                        style={{ borderRadius: rLg, border: `1px solid ${p.border}`, boxShadow: '0 12px 28px -14px rgba(0,0,0,0.45)' }}
                      >
                        {/* accent strip — the accent pairing at a glance before reading anything else */}
                        <div className="h-[3px] w-full" style={{ background: `linear-gradient(90deg, ${p.primary}, ${p.secondary})` }} />
                        <div className="p-5" style={{ background: p.bg, fontFamily }}>
                          {/* mini app header: brand mark + wordmark + avatar */}
                          <div className="flex items-center gap-2.5 mb-4">
                            <div
                              className="w-7 h-7 flex items-center justify-center shrink-0"
                              style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.secondary})`, borderRadius: rMd }}
                            >
                              <SparklesIcon className="w-3.5 h-3.5" style={{ color: '#fff' }} />
                            </div>
                            <span className="font-bold truncate" style={{ color: p.text, fontSize: `${14.5 * scale}px` }}>
                              {builderName.trim() || 'SlickSync'}
                            </span>
                            <div
                              className="ml-auto w-6 h-6 rounded-full flex items-center justify-center shrink-0 font-semibold"
                              style={{ background: p.bgMuted, color: p.textMuted, fontSize: `${9.5 * scale}px` }}
                            >
                              A
                            </div>
                          </div>

                          {/* status dots — same green/red health-check language as the
                              real Addons list, so Success/Error accents show up somewhere too */}
                          <div className="flex items-center gap-3 mb-4">
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.success }} />
                              <span style={{ color: p.textMuted, fontSize: `${10 * scale}px` }}>Online</span>
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.error }} />
                              <span style={{ color: p.textMuted, fontSize: `${10 * scale}px` }}>Offline</span>
                            </span>
                          </div>

                          {/* stat tiles — each in a different accent so primary/secondary/text all show up somewhere */}
                          <div className="grid grid-cols-3 gap-2 mb-4">
                            {[
                              { n: '1.2K', l: 'Watched', c: p.primary },
                              { n: '42h', l: 'This week', c: p.secondary },
                              { n: '12', l: 'Active', c: p.text },
                            ].map((s) => (
                              <div key={s.l} className="text-center py-2 px-1" style={{ background: p.bgMuted, borderRadius: rSm }}>
                                <p className="font-bold leading-tight" style={{ color: s.c, fontSize: `${14 * scale}px` }}>{s.n}</p>
                                <p className="uppercase tracking-wide leading-tight mt-0.5" style={{ color: p.textMuted, fontSize: `${8.5 * scale}px` }}>{s.l}</p>
                              </div>
                            ))}
                          </div>

                          {/* Continue Watching card, bound to the real progress-bar override */}
                          <div
                            className="p-3 mb-4"
                            style={{ background: p.surface, border: `1px solid ${p.border}`, borderRadius: rMd }}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-medium" style={{ color: p.text, fontSize: `${12 * scale}px` }}>Continue Watching</span>
                              <span
                                className="px-1.5 py-0.5 font-semibold"
                                style={{ background: `${progressAccent}26`, color: progressAccent, borderRadius: rSm, fontSize: `${10 * scale}px` }}
                              >
                                62%
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden" style={{ background: p.bgMuted, borderRadius: rSm }}>
                              <div className="h-full w-2/3" style={{ background: progressFill }} />
                            </div>
                          </div>

                          {/* tag pills — genre/tag chips, same visual language as Discover + Addons */}
                          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
                            <span className="px-2 py-0.5 font-medium" style={{ background: `${p.primary}22`, color: p.primary, borderRadius: rSm, fontSize: `${10 * scale}px` }}>Action</span>
                            <span className="px-2 py-0.5 font-medium" style={{ background: `${p.secondary}22`, color: p.secondary, borderRadius: rSm, fontSize: `${10 * scale}px` }}>4K</span>
                            <span className="px-2 py-0.5 font-medium" style={{ background: p.bgMuted, color: p.textMuted, borderRadius: rSm, fontSize: `${10 * scale}px` }}>Kids</span>
                          </div>

                          {/* body copy, on the resolved muted color */}
                          <p className="mb-4" style={{ color: p.textMuted, fontSize: `${11.5 * scale}px`, lineHeight: 1.5 }}>
                            The quick brown fox jumps over the lazy dog — body text and captions render like this.
                          </p>

                          {/* buttons + a toggle switch */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className="px-3 py-1.5 font-semibold"
                              style={{ background: p.primary, color: '#fff', borderRadius: rMd, fontSize: `${12 * scale}px` }}
                            >
                              Primary
                            </span>
                            <span
                              className="px-3 py-1.5 font-semibold"
                              style={{ background: 'transparent', color: p.primary, border: `1px solid ${p.primary}`, borderRadius: rMd, fontSize: `${12 * scale}px` }}
                            >
                              Secondary
                            </span>
                            <span
                              className="ml-auto w-8 h-[18px] rounded-full flex items-center px-0.5 shrink-0"
                              style={{ background: p.primary }}
                            >
                              <span className="w-3.5 h-3.5 rounded-full bg-white ml-auto block" />
                            </span>
                          </div>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted mt-2">
                        Based on {themeMeta[builderBase].name}
                      </p>
                    </>
                  );
                })()}
              </div>

              <div>
                <label className="block text-xs font-medium mb-2 text-muted">Theme name</label>
                <input
                  type="text"
                  value={builderName}
                  onChange={(e) => setBuilderName(e.target.value)}
                  placeholder={`Custom theme ${savedCustomThemes.length + 1}`}
                  className="input-base px-3 py-2 text-sm w-full max-w-xs"
                />
                <p className="text-[11px] text-muted mt-1">
                  Saved themes appear alongside the built-in ones above.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium mb-2 text-muted">Base (background, surfaces, text)</label>
                <select
                  value={builderBase}
                  onChange={(e) => { const v = e.target.value as ThemeId; setBuilderBase(v); previewCustom({ ...buildDraft(), base: v }); }}
                  className="input-base px-3 py-2 text-sm w-full max-w-xs"
                >
                  {themeIds.map((id) => (
                    <option key={id} value={id}>{themeMeta[id].name}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap gap-6">
                <div>
                  <label className="block text-xs font-medium mb-2 text-muted">Primary accent</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={builderPrimary}
                      onChange={(e) => { setBuilderPrimary(e.target.value); previewCustom({ ...buildDraft(), primary: e.target.value }); }}
                      className="w-12 h-10 rounded-lg cursor-pointer border border-default bg-transparent p-0.5"
                    />
                    <span className="text-xs font-mono text-muted uppercase">{builderPrimary}</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-2 text-muted">Secondary accent</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={builderSecondary}
                      onChange={(e) => { setBuilderSecondary(e.target.value); previewCustom({ ...buildDraft(), secondary: e.target.value }); }}
                      className="w-12 h-10 rounded-lg cursor-pointer border border-default bg-transparent p-0.5"
                    />
                    <span className="text-xs font-mono text-muted uppercase">{builderSecondary}</span>
                  </div>
                </div>
                <ColorOverride
                  label="Text color (optional)"
                  value={builderText}
                  seed={THEME_REAL_COLORS[builderBase].text}
                  onSet={(v) => { setBuilderText(v); previewCustom({ ...buildDraft(), text: v }); }}
                  onClear={() => { setBuilderText(''); previewCustom({ ...buildDraft(), text: null }); }}
                />
                <ColorOverride
                  label="Muted text (optional)"
                  value={builderTextMuted}
                  seed={THEME_REAL_COLORS[builderBase].textMuted}
                  onSet={(v) => { setBuilderTextMuted(v); previewCustom({ ...buildDraft(), textMuted: v }); }}
                  onClear={() => { setBuilderTextMuted(''); previewCustom({ ...buildDraft(), textMuted: null }); }}
                />
                <ColorOverride
                  label="Background (optional)"
                  value={builderBackground}
                  seed={themeMeta[builderBase].colors.bg}
                  onSet={(v) => { setBuilderBackground(v); previewCustom({ ...buildDraft(), background: v }); }}
                  onClear={() => { setBuilderBackground(''); previewCustom({ ...buildDraft(), background: null }); }}
                />
                <ColorOverride
                  label="Surface / cards (optional)"
                  value={builderSurface}
                  seed={themeMeta[builderBase].colors.surface}
                  onSet={(v) => { setBuilderSurface(v); previewCustom({ ...buildDraft(), surface: v }); }}
                  onClear={() => { setBuilderSurface(''); previewCustom({ ...buildDraft(), surface: null }); }}
                />
                <ColorOverride
                  label="Subtle fill (optional)"
                  value={builderBgMuted}
                  seed={THEME_REAL_COLORS[builderBase].bgMuted}
                  onSet={(v) => { setBuilderBgMuted(v); previewCustom({ ...buildDraft(), bgMuted: v }); }}
                  onClear={() => { setBuilderBgMuted(''); previewCustom({ ...buildDraft(), bgMuted: null }); }}
                />
                <ColorOverride
                  label="Card borders (optional)"
                  value={builderBorder}
                  seed={THEME_REAL_COLORS[builderBase].border}
                  onSet={(v) => { setBuilderBorder(v); previewCustom({ ...buildDraft(), border: v }); }}
                  onClear={() => { setBuilderBorder(''); previewCustom({ ...buildDraft(), border: null }); }}
                />
                <ColorOverride
                  label="Progress bar (optional)"
                  value={builderProgressBar}
                  seed={builderPrimary}
                  onSet={(v) => { setBuilderProgressBar(v); previewCustom({ ...buildDraft(), progressBar: v }); }}
                  onClear={() => { setBuilderProgressBar(''); previewCustom({ ...buildDraft(), progressBar: null }); }}
                />
                <ColorOverride
                  label="Success accent (optional)"
                  value={builderSuccess}
                  seed={THEME_REAL_COLORS[builderBase].success}
                  onSet={(v) => { setBuilderSuccess(v); previewCustom({ ...buildDraft(), success: v }); }}
                  onClear={() => { setBuilderSuccess(''); previewCustom({ ...buildDraft(), success: null }); }}
                />
                <ColorOverride
                  label="Error accent (optional)"
                  value={builderError}
                  seed={THEME_REAL_COLORS[builderBase].error}
                  onSet={(v) => { setBuilderError(v); previewCustom({ ...buildDraft(), error: v }); }}
                  onClear={() => { setBuilderError(''); previewCustom({ ...buildDraft(), error: null }); }}
                />
              </div>
              <p className="text-[11px] text-muted -mt-2">
                Progress bar overrides the resume-progress fill on Dashboard → Continue Watching (blank keeps the default primary→secondary gradient). Success/Error recolor health-check dots, badges, and confirmation toasts across the whole app.
              </p>

              <div>
                <label className="block text-xs font-medium mb-2 text-muted">Corner roundness</label>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(RADIUS_PRESETS) as RadiusId[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => { setBuilderRadius(id); previewCustom({ ...buildDraft(), radius: id }); }}
                      className={`px-3 py-1.5 text-sm transition-colors ${
                        builderRadius === id
                          ? 'bg-primary text-white'
                          : 'bg-surface-hover text-muted hover:text-default'
                      }`}
                      style={{
                        // Preview each preset's own corner style ON the button
                        // itself — square button for "Square", pill-ish for
                        // "Extra rounded", etc. Reads as a live legend.
                        borderRadius:
                          id === 'square' ? '2px'
                          : id === 'rounded' ? '14px'
                          : id === 'extra' ? '20px'
                          : '10px',
                      }}
                    >
                      {RADIUS_LABELS[id]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-2 text-muted">Font</label>
                <div className="flex flex-wrap gap-2">
                  {FONT_OPTIONS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => { setBuilderFont(f.id); previewCustom({ ...buildDraft(), fontDisplay: f.id }); }}
                      style={f.family ? { fontFamily: f.family } : undefined}
                      className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                        builderFont === f.id
                          ? 'bg-primary text-white'
                          : 'bg-surface-hover text-muted hover:text-default'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-2 text-muted">Text size</label>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(TEXT_SCALE_PRESETS) as TextScaleId[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => { setBuilderTextScale(id); previewCustom({ ...buildDraft(), textScale: id }); }}
                      className={`px-3 py-1.5 rounded-lg transition-colors ${
                        builderTextScale === id
                          ? 'bg-primary text-white'
                          : 'bg-surface-hover text-muted hover:text-default'
                      }`}
                      style={{ fontSize: `${13 * TEXT_SCALE_FACTORS[id]}px` }}
                    >
                      {TEXT_SCALE_LABELS[id]}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted mt-1.5">Scales body text and most UI chrome app-wide, not just this builder.</p>
              </div>

              <div className="flex items-center gap-3 pt-1 flex-wrap">
                {/* When a custom is currently active, offer BOTH: update it in
                    place OR fork the current builder state into a brand new
                    saved theme. When nothing custom is active, only "Save as
                    new" makes sense. */}
                {activeCustomTheme ? (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        updateCustomTheme(activeCustomTheme.id, buildDraft(), builderName);
                        toast.success(`Updated "${(builderName.trim() || activeCustomTheme.name)}"`);
                      }}
                    >
                      Update &quot;{activeCustomTheme.name}&quot;
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const id = saveCustomTheme(buildDraft(), builderName);
                        const created = builderName.trim() || `Custom theme ${savedCustomThemes.length + 1}`;
                        toast.success(`Saved "${created}" as a new theme`);
                        void id;
                      }}
                    >
                      Save as new theme
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      saveCustomTheme(buildDraft(), builderName);
                      const created = builderName.trim() || `Custom theme ${savedCustomThemes.length + 1}`;
                      toast.success(`Saved "${created}" as a new theme`);
                    }}
                  >
                    Save as new theme
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    // Discard the live preview, re-applying the active theme,
                    // and reset every builder input to the active custom's
                    // values (or defaults, if no custom is active).
                    cancelPreview();
                    setBuilderName(activeCustomTheme?.name || '');
                    setBuilderBase(activeCustomTheme?.base || 'nebula');
                    setBuilderPrimary(activeCustomTheme?.primary || '#8b7ec8');
                    setBuilderSecondary(activeCustomTheme?.secondary || '#5fd4c4');
                    setBuilderText(activeCustomTheme?.text || '');
                    setBuilderTextMuted(activeCustomTheme?.textMuted || '');
                    setBuilderBackground(activeCustomTheme?.background || '');
                    setBuilderSurface(activeCustomTheme?.surface || '');
                    setBuilderBgMuted(activeCustomTheme?.bgMuted || '');
                    setBuilderBorder(activeCustomTheme?.border || '');
                    setBuilderProgressBar(activeCustomTheme?.progressBar || '');
                    setBuilderSuccess(activeCustomTheme?.success || '');
                    setBuilderError(activeCustomTheme?.error || '');
                    setBuilderFont((activeCustomTheme?.fontDisplay as FontId) || 'default');
                    setBuilderRadius((activeCustomTheme?.radius as RadiusId) || 'default');
                    setBuilderTextScale((activeCustomTheme?.textScale as TextScaleId) || 'default');
                  }}
                  className="text-xs text-muted hover:text-default transition-colors"
                >
                  Reset preview
                </button>
              </div>
            </div>
          </Card>
        </PageSection>
      </div>
      </div>

      {/* Confirm delete for a saved custom theme. Deleting reverts to Nebula
          if it was the active theme (handled inside deleteCustomTheme). */}
      <ConfirmModal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const name = pendingDelete.name;
          deleteCustomTheme(pendingDelete.id);
          setPendingDelete(null);
          toast.success(`Deleted "${name}"`);
        }}
        title="Delete custom theme"
        description={pendingDelete ? `Delete "${pendingDelete.name}"? This can't be undone.` : ''}
        confirmText="Delete"
        variant="danger"
      />
    </>
  );
}
