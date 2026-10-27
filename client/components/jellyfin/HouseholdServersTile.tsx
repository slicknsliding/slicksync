'use client';

// A person's accounts on the Jellyfin servers given to their groups on the
// Addons page (server/utils/jellyfinHouseholdServers.js). Signing in on any
// Jellyfin app: Quick Connect there, then the code goes in here. Apps without
// Quick Connect use the account name and the password SlickSync made it with.
// Renders nothing for someone with no such server.

import { useEffect, useState } from 'react';
import { EyeIcon, EyeSlashIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { JellyfinLogo } from '@/components/jellyfin/JellyfinLogo';
import { api, type PersonHouseholdServer } from '@/lib/api';

const APPS = ['Odin', 'Swiftfin', 'Infuse', 'Findroid'];

function ServerRow({ personId, personName, server }: { personId: string; personName: string; server: PersonHouseholdServer }) {
  const [code, setCode] = useState('');
  const [approving, setApproving] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const from = server.groups.length ? ` · from the ${server.groups.join(', ')} group${server.groups.length > 1 ? 's' : ''}` : '';

  const approve = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setApproving(true);
    try {
      await api.approveHouseholdServerCode(server.id, personId, code);
      toast.success(`Approved - the app is signed in as ${server.userName}`);
      setCode('');
    } catch (err) {
      toast.error((err as Error)?.message || 'Could not approve the code');
    } finally {
      setApproving(false);
    }
  };

  const reveal = async () => {
    if (password !== null) { setPassword(null); return; }
    setRevealing(true);
    try {
      const r = await api.householdServerPassword(server.id, personId);
      setPassword(r.password);
    } catch (err) {
      toast.error((err as Error)?.message || 'Could not show the password');
    } finally {
      setRevealing(false);
    }
  };

  return (
    <div className="rounded-2xl border border-default p-4" style={{ background: 'color-mix(in srgb, var(--color-surface) 55%, transparent)' }}>
      <div className="flex items-center gap-3">
        <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#000b25', border: '1px solid rgba(120,130,220,.35)' }}>
          <JellyfinLogo size={24} />
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-default truncate">{server.name}</div>
          <div className="text-sm text-muted">
            {server.waiting
              ? <>Gets an account on the next sync{from}</>
              : <>{personName}&apos;s account: <b className="text-default">{server.userName}</b>{from}</>}
          </div>
        </div>
      </div>
      {!server.waiting && (
        <>
          <div className="flex flex-wrap gap-2 my-3">
            {APPS.map((a) => <span key={a} className="text-xs px-2.5 py-1 rounded-full bg-surface-hover text-default">{a}</span>)}
            <span className="text-xs px-2.5 py-1 rounded-full bg-surface-hover text-muted">and other Jellyfin apps</span>
          </div>
          <p className="text-sm text-muted">Signing in on a new app: choose Quick Connect there, then type the code it shows here.</p>
          <form onSubmit={approve} className="flex flex-wrap items-center gap-2 mt-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 12))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Code"
              aria-label={`Quick Connect code for ${server.name}`}
              className="flex-1 min-w-[140px] px-4 py-2.5 rounded-xl text-base font-bold tracking-[0.2em] bg-[var(--color-bg)] border border-default text-default placeholder:font-normal placeholder:tracking-normal placeholder:text-subtle"
            />
            <Button type="submit" variant="primary" isLoading={approving} disabled={code.replace(/\D/g, '').length < 4}>Approve</Button>
          </form>
          {server.hasPassword ? (
            <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-default text-sm text-muted">
              <span className="min-w-0">
                App without Quick Connect? Sign in with <b className="text-default">{server.userName}</b> and{' '}
                {password !== null ? <code className="px-1.5 py-0.5 rounded-md bg-surface-hover text-default select-all">{password}</code> : 'the password'}.
              </span>
              <span className="ml-auto flex gap-2">
                {password !== null && (
                  <Button variant="ghost" size="sm" leftIcon={<ClipboardDocumentIcon className="w-4 h-4" />} onClick={() => { navigator.clipboard?.writeText(password).then(() => toast.success('Copied'), () => {}); }}>
                    Copy
                  </Button>
                )}
                <Button variant="secondary" size="sm" isLoading={revealing} leftIcon={password !== null ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />} onClick={reveal}>
                  {password !== null ? 'Hide password' : 'Show password'}
                </Button>
              </span>
            </div>
          ) : (
            <p className="mt-3 pt-3 border-t border-default text-sm text-muted">
              App without Quick Connect? This account was already on the server, so it signs in with its own password.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function HouseholdServersTile({ userId, username }: { userId: string; username: string }) {
  const [servers, setServers] = useState<PersonHouseholdServer[] | null>(null);

  useEffect(() => {
    api.personHouseholdServers(userId).then((r) => setServers(r.servers || [])).catch(() => setServers(null));
  }, [userId]);

  if (!servers?.length) return null;

  return (
    <Card padding="lg">
      <h3 className="text-base font-semibold text-default mb-3">Their Jellyfin {servers.length > 1 ? 'servers' : 'server'}</h3>
      <div className="space-y-3">
        {servers.map((s) => <ServerRow key={s.id} personId={userId} personName={username} server={s} />)}
      </div>
    </Card>
  );
}
