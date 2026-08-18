'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Header } from '@/components/layout/Header';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { Button, Card, Badge, Modal, ConfirmModal, Avatar, ComboBox } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { useTheme } from '@/lib/theme';
import { useLayoutMode } from '@/lib/layout-mode';
import { api, SyncSettings, AccountStats, PushDevice } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import { AvatarPickerModal } from '@/components/modals/AvatarPickerModal';
import { PushNotificationToggle } from '@/components/ui/PushNotificationToggle';
import { invalidatePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import {
  CloudArrowUpIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  ClipboardDocumentIcon,
  GlobeAltIcon,
  ShieldCheckIcon,
  CogIcon,
  DocumentTextIcon,
  UserCircleIcon,
  SparklesIcon,
  DevicePhoneMobileIcon,
  ComputerDesktopIcon,
  PencilIcon,
  TrashIcon,
  CheckIcon,
  XMarkIcon,
  ArrowTopRightOnSquareIcon,
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

// Best-effort friendly guess from a stored User-Agent string, for a device
// that's never been given a custom label. Rough on purpose - this is a
// fallback shown alongside a rename control, not a full UA parser.
function guessDeviceName(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMac = /Macintosh/.test(ua);
  const isWindows = /Windows/.test(ua);
  const browser = /Firefox/.test(ua) ? 'Firefox'
    : /Edg\//.test(ua) ? 'Edge'
    : /Chrome/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari'
    : 'Browser';
  if (isIOS) return `${/iPad/.test(ua) ? 'iPad' : 'iPhone'} - ${browser}`;
  if (isAndroid) return `Android - ${browser}`;
  if (isMac) return `Mac - ${browser}`;
  if (isWindows) return `Windows - ${browser}`;
  return browser;
}

function isMobileDevice(userAgent: string | null): boolean {
  return !!userAgent && /iPhone|iPad|iPod|Android/.test(userAgent);
}

function formatLastSeen(dateStr: string | null): string {
  if (!dateStr) return 'Never notified';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffMins < 1) return 'Active just now';
  if (diffMins < 60) return `Active ${diffMins}m ago`;
  if (diffHours < 24) return `Active ${diffHours}h ago`;
  return `Active ${diffDays}d ago`;
}

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

// Suggestions for the AI Services ComboBoxes below - never the only valid
// values (both still take arbitrary text), just the common cases someone
// shouldn't have to remember/retype from a provider's docs.
const AI_BASE_URL_OPTIONS = [
  { value: 'https://api.openai.com/v1', label: 'OpenAI' },
  { value: 'https://openrouter.ai/api/v1', label: 'OpenRouter' },
  { value: 'https://api.groq.com/openai/v1', label: 'Groq' },
  { value: 'https://generativelanguage.googleapis.com/v1beta/openai', label: 'Google Gemini' },
  { value: 'https://api.deepseek.com', label: 'DeepSeek' },
];
// Keyed by base URL, NOT one flat combined list - a model name only means
// something in the context of which endpoint it's sent to (OpenRouter's
// "google/gemini-2.0-flash-001" slug format vs Google's own native
// "gemini-2.0-flash" are genuinely different strings for effectively the
// same model), and a flat list let someone pick a Google-formatted URL
// alongside an OpenRouter-formatted model with nothing stopping the
// mismatch - confirmed real case, a user did exactly that and got a 404
// with no clue why until the AI Services error surfacing was added. Now
// the model list itself narrows to only what actually works with whatever
// base URL is currently selected.
const AI_MODEL_OPTIONS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  'https://api.openai.com/v1': [
    { value: 'gpt-5.2-mini', label: 'gpt-5.2-mini' },
    { value: 'gpt-5.2-chat-latest', label: 'gpt-5.2-chat-latest' },
    { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
  ],
  'https://openrouter.ai/api/v1': [
    { value: 'openai/gpt-5.2-mini', label: 'GPT-5.2 mini' },
    { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
    { value: 'google/gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { value: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout' },
  ],
  'https://api.groq.com/openai/v1': [
    { value: 'llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout' },
    { value: 'llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick' },
    { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
  ],
  'https://generativelanguage.googleapis.com/v1beta/openai': [
    { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash (latest)' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  'https://api.deepseek.com': [
    { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  ],
};
// Fallback for a custom/unrecognized base URL (a local proxy, something not
// in the preset list) - can't narrow to a known-correct set, so show
// everything rather than nothing.
const AI_MODEL_OPTIONS_ALL = Object.values(AI_MODEL_OPTIONS_BY_PROVIDER).flat();

export default function SettingsPage() {
  // Theme picking + the theme builder now live on their own page (Themes) —
  // only the sensitive-data toggle from useTheme() is still needed here.
  const { hideSensitive, toggleHideSensitive } = useTheme();
  const { layoutMode } = useLayoutMode();
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isPublicInstance = (process.env.NEXT_PUBLIC_INSTANCE_TYPE || 'private') === 'public';
  const [isDeleteAccountModalOpen, setIsDeleteAccountModalOpen] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  
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
    notifyOnAddonHealth: false,
    notifyOnNewDevice: false,
    notifyOnBackup: false,
    notifyOnProxyHealth: false,
    notifyOnUpdateAvailable: false,
    notifyOnMosaic: false,
    notifyDigestEnabled: false,
    notifyDigestFrequency: 'daily' as 'daily' | 'weekly',
    accountTimezone: '',
  });

  // AI Services (Settings > External API Keys) - powers natural-language
  // Catalog building (Catalogs -> "Describe a catalog"). Stored as a Vault
  // entry underneath (see api.ts's getAiServicesStatus comment) - the
  // status endpoint never returns the key itself, only whether one is set,
  // same as the account API key above.
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiApiKey, setAiApiKey] = useState('');
  // Reveal state for the API key field's eye icon - lazy-fetches the real
  // stored key on first click (this field is a plain <input>, not the
  // shared Input component, so this is hand-rolled rather than that
  // component's built-in onRevealClick).
  const [aiKeyVisible, setAiKeyVisible] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [isSavingAi, setIsSavingAi] = useState(false);
  // liveAiModels comes from the provider's own GET /models (fetched below)
  // once a key is available - the real, current list, not a hardcoded guess
  // that inevitably drifts as providers retire/rename models (confirmed
  // real case: every hardcoded suggestion here had already gone stale).
  // Falls back to the static per-provider list only until that live fetch
  // has something, so the field isn't empty before a key exists to fetch
  // with.
  const [liveAiModels, setLiveAiModels] = useState<string[]>([]);
  const [loadingAiModels, setLoadingAiModels] = useState(false);
  const staticAiModelOptions = AI_MODEL_OPTIONS_BY_PROVIDER[aiBaseUrl.trim() || 'https://api.openai.com/v1'] || AI_MODEL_OPTIONS_ALL;
  const aiModelOptions = liveAiModels.length > 0
    ? liveAiModels.map((m) => ({ value: m, label: m }))
    : staticAiModelOptions;

  // Both overrides exist because React state updates are async - a caller
  // that just called setAiBaseUrl()/setAiConfigured() moments ago
  // (loadAiServicesStatus, on mount) can't rely on those closure values
  // reflecting the update yet.
  const fetchLiveAiModels = async (opts?: { baseUrl?: string; hasKey?: boolean }) => {
    const effectiveBaseUrl = opts?.baseUrl ?? aiBaseUrl;
    const hasKey = opts?.hasKey ?? (!!aiApiKey.trim() || aiConfigured);
    if (!hasKey) return; // nothing to fetch with yet
    setLoadingAiModels(true);
    try {
      const { models } = await api.listAiModels({ apiKey: aiApiKey.trim() || undefined, baseUrl: effectiveBaseUrl.trim() });
      setLiveAiModels(models);
    } catch {
      setLiveAiModels([]); // fails silently - falls back to the static suggestions, same "bonus, not required" treatment as everywhere else this pattern is used
    } finally {
      setLoadingAiModels(false);
    }
  };
  // Real verification result from the last save (settings.js actually calls
  // the provider, not just "was something written to the DB") - null means
  // never checked yet (fresh page load before any save, or an entry saved
  // before this check existed). Previously "Connected" meant only "a key is
  // stored," true even for garbage input - this is what makes the badge
  // mean something.
  const [aiCheckStatus, setAiCheckStatus] = useState<'ok' | 'error' | null>(null);
  const [aiCheckMessage, setAiCheckMessage] = useState<string | null>(null);

  const loadAiServicesStatus = async () => {
    try {
      const status = await api.getAiServicesStatus();
      setAiConfigured(!!status.configured);
      setAiBaseUrl(status.baseUrl || '');
      setAiModel(status.model || '');
      setAiCheckStatus(status.lastCheckStatus || null);
      setAiCheckMessage(status.lastCheckMessage || null);
      if (status.configured) fetchLiveAiModels({ baseUrl: status.baseUrl || '', hasKey: true });
    } catch {
      // Endpoint may not exist yet on an older backend - stay silent.
    }
  };

  // Auto-saves on blur, same as every other API key field on this page (no
  // separate Save button) - always sends baseUrl/model together (they share
  // one testConfig JSON server-side) plus apiKey only when the admin
  // actually typed a new one, so blurring baseUrl right after typing a key
  // doesn't accidentally save an empty key over it.
  const handleAiFieldBlur = async () => {
    if (!aiApiKey.trim() && !aiConfigured) return; // nothing to save yet
    setIsSavingAi(true);
    try {
      const result = await api.setAiServices({ apiKey: aiApiKey.trim() || undefined, baseUrl: aiBaseUrl.trim(), model: aiModel.trim() });
      setAiApiKey('');
      setAiConfigured(true);
      setAiCheckStatus(result.lastCheckStatus);
      setAiCheckMessage(result.lastCheckMessage);
      if (result.lastCheckStatus === 'ok') toast.success('AI Services verified and saved');
      else toast.error(`Saved, but verification failed: ${result.lastCheckMessage}`);
      fetchLiveAiModels({ hasKey: true }); // refresh the model dropdown against whatever key/URL just got saved
    } catch (e: any) {
      toast.error(e.message || 'Failed to save AI Services');
    } finally {
      setIsSavingAi(false);
    }
  };

  // Lazy-fills the field with the real stored key the first time the eye
  // icon reveals (not on hide) - only when it's still blank, so it never
  // clobbers something already being typed to replace it.
  const handleRevealAiKey = async () => {
    if (aiApiKey) return;
    try {
      const result = await api.revealAiServicesKey();
      setAiApiKey(result.secret);
    } catch (e: any) {
      toast.error(e.message || 'Failed to reveal API key');
    }
  };

  // Blank password field can't double as "clear" the way a plain visible-
  // value field can (an untouched blur would look identical to "I want to
  // delete this"), so this stays a distinct affordance - just a small icon
  // action now rather than a full button, since it's the only one left.
  const handleRemoveAiServices = async () => {
    try {
      await api.removeAiServices();
      setAiConfigured(false);
      setAiApiKey('');
      setAiBaseUrl('');
      setAiModel('');
      setAiCheckStatus(null);
      setAiCheckMessage(null);
      toast.success('AI Services removed');
    } catch (e: any) {
      toast.error(e.message || 'Failed to remove AI Services');
    }
  };

  // Push-subscribed devices (Settings > Notifications > Devices) - every
  // browser/phone currently subscribed to push on this account, with zero
  // UI over it until now.
  const [pushDevices, setPushDevices] = useState<PushDevice[]>([]);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');

  const loadPushDevices = async () => {
    try {
      setPushDevices(await api.getPushDevices());
    } catch {
      // Endpoint may not exist yet on an older backend - stay silent.
    }
  };

  const handleRenameDevice = async (id: string) => {
    const label = editingLabel.trim();
    setEditingDeviceId(null);
    try {
      const updated = await api.renamePushDevice(id, label || null);
      setPushDevices(prev => prev.map(d => d.id === id ? updated : d));
    } catch (e: any) {
      toast.error(e.message || 'Failed to rename device');
    }
  };

  const handleRevokeDevice = async (id: string) => {
    setPushDevices(prev => prev.filter(d => d.id !== id));
    try {
      await api.revokePushDevice(id);
      toast.success('Device revoked');
    } catch (e: any) {
      loadPushDevices(); // revert on failure
      toast.error(e.message || 'Failed to revoke device');
    }
  };

  // Mouse-only grab-and-drag horizontal scrolling, same pattern as the
  // Continue Watching row and MediaDetailModal's Cast row - deferred pointer
  // capture until an actual drag crosses the 5px threshold, so a plain click
  // on rename/revoke isn't swallowed as a drag.
  const devicesRowRef = useRef<HTMLDivElement>(null);
  const isDevicesPointerDownRef = useRef(false);
  const devicesDragStartXRef = useRef(0);
  const devicesDragStartScrollLeftRef = useRef(0);
  const hasCapturedDevicesPointerRef = useRef(false);

  const handleDevicesPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !devicesRowRef.current) return;
    isDevicesPointerDownRef.current = true;
    hasCapturedDevicesPointerRef.current = false;
    devicesDragStartXRef.current = e.clientX;
    devicesDragStartScrollLeftRef.current = devicesRowRef.current.scrollLeft;
  }, []);

  const handleDevicesPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !isDevicesPointerDownRef.current || !devicesRowRef.current) return;
    if ((e.buttons & 1) === 0) {
      isDevicesPointerDownRef.current = false;
      return;
    }
    const dx = e.clientX - devicesDragStartXRef.current;
    if (Math.abs(dx) > 5 && !hasCapturedDevicesPointerRef.current) {
      devicesRowRef.current.setPointerCapture(e.pointerId);
      hasCapturedDevicesPointerRef.current = true;
    }
    devicesRowRef.current.scrollLeft = devicesDragStartScrollLeftRef.current - dx;
  }, []);

  const handleDevicesPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    isDevicesPointerDownRef.current = false;
    if (hasCapturedDevicesPointerRef.current) {
      devicesRowRef.current?.releasePointerCapture(e.pointerId);
      hasCapturedDevicesPointerRef.current = false;
    }
  }, []);

  // API Key state
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);

  // 2FA (TOTP) state - see server/utils/twoFactor.js for the backend design.
  const [twoFaEnabled, setTwoFaEnabled] = useState<boolean | null>(null);
  const [twoFaSetup, setTwoFaSetup] = useState<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string } | null>(null);
  const [twoFaSetupCode, setTwoFaSetupCode] = useState('');
  const [twoFaEnabling, setTwoFaEnabling] = useState(false);
  const [twoFaStartingSetup, setTwoFaStartingSetup] = useState(false);
  const [twoFaBackupCodes, setTwoFaBackupCodes] = useState<string[] | null>(null);
  const [twoFaDisablePrompt, setTwoFaDisablePrompt] = useState(false);
  const [twoFaDisableCode, setTwoFaDisableCode] = useState('');
  const [twoFaDisabling, setTwoFaDisabling] = useState(false);
  const [twoFaRegenPrompt, setTwoFaRegenPrompt] = useState(false);
  const [twoFaRegenCode, setTwoFaRegenCode] = useState('');
  const [twoFaRegenerating, setTwoFaRegenerating] = useState(false);

  // Webhook testing
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  const [isGeneratingMosaic, setIsGeneratingMosaic] = useState(false);

  // Account/avatar state
  const [accountInfo, setAccountInfo] = useState<AccountStats | null>(null);
  const [avatarModalOpen, setAvatarModalOpen] = useState(false);
  const [uuidCopied, setUuidCopied] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const stats = await api.getAccountStats();
        setAccountInfo(stats);
        setDisplayNameDraft(stats.displayName || '');
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
          notifyOnAddonHealth: settings.notifyOnAddonHealth || false,
          notifyOnNewDevice: settings.notifyOnNewDevice || false,
          notifyOnBackup: settings.notifyOnBackup || false,
          notifyOnProxyHealth: settings.notifyOnProxyHealth || false,
          notifyOnUpdateAvailable: settings.notifyOnUpdateAvailable || false,
          notifyOnMosaic: settings.notifyOnMosaic || false,
          notifyDigestEnabled: settings.notifyDigestEnabled || false,
          notifyDigestFrequency: settings.notifyDigestFrequency === 'weekly' ? 'weekly' : 'daily',
          accountTimezone: settings.accountTimezone || '',
          tmdbApiKey: settings.tmdbApiKey || '',
          mdblistApiKey: settings.mdblistApiKey || '',
          rpdbApiKey: settings.rpdbApiKey || '',
          omdbApiKey: settings.omdbApiKey || '',
          simklClientId: settings.simklClientId || '',
          enableWatchlist: settings.enableWatchlist !== false,
          enableWatchedIndicators: settings.enableWatchedIndicators !== false,
          enableRecommendations: settings.enableRecommendations !== false,
          enableAutoplayTrailer: settings.enableAutoplayTrailer === true,
          autoplayTrailerStartMuted: settings.autoplayTrailerStartMuted !== false,
          enablePosterRatings: settings.enablePosterRatings === true,
          enableReactions: settings.enableReactions !== false,
          enableAutoThemedCatalogs: settings.enableAutoThemedCatalogs === true,
        });

        // Nobody has ever explicitly saved a timezone for this account - the
        // browser already knows the OS's own zone, so silently fill that in
        // once instead of leaving it on the bare fallback until someone
        // happens to open this dropdown. Still stored explicitly server-side
        // right away (background jobs have no browser to read from later) -
        // this only removes the manual first pick, not the persisted value.
        if (settings.accountTimezoneIsDefault) {
          try {
            const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (detected && detected !== settings.accountTimezone) {
              setSyncSettings((prev) => ({ ...prev, accountTimezone: detected }));
              api.updateSyncSettings({ accountTimezone: detected }).catch(() => {});
            }
          } catch {
            // Intl.DateTimeFormat().resolvedOptions().timeZone is universally
            // supported in practice, but never let a detection failure block
            // the rest of settings from loading.
          }
        }
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

      try {
        const status = await api.get2faStatus();
        setTwoFaEnabled(!!status.enabled);
      } catch (e) {
        setTwoFaEnabled(false);
      }
    };

    loadSettings();
    loadPushDevices();
    loadAiServicesStatus();
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

  const handleSaveDisplayName = async () => {
    const trimmed = displayNameDraft.trim();
    if (trimmed === (accountInfo?.displayName || '')) return;
    setSavingDisplayName(true);
    try {
      const result = await api.updateAccountDisplayName(trimmed || null);
      setAccountInfo((prev) => prev ? { ...prev, displayName: result.displayName } : prev);
      setDisplayNameDraft(result.displayName || '');
      toast.success('Nickname saved');
    } catch (e: any) {
      toast.error(e.message || 'Failed to save nickname');
    } finally {
      setSavingDisplayName(false);
    }
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

  const handleGenerateMosaic = async () => {
    setIsGeneratingMosaic(true);
    try {
      const result = await api.generateMosaicNow();
      if (result.posted) {
        toast.success(syncSettings.webhookUrl?.trim()
          ? `Posted ${result.month} — ${result.count} title${result.count === 1 ? '' : 's'} to Discord`
          : `Sent ${result.month} recap — ${result.count} title${result.count === 1 ? '' : 's'} watched`);
      } else if (result.reason === 'nothing watched') {
        toast.error('Nothing watched last month - nothing to post');
      } else {
        toast.error(result.reason || 'Failed to generate mosaic');
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to generate mosaic');
    } finally {
      setIsGeneratingMosaic(false);
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

  const handleStart2fa = async () => {
    setTwoFaStartingSetup(true);
    try {
      const result = await api.setup2fa();
      setTwoFaSetup(result);
      setTwoFaSetupCode('');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to start 2FA setup');
    } finally {
      setTwoFaStartingSetup(false);
    }
  };

  const handleConfirm2fa = async () => {
    if (!twoFaSetup || !twoFaSetupCode.trim()) return;
    setTwoFaEnabling(true);
    try {
      const result = await api.enable2fa(twoFaSetup.secret, twoFaSetupCode.trim());
      setTwoFaEnabled(true);
      setTwoFaSetup(null);
      setTwoFaSetupCode('');
      setTwoFaBackupCodes(result.backupCodes);
      toast.success('2FA enabled');
    } catch (e: any) {
      toast.error(e?.message || 'Incorrect code');
    } finally {
      setTwoFaEnabling(false);
    }
  };

  const handleCancel2faSetup = () => {
    setTwoFaSetup(null);
    setTwoFaSetupCode('');
  };

  const handleDisable2fa = async () => {
    if (!twoFaDisableCode.trim()) return;
    setTwoFaDisabling(true);
    try {
      await api.disable2fa(twoFaDisableCode.trim());
      setTwoFaEnabled(false);
      setTwoFaDisablePrompt(false);
      setTwoFaDisableCode('');
      toast.success('2FA disabled');
    } catch (e: any) {
      toast.error(e?.message || 'Incorrect code');
    } finally {
      setTwoFaDisabling(false);
    }
  };

  const handleRegenerate2faBackupCodes = async () => {
    if (!twoFaRegenCode.trim()) return;
    setTwoFaRegenerating(true);
    try {
      const result = await api.regenerate2faBackupCodes(twoFaRegenCode.trim());
      setTwoFaRegenPrompt(false);
      setTwoFaRegenCode('');
      setTwoFaBackupCodes(result.backupCodes);
      toast.success('New backup codes generated - your old codes no longer work');
    } catch (e: any) {
      toast.error(e?.message || 'Incorrect code');
    } finally {
      setTwoFaRegenerating(false);
    }
  };

  const handleCopyBackupCodes = () => {
    if (!twoFaBackupCodes) return;
    navigator.clipboard.writeText(twoFaBackupCodes.join('\n'));
    toast.success('Backup codes copied to clipboard');
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
      notifyOnAddonHealth: false,
      notifyOnNewDevice: false,
      notifyOnBackup: false,
      notifyOnProxyHealth: false,
      notifyOnUpdateAvailable: false,
      notifyOnMosaic: false,
      notifyDigestEnabled: false,
      notifyDigestFrequency: 'daily',
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
        notifyOnAddonHealth: false,
        notifyOnNewDevice: false,
        notifyOnBackup: false,
        notifyOnProxyHealth: false,
        notifyOnUpdateAvailable: false,
        notifyOnMosaic: false,
        notifyDigestEnabled: false,
        notifyDigestFrequency: 'daily',
      });
      toast.success('Settings reset to defaults');
    } catch (e: any) {
      toast.error(e.message || 'Failed to reset settings');
    }
  };

  // Irreversible - server re-checks public-instance-only and always deletes
  // the caller's own account (never an id from here). Clears the same
  // localStorage token NebulaTopbar's own handleLogout does and sends the
  // browser to /login, since the account (and its session) no longer exists.
  const handleDeleteAccount = async () => {
    setIsDeletingAccount(true);
    try {
      await api.deleteMyAccount();
      localStorage.removeItem('slicksync-admin-token');
      toast.success('Account deleted');
      window.location.href = '/login?mode=admin';
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete account');
      setIsDeletingAccount(false);
    }
  };

  // Mask API key for display
  const maskedApiKey = apiKey 
    ? (apiKeyVisible ? apiKey : apiKey.slice(0, 8) + '••••••••' + apiKey.slice(-4))
    : 'No API key';

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title="Settings"
          subtitle="Customize your SlickSync experience"
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-6 lg:p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={{ maxWidth: layoutMode === 'nebula' ? '72rem' : '896px' }}>
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

            {isPublicInstance && (
              <div className="mt-5 pt-5 border-t border-default">
                <label className="text-sm font-medium text-default mb-1.5 block">Nickname</label>
                <p className="text-xs text-muted mb-2">
                  Pick your own name for this account. It's yours to set - shown next to your UUID wherever this instance needs to tell accounts apart.
                </p>
                <div className="flex items-center gap-2 max-w-sm">
                  <input
                    type="text"
                    value={displayNameDraft}
                    onChange={(e) => setDisplayNameDraft(e.target.value)}
                    onBlur={handleSaveDisplayName}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder="e.g. Thomas's household"
                    maxLength={60}
                    autoComplete="off"
                    spellCheck={false}
                    className="input-base w-full px-3 py-2 text-sm"
                  />
                  {savingDisplayName && <span className="text-xs text-muted shrink-0">Saving...</span>}
                </div>
              </div>
            )}
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
                  Auto-detected from this browser on first visit, then stored explicitly - used server-side to
                  decide what counts as &quot;today&quot; for Watch Time Today and streaks, and background jobs
                  have no browser to re-check it against later, so change it here if you ever travel or move.
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

        {/* Notifications */}
        <PageSection delay={0.15} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-indigo-500/20">
                <GlobeAltIcon className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Notifications</h3>
                <p className="text-xs text-muted">Push + bell by default; add a Discord webhook below for optional Discord delivery too</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Phone / desktop push - separate from Discord: install
                  SlickSync as an app and get new-episode alerts as native
                  notifications, even when it's closed. Per-device. */}
              <div>
                <label className="block text-sm font-medium text-default mb-1">Phone notifications (PWA)</label>
                <p className="text-xs text-muted mb-3">
                  Install SlickSync to your home screen, then enable native new-episode notifications on this device.
                </p>
                <PushNotificationToggle />
              </div>

              <div className="pt-4 border-t border-default">
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
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnVault || false}
                    onChange={(v) => handleSaveSetting('notifyOnVault', v)}
                    label="Toggle vault notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="Addon health notifications"
                  description="Notify when a primary addon goes offline (and switches to its backup) or comes back"
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnAddonHealth || false}
                    onChange={(v) => handleSaveSetting('notifyOnAddonHealth', v)}
                    label="Toggle addon health notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="New device notifications"
                  description="Notify when a user's stream is seen from an IP we haven't confirmed for them before"
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnNewDevice || false}
                    onChange={(v) => handleSaveSetting('notifyOnNewDevice', v)}
                    label="Toggle new device notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="Backup notifications"
                  description="Notify only if an automatic backup fails validation (a good backup stays silent - see its badge on Tasks)"
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnBackup || false}
                    onChange={(v) => handleSaveSetting('notifyOnBackup', v)}
                    label="Toggle backup notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="Proxy connectivity notifications"
                  description="Notify if the AIOStreams proxy (Now Playing polling) goes unreachable or recovers"
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnProxyHealth || false}
                    onChange={(v) => handleSaveSetting('notifyOnProxyHealth', v)}
                    label="Toggle proxy connectivity notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="Update available notifications"
                  description="Notify when a newer stable SlickSync release is published (checked every 6h) - also always visible on Metrics > Health regardless of this toggle"
                >
                  <ToggleSwitch
                    enabled={syncSettings.notifyOnUpdateAvailable || false}
                    onChange={(v) => handleSaveSetting('notifyOnUpdateAvailable', v)}
                    label="Toggle update available notifications"
                  />
                </SettingRow>

                <SettingRow
                  label="Monthly poster mosaic"
                  description={syncSettings.webhookUrl?.trim()
                    ? "Post a poster collage of everything watched last month to Discord, on the 1st"
                    : "Sends a push+bell text recap on the 1st (e.g. \"14 titles watched\") - add a Discord webhook above for the actual poster collage image"}
                >
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleGenerateMosaic}
                      isLoading={isGeneratingMosaic}
                    >
                      Generate now
                    </Button>
                    <ToggleSwitch
                      enabled={syncSettings.notifyOnMosaic || false}
                      onChange={(v) => handleSaveSetting('notifyOnMosaic', v)}
                      label="Toggle monthly poster mosaic"
                    />
                  </div>
                </SettingRow>

                <SettingRow
                  label="Digest mode"
                  description="Batch every notification above into one push + bell summary on a schedule instead of pinging instantly (also posts to Discord if a webhook is set above)"
                >
                  <div className="flex items-center gap-2">
                    <select
                      value={syncSettings.notifyDigestFrequency || 'daily'}
                      onChange={(e) => handleSaveSetting('notifyDigestFrequency', e.target.value)}
                      disabled={!syncSettings.notifyDigestEnabled}
                      className="input-base px-2 py-1.5 text-sm disabled:opacity-50"
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                    <ToggleSwitch
                      enabled={syncSettings.notifyDigestEnabled || false}
                      onChange={(v) => handleSaveSetting('notifyDigestEnabled', v)}
                      label="Toggle digest mode"
                    />
                  </div>
                </SettingRow>
              </div>

              {/* Devices - every push-subscribed browser/phone, with zero
                  visibility anywhere else in the app until now. Grab-and-drag
                  horizontal scroller, same interaction as Continue Watching's
                  row, rather than a plain list - reads as its own little
                  shelf instead of another settings list. */}
              {pushDevices.length > 0 && (
                <div className="pt-4 border-t border-default">
                  <label className="block text-sm font-medium text-default mb-1">Devices</label>
                  <p className="text-xs text-muted mb-3">
                    Every browser or phone currently subscribed to push notifications on this account.
                  </p>
                  <div
                    ref={devicesRowRef}
                    onPointerDown={handleDevicesPointerDown}
                    onPointerMove={handleDevicesPointerMove}
                    onPointerUp={handleDevicesPointerUp}
                    onPointerLeave={handleDevicesPointerUp}
                    className="flex gap-3 overflow-x-auto pb-1 no-scrollbar cursor-grab active:cursor-grabbing select-none"
                  >
                    {pushDevices.map((device) => {
                      const mobile = isMobileDevice(device.userAgent);
                      const displayName = device.label || guessDeviceName(device.userAgent);
                      const isEditing = editingDeviceId === device.id;
                      return (
                        <div
                          key={device.id}
                          className="shrink-0 w-44 p-3 rounded-xl border border-default flex flex-col gap-2"
                          style={{ background: 'var(--color-subtle)' }}
                        >
                          <div className="flex items-center justify-between">
                            <div
                              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                              style={{ background: 'var(--color-primary-muted)' }}
                            >
                              {mobile
                                ? <DevicePhoneMobileIcon className="w-4 h-4 text-primary" />
                                : <ComputerDesktopIcon className="w-4 h-4 text-primary" />}
                            </div>
                            <button
                              onClick={() => handleRevokeDevice(device.id)}
                              title="Revoke this device"
                              className="p-1 rounded-md text-subtle hover:text-error hover:bg-surface transition-colors"
                            >
                              <TrashIcon className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <input
                                autoFocus
                                value={editingLabel}
                                onChange={(e) => setEditingLabel(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleRenameDevice(device.id);
                                  if (e.key === 'Escape') setEditingDeviceId(null);
                                }}
                                placeholder={guessDeviceName(device.userAgent)}
                                className="input-base px-2 py-1 text-xs w-full"
                              />
                              <button onClick={() => handleRenameDevice(device.id)} className="shrink-0 text-success">
                                <CheckIcon className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => setEditingDeviceId(null)} className="shrink-0 text-subtle">
                                <XMarkIcon className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setEditingDeviceId(device.id); setEditingLabel(device.label || ''); }}
                              className="flex items-center gap-1 text-left group"
                            >
                              <p className="text-sm font-medium text-default truncate">{displayName}</p>
                              <PencilIcon className="w-3 h-3 text-subtle opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                            </button>
                          )}

                          <p className="text-xs text-subtle">{formatLastSeen(device.lastSeenAt)}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </PageSection>

        {/* SlickTrax — opt-outs for SlickSync's native tracking surfaces
            (Watchlist, Watched indicators, Recommendations). All default ON.
            Turning any off hides its UI + skips its network requests
            immediately (the hook cache invalidates on save). */}
        <PageSection delay={0.18} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <SparklesIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">SlickTrax</h3>
                <p className="text-xs text-muted">Toggle SlickSync&apos;s built-in tracking system on or off. Your watch history is unaffected — this only controls what you see.</p>
              </div>
            </div>

            <div className="space-y-3">
              <SettingRow
                label="Watchlist"
                description="Bookmark items to watch later. Adds a ★ Watchlist source in Discover and an Add-to-Watchlist button on every detail page. Off: everything watchlist-related is hidden; saved items stay in the database until you re-enable."
              >
                <ToggleSwitch
                  enabled={syncSettings.enableWatchlist !== false}
                  onChange={async (v) => { await handleSaveSetting('enableWatchlist' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle Watchlist"
                />
              </SettingRow>

              <SettingRow
                label="Watched indicators"
                description="Show ✓ checkmark badges on Discover posters for things you've already watched (from either provider), the Unwatched / Watched filter, and the Mark-as-watched menu option. Off: no badges, no filter, no menu item."
              >
                <ToggleSwitch
                  enabled={syncSettings.enableWatchedIndicators !== false}
                  onChange={async (v) => { await handleSaveSetting('enableWatchedIndicators' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle watched indicators"
                />
              </SettingRow>

              <SettingRow
                label="Recommendations"
                description={'The "Because you watched X" rows on the Dashboard, computed from your watch-history genres. Off: no recommendations panel, no server-side genre computation.'}
              >
                <ToggleSwitch
                  enabled={syncSettings.enableRecommendations !== false}
                  onChange={async (v) => { await handleSaveSetting('enableRecommendations' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle recommendations"
                />
              </SettingRow>

              <SettingRow
                label="Auto-generated catalogs"
                description={'Detects a real taste cluster in your watch history (a genre, or a genre+decade combo like "90s Action") and saves it as an actual Catalog - e.g. "Your 90s Action Pack" - instead of a recommendation row that only scrolls by once. Checked daily; deleting a generated catalog stops it from coming back. Off by default.'}
              >
                <ToggleSwitch
                  enabled={syncSettings.enableAutoThemedCatalogs === true}
                  onChange={async (v) => { await handleSaveSetting('enableAutoThemedCatalogs' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle auto-generated catalogs"
                />
              </SettingRow>

              <SettingRow
                label="Poster ratings"
                description="Show IMDb/Rotten Tomatoes/Metacritic score badges on every poster card in Discover and Catalogs - also the master switch for RPDB's rating-embedded posters below, if you've set a key. Off by default - turn this on if you want scores visible before opening a title."
              >
                <ToggleSwitch
                  enabled={syncSettings.enablePosterRatings === true}
                  onChange={async (v) => { await handleSaveSetting('enablePosterRatings' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle poster ratings"
                />
              </SettingRow>

              <SettingRow
                label="Reactions"
                description="Thumbs up/down on the detail modal. Not just decorative - it feeds what SlickTrax recommends, boosting titles similar to what you reacted positively to and suppressing ones similar to what you didn't like."
              >
                <ToggleSwitch
                  enabled={syncSettings.enableReactions !== false}
                  onChange={async (v) => { await handleSaveSetting('enableReactions' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle reactions"
                />
              </SettingRow>

              <SettingRow
                label="Autoplay trailer"
                description="When you open a title's detail popup, its trailer starts playing automatically instead of waiting for a Play Trailer click. Off by default - turn this on if you want it."
              >
                <ToggleSwitch
                  enabled={syncSettings.enableAutoplayTrailer === true}
                  onChange={async (v) => { await handleSaveSetting('enableAutoplayTrailer' as keyof SyncSettings, v); invalidatePersonalFeatures(); }}
                  label="Toggle autoplay trailer"
                />
              </SettingRow>

              <SettingRow
                label="Autoplay with sound"
                description="Whether the autoplayed trailer starts muted (default) or with sound. An explicit Play Trailer click always has sound regardless of this."
                disabled={syncSettings.enableAutoplayTrailer !== true}
              >
                <ToggleSwitch
                  enabled={syncSettings.autoplayTrailerStartMuted === false}
                  onChange={async (v) => { await handleSaveSetting('autoplayTrailerStartMuted' as keyof SyncSettings, !v); invalidatePersonalFeatures(); }}
                  label="Toggle autoplay trailer sound"
                />
              </SettingRow>
            </div>
          </Card>
        </PageSection>

        {/* External API Keys — every external service key SlickSync can use, split
            out from SlickTrax so that card stays pure on/off toggles.
            Each one is optional and account-scoped: resolved from here
            first, falling back to the instance's own env var (if the
            operator configured one) only when this is left blank - never
            a flat shared key silently used across every account. */}
        <PageSection delay={0.19} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <KeyIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">External API Keys</h3>
                <p className="text-xs text-muted">Optional keys for external services. Yours first, the server's own (if configured) as a fallback.</p>
              </div>
            </div>

            <div className="space-y-3">
              {/* AI Services key - powers natural-language Catalog building
                  (Catalogs -> "Describe a catalog"). Placed first/most
                  prominent of this group deliberately: this used to only be
                  configurable from a generic Vault "add credential" entry
                  with no explanation of what it did, which made it easy to
                  add a key there and have no idea whether it was doing
                  anything. Still stored as a Vault entry underneath (see
                  api.ts), just with a clear, focused front door here. */}
              <div className="rounded-xl p-3" style={{ background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)' }}>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-default">AI Services <span className="text-subtle font-normal">(optional)</span></label>
                  <div className="flex items-center gap-2">
                    {isSavingAi && <span className="text-xs text-subtle">Verifying...</span>}
                    {!isSavingAi && aiConfigured && aiCheckStatus === 'ok' && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-success-muted)', color: 'var(--color-success)' }}>
                        Verified
                      </span>
                    )}
                    {!isSavingAi && aiConfigured && aiCheckStatus === 'error' && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-error-muted)', color: 'var(--color-error)' }} title={aiCheckMessage || undefined}>
                        Check failed
                      </span>
                    )}
                    {!isSavingAi && aiConfigured && !aiCheckStatus && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-surface-border)', color: 'var(--color-text-muted)' }}>
                        Not yet verified
                      </span>
                    )}
                    {aiConfigured && (
                      <button
                        type="button"
                        onClick={handleRemoveAiServices}
                        className="text-subtle hover:text-error transition-colors"
                        title="Remove AI Services"
                      >
                        <XMarkIcon className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted mb-2">
                  Powers natural-language Catalog building (Catalogs → &quot;Describe a catalog&quot;) — describe what you want in plain English and get a real saved Catalog back. Works without a key too, using a built-in keyword parser; adding one here just makes it understand nuanced descriptions better. Defaults to OpenAI, but any OpenAI-compatible endpoint works (OpenRouter, Groq, a local proxy) - the base URL and model need to actually match each other (a Gemini model name against OpenAI&apos;s own endpoint will fail).
                </p>
                {aiCheckStatus === 'error' && aiCheckMessage && (
                  <p className="text-xs mb-2" style={{ color: 'var(--color-error)' }}>{aiCheckMessage}</p>
                )}
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type={aiKeyVisible ? 'text' : 'password'}
                      value={aiApiKey}
                      onChange={(e) => setAiApiKey(e.target.value)}
                      onBlur={handleAiFieldBlur}
                      placeholder={aiConfigured ? '•••••••• (leave blank to keep current)' : 'API key'}
                      autoComplete="off"
                      spellCheck={false}
                      className="input-base w-full px-3 py-2 pr-10 text-sm"
                    />
                    {aiConfigured && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()} // don't steal focus from the input before the click registers
                        onClick={() => { if (!aiKeyVisible) handleRevealAiKey(); setAiKeyVisible((v) => !v); }}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-surface-hover transition-colors"
                        style={{ color: 'var(--color-textMuted)' }}
                        title={aiKeyVisible ? 'Hide key' : 'Show key'}
                      >
                        {aiKeyVisible ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <ComboBox
                      value={aiBaseUrl}
                      onChange={setAiBaseUrl}
                      onBlur={handleAiFieldBlur}
                      placeholder="API base URL (optional, default OpenAI)"
                      options={AI_BASE_URL_OPTIONS}
                    />
                    <ComboBox
                      value={aiModel}
                      onChange={setAiModel}
                      onBlur={handleAiFieldBlur}
                      placeholder="Model (optional, default gpt-5.2-mini)"
                      options={aiModelOptions}
                    />
                  </div>
                  <p className="text-[11px] text-subtle">
                    {loadingAiModels
                      ? 'Loading current models from the provider...'
                      : liveAiModels.length > 0
                        ? `${liveAiModels.length} models loaded live from the provider.`
                        : 'Showing common suggestions - enter a key to load the provider\'s actual current model list.'}
                  </p>
                </div>
              </div>

              {/* TMDb key for the cast/crew deep-dive. Text field, not a
                  toggle - the feature simply appears once a valid key is set.
                  Free from themoviedb.org (Settings -> API). Saved on blur,
                  same pattern as the webhook URL above. */}
              <div>
                <label className="block text-sm font-medium text-default mb-1.5">TMDb API key <span className="text-subtle font-normal">(optional)</span></label>
                <p className="text-xs text-muted mb-2">
                  Enables the cast/crew deep-dive — click any actor in a title's detail popup to see everything else they're in. Get a free key at themoviedb.org → Settings → API. Leave blank to keep the feature off.
                </p>
                <input
                  type="text"
                  value={syncSettings.tmdbApiKey || ''}
                  onChange={(e) => setSyncSettings(prev => ({ ...prev, tmdbApiKey: e.target.value }))}
                  onBlur={() => handleSaveSetting('tmdbApiKey' as keyof SyncSettings, syncSettings.tmdbApiKey)}
                  placeholder="TMDb API key"
                  autoComplete="off"
                  spellCheck={false}
                  className="input-base w-full px-3 py-2 text-sm"
                />
              </div>

              {/* MDBList key for List import (Lists page - "Import"). Free
                  from mdblist.com -> Preferences -> API Access. Same
                  optional-text-field pattern as the TMDb key above. */}
              <div className="pt-1">
                <label className="block text-sm font-medium text-default mb-1.5">MDBList API key <span className="text-subtle font-normal">(optional)</span></label>
                <p className="text-xs text-muted mb-2">
                  Enables importing an MDBList list into Lists. Get a free key at mdblist.com → Preferences → API Access. Leave blank to keep list import to TMDb lists only.
                </p>
                <input
                  type="text"
                  value={syncSettings.mdblistApiKey || ''}
                  onChange={(e) => setSyncSettings(prev => ({ ...prev, mdblistApiKey: e.target.value }))}
                  onBlur={() => handleSaveSetting('mdblistApiKey' as keyof SyncSettings, syncSettings.mdblistApiKey)}
                  placeholder="MDBList API key"
                  autoComplete="off"
                  spellCheck={false}
                  className="input-base w-full px-3 py-2 text-sm"
                />
              </div>

              {/* RPDB key - upgrades posters app-wide (Discover, Lists,
                  Activity, Airing Calendar) to rating-embedded art. The free
                  tier (Tier 0) already includes ratings, just not the
                  customizable badge styles - plenty for this purpose. */}
              <div className="pt-1">
                <label className="block text-sm font-medium text-default mb-1.5">RPDB API key <span className="text-subtle font-normal">(optional)</span></label>
                <p className="text-xs text-muted mb-2">
                  Upgrades posters everywhere to rating-embedded art from RatingPosterDB, when Poster ratings (in SlickTrax above) is also on. The free key works fine. Get one at ratingposterdb.com → API Key. Leave blank to keep today's posters.
                </p>
                <input
                  type="text"
                  value={syncSettings.rpdbApiKey || ''}
                  onChange={(e) => setSyncSettings(prev => ({ ...prev, rpdbApiKey: e.target.value }))}
                  onBlur={async () => { await handleSaveSetting('rpdbApiKey' as keyof SyncSettings, syncSettings.rpdbApiKey); invalidatePersonalFeatures(); }}
                  placeholder="RPDB API key"
                  autoComplete="off"
                  spellCheck={false}
                  className="input-base w-full px-3 py-2 text-sm"
                />
              </div>

              {/* OMDb key - Rotten Tomatoes/Metacritic ratings on posters and
                  the detail modal, account-scoped like the three keys above
                  it so this account's OMDb quota isn't shared with everyone
                  else on the instance. */}
              <div className="pt-1">
                <label className="block text-sm font-medium text-default mb-1.5">OMDb API key <span className="text-subtle font-normal">(optional)</span></label>
                <p className="text-xs text-muted mb-2">
                  Adds Rotten Tomatoes/Metacritic ratings. Get a free key at omdbapi.com/apikey.aspx. Paste just the key itself, not the test URL OMDb's confirmation email shows (the one starting "http://www.omdbapi.com/?i=..."). Leave blank to use the server's own key, if one is configured.
                </p>
                <input
                  type="text"
                  value={syncSettings.omdbApiKey || ''}
                  onChange={(e) => setSyncSettings(prev => ({ ...prev, omdbApiKey: e.target.value }))}
                  onBlur={() => handleSaveSetting('omdbApiKey' as keyof SyncSettings, syncSettings.omdbApiKey)}
                  placeholder="OMDb API key"
                  autoComplete="off"
                  spellCheck={false}
                  className="input-base w-full px-3 py-2 text-sm"
                />
              </div>

              {/* SIMKL Client ID - powers the "Link SIMKL" flow on a user's
                  own page (watch-history pull/push). Account-scoped like the
                  keys above so this account isn't dependent on whatever the
                  server operator did or didn't configure in .env. */}
              <div className="pt-1">
                <label className="block text-sm font-medium text-default mb-1.5">SIMKL Client ID <span className="text-subtle font-normal">(optional)</span></label>
                <p className="text-xs text-muted mb-2">
                  Powers linking a user&apos;s SIMKL account for watch-history sync. Get one free: sign in at{' '}
                  <a href="https://simkl.com/settings/developer" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">simkl.com/settings/developer</a>
                  {' '}→ under &quot;List of your apps&quot;, click <strong>+ Add a New App</strong> → give it any name and redirect URI (SlickSync&apos;s SIMKL login is PIN-based, so the redirect URI is never actually used — any placeholder like https://slicksync.local works) → paste the <strong>Client ID</strong> it shows you here. The Client Secret isn&apos;t needed. Leave blank to use the server&apos;s own, if one is configured.
                </p>
                <input
                  type="text"
                  value={syncSettings.simklClientId || ''}
                  onChange={(e) => setSyncSettings(prev => ({ ...prev, simklClientId: e.target.value }))}
                  onBlur={() => handleSaveSetting('simklClientId' as keyof SyncSettings, syncSettings.simklClientId)}
                  placeholder="SIMKL Client ID"
                  autoComplete="off"
                  spellCheck={false}
                  className="input-base w-full px-3 py-2 text-sm"
                />
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
                <a
                  href="/api/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline mt-2"
                >
                  Interactive API docs
                  <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          </Card>
        </PageSection>

        {/* Two-Factor Authentication - opt-in TOTP on top of the account
            login. See server/utils/twoFactor.js for why disable/regenerate
            both require a fresh code rather than just an active session. */}
        <PageSection delay={0.21} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                <ShieldCheckIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Two-Factor Authentication</h3>
                <p className="text-xs text-muted">Require a code from an authenticator app to sign in, on top of your password</p>
              </div>
            </div>

            {twoFaEnabled === null ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : twoFaSetup ? (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-4 items-start">
                  <img
                    src={twoFaSetup.qrCodeDataUrl}
                    alt="2FA QR code"
                    className="w-40 h-40 rounded-lg border border-default bg-white p-2 shrink-0"
                  />
                  <div className="space-y-2 min-w-0">
                    <p className="text-sm text-default">Scan this with your authenticator app (Google Authenticator, Authy, 1Password, etc.), or enter the code manually:</p>
                    <code className="block text-xs font-mono text-muted break-all px-2 py-1.5 rounded bg-subtle border border-default">
                      {twoFaSetup.secret}
                    </code>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-default mb-1.5">Enter the 6-digit code it shows</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoFocus
                      value={twoFaSetupCode}
                      onChange={(e) => setTwoFaSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm2fa(); }}
                      placeholder="123456"
                      className="input-base px-3 py-2 text-sm font-mono tracking-widest w-32"
                    />
                    <Button variant="primary" size="sm" onClick={handleConfirm2fa} disabled={twoFaSetupCode.length !== 6 || twoFaEnabling} isLoading={twoFaEnabling}>
                      Confirm
                    </Button>
                    <Button variant="ghost" size="sm" onClick={handleCancel2faSetup} disabled={twoFaEnabling}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            ) : twoFaEnabled ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="success">Enabled</Badge>
                  <span className="text-xs text-muted">You&apos;ll be asked for a code from your authenticator app each time you sign in</span>
                </div>
                {twoFaDisablePrompt ? (
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoFocus
                      value={twoFaDisableCode}
                      onChange={(e) => setTwoFaDisableCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleDisable2fa(); }}
                      placeholder="Code or backup code"
                      className="input-base px-3 py-2 text-sm font-mono w-40"
                    />
                    <Button variant="danger" size="sm" onClick={handleDisable2fa} disabled={!twoFaDisableCode.trim() || twoFaDisabling} isLoading={twoFaDisabling}>
                      Confirm disable
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setTwoFaDisablePrompt(false); setTwoFaDisableCode(''); }} disabled={twoFaDisabling}>
                      Cancel
                    </Button>
                  </div>
                ) : twoFaRegenPrompt ? (
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoFocus
                      value={twoFaRegenCode}
                      onChange={(e) => setTwoFaRegenCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRegenerate2faBackupCodes(); }}
                      placeholder="Current code"
                      className="input-base px-3 py-2 text-sm font-mono w-40"
                    />
                    <Button variant="primary" size="sm" onClick={handleRegenerate2faBackupCodes} disabled={!twoFaRegenCode.trim() || twoFaRegenerating} isLoading={twoFaRegenerating}>
                      Confirm
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setTwoFaRegenPrompt(false); setTwoFaRegenCode(''); }} disabled={twoFaRegenerating}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setTwoFaRegenPrompt(true)}>
                      Regenerate backup codes
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setTwoFaDisablePrompt(true)}>
                      Disable 2FA
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <Button variant="primary" size="sm" onClick={handleStart2fa} isLoading={twoFaStartingSetup}>
                Enable 2FA
              </Button>
            )}
          </Card>
        </PageSection>

        {/* Backup codes - shown exactly once, right after enabling 2FA or
            regenerating codes. Closing this modal is the only way past it,
            same "you must acknowledge you saved this" pattern as the
            Disaster Recovery Kit passphrase reveal elsewhere in the app. */}
        <Modal isOpen={!!twoFaBackupCodes} onClose={() => setTwoFaBackupCodes(null)} title="Your backup codes" size="sm">
          {twoFaBackupCodes && (
            <div className="space-y-3">
              <p className="text-sm text-default">
                Save these somewhere safe. Each one lets you sign in <strong>once</strong> if you lose access to your authenticator app. They won&apos;t be shown again.
              </p>
              <div className="grid grid-cols-2 gap-1.5 p-3 rounded-lg bg-subtle border border-default">
                {twoFaBackupCodes.map((c) => (
                  <code key={c} className="text-xs font-mono text-default">{c}</code>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={handleCopyBackupCodes} leftIcon={<ClipboardDocumentIcon className="w-4 h-4" />}>
                  Copy
                </Button>
                <Button variant="primary" size="sm" onClick={() => setTwoFaBackupCodes(null)}>
                  I&apos;ve saved these
                </Button>
              </div>
            </div>
          )}
        </Modal>

        {/* Account ID - public-mode login is a UUID with no recovery flow
            (per the register page's own warning), and there was previously
            nowhere to look it back up short of the Account dropdown modal.
            Always findable here for troubleshooting/support. */}
        {isPublicInstance && accountInfo?.uuid && (
          <PageSection delay={0.22} className="mb-6">
            <Card padding="lg">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary-muted">
                  <KeyIcon className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h3 className="text-base font-semibold font-display text-default">Account ID</h3>
                  <p className="text-xs text-muted">Your login UUID - keep this handy for support/troubleshooting</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 px-4 py-3 rounded-xl text-sm font-mono truncate bg-bg border border-surface-border text-default">
                  {accountInfo.uuid}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(accountInfo.uuid!);
                    setUuidCopied(true);
                    toast.success('Account ID copied to clipboard');
                    setTimeout(() => setUuidCopied(false), 2000);
                  }}
                >
                  {uuidCopied ? (
                    <CheckIcon className="w-4 h-4" />
                  ) : (
                    <ClipboardDocumentIcon className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </Card>
          </PageSection>
        )}

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

              {/* Public-mode only - private mode's "account" is the whole
                  shared instance, not a personal one a user should be able
                  to wipe from a settings toggle. */}
              {isPublicInstance && (
                <div className="flex items-center justify-between p-4 rounded-lg bg-error-muted">
                  <div>
                    <p className="font-medium text-sm text-default">Delete Account</p>
                    <p className="text-xs text-muted">Permanently delete your SlickSync account and all its data</p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    leftIcon={<TrashIcon className="w-4 h-4" />}
                    onClick={() => setIsDeleteAccountModalOpen(true)}
                  >
                    Delete Account
                  </Button>
                </div>
              )}
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

      {/* Delete Account Confirmation Modal */}
      <ConfirmModal
        isOpen={isDeleteAccountModalOpen}
        onClose={() => setIsDeleteAccountModalOpen(false)}
        onConfirm={handleDeleteAccount}
        title="Delete Your Account?"
        description="This permanently deletes your SlickSync account and every piece of data tied to it: all managed users, groups, addons, catalogs, watch history, Vault entries, and settings. There is no undo, no recovery, and no grace period - deletion happens immediately. If you're sure, click 'Yes, delete everything' below. Otherwise, click 'No, keep my account.'"
        confirmText="Yes, delete everything"
        cancelText="No, keep my account"
        variant="danger"
        isLoading={isDeletingAccount}
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
