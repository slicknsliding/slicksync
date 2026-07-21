'use client';

import { useState, useEffect, useRef, memo } from 'react';
import { motion } from 'framer-motion';
import { Header } from '@/components/layout/Header';
import { NebulaTopbar, NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { Button, Card, Badge, Modal, ConfirmModal, Avatar } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { useTheme, themeMeta, themeIds, ThemeId } from '@/lib/theme';
import { useLayoutMode, layoutModeMeta, layoutModeIds, LayoutModeId } from '@/lib/layout-mode';
import { api, SyncSettings, AccountStats } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { useDefaultViewMode } from '@/lib/viewMode';
import { ViewModeToggle } from '@/components/ui/ViewModeToggle';
import { AvatarPickerModal } from '@/components/modals/AvatarPickerModal';
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
  const { themeId, setTheme, hideSensitive, toggleHideSensitive, isCustom, customTheme, applyCustom, previewCustom, cancelPreview } = useTheme();
  const { layoutMode, setLayoutMode } = useLayoutMode();
  // Custom-theme builder working state, seeded from the saved custom theme.
  const [builderBase, setBuilderBase] = useState<ThemeId>(customTheme.base);
  const [builderPrimary, setBuilderPrimary] = useState(customTheme.primary);
  const [builderSecondary, setBuilderSecondary] = useState(customTheme.secondary);
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
                  isSelected={themeId === id && !isCustom}
                  onSelect={() => setTheme(id)}
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
                <label className="block text-xs font-medium mb-2 text-muted">Base (background, surfaces, text)</label>
                <select
                  value={builderBase}
                  onChange={(e) => { const v = e.target.value as ThemeId; setBuilderBase(v); previewCustom({ base: v, primary: builderPrimary, secondary: builderSecondary }); }}
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
                      onChange={(e) => { setBuilderPrimary(e.target.value); previewCustom({ base: builderBase, primary: e.target.value, secondary: builderSecondary }); }}
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
                      onChange={(e) => { setBuilderSecondary(e.target.value); previewCustom({ base: builderBase, primary: builderPrimary, secondary: e.target.value }); }}
                      className="w-12 h-10 rounded-lg cursor-pointer border border-default bg-transparent p-0.5"
                    />
                    <span className="text-xs font-mono text-muted uppercase">{builderSecondary}</span>
                  </div>
                </div>
              </div>

              {/* Live preview swatch - the same primary→secondary gradient the
                  app's accents use, so this is exactly what you'll get. */}
              <div>
                <label className="block text-xs font-medium mb-2 text-muted">Preview</label>
                <div className="flex items-center gap-3">
                  <div className="h-8 w-40 rounded-lg" style={{ background: `linear-gradient(90deg, ${builderPrimary}, ${builderSecondary})` }} />
                  <div className="h-8 w-8 rounded-lg" style={{ background: builderPrimary }} />
                  <div className="h-8 w-8 rounded-lg" style={{ background: builderSecondary }} />
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => applyCustom({ base: builderBase, primary: builderPrimary, secondary: builderSecondary })}
                >
                  {isCustom ? 'Save changes' : 'Use this theme'}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    // Discard the live preview, re-applying the active theme,
                    // and reset the builder inputs to the saved custom values.
                    cancelPreview();
                    setBuilderBase(customTheme.base);
                    setBuilderPrimary(customTheme.primary);
                    setBuilderSecondary(customTheme.secondary);
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
    </>
  );
}
