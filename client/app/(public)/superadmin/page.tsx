'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, Button, Input, Badge, SlickSyncLogo } from '@/components/ui';
import { toast } from '@/components/ui/Toast';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

interface SuperAdminAccount {
  id: string;
  uuid: string | null;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  disabled: boolean;
  userCount: number;
  groupCount: number;
  addonCount: number;
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
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-default">Superadmin</h1>
            <p className="text-sm text-muted">{accounts.length} registered account{accounts.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={loadAccounts} isLoading={loadingAccounts}>Refresh</Button>
            <Button variant="ghost" size="sm" onClick={handleLogout}>Sign out</Button>
          </div>
        </div>

        <Card padding="none">
          <div className="divide-y divide-default">
            {accounts.length === 0 && !loadingAccounts ? (
              <p className="text-sm text-muted p-6 text-center">No accounts registered yet.</p>
            ) : (
              accounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-default truncate">{a.uuid || a.id}</span>
                      {a.disabled && <Badge variant="warning" size="sm">Disabled</Badge>}
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      {a.userCount} user{a.userCount !== 1 ? 's' : ''} · {a.groupCount} group{a.groupCount !== 1 ? 's' : ''} · {a.addonCount} addon{a.addonCount !== 1 ? 's' : ''}
                    </p>
                    <p className="text-xs text-subtle mt-0.5">
                      Registered {new Date(a.createdAt).toLocaleDateString()} · Last login {a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : 'never'}
                    </p>
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
      </div>

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
    </div>
  );
}
