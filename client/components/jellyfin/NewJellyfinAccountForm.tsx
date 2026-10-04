'use client';

// The invite page's "make me an account" choice, for an invitation that makes
// Jellyfin accounts (server/utils/jellyfinInviteAccounts.js). The account is
// named after the username chosen above; only a password is asked for here.

import { useState } from 'react';
import { LockClosedIcon } from '@heroicons/react/24/outline';

export function NewJellyfinAccountForm({ server, username, onSubmit }: {
  server: string;
  username: string;
  /** Throws with a showable message when it didn't work. */
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password.length < 6) { setError('Use at least 6 characters'); return; }
    if (password !== confirm) { setError('The two passwords don’t match'); return; }
    setError(null);
    setBusy(true);
    try {
      await onSubmit(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t work');
    } finally {
      setBusy(false);
    }
  };

  const field = (value: string, set: (v: string) => void, placeholder: string, autoComplete: string) => (
    <div className="relative">
      <div className="absolute left-4 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-subtle)' }}>
        <LockClosedIcon className="w-5 h-5" />
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => { set(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={busy}
        className="slicksync-input w-full pl-12 pr-4 py-3.5 rounded-xl focus:outline-none"
        style={{ backgroundColor: 'var(--color-bg-subtle)', color: 'var(--color-text)', border: '1px solid var(--color-surface-border)' }}
      />
    </div>
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
        You’ll get an account on {server} called <strong style={{ color: 'var(--color-text)' }}>{username || 'your username'}</strong>. It works once you’re accepted.
      </p>
      {field(password, setPassword, 'Choose a password', 'new-password')}
      {field(confirm, setConfirm, 'Type it again', 'new-password')}
      {error && <p className="text-sm text-center" style={{ color: 'var(--color-error)' }}>{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={busy || !password || !confirm}
        className="w-full py-3.5 rounded-xl text-sm font-semibold text-white bg-primary disabled:opacity-50 transition-opacity"
      >
        {busy ? 'Making your account…' : 'Request access'}
      </button>
    </div>
  );
}
