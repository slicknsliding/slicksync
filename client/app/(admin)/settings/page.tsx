'use client';

import { useState, useEffect, useRef, memo } from 'react';
import { motion } from 'framer-motion';
import { Header } from '@/components/layout/Header';
import { NebulaTopbar, NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { Button, Card, Badge, Modal, ConfirmModal, Avatar } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { useTheme, themeMeta, themeIds, ThemeId, FONT_OPTIONS, FontId, CustomTheme, SavedCustomTheme, RADIUS_PRESETS, RADIUS_LABELS, RadiusId, TEXT_SCALE_PRESETS, TEXT_SCALE_LABELS, TEXT_SCALE_FACTORS, TextScaleId } from '@/lib/theme';
import { useLayoutMode, layoutModeMeta, layoutModeIds, LayoutModeId } from '@/lib/layout-mode';
import { api, SyncSettings, AccountStats } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { useDefaultViewMode } from '@/lib/viewMode';
import { ViewModeToggle } from '@/components/ui/ViewModeToggle';
import { AvatarPickerModal } from '@/components/modals/AvatarPickerModal';
import { PushNotificationToggle } from '@/components/ui/PushNotificationToggle';
import { invalidatePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import {
  PaintBrushIcon,
  SwatchIcon,
  Squares2X2Icon,
  CloudArrowUpIcon,
  TrashIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  CheckIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  ClipboardDocumentIcon,
  GlobeAltIcon,
  ShieldCheckIcon,
  CogIcon,
  BoltIcon,
  DocumentTextIcon,
  UserCircleIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';

// Small curated fallback for environments without Intl.supportedValuesOf
// ('timeZone') - a fairly recent addition (Baseline 2023), not guaranteed
// everywhere this might render (including Next.js server-side rendering on
// an older Node build).
const FALLBACK_TIMEZONES = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Europe/Moscow', 'Africa/Cairo', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney', 'Pacific/Auckland',
];

function getSupportedTimezones(): string[] {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone');
    }
  } catch {
    // fall through to the curated list below
  }
  return FALLBACK_TIMEZONES;
}

const TIMEZONES = getSupportedTimezones();

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
  progressBar: string;
}) {
  const meta = themeMeta[base].colors;
  const isLight = base === 'daylight';
  return {
    bg: o.background || meta.bg,
    surface: o.surface || meta.surface,
    bgMuted: o.bgMuted || (isLight ? '#e2e8f0' : '#21262d'),
    border: o.border || (isLight ? 'rgba(15,23,42,0.14)' : 'rgba(255,255,255,0.08)'),
    text: o.text || (isLight ? '#0f172a' : '#e6edf3'),
    textMuted: o.textMuted || (isLight ? '#64748b' : '#8b949e'),
    primary: o.primary || meta.primary,
    secondary: o.secondary || meta.secondary,
    // No fallback constant here — a blank override means "keep the default
    // primary→secondary gradient," which the caller renders itself.
    progressBar: o.progressBar || null,
  };
}

// Layout mode card - structure preview only (sidebar-vs-topbar), not colors,
// since layout mode is orthogonal to the Theme setting above and should read
// as "shape," not "another color choice."
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

// Toggle switch component
function ToggleSwitch({
  enabled,
  onChange,
  label,
  disabled,
}: {
  enabled: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!enabled)}
      className={`flex items-center gap-3 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
    >
      <div
        className={`relative w-10 h-5 rounded-full transition-colors ${
          enabled ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <motion.div
          initial={false}
          animate={{ x: enabled ? 20 : 2 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="absolute top-0.5 w-4 h-4 rounded-full shadow-md bg-surface"
          style={{ backgroundColor: 'var(--color-text)' }}
        />
      </div>
    </button>
  );
}

// Setting row component
function SettingRow({
  label,
  description,
  children,
  disabled,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between p-4 rounded-lg bg-subtle ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div>
        <p className="font-medium text-sm text-default">{label}</p>
        <p className="text-xs text-muted">{description}</p>
      </div>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const {
    themeId, setTheme, hideSensitive, toggleHideSensitive,
    isCustom, activeCustomTheme, savedCustomThemes,
    saveCustomTheme, updateCustomTheme, deleteCustomTheme,
    previewCustom, cancelPreview,
  } = useTheme();
  // Confirmation modal for deleting a saved custom theme.
  const [pendingDelete, setPendingDelete] = useState<SavedCustomTheme | null>(null);
  const { layoutMode, setLayoutMode } = useLayoutMode();
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
    setBuilderFont((activeCustomTheme?.fontDisplay as FontId) || 'default');
    setBuilderRadius((activeCustomTheme?.radius as RadiusId) || 'default');
    setBuilderTextScale((activeCustomTheme?.textScale as TextScaleId) || 'default');
  }, [activeCustomTheme]);
  // Revert any unsaved live preview when leaving Settings (a saved theme is a
  // no-op here since cancelPreview just re-applies whatever's active). Kept
  // in a ref so the unmount cleanup uses the latest active-theme state, not a
  // stale closure from first render.
  const cancelPreviewRef = useRef(cancelPreview);
  cancelPreviewRef.current = cancelPreview;
  useEffect(() => () => cancelPreviewRef.current(), []);
  const { viewMode, setViewMode } = useDefaultViewMode();
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isPublicInstance = (process.env.NEXT_PUBLIC_INSTANCE_TYPE || 'private') === 'public';
  
  // Sync settings state
  const [syncSettings, setSyncSettings] = useState<Partial<SyncSettings>>({
    mode: 'normal',
    safe: true,
    useCustomFields: false,
    webhookUrl: '',
    notifyOnActivity: false,
    notifyOnSync: false,
    notifyOnInvite: false,
    notifyOnVault: false,
    accountTimezone: '',
  });

  // API Key state
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);

  // Webhook testing
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);

  // Account/avatar state
  const [accountInfo, setAccountInfo] = useState<AccountStats | null>(null);
  const [avatarModalOpen, setAvatarModalOpen] = useState(false);

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const stats = await api.getAccountStats();
        setAccountInfo(stats);
      } catch (e) {
        // Account stats endpoint may not be available
      }

      try {
        const settings = await api.getSyncSettings();
        setSyncSettings({
          mode: settings.mode || 'normal',
          safe: settings.safe !== false,
          useCustomFields: settings.useCustomFields || false,
          webhookUrl: settings.webhookUrl || '',
          notifyOnActivity: settings.notifyOnActivity || false,
          notifyOnSync: settings.notifyOnSync || false,
          notifyOnInvite: settings.notifyOnInvite || false,
          notifyOnVault: settings.notifyOnVault || false,
          accountTimezone: settings.accountTimezone || '',
        });
      } catch (e) {
        // Settings may not exist yet, use defaults
      }

      try {
        const keyStatus = await api.getApiKeyStatus();
        if (keyStatus.apiKey) {
          setApiKey(keyStatus.apiKey);
        } else if (!keyStatus.hasKey) {
          // Auto-generate if missing
          const generated = await api.generateApiKey();
          setApiKey(generated.apiKey);
          toast.success('API key auto-generated');
        }
      } catch (e) {
        // API key endpoint may not be available
      }
    };
    
    loadSettings();
  }, []);

  const handleSaveSetting = async (key: keyof SyncSettings, value: any) => {
    const newSettings = { ...syncSettings, [key]: value };
    setSyncSettings(newSettings);
    
    try {
      await api.updateSyncSettings({ [key]: value });
      toast.success('Setting saved');
    } catch (e: any) {
      toast.error(e.message || 'Failed to save setting');
    }
  };

  const handleAvatarSave = async (data: { avatarUrl?: string | null; colorIndex?: number }) => {
    await api.updateAccountAvatar(data.avatarUrl ?? null);
    setAccountInfo((prev) => prev ? { ...prev, avatarUrl: data.avatarUrl ?? null } : prev);
    // Sidebar/Nebula topbar fetch account info independently on mount, so a
    // full reload is the simplest way to get the new picture to show there too.
    setTimeout(() => window.location.reload(), 600);
  };

  const handleTestWebhook = async () => {
    if (!syncSettings.webhookUrl?.trim()) {
      toast.error('Enter a webhook URL first');
      return;
    }
    
    setIsTestingWebhook(true);
    try {
      await api.testWebhook(syncSettings.webhookUrl);
      toast.success('Test message sent to Discord');
    } catch (e: any) {
      toast.error(e.message || 'Failed to send test message');
    } finally {
      setIsTestingWebhook(false);
    }
  };

  const handleGenerateApiKey = async () => {
    setIsGeneratingKey(true);
    try {
      const result = apiKey ? await api.rotateApiKey() : await api.generateApiKey();
      setApiKey(result.apiKey);
      navigator.clipboard.writeText(result.apiKey);
      toast.success(apiKey ? 'API key rotated and copied' : 'API key generated and copied');
    } catch (e: any) {
      toast.error(e.message || 'Failed to generate API key');
    } finally {
      setIsGeneratingKey(false);
    }
  };

  const handleCopyApiKey = () => {
    if (apiKey) {
      navigator.clipboard.writeText(apiKey);
      toast.success('API key copied to clipboard');
    }
  };

  const handleReset = async () => {
    setIsResetModalOpen(false);
    // Reset to defaults
    setSyncSettings({
      mode: 'normal',
      safe: true,
      useCustomFields: false,
      webhookUrl: '',
      notifyOnActivity: false,
      notifyOnSync: false,
      notifyOnInvite: false,
      notifyOnVault: false,
    });
    try {
      await api.updateSyncSettings({
        mode: 'normal',
        safe: true,
        useCustomFields: false,
        webhookUrl: '',
        notifyOnActivity: false,
        notifyOnSync: false,
        notifyOnInvite: false,
        notifyOnVault: false,
      });
      toast.success('Settings reset to defaults');
    } catch (e: any) {
      toast.error(e.message || 'Failed to reset settings');
    }
  };

  // Mask API key for display
  const maskedApiKey = apiKey 
    ? (apiKeyVisible ? apiKey : apiKey.slice(0, 8) + '••••••••' + apiKey.slice(-4))
    : 'No API key';

  return (
    <>
      {layoutMode === 'nebula' ? (
        <NebulaTopbar />
      ) : (
        <Header
          title="Settings"
          subtitle="Customize your SlickSync experience"
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-6 lg:p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : 'max-w-4xl'} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
      {layoutMode === 'nebula' && (
        <NebulaPageHeading title="Settings" subtitle="Customize your SlickSync experience" />
      )}
        {/* Profile Picture - shown on the account button (bottom-left in
            Nebula, bottom of sidebar in Original) and its dropdown menu. */}
        <PageSection className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <UserCircleIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Profile Picture</h3>
                <p className="text-xs text-muted">Shown on your account button and its menu</p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Avatar
                name={isPublicInstance ? (accountInfo?.uuid || accountInfo?.email || 'Admin') : 'Administrator'}
                src={accountInfo?.avatarUrl || undefined}
                email={accountInfo?.email || undefined}
                size="xl"
                fallbackIcon={<ShieldCheckIcon className="w-7 h-7" style={{ color: 'white' }} />}
              />
              <div className="flex-1">
                <Button variant="secondary" size="sm" onClick={() => setAvatarModalOpen(true)}>
                  Change Picture
                </Button>
                <p className="text-xs text-muted mt-2">
                  Upload an image, paste a URL, or pick a color
                </p>
              </div>
            </div>
          </Card>
        </PageSection>

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

        {/* Custom Theme builder - pick your own accent colors on top of any
            base theme's structure, live-preview, and save. */}
        <PageSection className="mb-6">
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
                  seed="#e2e8f0"
                  onSet={(v) => { setBuilderText(v); previewCustom({ ...buildDraft(), text: v }); }}
                  onClear={() => { setBuilderText(''); previewCustom({ ...buildDraft(), text: null }); }}
                />
                <ColorOverride
                  label="Muted text (optional)"
                  value={builderTextMuted}
                  seed="#8b949e"
                  onSet={(v) => { setBuilderTextMuted(v); previewCustom({ ...buildDraft(), textMuted: v }); }}
                  onClear={() => { setBuilderTextMuted(''); previewCustom({ ...buildDraft(), textMuted: null }); }}
                />
                <ColorOverride
                  label="Background (optional)"
                  value={builderBackground}
                  seed="#0d1117"
                  onSet={(v) => { setBuilderBackground(v); previewCustom({ ...buildDraft(), background: v }); }}
                  onClear={() => { setBuilderBackground(''); previewCustom({ ...buildDraft(), background: null }); }}
                />
                <ColorOverride
                  label="Surface / cards (optional)"
                  value={builderSurface}
                  seed="#1c2128"
                  onSet={(v) => { setBuilderSurface(v); previewCustom({ ...buildDraft(), surface: v }); }}
                  onClear={() => { setBuilderSurface(''); previewCustom({ ...buildDraft(), surface: null }); }}
                />
                <ColorOverride
                  label="Subtle fill (optional)"
                  value={builderBgMuted}
                  seed="#21262d"
                  onSet={(v) => { setBuilderBgMuted(v); previewCustom({ ...buildDraft(), bgMuted: v }); }}
                  onClear={() => { setBuilderBgMuted(''); previewCustom({ ...buildDraft(), bgMuted: null }); }}
                />
                <ColorOverride
                  label="Card borders (optional)"
                  value={builderBorder}
                  seed="#2d333b"
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
              </div>
              <p className="text-[11px] text-muted -mt-2">
                Progress bar overrides the resume-progress fill on Dashboard → Continue Watching. Blank keeps the default primary→secondary gradient.
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

              {/* Live mockup — a self-contained mini "card" rendered with the
                  builder's own resolved colors/font/radius/text-scale, rather
                  than relying on the swatches once used here. Independent of
                  document.documentElement so it's accurate even mid-drag on a
                  color input, and it doubles as a legend: every dimension the
                  builder controls shows up somewhere in it. */}
              <div>
                <label className="block text-xs font-medium mb-2 text-muted">Preview</label>
                {(() => {
                  const p = resolvePreviewPalette(builderBase, {
                    primary: builderPrimary, secondary: builderSecondary,
                    text: builderText, textMuted: builderTextMuted,
                    background: builderBackground, surface: builderSurface,
                    bgMuted: builderBgMuted, border: builderBorder,
                    progressBar: builderProgressBar,
                  });
                  const radiusScale = builderRadius !== 'default' ? RADIUS_PRESETS[builderRadius] : null;
                  const rLg = radiusScale?.lg || BASE_RADIUS_PX.lg;
                  const rMd = radiusScale?.md || BASE_RADIUS_PX.md;
                  const rSm = radiusScale?.sm || BASE_RADIUS_PX.sm;
                  const fontFamily = FONT_OPTIONS.find((f) => f.id === builderFont)?.family || undefined;
                  const scale = TEXT_SCALE_FACTORS[builderTextScale];
                  return (
                    <div
                      className="p-5"
                      style={{ background: p.bg, borderRadius: rLg, border: `1px solid ${p.border}`, fontFamily }}
                    >
                      {/* header row */}
                      <div className="flex items-center gap-2.5 mb-4">
                        <div
                          className="w-8 h-8 flex items-center justify-center shrink-0"
                          style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.secondary})`, borderRadius: rMd }}
                        >
                          <SparklesIcon className="w-4 h-4" style={{ color: '#fff' }} />
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold leading-tight truncate" style={{ color: p.text, fontSize: `${14 * scale}px` }}>
                            {builderName.trim() || 'Preview theme'}
                          </p>
                          <p className="leading-tight truncate" style={{ color: p.textMuted, fontSize: `${11 * scale}px` }}>
                            Based on {themeMeta[builderBase].name}
                          </p>
                        </div>
                        <span
                          className="ml-auto shrink-0 flex items-center gap-1 px-2 py-0.5 font-medium"
                          style={{ background: `${p.secondary}26`, color: p.secondary, borderRadius: rSm, fontSize: `${10.5 * scale}px` }}
                        >
                          <BoltIcon className="w-3 h-3" /> Live
                        </span>
                      </div>

                      {/* body copy, on the resolved text/muted colors */}
                      <p className="mb-3" style={{ color: p.text, fontSize: `${13 * scale}px`, lineHeight: 1.5 }}>
                        The quick brown fox jumps over the lazy dog.
                      </p>
                      <p className="mb-4" style={{ color: p.textMuted, fontSize: `${11.5 * scale}px`, lineHeight: 1.5 }}>
                        Caption and muted text render like this — labels, hints, timestamps.
                      </p>

                      {/* a nested card, to preview surface + bgMuted + border,
                          plus a Continue Watching-style progress bar so the
                          "Progress bar" override shows up somewhere too. */}
                      <div
                        className="p-3 mb-4"
                        style={{ background: p.surface, border: `1px solid ${p.border}`, borderRadius: rMd }}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium" style={{ color: p.text, fontSize: `${12 * scale}px` }}>Continue Watching</span>
                          <span
                            className="flex items-center gap-1 px-1.5 py-0.5 font-medium"
                            style={{ background: p.bgMuted, color: p.textMuted, borderRadius: rSm, fontSize: `${10 * scale}px` }}
                          >
                            <CheckIcon className="w-3 h-3" /> 62% watched
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden" style={{ background: p.bgMuted, borderRadius: rSm }}>
                          <div
                            className="h-full w-2/3"
                            style={{ background: p.progressBar || `linear-gradient(90deg, ${p.primary}, ${p.secondary})` }}
                          />
                        </div>
                      </div>

                      {/* button row */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="px-3 py-1.5 font-semibold"
                          style={{ background: p.primary, color: '#fff', borderRadius: rMd, fontSize: `${12 * scale}px` }}
                        >
                          Primary action
                        </span>
                        <span
                          className="px-3 py-1.5 font-semibold"
                          style={{ background: 'transparent', color: p.primary, border: `1px solid ${p.primary}`, borderRadius: rMd, fontSize: `${12 * scale}px` }}
                        >
                          Secondary
                        </span>
                        <span
                          className="px-3 py-1.5 font-medium"
                          style={{ color: p.textMuted, fontSize: `${12 * scale}px` }}
                        >
                          Cancel
                        </span>
                      </div>
                    </div>
                  );
                })()}
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

        {/* Layout - structure, independent of Theme's color choice. Scoped
            to Dashboard + Activity today; other pages are unaffected. */}
        <PageSection className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <Squares2X2Icon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Layout</h3>
                <p className="text-xs text-muted">Choose how Dashboard and Activity are arranged - applies on top of whichever Theme you pick above</p>
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

        {/* Privacy & Display */}
        <PageSection delay={0.05} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-secondary-muted">
                <EyeSlashIcon className="w-5 h-5 text-secondary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Privacy & Display</h3>
                <p className="text-xs text-muted">Control how information is displayed</p>
              </div>
            </div>

            <div className="space-y-3">
              <SettingRow
                label="Private Mode"
                description="Hide sensitive information like emails, IPs, and API keys"
              >
                <ToggleSwitch
                  enabled={hideSensitive}
                  onChange={toggleHideSensitive}
                  label="Toggle private mode"
                />
              </SettingRow>

              <SettingRow
                label="Custom Addon Names"
                description="Show custom names instead of original addon names"
              >
                <ToggleSwitch
                  enabled={syncSettings.useCustomFields || false}
                  onChange={(v) => handleSaveSetting('useCustomFields', v)}
                  label="Toggle custom addon names"
                />
              </SettingRow>

              <div className="p-4 rounded-lg bg-subtle">
                <label className="block text-sm font-medium text-default mb-2">Timezone</label>
                <select
                  value={syncSettings.accountTimezone || ''}
                  onChange={(e) => handleSaveSetting('accountTimezone', e.target.value)}
                  className="input-base w-full px-3 py-2 text-sm"
                >
                  {syncSettings.accountTimezone && !TIMEZONES.includes(syncSettings.accountTimezone) && (
                    <option value={syncSettings.accountTimezone}>{syncSettings.accountTimezone}</option>
                  )}
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
                <p className="text-xs text-muted mt-2">
                  Used server-side to decide what counts as &quot;today&quot; for Watch Time Today and streaks -
                  background jobs have no browser to read a timezone from, so this has to be set explicitly rather
                  than auto-detected.
                </p>
              </div>
            </div>
          </Card>
        </PageSection>

        {/* Sync Mode */}
        <PageSection delay={0.1} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-warning-muted">
                <CogIcon className="w-5 h-5 text-warning" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Sync Mode</h3>
                <p className="text-xs text-muted">Configure how addons are synchronized</p>
              </div>
            </div>

            <div className="space-y-3">
              <SettingRow
                label="Advanced Sync"
                description="Enable advanced sync features for more control over addon syncing"
              >
                <ToggleSwitch
                  enabled={syncSettings.mode === 'advanced'}
                  onChange={(v) => handleSaveSetting('mode', v ? 'advanced' : 'normal')}
                  label="Toggle advanced sync"
                />
              </SettingRow>

              <SettingRow
                label="Unsafe Mode"
                description="Allow destructive operations without confirmation (not recommended)"
              >
                <div className="flex items-center gap-2">
                  {!syncSettings.safe && (
                    <Badge variant="error" size="sm">Enabled</Badge>
                  )}
                  <ToggleSwitch
                    enabled={!syncSettings.safe}
                    onChange={(v) => handleSaveSetting('safe', !v)}
                    label="Toggle unsafe mode"
                  />
                </div>
              </SettingRow>
            </div>
          </Card>
        </PageSection>

        {/* Other Settings */}
        <PageSection delay={0.12} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <CogIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Other Settings</h3>
                <p className="text-xs text-muted">Miscellaneous preferences</p>
              </div>
            </div>

            <div className="space-y-3">
              <SettingRow
                label="Default View Mode"
                description="Choose how lists are displayed by default"
              >
                <div className="hidden md:block">
                  <ViewModeToggle
                    mode={viewMode}
                    onChange={setViewMode}
                    showLabels={false}
                  />
                </div>
                <span className="md:hidden text-xs text-muted text-right max-w-[120px]">
                  Grid view only on mobile
                </span>
              </SettingRow>
            </div>
          </Card>
        </PageSection>

        {/* Notifications */}
        <PageSection delay={0.15} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-indigo-500/20">
                <GlobeAltIcon className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Notifications</h3>
                <p className="text-xs text-muted">Receive notifications via Discord</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-default mb-2">Webhook URL</label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={syncSettings.webhookUrl || ''}
                    onChange={(e) => setSyncSettings(prev => ({ ...prev, webhookUrl: e.target.value }))}
                    onBlur={() => handleSaveSetting('webhookUrl', syncSettings.webhookUrl)}
                    placeholder="https://discord.com/api/webhooks/..."
                    className="input-base flex-1 px-3 py-2 text-sm"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleTestWebhook}
                    isLoading={isTestingWebhook}
                    disabled={!syncSettings.webhookUrl?.trim()}
                  >
                    Test
                  </Button>
                </div>
                <p className="text-xs text-muted mt-2">
                  Create a webhook in your Discord server settings to receive notifications
                </p>
              </div>

              <div className="space-y-3">
                <SettingRow
                  label="Activity notifications"
                  description="Notify when users start watching"
                  disabled={!syncSettings.webhookUrl?.trim()}
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnActivity || false}
                    onChange={(v) => handleSaveSetting('notifyOnActivity', v)}
                    label="Toggle activity notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="Sync notifications"
                  description="Notify when sync completes"
                  disabled={!syncSettings.webhookUrl?.trim()}
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnSync || false}
                    onChange={(v) => handleSaveSetting('notifyOnSync', v)}
                    label="Toggle sync notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="Invite notifications"
                  description="Notify for invitations and user joins"
                  disabled={!syncSettings.webhookUrl?.trim()}
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnInvite || false}
                    onChange={(v) => handleSaveSetting('notifyOnInvite', v)}
                    label="Toggle invite notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="Vault notifications"
                  description="Notify when a Vault entry is about to expire or an automated check starts failing"
                  disabled={!syncSettings.webhookUrl?.trim()}
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnVault || false}
                    onChange={(v) => handleSaveSetting('notifyOnVault', v)}
                    label="Toggle vault notifications"
                  />
                </SettingRow>
              </div>

              {/* Phone / desktop push - separate from Discord: install
                  SlickSync as an app and get new-episode alerts as native
                  notifications, even when it's closed. Per-device. */}
              <div className="pt-4 border-t border-default">
                <label className="block text-sm font-medium text-default mb-1">Phone notifications (PWA)</label>
                <p className="text-xs text-muted mb-3">
                  Install SlickSync to your home screen, then enable native new-episode notifications on this device.
                </p>
                <PushNotificationToggle />
              </div>
            </div>
          </Card>
        </PageSection>

        {/* Personal Features — opt-outs for the SlickSync-native tracking
            surfaces (Watchlist, Watched indicators, Recommendations). All
            default ON. Turning any off hides its UI + skips its network
            requests immediately (the hook cache invalidates on save). */}
        <PageSection delay={0.18} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <SparklesIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Personal Features</h3>
                <p className="text-xs text-muted">Toggle SlickSync&apos;s built-in tracking surfaces on or off. Your watch history is unaffected — this only controls what you see.</p>
              </div>
            </div>

            <div className="space-y-3">
              <SettingRow
                label="Watchlist"
                description="Bookmark items to watch later. Adds a ★ Watchlist source in Discover and an Add-to-Watchlist button on every detail page. Off: everything watchlist-related is hidden; saved items stay in the database until you re-enable."
              >
                <ToggleSwitch
                  enabled={syncSettings.enableWatchlist !== false}
                  onChange={(v) => { handleSaveSetting('enableWatchlist' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle Watchlist"
                />
              </SettingRow>

              <SettingRow
                label="Watched indicators"
                description="Show ✓ checkmark badges on Discover posters for things you've already watched (from either provider), the Unwatched / Watched filter, and the Mark-as-watched menu option. Off: no badges, no filter, no menu item."
              >
                <ToggleSwitch
                  enabled={syncSettings.enableWatchedIndicators !== false}
                  onChange={(v) => { handleSaveSetting('enableWatchedIndicators' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle watched indicators"
                />
              </SettingRow>

              <SettingRow
                label="Recommendations"
                description={'The "Because you watched X" rows on the Dashboard, computed from your watch-history genres. Off: no recommendations panel, no server-side genre computation.'}
              >
                <ToggleSwitch
                  enabled={syncSettings.enableRecommendations !== false}
                  onChange={(v) => { handleSaveSetting('enableRecommendations' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle recommendations"
                />
              </SettingRow>
            </div>
          </Card>
        </PageSection>

        {/* API Key */}
        <PageSection delay={0.2} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-success-muted">
                <KeyIcon className="w-5 h-5 text-success" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">API Key</h3>
                                    <p className="text-xs text-muted">Access the SlickSync API programmatically</p>              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-default mb-2">Your API Key</label>
                <div className="flex gap-2">
                  <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-subtle border border-default">
                    <code className="flex-1 text-sm font-mono text-muted truncate">
                      {apiKeyVisible ? apiKey : (hideSensitive ? '••••••••••••••••' : maskedApiKey)}
                    </code>
                    <button
                      onClick={() => setApiKeyVisible(!apiKeyVisible)}
                      className="p-1 rounded hover:bg-surface-hover transition-colors"
                      title={apiKeyVisible ? 'Hide' : 'Show'}
                    >
                      {apiKeyVisible ? (
                        <EyeSlashIcon className="w-4 h-4 text-muted" />
                      ) : (
                        <EyeIcon className="w-4 h-4 text-muted" />
                      )}
                    </button>
                    <button
                      onClick={handleCopyApiKey}
                      className="p-1 rounded hover:bg-surface-hover transition-colors"
                      title="Copy"
                      disabled={!apiKey}
                    >
                      <ClipboardDocumentIcon className="w-4 h-4 text-muted" />
                    </button>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleGenerateApiKey}
                    isLoading={isGeneratingKey}
                    leftIcon={<ArrowPathIcon className="w-4 h-4" />}
                  >
                    {apiKey ? 'Rotate' : 'Generate'}
                  </Button>
                </div>
                <p className="text-xs text-muted mt-2">
                  Use this key to authenticate API requests. Keep it secret!
                </p>
              </div>
            </div>
          </Card>
        </PageSection>

        {/* Danger Zone */}
        <PageSection delay={0.25}>
          <Card padding="lg" className="border-error">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-error-muted">
                <ExclamationTriangleIcon className="w-5 h-5 text-error" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Danger Zone</h3>
                <p className="text-xs text-muted">Irreversible actions</p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 rounded-lg bg-error-muted">
                <div>
                  <p className="font-medium text-sm text-default">Reset All Settings</p>
                  <p className="text-xs text-muted">Restore all settings to their defaults</p>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  leftIcon={<ArrowPathIcon className="w-4 h-4" />}
                  onClick={() => setIsResetModalOpen(true)}
                >
                  Reset
                </Button>
              </div>
            </div>
          </Card>
        </PageSection>
      </div>
      </div>

      {/* Reset Confirmation Modal */}
      <ConfirmModal
        isOpen={isResetModalOpen}
        onClose={() => setIsResetModalOpen(false)}
        onConfirm={handleReset}
        title="Reset Settings"
        description="Are you sure you want to reset all settings to their defaults? This cannot be undone."
        confirmText="Reset Settings"
        variant="danger"
      />

      {/* Avatar Picker Modal */}
      <AvatarPickerModal
        isOpen={avatarModalOpen}
        onClose={() => setAvatarModalOpen(false)}
        name={isPublicInstance ? (accountInfo?.uuid || accountInfo?.email || 'Admin') : 'Administrator'}
        currentAvatarUrl={accountInfo?.avatarUrl}
        onSave={handleAvatarSave}
      />

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
