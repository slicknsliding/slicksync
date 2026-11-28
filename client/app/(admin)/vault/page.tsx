'use client';

import { usePageArrangement, usePageDesign, useSavedFilter } from '@/lib/arrange';
import { ArrangeBar, ArrangeButton, ArrangePanel, HiddenTray } from '@/components/ui/Arrange';
import { VaultV2, VAULT_SECTIONS } from '@/components/v2/VaultV2';
import { VaultHistoryButton, VaultHistoryPopup } from '@/components/vault/VaultHistory';
import { useDefaultViewMode } from '@/lib/viewMode';
import Head from 'next/head';
import { useState, useEffect, useCallback, useMemo, useRef, Suspense, Fragment } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { copyToClipboard } from '@/lib/clipboard';
import { useLongPress } from '@/lib/hooks/useLongPress';
import { TVPageProvider } from '@/components/tv/TVPageProvider';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { NebulaPageHeading, NEBULA_GLASS_CLASS, nebulaGlassStyle, NebulaGlassStripe } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { StaggerContainer, StaggerItem } from '@/components/layout/PageContainer';
import { useSortableDragState } from '@/components/ui/DragSortable';
import { SortableContext, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { useVaultDrag, SIDEBAR_ADDONS_DROPZONE_ID } from '@/components/providers/VaultDragContext';
import type { DragEndEvent } from '@dnd-kit/core';
import { Button, Card, Badge, Modal, Input, FilterTabsResponsive, ToggleSwitch, ContextMenu, useContextMenu } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { EmptyState } from '@/components/ui/EmptyState';
import { TwoStepButton } from '@/components/ui/TwoStepButton';
import { showDeletedWithUndo } from '@/components/ui/undoToast';
import { api, VaultEntry, VaultCategory, type VaultEntryInput } from '@/lib/api';
import { VaultEntryForm } from '@/components/vault/VaultEntryForm';
import { UsedByChip, VaultStatusBadge } from '@/components/vault/VaultBits';
import { KIND_LABELS, fromEntry, type VaultFormValues, type VaultPayload } from '@/lib/vaultKinds';
import { canMarkRenewed, costSummary, daysUntil, isFree, isLifetime, isNote, isSnoozed, judgeEntry, matchesSearch, monthlyCost, shortDay } from '@/lib/vaultStatus';
import { useLastKnown } from '@/lib/hooks/useLastKnown';
import {
  PlusIcon,
  EyeIcon,
  EyeSlashIcon,
  ArrowPathIcon,
  TrashIcon,
  PencilIcon,
  ArrowTopRightOnSquareIcon,
  Bars3Icon,
  PuzzlePieceIcon,
  BanknotesIcon,
  ClockIcon,
  CreditCardIcon,
  DocumentDuplicateIcon,
  BellSlashIcon,
  CalendarDaysIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

// What each kind is called on its tab and on a card (lib/vaultKinds).
const CATEGORY_LABELS: Record<VaultCategory, string> = KIND_LABELS;
const VAULT_UI_CATEGORY_LABELS = CATEGORY_LABELS;

// Common currency codes for the Vault cost selector. Intl.NumberFormat
// renders the correct symbol/placement for each, so only the ISO code is
// stored - no hardcoded "$".
const CLASSIC_SECTION_LABELS: Record<string, string> = { cost: 'Cost summary', renewals: 'Upcoming renewals', entries: 'Entries' };
const CLASSIC_SECTION_KEYS = Object.keys(CLASSIC_SECTION_LABELS);
const CURRENCY_OPTIONS =['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'INR', 'BRL', 'MXN', 'SEK', 'NOK', 'DKK', 'PLN', 'NZD', 'ZAR'];

function formatDayString(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}, ${y}`;
}

// Live Real-Debrid/TorBox usage (active downloads, premium days left) plus
// the auto-remove toggle - own component (not inlined in renderEntryCard, a
// plain function that can't hold hooks - see SortableEntryCard's own
// comment on the same constraint) so each debrid card fetches independently
// on mount without re-fetching every OTHER card whenever any one entry's
// state changes.
function DebridUsageBadge({ entry, onEntryUpdated }: { entry: VaultEntry; onEntryUpdated: (id: string, patch: Partial<VaultEntry>) => void }) {
  const [usage, setUsage] = useState<{ premiumDaysLeft: number | null; activeDownloads: number | null } | null | undefined>(undefined);
  const [savingAutoRemove, setSavingAutoRemove] = useState(false);
  // Controlled (was uncontrolled + save-on-blur only) - clicking the
  // native spin-button arrows changes the value without ever blurring the
  // input, so a blur-only save silently dropped the change if the user
  // then refreshed or navigated away before clicking elsewhere. Saving on
  // every change (typed or via the arrows) instead of only on blur means
  // there's never a window where a real change sits unsaved.
  const [daysValue, setDaysValue] = useState(String(entry.autoRemoveAfterDays || 7));

  useEffect(() => {
    if (entry.testType !== 'real_debrid' && entry.testType !== 'torbox') return;
    let cancelled = false;
    api.getVaultEntryUsage(entry.id).then((r) => { if (!cancelled) setUsage(r.usage); }).catch(() => { if (!cancelled) setUsage(null); });
    return () => { cancelled = true; };
  }, [entry.id, entry.testType]);

  if (entry.testType !== 'real_debrid' && entry.testType !== 'torbox') return null;

  const parts: string[] = [];
  if (usage) {
    if (typeof usage.activeDownloads === 'number') parts.push(`${usage.activeDownloads} active download${usage.activeDownloads === 1 ? '' : 's'}`);
  }

  const handleToggleAutoRemove = async () => {
    const next = !entry.autoRemoveEnabled;
    setSavingAutoRemove(true);
    try {
      await api.updateVaultEntry(entry.id, { autoRemoveEnabled: next });
      onEntryUpdated(entry.id, { autoRemoveEnabled: next });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update auto-remove');
    } finally {
      setSavingAutoRemove(false);
    }
  };

  const handleChangeAutoRemoveDays = async (days: number) => {
    if (!Number.isFinite(days) || days < 1) return;
    try {
      await api.updateVaultEntry(entry.id, { autoRemoveAfterDays: days });
      onEntryUpdated(entry.id, { autoRemoveAfterDays: days });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update auto-remove');
    }
  };

  return (
    <div className="mb-3 space-y-1.5">
      {parts.length > 0 && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{parts.join(' · ')}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Auto-remove finished torrents</span>
        <ToggleSwitch
          size="sm"
          checked={!!entry.autoRemoveEnabled}
          onChange={handleToggleAutoRemove}
          disabled={savingAutoRemove}
        />
      </div>
      {/* Day-count control only shown once auto-remove is actually on -
          confirmed cramped/mismatched on both PC and mobile when it was
          always inline next to the toggle regardless of state (a size="md"
          toggle next to text-xs text plus a number input, all fighting for
          space on an already-narrow card). */}
      {entry.autoRemoveEnabled && (
        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <span>After</span>
          <input
            type="number"
            min={1}
            value={daysValue}
            onChange={(e) => {
              setDaysValue(e.target.value);
              const parsed = parseInt(e.target.value, 10);
              // Saves on every valid change (typing a digit or clicking a
              // spin-button arrow) - not just on blur, so a value changed
              // via the arrows and never blurred (e.g. the user immediately
              // refreshes or navigates away) still persists. An empty or
              // mid-edit value (e.g. briefly clearing the field to retype)
              // just doesn't save yet, rather than saving a bad number.
              if (Number.isFinite(parsed) && parsed >= 1) handleChangeAutoRemoveDays(parsed);
            }}
            onBlur={(e) => {
              // Safety net: if what's left in the field on blur never
              // resolved to a valid save above (e.g. the user left it
              // empty), fall back to the last known-good value instead of
              // leaving the field blank.
              const parsed = parseInt(e.target.value, 10);
              if (!Number.isFinite(parsed) || parsed < 1) setDaysValue(String(entry.autoRemoveAfterDays || 7));
            }}
            className="w-12 px-1.5 py-0.5 rounded text-xs text-center"
            style={{ background: 'var(--color-subtle)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
          />
          <span>days idle</span>
        </div>
      )}
    </div>
  );
}

// Failover partner picker. Every credential can nominate another entry on
// the account as its backup: when this key's own health check comes back
// failing, consumers (debrid auto-remove, usenet, AI catalog, the metadata
// key resolvers) transparently use the backup instead of just breaking.
// Scoped to the same category on purpose - a debrid key backed by an OMDb
// key would be accepted by the schema but is never what anyone means.
function BackupKeySelect({ entry, allEntries, onEntryUpdated }: {
  entry: VaultEntry;
  allEntries: VaultEntry[];
  onEntryUpdated: (id: string, patch: Partial<VaultEntry>) => void;
}) {
  const [saving, setSaving] = useState(false);

  // An entry cannot back up itself (the server rejects it too), and only
  // same-category entries are offered.
  const candidates = allEntries.filter(
    (e) => e.id !== entry.id && e.category === entry.category && e.isActive
  );

  // Nothing to fail over TO - showing an empty dropdown on every card in a
  // one-key-per-category vault would be pure noise.
  if (candidates.length === 0 && !entry.backupEntryId) return null;

  const handleChange = async (value: string) => {
    setSaving(true);
    try {
      await api.updateVaultEntry(entry.id, { backupEntryId: value || null });
      onEntryUpdated(entry.id, { backupEntryId: value || null });
      toast.success(value ? 'Backup key set' : 'Backup key cleared');
    } catch (err: any) {
      toast.error(err.message || 'Failed to set backup key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <span className="text-xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>Backup key</span>
      <select
        value={entry.backupEntryId || ''}
        disabled={saving}
        onChange={(e) => handleChange(e.target.value)}
        className="text-xs rounded px-1.5 py-1 min-w-0 max-w-[60%]"
        style={{ background: 'var(--color-subtle)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
      >
        <option value="">None</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </div>
  );
}

// Wraps a card with dnd-kit's sortable drag state AND a right-click context
// menu — both live here (rather than in renderEntryCard) since hooks can't
// be called conditionally or inside a .map() callback directly.
function SortableEntryCard({
  entry,
  renderEntryCard,
  onTest,
  onEdit,
  onDuplicate,
  onMoveToAddons,
  onDelete,
  plain = false,
}: {
  entry: VaultEntry;
  renderEntryCard: (entry: VaultEntry, dragHandleProps?: Record<string, unknown>, isDragging?: boolean) => React.ReactNode;
  onTest: (entry: VaultEntry) => void;
  onEdit: (entry: VaultEntry) => void;
  /** Opens the add form filled in like this one, without the secret. */
  onDuplicate: (entry: VaultEntry) => void;
  onMoveToAddons: (entry: VaultEntry) => void;
  onDelete: (entry: VaultEntry) => void;
  /** A search result: it can be anywhere in the Vault, so it is not dragged from here. */
  plain?: boolean;
}) {
  const { dragHandleProps, itemProps, isDragging } = useSortableDragState(entry.id);
  const { isOpen, position, handleContextMenu, close } = useContextMenu();
  // onContextMenu alone only covers a real desktop right-click - iOS Safari
  // doesn't reliably synthesize that DOM event from a touch-and-hold, so
  // this menu (Run Check Now/Edit/Move to Addons/Delete) was effectively
  // unreachable by holding on mobile. See useLongPress's own comment.
  const longPress = useLongPress({ onLongPress: handleContextMenu });

  return (
    <div ref={itemProps.ref} style={itemProps.style} className={`${itemProps.className} tap-card`} onContextMenu={handleContextMenu} {...longPress}>
      {renderEntryCard(entry, plain ? undefined : dragHandleProps, isDragging)}

      <ContextMenu isOpen={isOpen} position={position} onClose={close}>
        {entry.category !== 'note' && (
        <button
          onClick={() => { close(); onTest(entry); }}
          disabled={entry.testType === 'manual'}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors disabled:opacity-40"
        >
          <ArrowPathIcon className="w-4 h-4" />
          Run Check Now
        </button>
        )}
        <button
          onClick={() => { close(); onEdit(entry); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <PencilIcon className="w-4 h-4" />
          Edit
        </button>
        <button
          onClick={() => { close(); onDuplicate(entry); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <DocumentDuplicateIcon className="w-4 h-4" />
          Duplicate
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
        {entry.dashboardUrl && (
          <button
            onClick={() => {
              close();
              window.open(entry.dashboardUrl || undefined, '_blank', 'noopener,noreferrer');
              onEdit(entry);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
            title="Open the provider's dashboard and this entry's edit form together"
          >
            <ArrowPathIcon className="w-4 h-4" />
            Rotate Now
          </button>
        )}
        {entry.category !== 'note' && (
        <>
        <div className="my-1 border-t border-default" />
        <button
          onClick={() => { close(); onMoveToAddons(entry); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <PuzzlePieceIcon className="w-4 h-4" />
          Move to Addons
        </button>
        </>
        )}
        <div className="my-1 border-t border-default" />
        <TwoStepButton
          onConfirm={() => { close(); onDelete(entry); }}
          label="Delete"
          icon={<TrashIcon className="w-4 h-4" />}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-error-muted transition-colors"
        />
      </ContextMenu>
    </div>
  );
}

// useSearchParams (for the ?edit= deep link below) requires a Suspense
// boundary above it in the App Router - same pattern Activity's page
// already uses for its own search-param-driven state.
function VaultPageContent() {
  const { layoutMode } = useLayoutMode();
  const isTV = useIsTV();
  const Wrapper = isTV ? TVPageProvider : Fragment;
  const searchParams = useSearchParams();
  const router = useRouter();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  // Kept between visits when "Keep each page's filter" is on (Themes).
  const [activeCategory, setActiveCategory] = useSavedFilter('vault', 'debrid' as string); // 'all' tab removed - defaults to first real category
  const [isLoading, setIsLoading] = useState(true);

  // Instant navigation: the last-known entries of the category this page
  // opens on, shown at once while load() below refreshes them.
  useLastKnown<{ entries: VaultEntry[]; categories: Record<string, number>; total: number }>('/vault?category=debrid', (cached) => {
    setEntries(cached.entries);
    setCategoryCounts(cached.categories);
    setTotal(cached.total);
    setIsLoading(false);
  });
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  // A secret shown on a card hides itself again after 30 seconds. The stamp
  // restarts the line that runs out under it.
  const [revealStamp, setRevealStamp] = useState<Record<string, number>>({});
  const hideTimers = useRef<Record<string, number>>({});
  useEffect(() => {
    const timers = hideTimers.current;
    return () => { Object.values(timers).forEach((t) => window.clearTimeout(t)); };
  }, []);
  // v2: the entry whose History is open from its card's menu.
  const [historyFor, setHistoryFor] = useState<{ id: string; name: string } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [movingToAddonsId, setMovingToAddonsId] = useState<string | null>(null);

  const [isAddOpen, setIsAddOpen] = useState(false);
  // Set only when the edit modal was opened via an alert's deep link
  // (?edit=<id>), so the "rotate now" banner (open the dashboard right from
  // inside the form) only shows in that context, not on every manual edit.
  const [arrivedViaAlert, setArrivedViaAlert] = useState(false);
  // The entry being edited, with its details; null while adding.
  const [editingEntry, setEditingEntry] = useState<VaultEntry | null>(null);
  // Duplicate: the add form starts filled in like another entry, without its secret.
  const [startWith, setStartWith] = useState<VaultFormValues | null>(null);
  // A new form each time it opens, so nothing typed last time is still in it.
  const [formKey, setFormKey] = useState(0);
  // Search across every kind at once, and only what needs a look.
  const [query, setQuery] = useState('');
  const [needOnly, setNeedOnly] = useState(false);
  // Test all: how far along it is.
  const [testAll, setTestAll] = useState<{ at: number; of: number } | null>(null);
  // How many addons carry each key, by entry id.
  const [usedBy, setUsedBy] = useState<Record<string, number>>({});
  // TorBox's plan + list price, offered once for an empty Cost field.
  const [planOffer, setPlanOffer] = useState<{ name: string; monthlyUsd: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Cost summary - needs ALL entries (not just the active category tab's) plus
  // recent watch hours, so it's a separate fetch from the tab-scoped `load()`.
  // Re-fetched via `costRefreshKey` whenever an entry is saved/deleted so the
  // summary stays in sync with edits.
  const [allCostEntries, setAllCostEntries] = useState<VaultEntry[]>([]);
  const [hoursLast30, setHoursLast30] = useState<number | null>(null);
  const [currency, setCurrency] = useState('USD');
  const [costRefreshKey, setCostRefreshKey] = useState(0);
  // Renewal calendar starts collapsed to just its one summary line - the
  // detail list of every individual upcoming renewal is worth having but
  // not worth always taking up vertical space for.
  const [renewalExpanded, setRenewalExpanded] = useState(false);

  useEffect(() => {
    api.getVaultEntries().then((d) => {
      setAllCostEntries(d.entries);
      if (d.currency) setCurrency(d.currency);
    }).catch(() => {});
    // Which keys addons carry. Nothing shows when this cannot be read.
    api.getVaultUsageCounts().then((r) => setUsedBy(r.counts || {})).catch(() => {});
    // Sum hours from the last 30 days of watchTime.byDay - a monthly spend
    // figure divided by ~a month of hours keeps cost/hour dimensionally
    // honest (a monthly $ over all-time hours would keep shrinking as history
    // piles up, which reads as "getting cheaper" when nothing changed).
    api.getMetrics('all').then((m) => {
      const byDay = m.watchTime?.byDay || [];
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const sum = byDay.filter((d) => d.date >= cutoff).reduce((acc, d) => acc + (d.hours || 0), 0);
      setHoursLast30(sum);
    }).catch(() => {});
  }, [costRefreshKey]);

  // Format any amount in the account's chosen currency - Intl handles the
  // symbol, placement, and decimal conventions for whatever code is set, so
  // there's no hardcoded "$". Falls back to a plain prefix if the code is
  // somehow invalid.
  const fmtMoney = useCallback((amount: number) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch {
      return `${currency} ${amount.toFixed(2)}`;
    }
  }, [currency]);

  const handleCurrencyChange = async (next: string) => {
    setCurrency(next);
    try {
      await api.updateSyncSettings({ vaultCurrency: next });
    } catch (e: any) {
      toast.error(e.message || 'Failed to update currency');
    }
  };

  // A yearly price is spread over twelve months; a lifetime plan is paid once
  // and stays out of the monthly and yearly totals (lib/vaultStatus).
  const { monthly: monthlyTotal, tracked: trackedCount, paidOnce, lifetimeCount } = useMemo(() => costSummary(allCostEntries), [allCostEntries]);
  const costPerHour = hoursLast30 && hoursLast30 > 0 ? monthlyTotal / hoursLast30 : null;

  // Renewal calendar: projects each cost-tracked entry's OWN renewal cycle
  // forward from its current expiresAt (not just a single "next renewal"
  // check) - a monthly service renews up to 3 times within a 90-day window,
  // and each occurrence is a real, separate charge, not one. expiresAt is
  // kept current either by Real-Debrid/TorBox's own auto-check (see
  // vaultCheckers.js) or manually whenever the admin renews something else -
  // this only ever projects forward from whatever that value currently is,
  // never guesses at a renewal that hasn't happened.
  const FORECAST_WINDOW_DAYS = 90;
  const upcomingRenewals = useMemo(() => {
    const now = Date.now();
    const windowEnd = now + FORECAST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const occurrences: Array<{ entryId: string; name: string; date: Date; amount: number }> = [];
    for (const e of allCostEntries) {
      if (!e.cost || e.cost <= 0 || !e.expiresAt || !e.isActive || monthlyCost(e) === 0) continue;
      const cycleDays = e.costCycle === 'yearly' ? 365 : 30;
      let next = new Date(e.expiresAt).getTime();
      // Catch up past-due entries (expiresAt already passed but never
      // updated) to the next real occurrence instead of skipping the
      // window entirely or double-counting a stale date.
      while (next < now) next += cycleDays * 24 * 60 * 60 * 1000;
      while (next <= windowEnd) {
        occurrences.push({ entryId: e.id, name: e.name, date: new Date(next), amount: e.cost });
        next += cycleDays * 24 * 60 * 60 * 1000;
      }
    }
    return occurrences.sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [allCostEntries]);
  const forecastTotal = upcomingRenewals.reduce((sum, r) => sum + r.amount, 0);

  const load = useCallback(async () => {
    try {
      const data = await api.getVaultEntries(activeCategory);
      setEntries(data.entries);
      setCategoryCounts(data.categories);
      setTotal(data.total);
      // Keep the (all-category) cost summary in sync with any edit that
      // triggered this reload.
      setCostRefreshKey((k) => k + 1);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load vault entries');
    } finally {
      setIsLoading(false);
    }
  }, [activeCategory]);

  useEffect(() => { load(); }, [load]);

  const openAddModal = () => {
    setEditingEntry(null);
    setStartWith(null);
    setPlanOffer(null);
    setArrivedViaAlert(false);
    setFormKey((k) => k + 1);
    setIsAddOpen(true);
  };

  const openEditModal = async (entry: VaultEntry) => {
    // A card carries only what it shows; the form needs the rest (addresses, the form picked).
    let full = entry;
    if (entry.testConfig === undefined) {
      try { full = await api.getVaultEntry(entry.id); } catch (err: any) { toast.error(err.message || 'Could not open that entry'); return; }
    }
    setEditingEntry(full);
    setStartWith(null);
    setPlanOffer(null);
    if (full.testType === 'torbox' && full.cost == null) {
      api.getVaultEntryUsage(full.id).then((r) => setPlanOffer(r.usage?.plan || null)).catch(() => {});
    }
    setArrivedViaAlert(false);
    setFormKey((k) => k + 1);
    setIsAddOpen(true);
  };

  // Duplicate: the add form, filled in like this entry, without its secret.
  const handleDuplicate = async (entry: VaultEntry) => {
    try {
      const full = await api.getVaultEntry(entry.id);
      setEditingEntry(null);
      setStartWith({ ...fromEntry(full), name: `${full.name} (copy)`, secret: '' });
      setPlanOffer(null);
      setArrivedViaAlert(false);
      setFormKey((k) => k + 1);
      setIsAddOpen(true);
    } catch (err: any) {
      toast.error(err.message || 'Could not open that entry');
    }
  };

  // Deep link from a Vault alert's "Fix now" button (?edit=<entryId>) - jump
  // straight into that entry's edit form instead of leaving someone to hunt
  // through categories for whichever one just failed. Fetches the entry
  // directly by id rather than relying on `entries` (which is filtered by
  // activeCategory and may not include it), and switches the active category
  // tab to match so the page behind the modal isn't left showing an
  // unrelated filter. Strips the param once handled so a refresh or closing
  // and reopening the modal manually doesn't reopen it again.
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (!editId) return;
    api.getVaultEntry(editId)
      .then((entry) => {
        setActiveCategory(entry.category);
        void openEditModal(entry).then(() => setArrivedViaAlert(true));
      })
      .catch(() => toast.error('Could not find that Vault entry'))
      .finally(() => router.replace('/vault'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ?open=add - deep link from the Guides pages straight into Add Entry,
  // rather than landing on Vault with a "now click Add Entry" instruction.
  // Same strip-the-param behaviour as ?edit= above.
  useEffect(() => {
    if (searchParams.get('open') !== 'add') return;
    openAddModal();
    router.replace('/vault');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleSubmit = async (payload: VaultPayload, opts: { test: boolean }) => {
    setIsSaving(true);
    try {
      if (editingEntry) {
        const result = await api.updateVaultEntry(editingEntry.id, payload as Partial<VaultEntryInput>);
        // The key changed and SlickSync put the new one where the old one
        // was: say exactly what, since addon settings and people's accounts
        // just changed as a side effect of saving a key.
        const aio = result?.rotation?.aioConfigsUpdated?.length || 0;
        const aioNote = aio ? `${aio} AIOStreams setup${aio === 1 ? '' : 's'}` : '';
        if (result?.rotation && result.rotation.addonsUpdated.length > 0) {
          const r = result.rotation;
          const updated = `Updated ${r.addonsUpdated.length} addon${r.addonsUpdated.length === 1 ? '' : 's'}${aioNote ? `, ${aioNote}` : ''} and re-synced ${r.usersSynced} ${r.usersSynced === 1 ? 'person' : 'people'}.`;
          if (r.userFailures.length) {
            toast.warning('Key rotated', {
              line: `${updated} ${r.userFailures.length} couldn’t be re-synced. Details are in your notifications.`,
            });
          } else {
            toast.success('Key rotated', { line: updated });
          }
        } else if (aioNote) {
          toast.success('Key rotated', { line: `Updated ${aioNote}.` });
        } else {
          toast.success(`${payload.name} saved`);
        }
      } else {
        const made = await api.createVaultEntry(payload as unknown as VaultEntryInput);
        // "Add and test": its check runs straight away, and the answer is said with it.
        let checked: { ok: boolean | null; message: string } | null = null;
        if (opts.test) { try { checked = await api.testVaultEntry(made.id); } catch { checked = null; } }
        if (checked?.ok === false) toast.warning(`${payload.name} added, but its check failed`, { line: checked.message });
        else if (checked) toast.success(`${payload.name} added`, { line: checked.message });
        else toast.success(`${payload.name} added`);
        // Land on its own tab, so what was just added is in view.
        if (payload.category !== activeCategory) setActiveCategory(payload.category);
      }
      setIsAddOpen(false);
      load();
    } catch (err: any) {
      toast.error(err.message || 'Could not save it');
    } finally {
      setIsSaving(false);
    }
  };

  // "I renewed it": the end date moves on one billing period; Undo puts it back.
  const handleRenewed = async (entry: VaultEntry) => {
    try {
      const r = await api.markVaultRenewed(entry.id);
      toast.success(`${entry.name} now ends ${shortDay(r.expiresAt)}`, {
        actions: [{
          label: 'Undo',
          onClick: async () => {
            try { await api.updateVaultEntry(entry.id, { expiresAt: r.previousExpiresAt }); load(); }
            catch (e) { toast.error(e instanceof Error ? e.message : 'Could not put the date back'); }
          },
        }],
      });
      load();
    } catch (err: any) {
      toast.error(err.message || 'Could not move the date');
    }
  };

  // Test all: every entry that has a check, one after another, counting as it goes.
  const checkable = useMemo(() => allCostEntries.filter((e) => e.isActive && !isNote(e) && e.testType !== 'manual'), [allCostEntries]);
  const handleTestAll = async () => {
    if (testAll || checkable.length === 0) return;
    let failed = 0;
    for (let i = 0; i < checkable.length; i++) {
      setTestAll({ at: i + 1, of: checkable.length });
      try { const r = await api.testVaultEntry(checkable[i].id); if (r.ok === false) failed++; } catch { failed++; }
    }
    setTestAll(null);
    if (failed) toast.warning(`${checkable.length} checked`, { line: `${failed} ${failed === 1 ? 'is' : 'are'} not working. ${failed === 1 ? 'It is' : 'They are'} under Needs a look.` });
    else toast.success(`${checkable.length} checked`, { line: 'All working.' });
    load();
  };

  // The buttons ask twice (TwoStepButton, or the menu's "Delete?"), so by
  // here it is decided; Undo brings the entry back from the Trash.
  const handleDelete = async (entry: VaultEntry) => {
    try {
      const res = await api.deleteVaultEntry(entry.id);
      showDeletedWithUndo(`"${entry.name}"`, res?.trashId, load);
      load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    }
  };

  const handleMoveToAddons = async (entry: VaultEntry) => {
    if (!confirm(`Move "${entry.name}" to Addons? This removes it from the Vault.`)) return;
    setMovingToAddonsId(entry.id);
    try {
      const { secret } = await api.revealVaultSecret(entry.id, 'move');
      if (!secret || !/^https?:\/\//i.test(secret.trim())) {
        toast.error('That isn’t an addon address', { line: 'The secret has to be a link starting with http:// or https://.' });
        return;
      }
      await api.createAddon({ manifestUrl: secret.trim(), name: entry.name } as any);
      await api.deleteVaultEntry(entry.id);
      toast.success(`Moved ${entry.name} to Addons`);
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

    return registerDragEndHandler(handleDragEnd);
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

  const hideSecret = (id: string) => {
    window.clearTimeout(hideTimers.current[id]);
    delete hideTimers.current[id];
    setRevealed(prev => { const next = { ...prev }; delete next[id]; return next; });
  };

  const handleReveal = async (entry: VaultEntry) => {
    if (revealed[entry.id]) {
      hideSecret(entry.id);
      return;
    }
    try {
      const result = await api.revealVaultSecret(entry.id);
      setRevealed(prev => ({ ...prev, [entry.id]: result.secret }));
      setRevealStamp(prev => ({ ...prev, [entry.id]: Date.now() }));
      window.clearTimeout(hideTimers.current[entry.id]);
      hideTimers.current[entry.id] = window.setTimeout(() => hideSecret(entry.id), 30000);
    } catch (err: any) {
      toast.error(err.message || 'Failed to reveal secret');
    }
  };

  // Lazy-fills the edit form's Secret field with the real stored value the
  // first time its eye icon is clicked to reveal (see Input's own
  // onRevealClick comment) - only when the field is still exactly the
  // placeholder-blank "leave empty to keep current" state, so it never
  // clobbers something the user already started typing to replace it with.
  // The eye in the edit form's secret box: the secret on file, fetched only then.
  const revealForForm = async (): Promise<string | null> => {
    if (!editingEntry) return null;
    try { return (await api.revealVaultSecret(editingEntry.id)).secret; }
    catch (err: any) { toast.error(err.message || 'Failed to reveal secret'); return null; }
  };

  // Copies the secret without requiring "Reveal" first, and never stores it
  // into `revealed`, so the card stays masked. Always asked of the server,
  // even when it is on screen already, so the key's History says Copied.
  const handleCopy = async (entry: VaultEntry) => {
    try {
      const value = (await api.revealVaultSecret(entry.id, 'copy')).secret;
      await copyToClipboard(value);
      toast.success('Copied to clipboard');
    } catch (err: any) {
      toast.error(err.message || 'Failed to copy');
    }
  };

  // Silences the expiry-warning alert for 7 days without dismissing the
  // entry or touching its notifyDaysBefore setting - a check-failure alert
  // (something's actually broken right now) is a different signal and still
  // fires normally.
  const handleSnooze = async (entry: VaultEntry) => {
    try {
      const updated = await api.snoozeVaultEntry(entry.id);
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, snoozedUntil: updated.snoozedUntil } : e));
      toast.success(`Snoozed "${entry.name}" for 7 days`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to snooze');
    }
  };

  // v2: what needs you first, then the rest; Arrange moves, folds and hides
  // the two sections and hides single entries (lib/arrange.tsx).
  const { design } = usePageDesign();
  const v2 = design === 'v2' && !isTV;
  const { viewMode, setViewMode } = useDefaultViewMode();
  const [renderedAt] = useState(() => Date.now());
  const sectionArrange = usePageArrangement('vault', useMemo(() => VAULT_SECTIONS.map((x) => x.key), []));
  const entryArrangeOwn = usePageArrangement('vault-items', useMemo(() => allCostEntries.map((e) => e.id), [allCostEntries]));
  const classicArrange = usePageArrangement('vault-classic', CLASSIC_SECTION_KEYS);
  const entryArrange = { ...entryArrangeOwn, arranging: sectionArrange.arranging };
  const pageArrange = { ...sectionArrange, isDefault: sectionArrange.isDefault && entryArrangeOwn.isDefault, reset: () => { sectionArrange.reset(); entryArrangeOwn.reset(); } };

  const filterOptions = [
    ...Object.entries(VAULT_UI_CATEGORY_LABELS).map(([key, label]) => ({
      key, label, count: categoryCounts[key] || 0,
    })),
  ];

  // A note is not a key: no status, no test, no backup key, no billing.
  const renderNoteCard = (entry: VaultEntry, dragHandleProps?: Record<string, unknown>, isDragging?: boolean) => (
    <Card data-vault-card="" data-vault-note="" variant="bordered" className={`h-full flex flex-col ${isDragging ? 'shadow-lg shadow-primary/25 scale-[1.01]' : ''}`}>
      <div className="flex items-center gap-2 mb-3 min-w-0">
        {dragHandleProps && (
          <div {...dragHandleProps} className="cursor-grab active:cursor-grabbing p-1 -ml-1 rounded hover:bg-surface-hover shrink-0">
            <Bars3Icon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          </div>
        )}
        <div className="min-w-0">
          <h3 className="font-semibold break-words" style={{ color: 'var(--color-text)' }}>{entry.name}</h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{CATEGORY_LABELS[entry.category]}</p>
        </div>
      </div>
      <div className="mb-3 p-3 rounded-lg flex items-start justify-between gap-2" style={{ background: 'var(--color-subtle)' }}>
        <div className="min-w-0 flex-1">
          {revealed[entry.id]
            ? <p className="text-sm whitespace-pre-wrap break-words" style={{ color: 'var(--color-text)' }}>{revealed[entry.id]}</p>
            : <code className="text-xs truncate block" style={{ color: 'var(--color-text)' }}>••••••••••••••••</code>}
          {revealed[entry.id] && <div key={revealStamp[entry.id] ?? 0} className="vault-reveal-line" aria-hidden="true" />}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(() => {
            const btn = (
              <button onClick={() => handleCopy(entry)} title="Copy to clipboard" aria-label="Copy to clipboard" style={{ color: 'var(--color-text-muted)' }}>
                <DocumentDuplicateIcon className="w-4 h-4" />
              </button>
            );
            return isTV ? <TVFocusable onEnterPress={() => handleCopy(entry)}>{btn}</TVFocusable> : btn;
          })()}
          {(() => {
            const btn = (
              <button onClick={() => handleReveal(entry)} title={revealed[entry.id] ? 'Hide value' : 'Reveal value'} aria-label={revealed[entry.id] ? 'Hide value' : 'Reveal value'} style={{ color: 'var(--color-text-muted)' }}>
                {revealed[entry.id] ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
              </button>
            );
            return isTV ? <TVFocusable onEnterPress={() => handleReveal(entry)}>{btn}</TVFocusable> : btn;
          })()}
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 pt-2 flex-wrap" style={{ borderTop: '1px solid var(--color-surface-border)' }}>
        {(() => {
          const btn = (
            <button onClick={() => openEditModal(entry)} title="Edit" aria-label="Edit" className="p-2 rounded-lg transition-colors" style={{ background: 'var(--color-surface-hover)' }}>
              <PencilIcon className="w-4 h-4" style={{ color: 'var(--color-text)' }} />
            </button>
          );
          return isTV ? <TVFocusable onEnterPress={() => openEditModal(entry)}>{btn}</TVFocusable> : btn;
        })()}
        <VaultHistoryButton entryId={entry.id} name={entry.name} />
        {(() => {
          // A remote cannot do a quick second press, so the TV keeps asking first.
          if (isTV) {
            return (
              <TVFocusable onEnterPress={() => { if (window.confirm(`Delete "${entry.name}"? It goes to the Trash and can be restored for 30 days.`)) handleDelete(entry); }}>
                <button title="Delete" aria-label="Delete" className="p-2 rounded-lg transition-colors ml-auto" style={{ background: 'var(--color-surface-hover)' }}>
                  <TrashIcon className="w-4 h-4" style={{ color: 'var(--color-error)' }} />
                </button>
              </TVFocusable>
            );
          }
          return (
            <TwoStepButton
              onConfirm={() => handleDelete(entry)}
              ariaLabel="Delete"
              title="Delete"
              icon={<TrashIcon className="w-4 h-4" style={{ color: 'var(--color-error)' }} />}
              className="p-2 rounded-lg transition-colors ml-auto inline-flex items-center gap-1.5 text-sm bg-surface-hover"
            />
          );
        })()}
      </div>
    </Card>
  );

  const renderKeyCard = (entry: VaultEntry, dragHandleProps?: Record<string, unknown>, isDragging?: boolean) => (
    <Card data-vault-card="" variant="bordered" className={`h-full flex flex-col ${isDragging ? 'shadow-lg shadow-primary/25 scale-[1.01]' : ''}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex items-center gap-2">
          {dragHandleProps && (
            <div {...dragHandleProps} className="cursor-grab active:cursor-grabbing p-1 -ml-1 rounded hover:bg-surface-hover shrink-0">
              <Bars3Icon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="font-semibold break-words" style={{ color: 'var(--color-text)' }}>{entry.name}</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              {CATEGORY_LABELS[entry.category]}{entry.provider ? ` • ${entry.provider}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isSnoozed(entry, renderedAt) && <Badge variant="neutral" size="sm">Snoozed</Badge>}
          <VaultStatusBadge judged={judgeEntry(entry, renderedAt)} />
          {/* Only worth offering once the badge is actually alert-worthy
              (expired, or inside the warning window) and not already
              snoozed - a plain "12d left" badge has nothing to snooze. */}
          {(() => {
            const days = daysUntil(entry.expiresAt, renderedAt);
            const alertWorthy = days !== null && !entry.autoRenew && (days < 0 || days <= entry.notifyDaysBefore);
            if (!alertWorthy || isSnoozed(entry, renderedAt)) return null;
            const btn = (
              <button
                onClick={() => handleSnooze(entry)}
                title="Snooze this expiry alert for 7 days"
                className="shrink-0"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <BellSlashIcon className="w-3.5 h-3.5" />
              </button>
            );
            return isTV ? <TVFocusable onEnterPress={() => handleSnooze(entry)}>{btn}</TVFocusable> : btn;
          })()}
        </div>
      </div>

      <div className="mb-3 p-3 rounded-lg flex items-center justify-between gap-2" style={{ background: 'var(--color-subtle)' }}>
        <div className="min-w-0 flex-1">
          <code className="text-xs truncate block" style={{ color: 'var(--color-text)' }}>
            {revealed[entry.id] || '••••••••••••••••'}
          </code>
          {revealed[entry.id] && <div key={revealStamp[entry.id] ?? 0} className="vault-reveal-line" aria-hidden="true" />}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(() => {
            const btn = (
              <button onClick={() => handleCopy(entry)} title="Copy to clipboard" aria-label="Copy to clipboard" style={{ color: 'var(--color-text-muted)' }}>
                <DocumentDuplicateIcon className="w-4 h-4" />
              </button>
            );
            return isTV ? <TVFocusable onEnterPress={() => handleCopy(entry)}>{btn}</TVFocusable> : btn;
          })()}
          {(() => {
            const btn = (
              <button onClick={() => handleReveal(entry)} title={revealed[entry.id] ? 'Hide value' : 'Reveal value'} aria-label={revealed[entry.id] ? 'Hide value' : 'Reveal value'} style={{ color: 'var(--color-text-muted)' }}>
                {revealed[entry.id] ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
              </button>
            );
            return isTV ? <TVFocusable onEnterPress={() => handleReveal(entry)}>{btn}</TVFocusable> : btn;
          })()}
        </div>
      </div>

      {entry.lastCheckMessage && (
        <p className="text-sm mb-3" style={{ color: 'var(--color-text-muted)' }}>{entry.lastCheckMessage}</p>
      )}
      {(() => {
        // When it ends (or that it never does), unless the badge or the message already says so.
        const j = judgeEntry(entry, renderedAt);
        const said = j.need === 'fix' || !j.line || j.line === entry.lastCheckMessage || j.line === 'Last check passed' || j.line === 'No automatic check';
        return said ? null : <p className={entry.lastCheckMessage ? 'text-xs -mt-1.5 mb-3' : 'text-xs mb-3'} style={{ color: 'var(--color-text-muted)' }}>{j.line}</p>;
      })()}
      {(usedBy[entry.id] || 0) > 0 && (
        <div className="mb-3"><UsedByChip entryId={entry.id} name={entry.name} count={usedBy[entry.id]} /></div>
      )}
      {canMarkRenewed(entry, renderedAt) && (() => {
        const btn = <Button variant="primary" size="sm" onClick={() => handleRenewed(entry)}>I renewed it</Button>;
        return <div className="mb-3 flex flex-wrap gap-2">{isTV ? <TVFocusable onEnterPress={() => handleRenewed(entry)}>{btn}</TVFocusable> : btn}</div>;
      })()}

      <DebridUsageBadge entry={entry} onEntryUpdated={(id, patch) => setEntries(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e))} />

      <BackupKeySelect
        entry={entry}
        allEntries={entries}
        onEntryUpdated={(id, patch) => setEntries(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e))}
      />

      <div className="mt-auto flex items-center gap-2 pt-2 flex-wrap" style={{ borderTop: '1px solid var(--color-surface-border)' }}>
        {(() => {
          const btn = (
            <button
              onClick={() => handleTest(entry)}
              disabled={testingId === entry.id || entry.testType === 'manual'}
              title={entry.testType === 'manual' ? 'No automated check configured' : 'Run check now'}
              className="p-2 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--color-surface-hover)' }}
            >
              <ArrowPathIcon className={`w-4 h-4 ${testingId === entry.id ? 'animate-spin' : ''}`} style={{ color: 'var(--color-text)' }} />
            </button>
          );
          return isTV && entry.testType !== 'manual' ? <TVFocusable onEnterPress={() => handleTest(entry)}>{btn}</TVFocusable> : btn;
        })()}
        {(() => {
          const btn = (
            <button onClick={() => openEditModal(entry)} title="Edit" aria-label="Edit" className="p-2 rounded-lg transition-colors" style={{ background: 'var(--color-surface-hover)' }}>
              <PencilIcon className="w-4 h-4" style={{ color: 'var(--color-text)' }} />
            </button>
          );
          return isTV ? <TVFocusable onEnterPress={() => openEditModal(entry)}>{btn}</TVFocusable> : btn;
        })()}
        {entry.dashboardUrl && (() => {
          const link = (
            <a href={entry.dashboardUrl} target="_blank" rel="noreferrer" className="p-2 rounded-lg transition-colors" style={{ background: 'var(--color-surface-hover)' }}>
              <ArrowTopRightOnSquareIcon className="w-4 h-4" style={{ color: 'var(--color-text)' }} />
            </a>
          );
          return isTV ? (
            <TVFocusable onEnterPress={() => window.open(entry.dashboardUrl || undefined, '_blank', 'noopener,noreferrer')}>{link}</TVFocusable>
          ) : link;
        })()}
        {(() => {
          const btn = (
            <button
              onClick={() => handleMoveToAddons(entry)}
              disabled={movingToAddonsId === entry.id}
              title="Move to Addons"
              className="p-2 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--color-surface-hover)' }}
            >
              <PuzzlePieceIcon className="w-4 h-4" style={{ color: 'var(--color-text)' }} />
            </button>
          );
          return isTV ? <TVFocusable onEnterPress={() => handleMoveToAddons(entry)}>{btn}</TVFocusable> : btn;
        })()}
        <VaultHistoryButton entryId={entry.id} name={entry.name} />
        {(() => {
          // A remote cannot do a quick second press, so the TV keeps asking first.
          if (isTV) {
            return (
              <TVFocusable onEnterPress={() => { if (window.confirm(`Delete "${entry.name}"? It goes to the Trash and can be restored for 30 days.`)) handleDelete(entry); }}>
                <button title="Delete" aria-label="Delete" className="p-2 rounded-lg transition-colors ml-auto" style={{ background: 'var(--color-surface-hover)' }}>
                  <TrashIcon className="w-4 h-4" style={{ color: 'var(--color-error)' }} />
                </button>
              </TVFocusable>
            );
          }
          return (
            <TwoStepButton
              onConfirm={() => handleDelete(entry)}
              ariaLabel="Delete"
              title="Delete"
              icon={<TrashIcon className="w-4 h-4" style={{ color: 'var(--color-error)' }} />}
              className="p-2 rounded-lg transition-colors ml-auto inline-flex items-center gap-1.5 text-sm bg-surface-hover"
            />
          );
        })()}
      </div>
    </Card>
  );

  const renderEntryCard = (entry: VaultEntry, dragHandleProps?: Record<string, unknown>, isDragging?: boolean) => (
    isNote(entry) ? renderNoteCard(entry, dragHandleProps, isDragging) : renderKeyCard(entry, dragHandleProps, isDragging)
  );

  // Search looks across every kind at once; "Needs a look" keeps only what is failing or ending.
  const filtering = query.trim() !== '' || needOnly;
  const needCount = allCostEntries.filter((e) => !isNote(e) && judgeEntry(e, renderedAt).need !== null).length;
  const shownEntries = filtering
    ? allCostEntries.filter((e) => matchesSearch(e, query, CATEGORY_LABELS[e.category] || '') && (!needOnly || (!isNote(e) && judgeEntry(e, renderedAt).need !== null)))
    : entries;
  const testAllButton = checkable.length > 0 ? (
    <Button variant="secondary" leftIcon={<ArrowPathIcon className={testAll ? 'w-5 h-5 animate-spin' : 'w-5 h-5'} />} onClick={handleTestAll} disabled={!!testAll}>
      {testAll ? `Testing ${testAll.at} of ${testAll.of}` : 'Test all'}
    </Button>
  ) : null;

  const classic = !v2 && !isTV;
  const costSection = (trackedCount > 0 || lifetimeCount > 0) ? (
    <>
      <div className="flex items-center justify-end mb-2">
        <label className="text-xs text-muted mr-2">Currency</label>
        {/* Explicit narrow width - the shared input-base class forces
            width:100%, which stretched this three-letter selector across
            the whole page. */}
        <select
          value={currency}
          onChange={(e) => handleCurrencyChange(e.target.value)}
          className="input-base px-2 py-1 text-xs rounded-lg"
          style={{ width: '6rem' }}
          title="Currency for all cost figures"
        >
          {CURRENCY_OPTIONS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-4">
        {[
          { label: `Monthly Spend · ${trackedCount} service${trackedCount !== 1 ? 's' : ''}`, value: fmtMoney(monthlyTotal), icon: <BanknotesIcon className="w-4 h-4 md:w-6 md:h-6" /> },
          { label: 'Yearly', value: fmtMoney(monthlyTotal * 12), icon: <CreditCardIcon className="w-4 h-4 md:w-6 md:h-6" /> },
          { label: costPerHour != null ? 'Per Hour Watched (30d)' : 'Per Hour Watched', value: costPerHour != null ? fmtMoney(costPerHour) : '—', icon: <ClockIcon className="w-4 h-4 md:w-6 md:h-6" /> },
        ].map((s, i) => {
          const isPrimary = i % 2 === 0;
          return (
            <div key={s.label} className={`${NEBULA_GLASS_CLASS} p-2.5 sm:p-3 md:p-5 flex items-center gap-2 md:gap-4 min-w-0`} style={nebulaGlassStyle}>
              <NebulaGlassStripe />
              <div className="w-8 h-8 md:w-11 md:h-11 rounded-lg md:rounded-xl flex items-center justify-center shrink-0" style={{ background: isPrimary ? 'var(--color-primary-muted)' : 'var(--color-secondary-muted)', color: isPrimary ? 'var(--color-primary)' : 'var(--color-secondary)' }}>
                {s.icon}
              </div>
              <div className="min-w-0">
                <p className="text-base sm:text-lg md:text-3xl font-bold font-display text-default leading-none truncate">{s.value}</p>
                <p className="text-[10px] md:text-sm text-muted mt-1 truncate">{s.label}</p>
              </div>
            </div>
          );
        })}
      </div>
      {lifetimeCount > 0 && (
        <p className="text-xs text-muted -mt-2 mb-4 px-1" data-vault-paid-once="">
          <span style={{ color: 'var(--color-secondary)', fontWeight: 600 }}>{paidOnce > 0 ? `${fmtMoney(paidOnce)} paid once` : 'Paid once'}</span>
          {' · '}{lifetimeCount} lifetime plan{lifetimeCount === 1 ? '' : 's'}, not counted in the totals above
        </p>
      )}
    </>
  ) : null;
  const renewalsSection = trackedCount > 0 && upcomingRenewals.length > 0 ? (
        <div className={`${NEBULA_GLASS_CLASS} p-4 sm:p-5 mb-4`} style={nebulaGlassStyle}>
          <NebulaGlassStripe />
          <button
            type="button"
            onClick={() => setRenewalExpanded((v) => !v)}
            className="w-full flex items-center gap-2 text-left"
          >
            <CalendarDaysIcon className="w-5 h-5 shrink-0" style={{ color: 'var(--color-primary)' }} />
            <h3 className="text-sm font-semibold text-default flex-1">
              Next {FORECAST_WINDOW_DAYS} days: {fmtMoney(forecastTotal)} across {upcomingRenewals.length} renewal{upcomingRenewals.length !== 1 ? 's' : ''}
            </h3>
            <ChevronDownIcon
              className="w-4 h-4 shrink-0 transition-transform"
              style={{ color: 'var(--color-text-muted)', transform: renewalExpanded ? 'rotate(180deg)' : undefined }}
            />
          </button>
          {renewalExpanded && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto mt-3 pt-3" style={{ borderTop: '1px solid var(--color-surface-border)' }}>
              {upcomingRenewals.map((r, i) => {
                const days = Math.max(0, Math.round((r.date.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
                return (
                  <div key={`${r.entryId}-${i}`} className="flex items-center justify-between text-xs py-1">
                    <span className="text-default truncate">{r.name}</span>
                    <span className="text-muted shrink-0 ml-2">
                      {days === 0 ? 'today' : `in ${days}d`} · {fmtMoney(r.amount)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
  ) : null;
  const entriesSection = (
  <div className={layoutMode === 'nebula' && !v2 ? `${NEBULA_GLASS_CLASS} p-5` : ''} style={layoutMode === 'nebula' && !v2 ? nebulaGlassStyle : undefined}>
  {layoutMode === 'nebula' && !v2 && <NebulaGlassStripe />}
    {/* Typing on a remote is not worth it, so a TV keeps the tabs alone. */}
    {!isTV && total > 0 && (
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="vault-search">
          <MagnifyingGlassIcon className="w-4 h-4 shrink-0" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the Vault" aria-label="Search the Vault" />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear the search" className="shrink-0">
              <XMarkIcon className="w-4 h-4" />
            </button>
          )}
        </label>
        {(needCount > 0 || needOnly) && (
          <button type="button" className={needOnly ? 'vault-need on' : 'vault-need'} aria-pressed={needOnly} onClick={() => setNeedOnly((on) => !on)}>
            Needs a look ({needCount})
          </button>
        )}
      </div>
    )}
    {!filtering && (
    <div className={v2 ? 'mb-2 flex items-center gap-3' : 'mb-5'}>
      <div className={v2 ? 'flex-1 min-w-0' : ''}>
        <FilterTabsResponsive fill options={filterOptions} activeKey={activeCategory} onChange={setActiveCategory} layoutId="vault-filter" enableDropTargets />
      </div>
    </div>
    )}

    {isLoading ? (
      <div className="text-center py-16" style={{ color: 'var(--color-text-muted)' }}>Loading vault...</div>
    ) : shownEntries.length === 0 && filtering ? (
      <p className="text-sm text-center py-10" style={{ color: 'var(--color-text-muted)' }}>
        {needOnly && !query.trim() ? 'Nothing needs a look.' : 'Nothing in the Vault matches that.'}
      </p>
    ) : shownEntries.length === 0 ? (
      // Straight on the panel, like the empty states on Invitations,
      // Addons and Groups - not a second bordered box inside it.
      activeCategory === 'note' ? (
        <EmptyState
          art="vault"
          title="No notes yet"
          line="Keep a recovery code, a PIN, a Wi-Fi password or anything else here. A note stays hidden until you press Reveal."
          action={<Button variant="primary" onClick={openAddModal}>Add a note</Button>}
        />
      ) : (
        <EmptyState
          art="vault"
          title="Nothing in the Vault yet"
          line="Keep debrid, metadata and indexer keys here. SlickSync checks them and warns you before one runs out."
          action={<Button variant="primary" onClick={openAddModal}>Add a key</Button>}
        />
      )
    ) : v2 ? (
      <>
        <VaultV2
          entries={shownEntries}
          usedBy={usedBy}
          onDuplicate={handleDuplicate}
          onRenewed={handleRenewed}
          labels={CATEGORY_LABELS}
          arrange={sectionArrange}
          entryArrange={entryArrange}
          view={viewMode === 'list' ? 'list' : 'grid'}
          testing={testingId}
          now={renderedAt}
          onOpen={openEditModal}
          onCopy={handleCopy}
          onTest={handleTest}
          revealed={revealed}
          revealStamp={revealStamp}
          onReveal={handleReveal}
          onSnooze={handleSnooze}
          onRotate={(entry) => {
            window.open(entry.dashboardUrl || undefined, '_blank', 'noopener,noreferrer');
            openEditModal(entry);
          }}
          onMoveToAddons={handleMoveToAddons}
          onDelete={handleDelete}
          onHistory={(entry) => setHistoryFor({ id: entry.id, name: entry.name })}
        />
        {/* History from a card's menu: beside that card, pointing at its menu button. */}
        <VaultHistoryPopup
          entryId={historyFor?.id ?? ''}
          name={historyFor?.name ?? ''}
          open={!!historyFor}
          anchor={() => {
            if (!historyFor) return null;
            const label = `${historyFor.name} options`;
            const el = Array.from(document.querySelectorAll<HTMLElement>('[aria-label]')).find((x) => x.getAttribute('aria-label') === label);
            return el?.getBoundingClientRect() ?? null;
          }}
          around={() => {
            if (!historyFor) return null;
            const label = `${historyFor.name} options`;
            const el = Array.from(document.querySelectorAll<HTMLElement>('[aria-label]')).find((x) => x.getAttribute('aria-label') === label);
            return el?.closest<HTMLElement>('[data-v2-item]') ?? null;
          }}
          onClose={() => setHistoryFor(null)}
        />
        <HiddenTray
          arrange={sectionArrange}
          labelOf={(key) => `${VAULT_SECTIONS.find((x) => x.key === key)?.label ?? 'Section'} (section)`}
          extra={entryArrangeOwn.hidden.map((id) => ({ id: `e:${id}`, label: allCostEntries.find((e) => e.id === id)?.name ?? 'An entry', show: () => entryArrangeOwn.show(id) }))}
          note="Hidden only here: entries keep working and keep their alerts. Tap one to bring it back."
        />
      </>
    ) : (
      <>
        {!filtering && (
        <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
          Drag the handle to reorder within a category, drop onto a category tab above to recategorize, or drop onto "Addons" in the sidebar to move it there.
        </p>
        )}
        <SortableContext items={shownEntries.map(e => e.id)} strategy={rectSortingStrategy}>
          <StaggerContainer className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {shownEntries.map((entry) => (
              <StaggerItem key={entry.id}>
                <SortableEntryCard
                  entry={entry}
                  renderEntryCard={renderEntryCard}
                  onTest={handleTest}
                  onEdit={openEditModal}
                  onDuplicate={handleDuplicate}
                  onMoveToAddons={handleMoveToAddons}
                  onDelete={handleDelete}
                  plain={filtering}
                />
              </StaggerItem>
            ))}
          </StaggerContainer>
        </SortableContext>
      </>
    )}
  </div>
  );

  return (
    <Wrapper>
      <Head><title>SlickSync - Vault</title></Head>
      {layoutMode !== 'nebula' && (
        <Header
          title="Vault"
          subtitle={isLoading ? 'Loading...' : `${total} ${total === 1 ? 'entry' : 'entries'}`}
          actions={
            <>
              {(v2 || classic) && <ArrangeButton arrange={v2 ? sectionArrange : classicArrange} />}
              {testAllButton}
              <Button variant="primary" leftIcon={<PlusIcon className="w-5 h-5" />} onClick={openAddModal}>
                Add Entry
              </Button>
            </>
          }
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'px-4 md:px-6 pb-6'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(120rem, 92vw)' } : undefined}>
      {layoutMode === 'nebula' && (
        <NebulaPageHeading
          title="Vault"
          subtitle={isLoading ? 'Loading...' : `${total} ${total === 1 ? 'entry' : 'entries'}`}
          actions={(() => {
            const btn = (
              <Button variant="primary" leftIcon={<PlusIcon className="w-5 h-5" />} onClick={openAddModal}>
                Add Entry
              </Button>
            );
            return isTV ? <div className="flex items-center gap-2 flex-wrap justify-end">{testAllButton && <TVFocusable onEnterPress={handleTestAll}>{testAllButton}</TVFocusable>}<TVFocusable onEnterPress={openAddModal}>{btn}</TVFocusable></div> : (v2 || classic) ? <div className="flex items-center gap-2 flex-wrap justify-end"><ArrangeButton arrange={v2 ? sectionArrange : classicArrange} />{testAllButton}{btn}</div> : btn;
          })()}
        />
      )}
      {classic ? (
        <>
          <ArrangeBar arrange={classicArrange} />
          {classicArrange.shown.map((id) => {
            const node = id === 'cost' ? costSection : id === 'renewals' ? renewalsSection : id === 'entries' ? entriesSection : null;
            // An empty section still has its place while arranging, as a dashed placeholder.
            if (!node && !classicArrange.arranging) return null;
            return (
              <ArrangePanel key={id} arrange={classicArrange} id={id} label={CLASSIC_SECTION_LABELS[id] ?? 'Section'} ownHeading={false}
                emptyNote={node ? undefined : `${CLASSIC_SECTION_LABELS[id] ?? 'Section'} · shows when there is something in it`}>{node}</ArrangePanel>
            );
          })}
          <HiddenTray arrange={classicArrange} labelOf={(key) => `${CLASSIC_SECTION_LABELS[key] ?? 'Section'} (section)`} />
        </>
      ) : (
        <>
          {costSection}
          {renewalsSection}
          {v2 && <ArrangeBar arrange={pageArrange} />}
          {entriesSection}
        </>
      )}
      </div>
      </div>

      {/* Add / edit: pick what it is, then only what that kind has (components/vault/VaultEntryForm). */}
      <Modal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} ariaLabel={editingEntry ? `Edit ${editingEntry.name}` : 'Add to the Vault'} size="lg">
        <VaultEntryForm
          key={formKey}
          editing={editingEntry}
          startWith={startWith}
          currency={currency}
          planOffer={planOffer}
          arrivedViaAlert={arrivedViaAlert}
          saving={isSaving}
          onCancel={() => setIsAddOpen(false)}
          onSubmit={handleSubmit}
          onRevealSecret={editingEntry ? revealForForm : undefined}
        />
      </Modal>
    </Wrapper>
  );
}

export default function VaultPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <VaultPageContent />
    </Suspense>
  );
}
