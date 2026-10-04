'use client';

// Signing in to a Jellyfin-compatible server - a real Jellyfin, the media
// server an AIOStreams configuration runs, or AIOMetadata's. One flow for
// every place it is offered (Add User, the sign-in page, invitations): type
// the address, then either sign in as a user or approve a Quick Connect code.
//
// The parent supplies the calls, because each place reaches the server
// through its own API, and decides what a finished sign-in does. Nothing
// secret comes back to the browser: the server signs in when onSubmit is
// called with what the person typed.

import { useEffect, useRef, useState } from 'react';
import { ArrowPathIcon, CheckCircleIcon, EyeIcon, EyeSlashIcon, ServerStackIcon } from '@heroicons/react/24/outline';

export type JellyfinServerInfo = {
  serverUrl: string;
  serverName: string;
  kind: 'jellyfin' | 'aiostreams' | 'aiometadata';
  kindLabel: string;
  version?: string | null;
  users: { id: string; name: string; hasPassword?: boolean }[];
  quickConnect: boolean;
  pinSignIn?: boolean;
  display: string;
};

export type JellyfinCredentials =
  | { serverUrl: string; jellyfinUsername: string; password: string }
  | { serverUrl: string; quickConnectSecret: string; quickConnectDevice: string };

export type JellyfinSignInApi = {
  probe: (serverUrl: string) => Promise<JellyfinServerInfo>;
  startQuickConnect: (serverUrl: string) => Promise<{ code: string; secret: string; device: string; serverUrl: string }>;
  quickConnectStatus: (params: { serverUrl: string; secret: string; device: string }) => Promise<{ authenticated: boolean; expired?: boolean }>;
};

type Props = {
  api: JellyfinSignInApi;
  onSubmit: (credentials: JellyfinCredentials, server: JellyfinServerInfo) => Promise<void>;
  submitLabel?: string;
  // Lets the parent prefill and remember the address, e.g. "add another
  // person from the same server".
  initialServerUrl?: string;
  onServerChange?: (server: JellyfinServerInfo | null) => void;
  compact?: boolean;
};

const inputStyle = {
  background: 'var(--color-bg)',
  border: '1px solid var(--color-surface-border)',
  color: 'var(--color-text)',
} as const;

function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase();
}

export default function JellyfinSignIn({ api, onSubmit, submitLabel = 'Sign in', initialServerUrl = '', onServerChange, compact = false }: Props) {
  const [address, setAddress] = useState(initialServerUrl);
  const [server, setServer] = useState<JellyfinServerInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<'password' | 'quick'>('password');
  const [loginName, setLoginName] = useState('');
  const [typingName, setTypingName] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pinHint, setPinHint] = useState(false);
  const [quick, setQuick] = useState<{ code: string; secret: string; device: string; serverUrl: string } | null>(null);
  const [quickStatus, setQuickStatus] = useState<'idle' | 'starting' | 'waiting' | 'approved' | 'expired'>('idle');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // Started on a known server (the next person from the same household):
  // go straight to who is signing in.
  useEffect(() => {
    if (initialServerUrl) checkAddress(initialServerUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const checkAddress = async (value = address) => {
    if (!value.trim()) {
      setError('Enter the server address');
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const info = await api.probe(value.trim());
      setServer(info);
      setAddress(info.serverUrl);
      setTypingName(info.users.length === 0);
      setLoginName('');
      setMethod('password');
      onServerChange?.(info);
    } catch (e: any) {
      setError(e?.message || 'Could not reach the server');
    } finally {
      setChecking(false);
    }
  };

  const changeServer = () => {
    stopPolling();
    setServer(null);
    setQuick(null);
    setQuickStatus('idle');
    setError(null);
    onServerChange?.(null);
  };

  const submitPassword = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!server) return;
    if (!loginName.trim()) {
      setError('Pick or type the user to sign in as');
      return;
    }
    setSubmitting(true);
    setError(null);
    setPinHint(false);
    try {
      await onSubmit({ serverUrl: server.serverUrl, jellyfinUsername: loginName.trim(), password }, server);
    } catch (err: any) {
      setError(err?.message || 'Could not sign in');
      if (err?.pinNeeded || err?.data?.pinNeeded || /pin/i.test(err?.message || '')) setPinHint(true);
    } finally {
      setSubmitting(false);
    }
  };

  const startQuick = async () => {
    if (!server) return;
    stopPolling();
    setQuickStatus('starting');
    setError(null);
    try {
      const started = await api.startQuickConnect(server.serverUrl);
      setQuick(started);
      setQuickStatus('waiting');
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.quickConnectStatus({ serverUrl: started.serverUrl, secret: started.secret, device: started.device });
          if (status.expired) {
            stopPolling();
            setQuickStatus('expired');
            return;
          }
          if (!status.authenticated) return;
          stopPolling();
          setQuickStatus('approved');
          setSubmitting(true);
          try {
            await onSubmit({ serverUrl: started.serverUrl, quickConnectSecret: started.secret, quickConnectDevice: started.device }, server);
          } catch (err: any) {
            setError(err?.message || 'Could not sign in');
            setQuickStatus('expired');
          } finally {
            setSubmitting(false);
          }
        } catch {
          /* keep waiting; a blip is not a failure */
        }
      }, 3000);
    } catch (e: any) {
      setQuickStatus('idle');
      setError(e?.message || 'Could not start Quick Connect');
    }
  };

  const pickMethod = (next: 'password' | 'quick') => {
    setMethod(next);
    setError(null);
    if (next === 'quick' && quickStatus === 'idle') startQuick();
    if (next === 'password') stopPolling();
  };

  const isAio = server && server.kind !== 'jellyfin';

  return (
    <div className="space-y-4">
      {!server ? (
        <form
          onSubmit={(e) => { e.preventDefault(); checkAddress(); }}
          className="space-y-3"
        >
          <div>
            <label htmlFor="jellyfin-address" className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>
              Server address
            </label>
            <input
              id="jellyfin-address"
              type="text"
              inputMode="url"
              autoComplete="url"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="jellyfin.example.com"
              className="w-full px-4 py-3 rounded-xl text-sm"
              style={inputStyle}
            />
            <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
              The address you open Jellyfin at. For AIOStreams or AIOMetadata, the address shown under Jellyfin apps on its configure page.
            </p>
          </div>
          <button
            type="submit"
            disabled={checking}
            className="w-full py-3 rounded-xl font-medium flex items-center justify-center gap-2"
            style={{ background: 'var(--color-primary)', color: 'white', opacity: checking ? 0.6 : 1 }}
          >
            {checking ? <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> : null}
            {checking ? 'Checking…' : 'Continue'}
          </button>
        </form>
      ) : (
        <>
          {/* The server, as a tile */}
          <div className="flex items-center gap-3 p-3 rounded-2xl" style={{ background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)' }}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--color-subtle)' }}>
              <ServerStackIcon className="w-5 h-5" style={{ color: 'var(--color-primary)' }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold truncate" style={{ color: 'var(--color-text)' }}>{server.serverName}</span>
                <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full shrink-0" style={{ background: 'color-mix(in srgb, var(--color-primary) 18%, transparent)', color: 'var(--color-primary)' }}>
                  {server.kindLabel}
                </span>
              </div>
              <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{server.display}</p>
            </div>
            <button type="button" onClick={changeServer} className="text-xs font-medium px-2 py-1 rounded-lg" style={{ color: 'var(--color-text-muted)' }}>
              Change
            </button>
          </div>

          {/* How to sign in */}
          {server.quickConnect && (
            <div className="flex gap-2 p-1 rounded-lg bg-bg-subtle">
              <button
                type="button"
                onClick={() => pickMethod('password')}
                className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${method === 'password' ? 'bg-surface shadow-sm text-default' : 'text-muted hover:text-default'}`}
              >
                User and password
              </button>
              <button
                type="button"
                onClick={() => pickMethod('quick')}
                className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-all ${method === 'quick' ? 'bg-surface shadow-sm text-default' : 'text-muted hover:text-default'}`}
              >
                Quick Connect
              </button>
            </div>
          )}

          {method === 'password' ? (
            <form onSubmit={submitPassword} className="space-y-3">
              {!typingName && server.users.length > 0 ? (
                <div>
                  <span className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>Who is signing in?</span>
                  <div className={`grid gap-2 ${compact ? 'grid-cols-3' : 'grid-cols-3 sm:grid-cols-4'}`}>
                    {server.users.map((u) => {
                      const selected = loginName === u.name;
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => { setLoginName(u.name); setError(null); }}
                          className="flex flex-col items-center gap-1.5 p-2 rounded-xl transition-all"
                          style={{
                            background: selected ? 'color-mix(in srgb, var(--color-primary) 16%, transparent)' : 'var(--color-surface-hover)',
                            border: `1px solid ${selected ? 'var(--color-primary)' : 'var(--color-surface-border)'}`,
                          }}
                        >
                          <span className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold" style={{ background: 'var(--color-subtle)', color: 'var(--color-text)' }}>
                            {initials(u.name)}
                          </span>
                          <span className="text-xs font-medium truncate max-w-full" style={{ color: 'var(--color-text)' }}>{u.name}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button type="button" onClick={() => { setTypingName(true); setLoginName(''); }} className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
                    Someone not listed? Type their name
                  </button>
                </div>
              ) : (
                <div>
                  <label htmlFor="jellyfin-user" className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>
                    User name
                  </label>
                  <input
                    id="jellyfin-user"
                    type="text"
                    autoComplete="username"
                    value={loginName}
                    onChange={(e) => setLoginName(e.target.value)}
                    placeholder={isAio ? 'Configuration UUID, or UUID/name' : 'Their Jellyfin user name'}
                    className="w-full px-4 py-3 rounded-xl text-sm"
                    style={inputStyle}
                  />
                  {isAio && (
                    <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
                      On this address, sign in with the configuration UUID (or its alias). For someone else in the household, add a slash and their name: UUID/Sam.
                    </p>
                  )}
                  {server.users.length > 0 && (
                    <button type="button" onClick={() => setTypingName(false)} className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
                      Pick from the list instead
                    </button>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="jellyfin-password" className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>
                  Password
                </label>
                <div className="relative">
                  <input
                    id="jellyfin-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-4 pr-12 py-3 rounded-xl text-sm"
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1"
                    style={{ color: 'var(--color-text-muted)' }}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeSlashIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                  </button>
                </div>
                {(isAio || pinHint) && (
                  <p className="text-xs mt-2" style={{ color: pinHint ? 'var(--color-warning, #f59e0b)' : 'var(--color-text-muted)' }}>
                    {isAio ? 'The configuration password. ' : ''}A user with a PIN: add it after the password, like password/1234.
                  </p>
                )}
              </div>

              {error && <p className="text-sm" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</p>}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-3 rounded-xl font-medium flex items-center justify-center gap-2"
                style={{ background: 'var(--color-primary)', color: 'white', opacity: submitting ? 0.6 : 1 }}
              >
                {submitting ? <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> : null}
                {submitting ? 'Signing in…' : submitLabel}
              </button>
            </form>
          ) : (
            <div className="space-y-3 text-center">
              {quickStatus === 'starting' && (
                <div className="py-6 flex justify-center">
                  <span className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" style={{ color: 'var(--color-primary)' }} />
                </div>
              )}
              {(quickStatus === 'waiting' || quickStatus === 'approved') && quick && (
                <>
                  <div className="py-4 rounded-2xl" style={{ background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)' }}>
                    <div className="text-4xl font-bold tracking-[0.3em] font-mono" style={{ color: 'var(--color-text)' }}>{quick.code}</div>
                  </div>
                  <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                    {server.kind === 'jellyfin'
                      ? 'Approve this code in a Jellyfin app that is already signed in: Settings, then Quick Connect.'
                      : 'Approve this code on the configure page, under Jellyfin apps, then Quick Connect.'}
                  </p>
                  <div className="flex items-center justify-center gap-2 text-sm" style={{ color: quickStatus === 'approved' ? 'var(--color-success, #22c55e)' : 'var(--color-text-muted)' }}>
                    {quickStatus === 'approved'
                      ? <><CheckCircleIcon className="w-5 h-5" /> Approved, signing in…</>
                      : <><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Waiting for approval</>}
                  </div>
                </>
              )}
              {quickStatus === 'expired' && (
                <button type="button" onClick={startQuick} className="w-full py-3 rounded-xl font-medium flex items-center justify-center gap-2" style={{ background: 'var(--color-primary)', color: 'white' }}>
                  <ArrowPathIcon className="w-5 h-5" /> Get a new code
                </button>
              )}
              {error && <p className="text-sm" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</p>}
            </div>
          )}
        </>
      )}
      {!server && error && <p className="text-sm" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</p>}
    </div>
  );
}
