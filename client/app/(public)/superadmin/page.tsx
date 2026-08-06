'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Button, Input, Badge, SlickSyncLogo, SelectionCheckbox, SelectAllCheckbox, ConfirmModal } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { XMarkIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

// An account counts as "abandoned" once it's been sitting empty (no users,
// groups, or addons set up) and untouched (never logged in past the initial
// registration) for a while - long enough that it's very unlikely someone's
// still mid-setup. Not "email" - that field isn't fetched at all anymore
// (see the server route's own comment on why).
const ABANDONED_AGE_MS = 24 * 60 * 60 * 1000;

interface SuperAdminAccount {
  id: string;
  uuid: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  disabled: boolean;
  userCount: number;
  groupCount: number;
  addonCount: number;
  // Row count across key account-scoped tables (users/groups/addons/
  // catalogs/watch sessions/vault entries) - a proxy for "how much data
  // does this account hold" for spotting heavy vs. empty accounts. Not a
  // byte-accurate size - public mode is one shared Postgres database, not
  // a file per account, so there's no real per-account disk size to report.
  resourceRowCount: number;
  // Self-service nickname the account holder set themselves in their own
  // Settings - read-only here, purely so accounts are easier to tell apart
  // than by raw UUID prefix. Superadmin never sets or edits this.
  displayName: string | null;
  // Set by the "Force logout" action - server/middleware/auth.js rejects
  // any token issued before this timestamp. Purely informational here.
  sessionsRevokedAt: string | null;
}

interface AuditLogEntry {
  id: string;
  action: 'disable' | 'enable' | 'delete' | 'revoke-sessions';
  targetAccountId: string;
  targetAccountUuid: string | null;
  bulk: boolean;
  createdAt: string;
}

type SortKey = 'createdAt' | 'lastLoginAt' | 'resourceRowCount';

function isAbandoned(a: SuperAdminAccount): boolean {
  if (a.lastLoginAt) return false;
  if (a.userCount > 0 || a.groupCount > 0 || a.addonCount > 0) return false;
  return Date.now() - new Date(a.createdAt).getTime() > ABANDONED_AGE_MS;
}

const NEW_ACCOUNT_AGE_MS = 48 * 60 * 60 * 1000;
function isRecentlyRegistered(a: SuperAdminAccount): boolean {
  return Date.now() - new Date(a.createdAt).getTime() < NEW_ACCOUNT_AGE_MS;
}

// Cumulative registrations by day, straight from each account's own
// createdAt - no new tracking/table needed, this is real data already on
// every row fetched for the list above it. Aggregate-only (a count per day),
// same privacy boundary as the rest of this page.
function buildGrowthSeries(accounts: SuperAdminAccount[], days: number): { date: string; count: number }[] {
  const now = new Date();
  const buckets: { date: string; day: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    buckets.push({ date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), day: d.getTime() });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  return buckets.map((b) => ({
    date: b.date,
    count: accounts.filter((a) => new Date(a.createdAt).getTime() < b.day + dayMs).length,
  }));
}

function GrowthSparkline({ series }: { series: { date: string; count: number }[] }) {
  if (series.length < 2) return null;
  const width = 100;
  const height = 32;
  const max = Math.max(...series.map((s) => s.count), 1);
  const min = Math.min(...series.map((s) => s.count));
  const range = Math.max(max - min, 1);
  const points = series.map((s, i) => {
    const x = (i / (series.length - 1)) * width;
    const y = height - ((s.count - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const last = series[series.length - 1];
  const first = series[0];
  const delta = last.count - first.count;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-24 h-8 overflow-visible" preserveAspectRatio="none">
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={width}
          cy={height - ((last.count - min) / range) * (height - 4) - 2}
          r="2.5"
          fill="var(--color-primary)"
        />
      </svg>
      <div>
        <p className="text-sm font-semibold text-default">{last.count} <span className="text-xs font-normal text-muted">total</span></p>
        <p className="text-xs text-subtle">{delta >= 0 ? '+' : ''}{delta} in {series.length}d</p>
      </div>
    </div>
  );
}

// Operator-only cross-account panel for public multi-tenant mode. Deliberately
// its own route with its own auth (a separate sfm_superadmin cookie, never an
// account login) - see server/routes/superadmin.js for the full reasoning.
// This page never requests or displays anything from inside a tenant's own
// data (their addons, Vault, watch history) - only whether the account
// exists, when it registered/last logged in, and coarse counts.
export default function SuperAdminPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [accounts, setAccounts] = useState<SuperAdminAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SuperAdminAccount | null>(null);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [loadingAuditLog, setLoadingAuditLog] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('createdAt');
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = !q
      ? accounts
      : accounts.filter((a) => (a.uuid || a.id).toLowerCase().includes(q) || (a.displayName || '').toLowerCase().includes(q));
    const sorted = [...base];
    if (sortBy === 'resourceRowCount') {
      sorted.sort((a, b) => b.resourceRowCount - a.resourceRowCount);
    } else if (sortBy === 'lastLoginAt') {
      // Never-logged-in accounts sort last, not first (as they would with a
      // naive null-as-epoch-0 comparison) - "most recently active" is the
      // useful ordering here, and "never" isn't recent.
      sorted.sort((a, b) => {
        if (!a.lastLoginAt && !b.lastLoginAt) return 0;
        if (!a.lastLoginAt) return 1;
        if (!b.lastLoginAt) return -1;
        return new Date(b.lastLoginAt).getTime() - new Date(a.lastLoginAt).getTime();
      });
    } else {
      sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return sorted;
  }, [accounts, search, sortBy]);

  const growthSeries = useMemo(() => buildGrowthSeries(accounts, 30), [accounts]);
  const recentCount = useMemo(() => accounts.filter(isRecentlyRegistered).length, [accounts]);

  // Health summary - counts over ALL accounts, not just the filtered view,
  // so it reads as a stable overview regardless of what's currently searched.
  const summary = useMemo(() => ({
    active: accounts.filter((a) => !a.disabled).length,
    disabled: accounts.filter((a) => a.disabled).length,
    neverLoggedIn: accounts.filter((a) => !a.lastLoginAt).length,
    abandoned: accounts.filter(isAbandoned).length,
  }), [accounts]);

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const res = await fetch(`${API_BASE}/superadmin/accounts`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load accounts');
      const data = await res.json();
      setAccounts(data.accounts || []);
    } catch {
      toast.error('Failed to load accounts');
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/superadmin/session`, { credentials: 'include' })
      .then((res) => {
        setSignedIn(res.ok);
        if (res.ok) loadAccounts();
      })
      .catch(() => setSignedIn(false));
  }, [loadAccounts]);

  // Lazy-loaded on first expand, not on page load - this is a secondary,
  // occasionally-checked view, no reason to pay for it on every visit.
  const loadAuditLog = useCallback(async () => {
    setLoadingAuditLog(true);
    try {
      const res = await fetch(`${API_BASE}/superadmin/audit-log`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load audit log');
      const data = await res.json();
      setAuditLog(data.entries || []);
    } catch {
      toast.error('Failed to load audit log');
    } finally {
      setLoadingAuditLog(false);
    }
  }, []);

  const toggleAuditLog = () => {
    const next = !showAuditLog;
    setShowAuditLog(next);
    if (next && auditLog.length === 0) loadAuditLog();
  };

  const handleLogin = async () => {
    if (!password.trim()) return;
    setSigningIn(true);
    try {
      const res = await fetch(`${API_BASE}/superadmin/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Login failed');
      }
      setSignedIn(true);
      setPassword('');
      loadAccounts();
    } catch (e: any) {
      toast.error(e.message || 'Login failed');
    } finally {
      setSigningIn(false);
    }
  };

  const handleLogout = async () => {
    await fetch(`${API_BASE}/superadmin/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
    setSignedIn(false);
    setAccounts([]);
  };

  const handleToggleDisabled = async (account: SuperAdminAccount, confirmed = false) => {
    setBusyId(account.id);
    try {
      const url = `${API_BASE}/superadmin/accounts/${account.id}/${account.disabled ? 'enable' : 'disable'}${confirmed ? '?confirm=true' : ''}`;
      const res = await fetch(url, { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data.requiresConfirmation) {
          if (window.confirm(data.message || 'This is the last enabled account. Disable it anyway?')) {
            return await handleToggleDisabled(account, true);
          }
          return;
        }
        throw new Error(data.message || 'Failed');
      }
      setAccounts((prev) => prev.map((a) => (a.id === account.id ? { ...a, disabled: !a.disabled } : a)));
      toast.success(account.disabled ? 'Account re-enabled' : 'Account disabled');
    } catch (e: any) {
      toast.error(e.message || 'Failed to update account');
    } finally {
      setBusyId(null);
    }
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAbandoned = () => {
    setSelectedIds(new Set(filteredAccounts.filter(isAbandoned).map((a) => a.id)));
  };

  const handleRevokeSessions = async (account: SuperAdminAccount) => {
    if (!window.confirm(`Force-logout everyone currently signed into ${account.displayName || account.uuid || account.id}? They'll need to log in again.`)) return;
    setRevokingId(account.id);
    try {
      const res = await fetch(`${API_BASE}/superadmin/accounts/${account.id}/revoke-sessions`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setAccounts((prev) => prev.map((a) => (a.id === account.id ? { ...a, sessionsRevokedAt: data.sessionsRevokedAt } : a)));
      toast.success('Active sessions revoked');
    } catch {
      toast.error('Failed to revoke sessions');
    } finally {
      setRevokingId(null);
    }
  };

  const handleBulkToggleDisabled = async (disable: boolean, confirmed = false) => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selectedIds);
      const url = `${API_BASE}/superadmin/accounts/bulk-${disable ? 'disable' : 'enable'}${confirmed ? '?confirm=true' : ''}`;
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data.requiresConfirmation) {
          if (window.confirm(data.message || 'This would disable every enabled account. Proceed anyway?')) {
            return await handleBulkToggleDisabled(disable, true);
          }
          return;
        }
        throw new Error(data.message || 'Failed');
      }
      setAccounts((prev) => prev.map((a) => (selectedIds.has(a.id) ? { ...a, disabled: disable } : a)));
      toast.success(`${ids.length} account${ids.length !== 1 ? 's' : ''} ${disable ? 'disabled' : 're-enabled'}`);
      setSelectedIds(new Set());
    } catch (e: any) {
      toast.error(e.message || 'Bulk update failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await fetch(`${API_BASE}/superadmin/accounts/bulk-delete`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setAccounts((prev) => prev.filter((a) => !selectedIds.has(a.id) || data.failed?.includes(a.id)));
      if (data.deleted > 0) toast.success(`${data.deleted} account${data.deleted !== 1 ? 's' : ''} deleted`);
      if (data.failed?.length > 0) toast.error(`${data.failed.length} account${data.failed.length !== 1 ? 's' : ''} failed to delete`);
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
    } catch {
      toast.error('Bulk delete failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setBusyId(confirmDelete.id);
    try {
      const res = await fetch(`${API_BASE}/superadmin/accounts/${confirmDelete.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed');
      setAccounts((prev) => prev.filter((a) => a.id !== confirmDelete.id));
      toast.success('Account deleted');
      setConfirmDelete(null);
    } catch {
      toast.error('Failed to delete account');
    } finally {
      setBusyId(null);
    }
  };

  if (signedIn === null) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-muted">Loading…</div>;
  }

  if (!signedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card padding="lg" className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-6">
            <SlickSyncLogo className="w-10 h-10 mb-3" />
            <h1 className="text-lg font-semibold text-default">Superadmin</h1>
            <p className="text-xs text-muted mt-1 text-center">Operator access only — not a tenant account login.</p>
          </div>
          <div className="space-y-3">
            <Input
              type="password"
              placeholder="Operator password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
              autoFocus
            />
            <Button variant="primary" className="w-full" onClick={handleLogin} isLoading={signingIn}>
              Sign in
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-default">Superadmin</h1>
            <p className="text-sm text-muted">{accounts.length} registered account{accounts.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={loadAccounts} isLoading={loadingAccounts}>Refresh</Button>
            <Button variant="ghost" size="sm" onClick={handleLogout}>Sign out</Button>
          </div>
        </div>

        {/* Health summary - counts only, same privacy boundary as everything
            else on this page (nothing from inside a tenant's own data). */}
        {accounts.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Card padding="md">
              <p className="text-xs text-muted mb-2">Growth (30d)</p>
              <GrowthSparkline series={growthSeries} />
            </Card>
            <Card padding="md">
              <p className="text-xs text-muted mb-1">Active</p>
              <p className="text-2xl font-semibold text-default">{summary.active}</p>
            </Card>
            <Card padding="md">
              <p className="text-xs text-muted mb-1">Disabled</p>
              <p className="text-2xl font-semibold text-default">{summary.disabled}</p>
            </Card>
            <Card padding="md">
              <p className="text-xs text-muted mb-1">New (48h)</p>
              <p className={`text-2xl font-semibold ${recentCount > 0 ? 'text-primary' : 'text-default'}`}>{recentCount}</p>
            </Card>
          </div>
        )}

        {accounts.length > 0 && (summary.neverLoggedIn > 0 || summary.abandoned > 0) && (
          <div className="flex items-center gap-4 flex-wrap mb-4 text-xs text-muted">
            <span><span className="text-default font-semibold">{summary.neverLoggedIn}</span> never logged in</span>
            {summary.abandoned > 0 && (
              <>
                <span>·</span>
                <span><span className="text-warning font-semibold">{summary.abandoned}</span> abandoned</span>
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 mb-3 flex-wrap">
          {accounts.length > 0 && (
            <SelectAllCheckbox
              totalCount={filteredAccounts.length}
              selectedCount={selectedIds.size}
              onSelectAll={() => setSelectedIds(new Set(filteredAccounts.map((a) => a.id)))}
              onDeselectAll={() => setSelectedIds(new Set())}
            />
          )}
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <MagnifyingGlassIcon className="w-4 h-4 text-subtle absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by UUID or label..."
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
            />
          </div>
          {search && (
            <span className="text-xs text-subtle">{filteredAccounts.length} of {accounts.length}</span>
          )}
          {summary.abandoned > 0 && (
            <Button variant="ghost" size="sm" onClick={selectAbandoned}>
              Select {summary.abandoned} abandoned
            </Button>
          )}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="py-2 px-3 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
          >
            <option value="createdAt">Newest first</option>
            <option value="lastLoginAt">Most recently active</option>
            <option value="resourceRowCount">Heaviest usage first</option>
          </select>
        </div>

        <Card padding="none">
          <div className="divide-y divide-default">
            {accounts.length === 0 && !loadingAccounts ? (
              <p className="text-sm text-muted p-6 text-center">No accounts registered yet.</p>
            ) : filteredAccounts.length === 0 ? (
              <p className="text-sm text-muted p-6 text-center">No accounts match &quot;{search}&quot;.</p>
            ) : (
              filteredAccounts.map((a) => (
                <div key={a.id} className={`flex items-center justify-between gap-4 p-4 transition-colors ${selectedIds.has(a.id) ? 'bg-primary-muted' : 'hover:bg-surface-hover'}`}>
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <SelectionCheckbox checked={selectedIds.has(a.id)} onChange={() => toggleSelect(a.id)} visible={selectedIds.has(a.id)} />
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-xs font-semibold ${a.disabled ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary'}`}>
                      {a.displayName ? a.displayName.slice(0, 2).toUpperCase() : (a.uuid || a.id).slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {a.displayName ? (
                          <>
                            <span className="text-sm font-semibold text-default truncate" title="Set by the account holder in their own Settings">{a.displayName}</span>
                            <span className="text-xs text-subtle font-mono truncate">{a.uuid || a.id}</span>
                          </>
                        ) : (
                          <span className="text-sm font-mono text-default truncate">{a.uuid || a.id}</span>
                        )}
                        {isRecentlyRegistered(a) && <Badge variant="primary" size="sm">New</Badge>}
                        {a.disabled && <Badge variant="warning" size="sm">Disabled</Badge>}
                        {isAbandoned(a) && <Badge variant="muted" size="sm" title="Registered a while ago, empty, never logged in">Abandoned</Badge>}
                      </div>
                      <p className="text-xs text-muted mt-0.5">
                        {a.userCount} user{a.userCount !== 1 ? 's' : ''} · {a.groupCount} group{a.groupCount !== 1 ? 's' : ''} · {a.addonCount} addon{a.addonCount !== 1 ? 's' : ''}
                        <span className="text-subtle" title="Row count across users/groups/addons/catalogs/watch sessions/vault entries - a usage proxy, not a byte-accurate size"> · {a.resourceRowCount} record{a.resourceRowCount !== 1 ? 's' : ''} total</span>
                      </p>
                      <p className="text-xs text-subtle mt-0.5">
                        Registered {new Date(a.createdAt).toLocaleDateString()} · Last login {a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : 'never'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevokeSessions(a)}
                      isLoading={revokingId === a.id}
                      title="Sign this account out everywhere - they'll need to log in again"
                    >
                      Force logout
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleToggleDisabled(a)}
                      isLoading={busyId === a.id}
                    >
                      {a.disabled ? 'Enable' : 'Disable'}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setConfirmDelete(a)}>
                      Delete
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Operator action trail - who got disabled/enabled/deleted and
            when. Collapsed by default and lazy-loaded, same reasoning as
            above. Never shows anything from inside a tenant's own data. */}
        <div className="mt-6">
          <button
            type="button"
            onClick={toggleAuditLog}
            className="text-sm font-medium text-muted hover:text-default transition-colors"
          >
            {showAuditLog ? '▾' : '▸'} Audit log
          </button>
          {showAuditLog && (
            <Card padding="none" className="mt-2">
              {loadingAuditLog ? (
                <p className="text-sm text-muted p-6 text-center">Loading...</p>
              ) : auditLog.length === 0 ? (
                <p className="text-sm text-muted p-6 text-center">No operator actions recorded yet.</p>
              ) : (
                <div className="divide-y divide-default">
                  {auditLog.map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-4 p-3 text-sm">
                      <div className="min-w-0">
                        <span className="font-mono text-default truncate">{e.targetAccountUuid || e.targetAccountId}</span>
                        <span className="text-muted"> — {e.action}</span>
                        {e.bulk && <Badge variant="muted" size="sm" className="ml-2">Bulk</Badge>}
                      </div>
                      <span className="text-xs text-subtle shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {/* Floating bulk-action bar - same pattern used across the rest of the
          app's own bulk-select flows. */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50">
          <div className="flex items-center gap-4 px-6 py-4 rounded-2xl shadow-2xl bg-surface border border-default backdrop-blur-xl">
            <div className="flex items-center gap-2 pr-4 border-r border-default">
              <div className="w-8 h-8 rounded-lg bg-primary-muted flex items-center justify-center">
                <span className="text-sm font-bold text-primary">{selectedIds.size}</span>
              </div>
              <span className="text-sm text-muted">selected</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleBulkToggleDisabled(true)} isLoading={bulkBusy}>
                Disable
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleBulkToggleDisabled(false)} isLoading={bulkBusy}>
                Enable
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirmBulkDelete(true)} isLoading={bulkBusy}>
                Delete
              </Button>
            </div>
            <button onClick={() => setSelectedIds(new Set())} className="p-2 rounded-lg text-muted hover:bg-surface-hover transition-colors">
              <XMarkIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <Card padding="lg" className="w-full max-w-sm">
            <h3 className="text-base font-semibold text-default mb-2">Delete this account?</h3>
            <p className="text-sm text-muted mb-4">
              Permanently deletes <span className="font-mono text-default">{confirmDelete.uuid || confirmDelete.id}</span> and everything in it — users, groups, addons, watch history, Vault entries. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={handleDelete} isLoading={busyId === confirmDelete.id}>Delete permanently</Button>
            </div>
          </Card>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={handleBulkDelete}
        title="Delete accounts"
        description={`Permanently delete ${selectedIds.size} account${selectedIds.size !== 1 ? 's' : ''} and everything in them — users, groups, addons, watch history, Vault entries. This cannot be undone.`}
        confirmText={bulkBusy ? 'Deleting...' : 'Delete permanently'}
        variant="danger"
        isLoading={bulkBusy}
      />
    </div>
  );
}
