'use client';

import { useState, useEffect, useRef, memo } from 'react';
import { motion } from 'framer-motion';
import {
  Cog6ToothIcon,
  EyeIcon,
  EyeSlashIcon,
  UserCircleIcon,
  ShieldCheckIcon,
  ArrowPathIcon,
  PaintBrushIcon,
  CheckIcon,
  KeyIcon,
  ClipboardDocumentIcon,
  GlobeAltIcon,
  BeakerIcon,
} from '@heroicons/react/24/outline';
import { useUserAuth, useUserAuthHeaders } from '@/lib/hooks/useUserAuth';
import { copyToClipboard } from '@/lib/clipboard';
import { userAuth, userExport, getUserApiKey } from '@/lib/user-api';
import { UserPageHeader } from '@/components/user/UserPageContainer';
import { ToggleSwitch, ConfirmModal } from '@/components/ui';
import { useTheme, themeMeta, themeIds, ThemeId } from '@/lib/theme';
import { toast } from '@/components/ui/Toast';
import { providerTypeLabel } from '@/lib/providers';
import { PersonPushRow } from '@/components/user/PersonPushRow';
import { ProfilePictureEditor } from '@/components/user/ProfilePictureEditor';
import { HistoryImportTile } from '@/components/user/HistoryImportTile';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useCwTime, useFoldArrows, useNameFolds, useNowPlayingProgress, useNowPlayingWho, usePageArrangement, usePageDesign } from '@/lib/arrange';
import { MeSettingsV2, SETTINGS_SECTIONS } from '@/components/v2/MeSettingsV2';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

// Theme Card component
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
      className={`relative p-3 rounded-xl border-2 transition-all text-left w-full ${isSelected ? 'opt-card-on' : 'opt-card-off'}`}
    >
      {isSelected && (
        <div 
          className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-primary)' }}
        >
          <CheckIcon className="w-3 h-3" style={{ color: 'var(--color-bg)' }} />
        </div>
      )}
      
      {/* Theme preview - mini mockup */}
      <div
        className="w-full h-20 rounded-lg mb-2 overflow-hidden"
        style={{ backgroundColor: colors.bg, border: `1px solid ${colors.surface}` }}
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
      
      <p className="font-medium text-sm" style={{ color: 'var(--color-text)' }}>
        {meta.name}
      </p>
      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {meta.description}
      </p>
    </motion.button>
  );
});

export default function UserSettingsPage() {
  const { userInfo, refreshUserInfo, provider, deleteAccount } = useUserAuth();
  const { userId, authKey, isReady } = useUserAuthHeaders();
  const providerLabel = providerTypeLabel(provider);
  const { themeId, setTheme } = useTheme();
  // Page design for their own pages: their own choice, saved with their
  // account (Classic until they pick v2).
  const { design, setDesign } = usePageDesign();
  const { where: npWhere, setWhere: setNpWhere } = useNowPlayingWho();
  const { where: cwWhere, setWhere: setCwWhere } = useCwTime();
  const { where: npProgress, setWhere: setNpProgress } = useNowPlayingProgress();
  const { shown: arrows, setShown: setArrows } = useFoldArrows();
  const { on: nameTap, setOn: setNameTap } = useNameFolds();
  const isTV = useIsTV();
  const v2 = design === 'v2' && !isTV;
  const v2Arrange = usePageArrangement('settings', [...SETTINGS_SECTIONS], { defaultFolded: ['leave'] });

  // Self-service "delete my account" - only this user's own data, not the
  // whole shared instance (that's an admin-only action). Works in both
  // private and public instance mode.
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const handleDeleteAccount = async () => {
    setIsDeletingAccount(true);
    const result = await deleteAccount();
    if (result.success) {
      toast.success('Your account was deleted');
      window.location.href = '/login?mode=user';
    } else {
      toast.error(result.error || 'Failed to delete account');
      setIsDeletingAccount(false);
    }
  };
  
  // Activity visibility
  const [updating, setUpdating] = useState(false);
  const [activityVisibility, setActivityVisibility] = useState<'public' | 'private'>('private');
  const [activityVisibilityLoaded, setActivityVisibilityLoaded] = useState(false);

  // Public stats share link - a genuinely public, unauthenticated link,
  // distinct from Activity Visibility above (household-only)
  const [publicStatsEnabled, setPublicStatsEnabled] = useState(false);
  const [publicStatsSlug, setPublicStatsSlug] = useState<string | null>(null);
  const [publicStatsLoaded, setPublicStatsLoaded] = useState(false);
  const [savingPublicStats, setSavingPublicStats] = useState(false);
  
  // Discord webhook
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState('');
  const [isSavingWebhook, setIsSavingWebhook] = useState(false);
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  // Whether MY watch activity (started/watched) notifies at all — account-wide
  // notifications stay on for everyone else regardless of what I pick here.
  const [notifyOnWatch, setNotifyOnWatch] = useState(true);
  const [notifyOnWatchLoaded, setNotifyOnWatchLoaded] = useState(false);
  const [isSavingNotifyOnWatch, setIsSavingNotifyOnWatch] = useState(false);
  
  // API Key
  const [apiKeyStatus, setApiKeyStatus] = useState<{ hasKey: boolean }>({ hasKey: false });
  const [currentApiKey, setCurrentApiKey] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [isGeneratingKey, setIsGeneratingKey] = useState(false);
  const autoGenAttemptedRef = useRef<boolean>(false);

  // Load user settings on mount
  useEffect(() => {
    if (!userId || !authKey) return;
    
    const loadSettings = async () => {
      try {
        // Get user info for activity visibility
        const info = await userAuth.getUserInfo(userId, authKey);
        setActivityVisibility(info?.activityVisibility ?? 'private');
        setActivityVisibilityLoaded(true);
        setPublicStatsEnabled(info?.publicStatsEnabled ?? false);
        setPublicStatsSlug(info?.publicStatsSlug ?? null);
        setPublicStatsLoaded(true);
        setDiscordWebhookUrl(info?.discordWebhookUrl || '');
        setNotifyOnWatch(info?.notifyOnWatch !== false);
        setNotifyOnWatchLoaded(true);

        // Fetch API key
        try {
          const data = await getUserApiKey(userId, authKey);
          const hasKey = data?.hasKey || false;
          const apiKey = data?.apiKey || null;
          setApiKeyStatus({ hasKey });
          if (hasKey && apiKey) {
            setCurrentApiKey(apiKey);
          } else {
            setCurrentApiKey(null);
          }
          
          // Auto-generate if missing
          if (!hasKey && !autoGenAttemptedRef.current) {
            autoGenAttemptedRef.current = true;
            try {
              const genResponse = await fetch(`${API_BASE}/public-library/user-api-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, authKey }),
              });
              const genData = await genResponse.json();
              const newKey = genData?.apiKey;
              if (newKey) {
                setCurrentApiKey(newKey);
                setApiKeyStatus({ hasKey: true });
                toast.success('API key auto-generated');
                copyToClipboard(newKey).catch(() => {});
              }
            } catch (e: any) {
              toast.error('Failed to auto-generate API key');
            }
          }
        } catch {
          setApiKeyStatus({ hasKey: false });
        }
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    };
    
    loadSettings();
  }, [userId, authKey]);

  // Toggle activity visibility
  const handleToggleVisibility = async () => {
    if (!isReady || !userId || !authKey || updating) return;

    const newVisibility = activityVisibility === 'public' ? 'private' : 'public';

    setUpdating(true);
    try {
      await userAuth.updateActivityVisibility(userId, authKey, newVisibility);
      setActivityVisibility(newVisibility);
      await refreshUserInfo();
      toast.success(`Activity visibility set to ${newVisibility}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update visibility');
    } finally {
      setUpdating(false);
    }
  };

  // Toggle the public stats share link
  const handleTogglePublicStats = async () => {
    if (!isReady || !userId || !authKey || savingPublicStats) return;
    setSavingPublicStats(true);
    try {
      if (publicStatsEnabled) {
        await userAuth.disablePublicStats(userId, authKey);
        setPublicStatsEnabled(false);
        setPublicStatsSlug(null);
        toast.success('Public stats link disabled');
      } else {
        const { slug } = await userAuth.enablePublicStats(userId, authKey);
        setPublicStatsEnabled(true);
        setPublicStatsSlug(slug);
        toast.success('Public stats link enabled');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to update public stats link');
    } finally {
      setSavingPublicStats(false);
    }
  };

  const publicStatsUrl = publicStatsSlug ? `${typeof window !== 'undefined' ? window.location.origin : ''}/u/${publicStatsSlug}` : null;

  const handleCopyPublicStatsUrl = async () => {
    if (!publicStatsUrl) return;
    try {
      await copyToClipboard(publicStatsUrl);
      toast.success('Link copied to clipboard');
    } catch {
      toast.error('Failed to copy link');
    }
  };

  // Download own history + watchlist as JSON
  const [isExportingMyData, setIsExportingMyData] = useState(false);
  const handleExportMyData = async () => {
    if (!userId || !authKey || isExportingMyData) return;
    setIsExportingMyData(true);
    try {
      const data = await userExport.getExport(userId, authKey);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().split('T')[0];
      a.download = `${date}-slicksync-my-data.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Your data was exported');
    } catch (err: any) {
      toast.error(err.message || 'Failed to export your data');
    } finally {
      setIsExportingMyData(false);
    }
  };

  // Save Discord webhook
  const handleSaveWebhook = async () => {
    if (!userId || !authKey) return;
    setIsSavingWebhook(true);
    try {
      const response = await fetch(`${API_BASE}/public-library/user-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-stremio-auth': authKey },
        body: JSON.stringify({ userId, discordWebhookUrl: discordWebhookUrl.trim() || null }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message || data?.error || 'Failed to save webhook');
      }
      toast.success('Webhook URL saved');
    } catch (e: any) {
      toast.error(e.message || 'Failed to save webhook');
    } finally {
      setIsSavingWebhook(false);
    }
  };

  // Toggle whether MY watch activity notifies at all
  const handleToggleNotifyOnWatch = async () => {
    if (!userId || !authKey || isSavingNotifyOnWatch) return;
    const next = !notifyOnWatch;
    setNotifyOnWatch(next);
    setIsSavingNotifyOnWatch(true);
    try {
      const response = await fetch(`${API_BASE}/public-library/user-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-stremio-auth': authKey },
        body: JSON.stringify({ userId, notifyOnWatch: next }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.message || data?.error || 'Failed to update notification preference');
      }
      toast.success(next ? 'Watch notifications enabled' : 'Watch notifications disabled');
    } catch (e: any) {
      setNotifyOnWatch(!next);
      toast.error(e.message || 'Failed to update notification preference');
    } finally {
      setIsSavingNotifyOnWatch(false);
    }
  };

  // Test Discord webhook
  const handleTestWebhook = async () => {
    const trimmed = (discordWebhookUrl || '').trim();
    if (!trimmed) {
      toast.error('Enter a webhook URL first');
      return;
    }
    if (!userId) return;
    
    setIsTestingWebhook(true);
    try {
      await fetch(`${API_BASE}/users/${userId}/test-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: trimmed }),
      });
      toast.success('Test message sent to Discord');
    } catch (e: any) {
      toast.error(e.message || 'Failed to send test message');
    } finally {
      setIsTestingWebhook(false);
    }
  };

  // Generate/Rotate API key
  const handleGenerateApiKey = async () => {
    if (!userId || !authKey) return;
    setIsGeneratingKey(true);
    try {
      // This button is the person asking for a new key; the server only
      // replaces one they already have when told to.
      const response = await fetch(`${API_BASE}/public-library/user-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, authKey, rotate: true }),
      });
      const data = await response.json();
      const newKey = data?.apiKey;
      if (newKey) {
        setCurrentApiKey(newKey);
        setApiKeyStatus({ hasKey: true });
        copyToClipboard(newKey);
        toast.success(currentApiKey ? 'API key rotated and copied' : 'API key generated and copied');
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to generate API key');
    } finally {
      setIsGeneratingKey(false);
    }
  };

  // Copy API key
  const handleCopyApiKey = () => {
    if (currentApiKey) {
      copyToClipboard(currentApiKey);
      toast.success('API key copied to clipboard');
    }
  };

  // Format date
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const isPublic = activityVisibility === 'public';
  
  // Mask API key for display
  const maskedApiKey = currentApiKey 
    ? (apiKeyVisible ? currentApiKey : currentApiKey.slice(0, 8) + '••••••••' + currentApiKey.slice(-4))
    : 'No API key';

  const deleteModal = (
    <ConfirmModal
      isOpen={isDeleteModalOpen}
      onClose={() => setIsDeleteModalOpen(false)}
      onConfirm={handleDeleteAccount}
      title="Delete Your Account?"
      description={`This permanently deletes your own watch history, watchlist, and account. It does not delete the shared addons, groups, or any other household member's data - only what belongs to you (${userInfo?.username || 'this account'}). There is no undo. If you're sure, click 'Yes, delete my account' below.`}
      confirmText="Yes, delete my account"
      cancelText="No, keep my account"
      variant="danger"
      isLoading={isDeletingAccount}
    />
  );

  if (v2) {
    return (
      <div className="p-4 sm:p-8">
        <MeSettingsV2
          arrange={v2Arrange}
          providerLabel={providerLabel}
          picture={<ProfilePictureEditor name={userInfo?.username || 'User'} email={userInfo?.email} />}
          groupName={userInfo?.groupName}
          memberSince={formatDate(userInfo?.createdAt)}
          expires={userInfo?.expiresAt ? formatDate(userInfo.expiresAt) : null}
          themeName={(themeMeta as Record<string, { name: string }>)[themeId]?.name || 'Custom'}
          themeGrid={(
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {themeIds.map((id) => (
                <ThemeCard key={id} themeId={id} meta={themeMeta[id]} isSelected={themeId === id} onSelect={() => setTheme(id)} />
              ))}
            </div>
          )}
          visibility={{ loaded: activityVisibilityLoaded, isPublic, busy: updating, toggle: handleToggleVisibility }}
          publicStats={{ loaded: publicStatsLoaded, enabled: publicStatsEnabled, busy: savingPublicStats, url: publicStatsUrl, toggle: handleTogglePublicStats, copy: handleCopyPublicStatsUrl }}
          exportData={{ busy: isExportingMyData, run: handleExportMyData }}
          historyImport={userId && authKey ? <HistoryImportTile userId={userId} authKey={authKey} /> : null}
          pushRow={<PersonPushRow userId={userId} authKey={authKey} />}
          watchNotify={{ loaded: notifyOnWatchLoaded, on: notifyOnWatch, busy: isSavingNotifyOnWatch, toggle: handleToggleNotifyOnWatch }}
          webhook={{ url: discordWebhookUrl, setUrl: setDiscordWebhookUrl, save: handleSaveWebhook, test: handleTestWebhook, testing: isTestingWebhook }}
          apiKey={{
            value: currentApiKey,
            masked: maskedApiKey,
            visible: apiKeyVisible,
            toggleVisible: () => setApiKeyVisible(!apiKeyVisible),
            copy: handleCopyApiKey,
            generate: handleGenerateApiKey,
            generating: isGeneratingKey,
            scrobbleUrl: `${API_BASE}/scrobble`,
          }}
          onDelete={() => setIsDeleteModalOpen(true)}
        />
        {deleteModal}
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8">
      <UserPageHeader
        title="Settings"
        subtitle="Manage your account preferences"
      />

      <div className="space-y-6" style={{ maxWidth: '768px' }}>
        {/* Profile Info */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          <div
            className="px-6 py-4 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--color-surface-border)' }}
          >
            <div 
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-primary-muted)' }}
            >
              <UserCircleIcon className="w-5 h-5" style={{ color: 'var(--color-primary)' }} />
            </div>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
                Profile Information
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Your account details
              </p>
            </div>
          </div>

          <div className="p-6 space-y-4">
            {/* Their picture (the avatar is the button) and name */}
            <ProfilePictureEditor name={userInfo?.username || 'User'} email={userInfo?.email} />

            {/* Details grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
              <div>
                <p className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-subtle)' }}>
                  Group
                </p>
                <p className="font-medium" style={{ color: 'var(--color-text)' }}>
                  {userInfo?.groupName || 'No group'}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-subtle)' }}>
                  Member Since
                </p>
                <p className="font-medium" style={{ color: 'var(--color-text)' }}>
                  {formatDate(userInfo?.createdAt)}
                </p>
              </div>
              {userInfo?.expiresAt && (
                <div className="col-span-2">
                  <p className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-subtle)' }}>
                    Account Expires
                  </p>
                  <p className="font-medium" style={{ color: 'var(--color-warning)' }}>
                    {formatDate(userInfo.expiresAt)}
                  </p>
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* Theme Selection */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="rounded-xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          <div
            className="px-6 py-4 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--color-surface-border)' }}
          >
            <div 
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-secondary-muted)' }}
            >
              <PaintBrushIcon className="w-5 h-5" style={{ color: 'var(--color-secondary)' }} />
            </div>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
                Appearance
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Choose your preferred color scheme
              </p>
            </div>
          </div>

          <div className="p-6">
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
            </div>
          </div>
        </motion.div>

        {/* Page design (their own pages; a TV always shows Classic) */}
        {!isTV && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="rounded-xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          <div
            className="px-6 py-4 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--color-surface-border)' }}
          >
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-secondary-muted)' }}
            >
              <PaintBrushIcon className="w-5 h-5" style={{ color: 'var(--color-secondary)' }} />
            </div>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
                Page design
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                How your pages are laid out
              </p>
            </div>
          </div>
          <div className="p-6 flex flex-wrap gap-2.5">
            {([
              { id: 'classic', title: 'Classic', line: 'Your pages as they have always been' },
              { id: 'v2', title: 'v2', line: 'Grouped sections, one clear button each, and Arrange to move or hide sections' },
            ] as const).map((o) => {
              const on = design === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setDesign(o.id)}
                  className="flex-[1_1_220px] min-w-0 text-left rounded-[14px] px-4 py-3.5 transition-colors"
                  style={{
                    background: 'var(--color-surface-hover)',
                    border: on ? '2px solid var(--color-primary)' : '1px solid var(--color-surface-border)',
                  }}
                >
                  <span className="flex items-center gap-2">
                    <b style={{ color: 'var(--color-text)' }}>{o.title}</b>
                    {on && <span className="ml-auto whitespace-nowrap text-[13px]" style={{ color: 'var(--color-primary)' }}>✓ In use</span>}
                  </span>
                  <span className="block text-[13px] mt-1" style={{ color: 'var(--color-text-muted)' }}>{o.line}</span>
                </button>
              );
            })}
          </div>
          <div className="px-6 pb-6 -mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex-1 min-w-[12rem]">
              <p className="font-medium text-sm" style={{ color: 'var(--color-text)' }}>Now Playing</p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Your app and room: under the picture, or on it</p>
            </div>
            <div className="menu-seg" role="radiogroup" aria-label="Now Playing">
              {(['under', 'on'] as const).map((w) => (
                <button key={w} type="button" role="radio" aria-checked={npWhere === w} className={npWhere === w ? 'on' : ''} onClick={() => setNpWhere(w)}>
                  {w === 'under' ? 'Under' : 'On the picture'}
                </button>
              ))}
            </div>
          </div>
          <div className="px-6 pb-6 -mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex-1 min-w-[12rem]">
              <p className="font-medium text-sm" style={{ color: 'var(--color-text)' }}>Now Playing progress</p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>How far in and when it ends: on the picture, or under it</p>
            </div>
            <div className="menu-seg" role="radiogroup" aria-label="Now Playing progress">
              {(['on', 'under'] as const).map((w) => (
                <button key={w} type="button" role="radio" aria-checked={npProgress === w} className={npProgress === w ? 'on' : ''} onClick={() => setNpProgress(w)}>
                  {w === 'under' ? 'Under' : 'On the picture'}
                </button>
              ))}
            </div>
          </div>
          <div className="px-6 pb-6 -mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex-1 min-w-[12rem]">
              <p className="font-medium text-sm" style={{ color: 'var(--color-text)' }}>Fold arrows</p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>The arrow beside each section’s name. Hidden by default; they always show while arranging</p>
            </div>
            <div className="menu-seg" role="radiogroup" aria-label="Fold arrows">
              {(['show', 'hide'] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={arrows === v} className={arrows === v ? 'on' : ''} onClick={() => setArrows(v)}>
                  {v === 'show' ? 'Show' : 'Hide'}
                </button>
              ))}
            </div>
          </div>
          <div className="px-6 pb-6 -mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex-1 min-w-[12rem]">
              <p className="font-medium text-sm" style={{ color: 'var(--color-text)' }}>Tap a name to fold</p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Tapping a section’s name, its count or “folded” folds and unfolds it</p>
            </div>
            <div className="menu-seg" role="radiogroup" aria-label="Tap a name to fold">
              {([true, false] as const).map((v) => (
                <button key={String(v)} type="button" role="radio" aria-checked={nameTap === v} className={nameTap === v ? 'on' : ''} onClick={() => setNameTap(v)}>
                  {v ? 'On' : 'Off'}
                </button>
              ))}
            </div>
          </div>
          <div className="px-6 pb-6 -mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex-1 min-w-[12rem]">
              <p className="font-medium text-sm" style={{ color: 'var(--color-text)' }}>Continue Watching</p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Time left: on the picture, or under it with the episode name</p>
            </div>
            <div className="menu-seg" role="radiogroup" aria-label="Continue Watching time left">
              {(['on', 'under'] as const).map((w) => (
                <button key={w} type="button" role="radio" aria-checked={cwWhere === w} className={cwWhere === w ? 'on' : ''} onClick={() => setCwWhere(w)}>
                  {w === 'under' ? 'Under' : 'On the picture'}
                </button>
              ))}
            </div>
          </div>
        </motion.div>
        )}

        {/* Privacy Settings */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          <div
            className="px-6 py-4 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--color-surface-border)' }}
          >
            <div 
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-success-muted)' }}
            >
              <ShieldCheckIcon className="w-5 h-5" style={{ color: 'var(--color-success)' }} />
            </div>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
                Privacy
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Control who can see your activity
              </p>
            </div>
          </div>

          <div className="p-6">
            {/* Activity Visibility Toggle */}
            <div 
              className="flex items-center justify-between p-4 rounded-lg"
              style={{ background: 'var(--color-surface-elevated)' }}
            >
              <div className="flex-1">
                <h3 className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>
                  Activity Visibility
                </h3>
                <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                  {isPublic
                    ? 'Your watch activity is visible to group members'
                    : 'Your watch activity is hidden from group members'}
                </p>
              </div>

              {activityVisibilityLoaded && (
                <div className="flex items-center gap-3">
                  <span 
                    className={`text-sm font-medium ${isPublic ? 'text-success' : 'text-muted'}`}
                  >
                    {isPublic ? 'Public' : 'Private'}
                  </span>
                  <ToggleSwitch
                    checked={isPublic}
                    onChange={handleToggleVisibility}
                    disabled={updating}
                  />
                </div>
              )}
            </div>

            {/* Public Stats Share Link - a genuinely public, unauthenticated
                page anyone with the link can view, unlike Activity
                Visibility above (household members only). */}
            <div
              className="flex items-center justify-between p-4 rounded-lg mt-3"
              style={{ background: 'var(--color-surface-elevated)' }}
            >
              <div className="flex-1">
                <h3 className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>
                  Public Stats Page
                </h3>
                <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                  {publicStatsEnabled
                    ? 'Anyone with this link can view your watch stats - no login required'
                    : 'Get a shareable link to your watch stats, viewable by anyone without logging in'}
                </p>
                {publicStatsEnabled && publicStatsUrl && (
                  <div className="flex items-center gap-2 mt-2">
                    <code
                      className="text-xs px-2 py-1 rounded truncate max-w-[220px] sm:max-w-xs"
                      style={{ background: 'var(--color-subtle)', color: 'var(--color-text)' }}
                    >
                      {publicStatsUrl}
                    </code>
                    <button
                      onClick={handleCopyPublicStatsUrl}
                      className="text-xs font-medium"
                      style={{ color: 'var(--color-primary)' }}
                    >
                      Copy
                    </button>
                  </div>
                )}
              </div>

              {publicStatsLoaded && (
                <ToggleSwitch
                  checked={publicStatsEnabled}
                  onChange={handleTogglePublicStats}
                  disabled={savingPublicStats}
                />
              )}
            </div>

            {/* Data export */}
            <div
              className="flex items-center justify-between p-4 rounded-lg mt-3"
              style={{ background: 'var(--color-surface-elevated)' }}
            >
              <div className="flex-1">
                <h3 className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>
                  Your Data
                </h3>
                <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                  Download your watch history and the household watchlist as a JSON file
                </p>
              </div>
              <button
                onClick={handleExportMyData}
                disabled={isExportingMyData}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50"
                style={{ background: 'var(--color-primary)', color: 'var(--color-bg)' }}
              >
                {isExportingMyData ? 'Exporting...' : 'Download'}
              </button>
            </div>

            {/* Bring a watch history in from another service (their own, SlickSync's history only) */}
            {userId && authKey && <HistoryImportTile userId={userId} authKey={authKey} />}
          </div>
        </motion.div>

        {/* Discord Webhook */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="rounded-xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          <div
            className="px-6 py-4 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--color-surface-border)' }}
          >
            <div 
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'rgba(88, 101, 242, 0.2)' }}
            >
              <GlobeAltIcon className="w-5 h-5" style={{ color: '#5865F2' }} />
            </div>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
                Notifications
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Shared content, plus your own watch activity
              </p>
            </div>
          </div>

          <div className="p-6">
            {/* This device: their sign-in stopping, and a daily limit or
                bedtime about to pause them. Off until they turn it on. */}
            <PersonPushRow userId={userId} authKey={authKey} />

            {/* Watch notifications toggle - independent of the shared account
                notification settings; opting out here only affects pings
                about MY OWN watch activity, nobody else's. */}
            {notifyOnWatchLoaded && (
              <div
                className="flex items-center justify-between p-4 rounded-lg mb-4"
                style={{ background: 'var(--color-surface-elevated)' }}
              >
                <div className="flex-1">
                  <h3 className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>
                    Watch notifications
                  </h3>
                  <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                    Notify (Discord + push) when I start or finish watching something
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`text-sm font-medium ${notifyOnWatch ? 'text-success' : 'text-muted'}`}
                  >
                    {notifyOnWatch ? 'On' : 'Off'}
                  </span>
                  <ToggleSwitch
                    checked={notifyOnWatch}
                    onChange={handleToggleNotifyOnWatch}
                    disabled={isSavingNotifyOnWatch}
                  />
                </div>
              </div>
            )}

            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>
              Personal Discord Webhook (optional)
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={discordWebhookUrl}
                onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                onBlur={() => {
                  if (discordWebhookUrl) {
                    handleSaveWebhook();
                  }
                }}
                placeholder="https://discord.com/api/webhooks/..."
                className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg"
                style={{
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-surface-border)',
                  color: 'var(--color-text)',
                }}
              />
              <button
                onClick={handleTestWebhook}
                disabled={isTestingWebhook || !discordWebhookUrl.trim()}
                className="shrink-0 px-3 py-2 rounded-lg flex items-center gap-2 transition-all"
                style={{
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-surface-border)',
                  color: 'var(--color-text-muted)',
                  opacity: (!discordWebhookUrl.trim() || isTestingWebhook) ? 0.5 : 1,
                }}
                title="Send test message"
              >
                {isTestingWebhook ? (
                  <ArrowPathIcon className="w-4 h-4 animate-spin" />
                ) : (
                  <BeakerIcon className="w-4 h-4" />
                )}
                <span className="text-sm">Test</span>
              </button>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--color-text-subtle)' }}>
              Always used for share notifications. Set this and your watch notifications route here too, instead of the shared family channel — leave it blank to keep using that.
            </p>
          </div>
        </motion.div>

        {/* API Key */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          <div
            className="px-6 py-4 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--color-surface-border)' }}
          >
            <div 
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-warning-muted)' }}
            >
              <KeyIcon className="w-5 h-5" style={{ color: 'var(--color-warning)' }} />
            </div>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
                API Access
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Access your metrics via external API
              </p>
            </div>
          </div>

          <div className="p-6">
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>
              Your API Key
            </label>
            <div className="flex gap-2">
              <div 
                className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-surface-border)',
                }}
              >
                <code 
                  className="flex-1 text-sm font-mono truncate"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {maskedApiKey}
                </code>
                <button
                  onClick={() => setApiKeyVisible(!apiKeyVisible)}
                  className="p-1 rounded transition-colors"
                  style={{ color: 'var(--color-text-muted)' }}
                  title={apiKeyVisible ? 'Hide' : 'Show'}
                >
                  {apiKeyVisible ? (
                    <EyeSlashIcon className="w-4 h-4" />
                  ) : (
                    <EyeIcon className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={handleCopyApiKey}
                  className="p-1 rounded transition-colors"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Copy"
                  disabled={!currentApiKey}
                >
                  <ClipboardDocumentIcon className="w-4 h-4" />
                </button>
              </div>
              <button
                onClick={handleGenerateApiKey}
                disabled={isGeneratingKey}
                className="shrink-0 px-3 py-2 rounded-lg flex items-center gap-2 transition-all"
                style={{
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-surface-border)',
                  color: 'var(--color-text-muted)',
                  opacity: isGeneratingKey ? 0.5 : 1,
                }}
                title={currentApiKey ? 'Rotate API key' : 'Generate API key'}
              >
                <ArrowPathIcon className={`w-4 h-4 ${isGeneratingKey ? 'animate-spin' : ''}`} />
                <span className="text-sm">{currentApiKey ? 'Rotate' : 'Generate'}</span>
              </button>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--color-text-subtle)' }}>
              Use this key in the Authorization header:{' '}
              <code 
                onClick={() => {
                  if (currentApiKey) {
                    const fullHeader = `Bearer ${currentApiKey}`;
                    copyToClipboard(fullHeader);
                    toast.success('Authorization header copied');
                  }
                }}
                className="px-1 py-0.5 rounded cursor-pointer"
                style={{ background: 'var(--color-surface-elevated)' }}
                title={currentApiKey ? 'Click to copy "Bearer {key}"' : 'API key not available'}
              >
                Bearer {currentApiKey ? '...' : '•••••'}
              </code>
            </p>

            <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-surface-border)' }}>
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--color-text)' }}>
                Scrobble from other apps
              </p>
              <p className="text-xs" style={{ color: 'var(--color-text-subtle)' }}>
                Any app with Trakt-compatible scrobbling (Infuse, Kodi's Trakt plugin, etc.) can write into your SlickTrax history instead - point its custom Trakt server at{' '}
                <code className="px-1 py-0.5 rounded" style={{ background: 'var(--color-surface-elevated)' }}>{API_BASE}/scrobble</code>
                {' '}using this same API key as the token.
              </p>
            </div>
          </div>
        </motion.div>

        {/* Account Actions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="rounded-xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          <div
            className="px-6 py-4 flex items-center gap-3"
            style={{ borderBottom: '1px solid var(--color-surface-border)' }}
          >
            <div 
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--color-error-muted)' }}
            >
              <Cog6ToothIcon className="w-5 h-5" style={{ color: 'var(--color-error)' }} />
            </div>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
                Account
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Manage your account
              </p>
            </div>
          </div>

          <div className="p-6">
            <div
              className="flex items-center justify-between p-4 rounded-lg"
              style={{ background: 'var(--color-error-muted)' }}
            >
              <div className="flex-1 pr-4">
                <p className="font-medium text-sm" style={{ color: 'var(--color-text)' }}>Delete My Account</p>
                <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                  Permanently deletes your own watch history, watchlist, and account - not the shared addons/groups. No undo.
                </p>
              </div>
              <button
                onClick={() => setIsDeleteModalOpen(true)}
                className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                style={{
                  background: 'var(--color-error)',
                  color: 'white',
                }}
              >
                Delete Account
              </button>
            </div>
          </div>
        </motion.div>

        {/* Info */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="p-4 rounded-xl"
          style={{ background: 'var(--color-primary-muted)' }}
        >
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            <strong style={{ color: 'var(--color-text)' }}>Note:</strong> Profile information is synced from your {providerLabel} account.
            To change your username or email, update them in the {providerLabel} app.
          </p>
        </motion.div>
      </div>

      {deleteModal}
    </div>
  );
}
