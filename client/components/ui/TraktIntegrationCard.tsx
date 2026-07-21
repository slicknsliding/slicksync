'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { PlayCircleIcon, CheckCircleIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import { api, TraktStatus } from '@/lib/api';
import { toast } from '@/components/ui/Toast';

// Trakt integration — connect a Trakt account and SlickSync will scrobble its
// own unified watch record (Nuvio + Stremio alike) to Trakt in the background.
// Auth is Trakt's device-code flow: the user pastes a Client ID/Secret from a
// one-time Trakt app registration, clicks Connect, and enters the shown code
// at trakt.tv/activate. All secrets/tokens stay server-side.

const POLL_MS = 5000;

export function TraktIntegrationCard() {
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [editingCreds, setEditingCreds] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.pollTraktConnect();
        setStatus(r.status);
        if (r.phase === 'authorized') {
          stopPolling();
          toast.success('Trakt connected');
        } else if (r.phase === 'expired' || r.phase === 'denied' || r.phase === 'none') {
          stopPolling();
          if (r.phase === 'expired') toast.error('The Trakt code expired — try connecting again');
          if (r.phase === 'denied') toast.error('Trakt authorization was denied');
        }
      } catch { /* keep polling; transient */ }
    }, POLL_MS);
  }, [stopPolling]);

  useEffect(() => {
    api.getTraktStatus()
      .then((s) => {
        setStatus(s);
        if (s.pending) startPolling(); // resume an in-flight device auth
      })
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const saveCreds = async () => {
    setSavingCreds(true);
    try {
      const s = await api.saveTraktCredentials(clientId.trim(), clientSecret.trim());
      setStatus(s);
      setEditingCreds(false);
      setClientId(''); setClientSecret('');
      toast.success('Trakt credentials saved');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save credentials');
    } finally {
      setSavingCreds(false);
    }
  };

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await api.connectTrakt();
      // Reflect the pending code immediately, then poll for the token.
      setStatus((prev) => prev ? { ...prev, pending: { userCode: r.userCode, verificationUrl: r.verificationUrl, expiresAt: r.expiresAt } } : prev);
      window.open(r.verificationUrl, '_blank', 'noopener');
      startPolling();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to start Trakt authorization');
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      stopPolling();
      const s = await api.disconnectTrakt();
      setStatus(s);
      toast.success('Trakt disconnected');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to disconnect');
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api.syncTraktNow();
      toast.success(r.synced > 0 ? `Scrobbled ${r.synced} item${r.synced !== 1 ? 's' : ''} to Trakt` : 'Trakt is already up to date');
      setStatus(await api.getTraktStatus());
    } catch (e: any) {
      toast.error(e?.message || 'Trakt sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const lastSyncLabel = status?.lastSyncAt
    ? new Date(status.lastSyncAt).toLocaleString()
    : 'not yet';

  return (
    <Card padding="lg">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-red-500/20">
          <PlayCircleIcon className="w-5 h-5 text-red-400" />
        </div>
        <div>
          <h3 className="text-base font-semibold font-display text-default">Trakt</h3>
          <p className="text-xs text-muted">Auto-scrobble everything you watch — Nuvio and Stremio — to your Trakt profile</p>
        </div>
        {status?.connected && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-success">
            <CheckCircleIcon className="w-4 h-4" /> Connected
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : status?.connected ? (
        // ---- Connected state ------------------------------------------------
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <div>
              <span className="text-muted">Account: </span>
              <span className="text-default font-medium">{status.username || 'connected'}</span>
            </div>
            <div>
              <span className="text-muted">Last scrobble sweep: </span>
              <span className="text-default">{lastSyncLabel}</span>
            </div>
          </div>
          <p className="text-xs text-muted">
            New watches sync automatically every few minutes. Only watches from when you connected onward are sent — your existing Trakt history is left untouched.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={syncNow} isLoading={syncing} leftIcon={!syncing ? <ArrowPathIcon className="w-4 h-4" /> : undefined}>
              Sync now
            </Button>
            <Button variant="ghost" size="sm" onClick={disconnect}>Disconnect</Button>
          </div>
        </div>
      ) : status?.pending ? (
        // ---- Awaiting device authorization ---------------------------------
        <div className="space-y-3">
          <p className="text-sm text-default">Enter this code at <span className="font-medium">{status.pending.verificationUrl.replace(/^https?:\/\//, '')}</span>:</p>
          <div className="inline-flex items-center gap-3">
            <code className="px-4 py-2 rounded-lg bg-surface-hover text-lg font-mono font-bold tracking-widest text-default select-all">
              {status.pending.userCode}
            </code>
            <a href={status.pending.verificationUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="secondary" size="sm">Open Trakt</Button>
            </a>
          </div>
          <p className="text-xs text-muted inline-flex items-center gap-1">
            <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" /> Waiting for you to authorize…
          </p>
        </div>
      ) : status?.configured && !editingCreds ? (
        // ---- Credentials saved, ready to connect ---------------------------
        <div className="space-y-3">
          <p className="text-sm text-muted">Your Trakt app is set up. Connect your account to start scrobbling.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={connect} isLoading={connecting}>Connect Trakt account</Button>
            <Button variant="ghost" size="sm" onClick={() => setEditingCreds(true)}>Change app credentials</Button>
          </div>
        </div>
      ) : (
        // ---- First-time credential entry -----------------------------------
        <div className="space-y-4">
          <div className="text-xs text-muted space-y-1">
            <p>
              Create a free Trakt API app at{' '}
              <a href="https://trakt.tv/oauth/applications/new" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">trakt.tv/oauth/applications</a>,
              then paste its Client ID and Secret here.
            </p>
            <p>For the app&apos;s <span className="font-medium">Redirect URI</span> field, enter <code className="px-1 rounded bg-surface-hover">urn:ietf:wg:oauth:2.0:oob</code>.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-default mb-2">Client ID</label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Trakt application Client ID"
              className="input-base w-full px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-default mb-2">Client Secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Trakt application Client Secret"
              className="input-base w-full px-3 py-2 text-sm font-mono"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={saveCreds} isLoading={savingCreds} disabled={!clientId.trim() || !clientSecret.trim()}>
              Save credentials
            </Button>
            {editingCreds && (
              <Button variant="ghost" size="sm" onClick={() => { setEditingCreds(false); setClientId(''); setClientSecret(''); }}>Cancel</Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
