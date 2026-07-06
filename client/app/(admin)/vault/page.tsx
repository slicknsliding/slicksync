'use client';

import Head from 'next/head';
import { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { StaggerContainer, StaggerItem } from '@/components/layout/PageContainer';
import { useSortableDragState } from '@/components/ui/DragSortable';
import { SortableContext, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { useVaultDrag, SIDEBAR_ADDONS_DROPZONE_ID } from '@/components/providers/VaultDragContext';
import type { DragEndEvent } from '@dnd-kit/core';
import { Button, Card, Badge, Modal, Input, FilterTabsResponsive, ToggleSwitch, ContextMenu, useContextMenu } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api, VaultEntry, VaultCategory, VaultTestType, VaultNotificationSettings } from '@/lib/api';
import {
  PlusIcon,
  ShieldCheckIcon,
  BellIcon,
  EyeIcon,
  EyeSlashIcon,
  ArrowPathIcon,
  TrashIcon,
  PencilIcon,
  ArrowTopRightOnSquareIcon,
  Bars3Icon,
  PuzzlePieceIcon,
} from '@heroicons/react/24/outline';

const CATEGORY_LABELS: Record<VaultCategory, string> = {
  debrid: 'Debrid Services',
  usenet_provider: 'Usenet Providers',
  usenet_indexer: 'Usenet Indexers',
  stremio: 'Stremio',
  nuvio: 'Nuvio',
  metadata: 'Metadata & Trackers',
  ai: 'AI Services',
  vpn: 'VPN',
  aiostreams: 'AIOStreams',
  custom: 'Custom',
};

const TEST_TYPE_LABELS: Record<VaultTestType, string> = {
  manual: 'Manual (no automated check)',
  generic_http: 'Generic HTTP request',
  real_debrid: 'Real-Debrid',
  torbox: 'TorBox',
  newznab_caps: 'Newznab indexer',
  tcp_reachability: 'TCP reachability',
  stremio_auth: 'Stremio login',
  nuvio_auth: 'Nuvio login',
};

function daysUntil(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function StatusBadge({ entry }: { entry: VaultEntry }) {
  if (entry.testType === 'manual' || !entry.lastCheckStatus) {
    return <Badge variant="neutral" size="sm">Not checked</Badge>;
  }
  if (entry.lastCheckStatus === 'ok') return <Badge variant="success" size="sm">Active</Badge>;
  if (entry.lastCheckStatus === 'error') return <Badge variant="error" size="sm">Error</Badge>;
  return <Badge variant="neutral" size="sm">Unknown</Badge>;
}

function ExpiryBadge({ entry }: { entry: VaultEntry }) {
  const days = daysUntil(entry.expiresAt);
  if (days === null) return null;
  if (days < 0) return <Badge variant="error" size="sm">Expired</Badge>;
  if (days <= entry.notifyDaysBefore) return <Badge variant="warning" size="sm">{days}d left</Badge>;
  return <Badge variant="outline" size="sm">{days}d left</Badge>;
}

interface EntryFormState {
  name: string;
  category: VaultCategory;
  provider: string;
  secretLabel: string;
  secret: string;
  secretUsername: string; // only used for usenet_provider mode (combined into JSON on save)
  testType: VaultTestType;
  testUrl: string;
  testHost: string;
  testPort: string;
  testSsl: boolean;
  testDataCap: string;
  dashboardUrl: string;
  expiresAt: string;
  notifyDaysBefore: string;
}

const EMPTY_FORM: EntryFormState = {
  name: '', category: 'custom', provider: '', secretLabel: 'API Key', secret: '', secretUsername: '',
  testType: 'manual', testUrl: '', testHost: '', testPort: '', testSsl: true, testDataCap: '',
  dashboardUrl: '', expiresAt: '', notifyDaysBefore: '3',
};

// Which specialized form to show for a given category
function categoryFieldMode(category: VaultCategory): 'credentials' | 'indexer' | 'provider' | 'generic' {
  if (category === 'stremio' || category === 'nuvio') return 'credentials';
  if (category === 'usenet_indexer') return 'indexer';
  if (category === 'usenet_provider') return 'provider';
  return 'generic';
}

// Sensible defaults applied automatically when switching to a specialized category
function categoryDefaults(category: VaultCategory): Partial<EntryFormState> {
  switch (categoryFieldMode(category)) {
    case 'credentials':
      return { testType: category === 'nuvio' ? 'nuvio_auth' : 'stremio_auth', secretLabel: 'Password' };
    case 'indexer':
      return { testType: 'newznab_caps', secretLabel: 'API Key' };
    case 'provider':
      return { testType: 'tcp_reachability', secretLabel: 'Password' };
    default:
      return {};
  }
}

// Wraps a card with dnd-kit's sortable drag state AND a right-click context
// menu — both live here (rather than in renderEntryCard) since hooks can't
// be called conditionally or inside a .map() callback directly.
function SortableEntryCard({
  entry,
  renderEntryCard,
  onTest,
  onEdit,
  onMoveToAddons,
  onDelete,
}: {
  entry: VaultEntry;
  renderEntryCard: (entry: VaultEntry, dragHandleProps?: Record<string, unknown>, isDragging?: boolean) => React.ReactNode;
  onTest: (entry: VaultEntry) => void;
  onEdit: (entry: VaultEntry) => void;
  onMoveToAddons: (entry: VaultEntry) => void;
  onDelete: (entry: VaultEntry) => void;
}) {
  const { dragHandleProps, itemProps, isDragging } = useSortableDragState(entry.id);
  const { isOpen, position, handleContextMenu, close } = useContextMenu();

  return (
    <div ref={itemProps.ref} style={itemProps.style} className={itemProps.className} onContextMenu={handleContextMenu}>
      {renderEntryCard(entry, dragHandleProps, isDragging)}

      <ContextMenu isOpen={isOpen} position={position} onClose={close}>
        <button
          onClick={() => { close(); onTest(entry); }}
          disabled={entry.testType === 'manual'}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors disabled:opacity-40"
        >
          <ArrowPathIcon className="w-4 h-4" />
          Run Check Now
        </button>
        <button
          onClick={() => { close(); onEdit(entry); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <PencilIcon className="w-4 h-4" />
          Edit
        </button>
        {entry.dashboardUrl && (
          <a
            href={entry.dashboardUrl}
            target="_blank"
            rel="noreferrer"
            onClick={close}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
          >
            <ArrowTopRightOnSquareIcon className="w-4 h-4" />
            Open Dashboard
          </a>
        )}
        <div className="my-1 border-t border-default" />
        <button
          onClick={() => { close(); onMoveToAddons(entry); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <PuzzlePieceIcon className="w-4 h-4" />
          Move to Addons
        </button>
        <div className="my-1 border-t border-default" />
        <button
          onClick={() => { close(); onDelete(entry); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-error-muted transition-colors"
        >
          <TrashIcon className="w-4 h-4" />
          Delete
        </button>
      </ContextMenu>
    </div>
  );
}

export default function VaultPage() {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [activeCategory, setActiveCategory] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [movingToAddonsId, setMovingToAddonsId] = useState<string | null>(null);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EntryFormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<VaultNotificationSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState({ ntfyUrl: '', ntfyTopic: '', discordWebhookUrl: '', checkIntervalHours: '6' });
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getVaultEntries(activeCategory === 'all' ? undefined : activeCategory);
      setEntries(data.entries);
      setCategoryCounts(data.categories);
      setTotal(data.total);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load vault entries');
    } finally {
      setIsLoading(false);
    }
  }, [activeCategory]);

  useEffect(() => { load(); }, [load]);

  const openAddModal = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setIsAddOpen(true);
  };

  const openEditModal = async (entry: VaultEntry) => {
    setEditingId(entry.id);
    const cfg: any = entry.testConfig || {};
    setForm({
      name: entry.name,
      category: entry.category,
      provider: entry.provider || '',
      secretLabel: entry.secretLabel,
      secret: '', // left blank — only sent if user types a new value
      secretUsername: '', // same — usenet_provider username isn't returned decrypted either
      testType: entry.testType,
      testUrl: cfg.url || '',
      testHost: cfg.host || '',
      testPort: cfg.port ? String(cfg.port) : '',
      testSsl: cfg.ssl ?? true,
      testDataCap: cfg.dataCapGB ? String(cfg.dataCapGB) : '',
      dashboardUrl: entry.dashboardUrl || '',
      expiresAt: entry.expiresAt ? entry.expiresAt.split('T')[0] : '',
      notifyDaysBefore: String(entry.notifyDaysBefore ?? 3),
    });
    setIsAddOpen(true);
  };

  const handleCategoryChange = (category: VaultCategory) => {
    setForm(f => ({ ...f, category, ...categoryDefaults(category) }));
  };

  const buildTestConfig = (f: EntryFormState) => {
    const mode = categoryFieldMode(f.category);
    if (mode === 'indexer') {
      return f.testUrl ? { url: f.testUrl } : undefined;
    }
    if (mode === 'provider') {
      return (f.testHost && f.testPort)
        ? { host: f.testHost, port: Number(f.testPort), ssl: f.testSsl, dataCapGB: f.testDataCap ? Number(f.testDataCap) : undefined }
        : undefined;
    }
    // generic mode falls back to the manually-picked testType
    if (f.testType === 'generic_http' || f.testType === 'newznab_caps') {
      return f.testUrl ? { url: f.testUrl } : undefined;
    }
    if (f.testType === 'tcp_reachability') {
      return (f.testHost && f.testPort) ? { host: f.testHost, port: Number(f.testPort) } : undefined;
    }
    return undefined;
  };

  const handleSave = async () => {
    const mode = categoryFieldMode(form.category);

    if (!form.name.trim() || !form.category) {
      toast.error('Name and category are required');
      return;
    }
    // Mode-specific required-field validation
    if (mode === 'credentials' && !editingId && (!form.provider.trim() || !form.secret.trim())) {
      toast.error('Email/username and password are required');
      return;
    }
    if (mode === 'provider' && !editingId && (!form.testHost.trim() || !form.testPort.trim() || !form.secretUsername.trim() || !form.secret.trim())) {
      toast.error('Host, port, username, and password are required');
      return;
    }
    if (mode === 'indexer' && !editingId && (!form.testUrl.trim() || !form.secret.trim())) {
      toast.error('Newznab URL and API key are required');
      return;
    }
    if (mode === 'generic' && !editingId && !form.secret.trim()) {
      toast.error('Secret is required');
      return;
    }

    setIsSaving(true);
    try {
      const payload: any = {
        name: form.name.trim(),
        category: form.category,
        secretLabel: form.secretLabel.trim() || 'API Key',
        testType: form.testType,
        testConfig: buildTestConfig(form),
        dashboardUrl: form.dashboardUrl.trim() || undefined,
        expiresAt: form.expiresAt || undefined,
        notifyDaysBefore: form.notifyDaysBefore ? Number(form.notifyDaysBefore) : 3,
      };

      if (mode === 'provider') {
        // Host/port already live in testConfig; provider field stays free for a friendly label
        payload.provider = form.provider.trim() || undefined;
        if (form.secretUsername.trim() || form.secret.trim()) {
          payload.secret = JSON.stringify({ username: form.secretUsername.trim(), password: form.secret });
        }
      } else {
        payload.provider = form.provider.trim() || undefined;
        if (form.secret.trim()) payload.secret = form.secret.trim();
      }

      if (editingId) {
        await api.updateVaultEntry(editingId, payload);
        toast.success('Vault entry updated');
      } else {
        await api.createVaultEntry(payload);
        toast.success('Vault entry added');
      }
      setIsAddOpen(false);
      load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save vault entry');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (entry: VaultEntry) => {
    if (!confirm(`Delete "${entry.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteVaultEntry(entry.id);
      toast.success('Deleted');
      load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    }
  };

  const handleMoveToAddons = async (entry: VaultEntry) => {
    if (!confirm(`Move "${entry.name}" to Addons? This removes it from the Vault.`)) return;
    setMovingToAddonsId(entry.id);
    try {
      const { secret } = await api.revealVaultSecret(entry.id);
      if (!secret || !/^https?:\/\//i.test(secret.trim())) {
        toast.error("This entry's secret doesn't look like an addon manifest URL (must start with http:// or https://)");
        return;
      }
      await api.createAddon({ manifestUrl: secret.trim(), name: entry.name } as any);
      await api.deleteVaultEntry(entry.id);
      toast.success(`Moved "${entry.name}" to Addons`);
      load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to move to Addons');
    } finally {
      setMovingToAddonsId(null);
    }
  };

  const handleRecategorize = async (entry: VaultEntry, newCategory: string) => {
    if (entry.category === newCategory) return;
    // Optimistic update
    setEntries(prev => prev.filter(e => e.id !== entry.id));
    try {
      await api.updateVaultEntry(entry.id, { category: newCategory as VaultCategory });
      toast.success(`Moved "${entry.name}" to ${CATEGORY_LABELS[newCategory as VaultCategory] || newCategory}`);
      load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to recategorize');
      load();
    }
  };

  // Register this page's drag-end logic with the layout-level DndContext —
  // it's the one that actually owns the DndContext (see AdminClientLayout),
  // since dragging onto the Sidebar's Addons link requires a context that
  // spans both the page and the sidebar.
  const { registerDragEndHandler } = useVaultDrag();
  useEffect(() => {
    const handleDragEnd = (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const entry = entries.find(e => e.id === active.id);
      if (!entry) return;

      if (over.id === SIDEBAR_ADDONS_DROPZONE_ID) {
        handleMoveToAddons(entry);
        return;
      }

      if (typeof over.id === 'string' && over.id.startsWith('vault-category-')) {
        const newCategory = over.id.replace('vault-category-', '');
        if (newCategory !== 'all') handleRecategorize(entry, newCategory);
        return;
      }

      // Otherwise: dropped on another entry card -> reorder within the same category
      if (active.id !== over.id) {
        const oldIndex = entries.findIndex(e => e.id === active.id);
        const newIndex = entries.findIndex(e => e.id === over.id);
        if (oldIndex === -1 || newIndex === -1) return;
        const target = entries[newIndex];
        if (target.category !== entry.category) return; // don't reorder across categories
        const reordered = arrayMove(entries, oldIndex, newIndex);
        setEntries(reordered);
        api.reorderVaultEntries(entry.category, reordered.filter(e => e.category === entry.category).map(e => e.id))
          .catch((err: any) => {
            toast.error(err.message || 'Failed to save new order');
            load();
          });
      }
    };

    registerDragEndHandler(handleDragEnd);
    return () => registerDragEndHandler(null);
  }, [entries, registerDragEndHandler]);

  const handleTest = async (entry: VaultEntry) => {
    setTestingId(entry.id);
    try {
      const result = await api.testVaultEntry(entry.id);
      if (result.ok === true) toast.success(`${entry.name}: ${result.message}`);
      else if (result.ok === false) toast.error(`${entry.name}: ${result.message}`);
      else toast(result.message);
      load();
    } catch (err: any) {
      toast.error(err.message || 'Test failed');
    } finally {
      setTestingId(null);
    }
  };

  const handleReveal = async (entry: VaultEntry) => {
    if (revealed[entry.id]) {
      setRevealed(prev => { const next = { ...prev }; delete next[entry.id]; return next; });
      return;
    }
    try {
      const result = await api.revealVaultSecret(entry.id);
      setRevealed(prev => ({ ...prev, [entry.id]: result.secret }));
    } catch (err: any) {
      toast.error(err.message || 'Failed to reveal secret');
    }
  };

  const openSettingsModal = async () => {
    try {
      const data = await api.getVaultNotificationSettings();
      setSettings(data);
      setSettingsForm({
        ntfyUrl: data.ntfyUrl || '',
        ntfyTopic: data.ntfyTopic || '',
        discordWebhookUrl: '', // never prefilled — write-only field
        checkIntervalHours: String(data.checkIntervalHours || 6),
      });
      setIsSettingsOpen(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load notification settings');
    }
  };

  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    try {
      const payload: any = {
        ntfyUrl: settingsForm.ntfyUrl.trim() || undefined,
        ntfyTopic: settingsForm.ntfyTopic.trim() || undefined,
        checkIntervalHours: Number(settingsForm.checkIntervalHours) || 6,
      };
      if (settingsForm.discordWebhookUrl.trim()) payload.discordWebhookUrl = settingsForm.discordWebhookUrl.trim();
      await api.updateVaultNotificationSettings(payload);
      toast.success('Notification settings saved');
      setIsSettingsOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save settings');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleTestNotification = async () => {
    try {
      await api.testVaultNotification();
      toast.success('Test notification sent');
    } catch (err: any) {
      toast.error(err.message || 'No notification channel configured yet — save settings first');
    }
  };

  const filterOptions = [
    { key: 'all', label: 'All', count: total },
    ...Object.entries(CATEGORY_LABELS).map(([key, label]) => ({
      key, label, count: categoryCounts[key] || 0,
    })),
  ];

  const renderEntryCard = (entry: VaultEntry, dragHandleProps?: Record<string, unknown>, isDragging?: boolean) => (
    <Card variant="bordered" className={`h-full flex flex-col ${isDragging ? 'shadow-lg shadow-primary/25 scale-[1.01]' : ''}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex items-center gap-2">
          {dragHandleProps && (
            <div {...dragHandleProps} className="cursor-grab active:cursor-grabbing p-1 -ml-1 rounded hover:bg-surface-hover shrink-0">
              <Bars3Icon className="w-4 h-4" style={{ color: 'var(--color-textMuted)' }} />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="font-semibold truncate" style={{ color: 'var(--color-text)' }}>{entry.name}</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-textMuted)' }}>
              {CATEGORY_LABELS[entry.category]}{entry.provider ? ` • ${entry.provider}` : ''}
            </p>
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <StatusBadge entry={entry} />
          <ExpiryBadge entry={entry} />
        </div>
      </div>

      <div className="mb-3 p-3 rounded-lg flex items-center justify-between gap-2" style={{ background: 'var(--color-subtle)' }}>
        <code className="text-xs truncate" style={{ color: 'var(--color-text)' }}>
          {revealed[entry.id] || '••••••••••••••••'}
        </code>
        <button onClick={() => handleReveal(entry)} className="shrink-0" style={{ color: 'var(--color-textMuted)' }}>
          {revealed[entry.id] ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
        </button>
      </div>

      {entry.lastCheckMessage && (
        <p className="text-xs mb-3" style={{ color: 'var(--color-textMuted)' }}>{entry.lastCheckMessage}</p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-2 flex-wrap" style={{ borderTop: '1px solid var(--color-surfaceBorder)' }}>
        <button
          onClick={() => handleTest(entry)}
          disabled={testingId === entry.id || entry.testType === 'manual'}
          title={entry.testType === 'manual' ? 'No automated check configured' : 'Run check now'}
          className="p-2 rounded-lg transition-colors disabled:opacity-40"
          style={{ background: 'var(--color-surfaceHover)' }}
        >
          <ArrowPathIcon className={`w-4 h-4 ${testingId === entry.id ? 'animate-spin' : ''}`} style={{ color: 'var(--color-text)' }} />
        </button>
        <button onClick={() => openEditModal(entry)} className="p-2 rounded-lg transition-colors" style={{ background: 'var(--color-surfaceHover)' }}>
          <PencilIcon className="w-4 h-4" style={{ color: 'var(--color-text)' }} />
        </button>
        {entry.dashboardUrl && (
          <a href={entry.dashboardUrl} target="_blank" rel="noreferrer" className="p-2 rounded-lg transition-colors" style={{ background: 'var(--color-surfaceHover)' }}>
            <ArrowTopRightOnSquareIcon className="w-4 h-4" style={{ color: 'var(--color-text)' }} />
          </a>
        )}
        <button
          onClick={() => handleMoveToAddons(entry)}
          disabled={movingToAddonsId === entry.id}
          title="Move to Addons"
          className="p-2 rounded-lg transition-colors disabled:opacity-40"
          style={{ background: 'var(--color-surfaceHover)' }}
        >
          <PuzzlePieceIcon className="w-4 h-4" style={{ color: 'var(--color-text)' }} />
        </button>
        <button onClick={() => handleDelete(entry)} className="p-2 rounded-lg transition-colors ml-auto" style={{ background: 'var(--color-surfaceHover)' }}>
          <TrashIcon className="w-4 h-4" style={{ color: 'var(--color-error)' }} />
        </button>
      </div>
    </Card>
  );

  return (
    <>
      <Head><title>SlickSync - Vault</title></Head>
      <Header
        title="Vault"
        subtitle={isLoading ? 'Loading...' : `${total} ${total === 1 ? 'entry' : 'entries'}`}
        actions={
          <>
            <Button variant="secondary" leftIcon={<BellIcon className="w-5 h-5" />} onClick={openSettingsModal}>
              Notifications
            </Button>
            <Button variant="primary" leftIcon={<PlusIcon className="w-5 h-5" />} onClick={openAddModal}>
              Add Entry
            </Button>
          </>
        }
      />

      <div className="px-4 md:px-6 pb-6">
        <div className="mb-5">
          <FilterTabsResponsive options={filterOptions} activeKey={activeCategory} onChange={setActiveCategory} layoutId="vault-filter" enableDropTargets />
        </div>

        {isLoading ? (
          <div className="text-center py-16" style={{ color: 'var(--color-textMuted)' }}>Loading vault...</div>
        ) : entries.length === 0 ? (
          <Card variant="bordered" className="text-center py-16">
            <ShieldCheckIcon className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--color-textMuted)' }} />
            <h3 className="text-lg font-semibold mb-1" style={{ color: 'var(--color-text)' }}>No entries yet</h3>
            <p className="text-sm mb-4" style={{ color: 'var(--color-textMuted)' }}>
              Track API keys, accounts, and credentials with expiry alerts and active-checks.
            </p>
            <Button variant="primary" leftIcon={<PlusIcon className="w-5 h-5" />} onClick={openAddModal}>
              Add your first entry
            </Button>
          </Card>
        ) : (
          <>
            <p className="text-xs mb-3" style={{ color: 'var(--color-textMuted)' }}>
              Drag the handle to reorder within a category, drop onto a category tab above to recategorize, or drop onto "Addons" in the sidebar to move it there.
            </p>
            <SortableContext items={entries.map(e => e.id)} strategy={rectSortingStrategy}>
              <StaggerContainer className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {entries.map((entry) => (
                  <StaggerItem key={entry.id}>
                    <SortableEntryCard
                      entry={entry}
                      renderEntryCard={renderEntryCard}
                      onTest={handleTest}
                      onEdit={openEditModal}
                      onMoveToAddons={handleMoveToAddons}
                      onDelete={handleDelete}
                    />
                  </StaggerItem>
                ))}
              </StaggerContainer>
            </SortableContext>
          </>
        )}
      </div>

      {/* Add/Edit Modal */}
      <Modal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} title={editingId ? 'Edit Vault Entry' : 'Add Vault Entry'} size="lg">
        <div className="space-y-4">
          <Input label="Name" placeholder="e.g. Newshosting account" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />

          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-textMuted)' }}>Category</label>
            <select
              value={form.category}
              onChange={e => handleCategoryChange(e.target.value as VaultCategory)}
              className="w-full px-4 py-3 rounded-xl focus:outline-none"
              style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surfaceBorder)', color: 'var(--color-text)' }}
            >
              {Object.entries(CATEGORY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </div>

          {categoryFieldMode(form.category) === 'credentials' && (
            <>
              <p className="text-xs -mt-2" style={{ color: 'var(--color-textMuted)' }}>
                Stored credentials are validated by logging into {form.category === 'nuvio' ? 'Nuvio' : 'Stremio'} directly when you hit Test.
              </p>
              <Input label="Email or Username" placeholder="you@example.com" value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))} />
              <Input
                label={editingId ? 'Password (leave blank to keep current)' : 'Password'}
                type="password"
                placeholder={editingId ? '••••••••' : 'Account password'}
                value={form.secret}
                onChange={e => setForm(f => ({ ...f, secret: e.target.value }))}
              />
            </>
          )}

          {categoryFieldMode(form.category) === 'indexer' && (
            <>
              <Input label="Newznab URL" placeholder="https://indexer.example.com" value={form.testUrl} onChange={e => setForm(f => ({ ...f, testUrl: e.target.value }))} />
              <Input
                label={editingId ? 'API Key (leave blank to keep current)' : 'API Key'}
                type="password"
                placeholder={editingId ? '••••••••' : 'Indexer API key'}
                value={form.secret}
                onChange={e => setForm(f => ({ ...f, secret: e.target.value }))}
              />
            </>
          )}

          {categoryFieldMode(form.category) === 'provider' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Host" placeholder="news.example.com" value={form.testHost} onChange={e => setForm(f => ({ ...f, testHost: e.target.value }))} />
                <Input label="Port" placeholder="563" value={form.testPort} onChange={e => setForm(f => ({ ...f, testPort: e.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Username" placeholder="Account username" value={form.secretUsername} onChange={e => setForm(f => ({ ...f, secretUsername: e.target.value }))} />
                <Input
                  label={editingId ? 'Password (leave blank to keep current)' : 'Password'}
                  type="password"
                  placeholder={editingId ? '••••••••' : 'Account password'}
                  value={form.secret}
                  onChange={e => setForm(f => ({ ...f, secret: e.target.value }))}
                />
              </div>
              <div className="flex items-center justify-between p-3 rounded-xl" style={{ background: 'var(--color-subtle)' }}>
                <span className="text-sm" style={{ color: 'var(--color-text)' }}>Use SSL</span>
                <ToggleSwitch checked={form.testSsl} onChange={() => setForm(f => ({ ...f, testSsl: !f.testSsl }))} />
              </div>
              <Input label="Data cap in GB (optional)" placeholder="Leave blank for no cap" value={form.testDataCap} onChange={e => setForm(f => ({ ...f, testDataCap: e.target.value }))} />
            </>
          )}

          {categoryFieldMode(form.category) === 'generic' && (
            <>
              <Input label="Provider (optional)" placeholder="e.g. Newshosting, Real-Debrid" value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))} />
              <Input label="Secret label" placeholder="API Key" value={form.secretLabel} onChange={e => setForm(f => ({ ...f, secretLabel: e.target.value }))} />
              <Input
                label={editingId ? 'Secret (leave blank to keep current)' : 'Secret'}
                type="password"
                placeholder={editingId ? '••••••••' : 'Paste API key / password / token'}
                value={form.secret}
                onChange={e => setForm(f => ({ ...f, secret: e.target.value }))}
              />

              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-textMuted)' }}>Active check</label>
                <select
                  value={form.testType}
                  onChange={e => setForm(f => ({ ...f, testType: e.target.value as VaultTestType }))}
                  className="w-full px-4 py-3 rounded-xl focus:outline-none"
                  style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surfaceBorder)', color: 'var(--color-text)' }}
                >
                  {Object.entries(TEST_TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </div>

              {(form.testType === 'generic_http' || form.testType === 'newznab_caps') && (
                <Input label="Test URL" placeholder="https://..." value={form.testUrl} onChange={e => setForm(f => ({ ...f, testUrl: e.target.value }))} />
              )}
              {form.testType === 'tcp_reachability' && (
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Host" placeholder="news.example.com" value={form.testHost} onChange={e => setForm(f => ({ ...f, testHost: e.target.value }))} />
                  <Input label="Port" placeholder="563" value={form.testPort} onChange={e => setForm(f => ({ ...f, testPort: e.target.value }))} />
                </div>
              )}
            </>
          )}

          <Input label="Dashboard URL (optional)" placeholder="https://provider.com/dashboard" value={form.dashboardUrl} onChange={e => setForm(f => ({ ...f, dashboardUrl: e.target.value }))} />

          <div className="grid grid-cols-2 gap-3">
            <Input label="Expires on (optional)" type="date" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} />
            <Input label="Notify days before" type="number" value={form.notifyDaysBefore} onChange={e => setForm(f => ({ ...f, notifyDaysBefore: e.target.value }))} />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setIsAddOpen(false)}
              className="flex-1 py-3 text-sm font-medium rounded-xl transition-colors"
              style={{ background: 'var(--color-surfaceHover)', color: 'var(--color-text)' }}
            >
              Cancel
            </button>
            <Button variant="primary" className="flex-1" onClick={handleSave} isLoading={isSaving}>
              {editingId ? 'Save Changes' : 'Add Entry'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Notification Settings Modal */}
      <Modal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} title="Vault Notifications" size="md">
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--color-textMuted)' }}>
            Alerts fire when an entry enters its expiry window, or when an automated check starts failing. Configure ntfy and/or Discord — either or both.
          </p>
          <Input label="ntfy server URL" placeholder="https://ntfy.sh" value={settingsForm.ntfyUrl} onChange={e => setSettingsForm(f => ({ ...f, ntfyUrl: e.target.value }))} />
          <Input label="ntfy topic" placeholder="my-vault-alerts" value={settingsForm.ntfyTopic} onChange={e => setSettingsForm(f => ({ ...f, ntfyTopic: e.target.value }))} />
          <Input
            label={settings?.discordWebhookUrl ? 'Discord webhook URL (configured — leave blank to keep)' : 'Discord webhook URL'}
            type="password"
            placeholder="https://discord.com/api/webhooks/..."
            value={settingsForm.discordWebhookUrl}
            onChange={e => setSettingsForm(f => ({ ...f, discordWebhookUrl: e.target.value }))}
          />
          <Input label="Check interval (hours)" type="number" value={settingsForm.checkIntervalHours} onChange={e => setSettingsForm(f => ({ ...f, checkIntervalHours: e.target.value }))} />

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" className="flex-1" onClick={handleTestNotification}>
              Send Test
            </Button>
            <Button variant="primary" className="flex-1" onClick={handleSaveSettings} isLoading={isSavingSettings}>
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
