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
}

interface AuditLogEntry {
  id: string;
  action: 'disable' | 'enable' | 'delete';
  targetAccountId: string;
  targetAccountUuid: string | null;
  bulk: boolean;
  createdAt: string;
}

function isAbandoned(a: SuperAdminAccount): boolean {
  if (a.lastLoginAt) return false;
  if (a.userCount > 0 || a.groupCount > 0 || a.addonCount > 0) return false;
  return Date.now() - new Date(a.createdAt).getTime() > ABANDONED_AGE_MS;
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

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => (a.uuid || a.id).toLowerCase().includes(q));
  }, [accounts, search]);

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
          <div className="flex items-center gap-4 flex-wrap mb-4 text-xs text-muted">
            <span><span className="text-default font-semibold">{summary.active}</span> active</span>
            <span>·</span>
            <span><span className="text-default font-semibold">{summary.disabled}</span> disabled</span>
            <span>·</span>
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
              placeholder="Search by UUID..."
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
            />
          </div>
          {search && (
            <span className="text-xs text-subtle">{filteredAccounts.length} of {accounts.length}</span>
          )}
        </div>

        <Card padding="none">
          <div className="divide-y divide-default">
            {accounts.length === 0 && !loadingAccounts ? (
              <p className="text-sm text-muted p-6 text-center">No accounts registered yet.</p>
            ) : filteredAccounts.length === 0 ? (
              <p className="text-sm text-muted p-6 text-center">No accounts match &quot;{search}&quot;.</p>
            ) : (
              filteredAccounts.map((a) => (
                <div key={a.id} className={`flex items-center justify-between gap-4 p-4 ${selectedIds.has(a.id) ? 'bg-primary-muted' : ''}`}>
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <SelectionCheckbox checked={selectedIds.has(a.id)} onChange={() => toggleSelect(a.id)} visible={selectedIds.has(a.id)} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-mono text-default truncate">{a.uuid || a.id}</span>
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
