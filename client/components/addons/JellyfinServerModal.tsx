'use client';

// Adding a Jellyfin server on the Addons page, and changing one later. The
// server is given to groups like an addon: when a group syncs, everyone in it
// gets their own account on it (server/utils/jellyfinHouseholdServers.js).
// SlickSync needs an administrator's say-so to make accounts - Quick Connect,
// an API key from the server's dashboard, or a username (password optional,
// as a Jellyfin account may have none).

import { useEffect, useRef, useState } from 'react';
import { ArrowPathIcon, CheckCircleIcon, EyeIcon, EyeSlashIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Modal, Button, ConfirmModal } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { JellyfinLogo } from '@/components/jellyfin/JellyfinLogo';
import { api, type HouseholdServer, type HouseholdServerChange } from '@/lib/api';

type Method = 'quickconnect' | 'apikey' | 'username';
type Group = { id: string; name: string; color?: string; description?: string };

const field = 'w-full px-4 py-3 rounded-xl text-sm bg-[var(--color-bg)] border border-default text-default placeholder:text-subtle';
const label = 'block text-sm font-medium mb-2 text-default';
const hint = 'text-xs mt-2 text-muted';

/** "Made an account for Sarah · linked Gary" - what a sync did, in a sentence. */
export function describeChanges(changes: HouseholdServerChange[]) {
  const names = (action: HouseholdServerChange['action']) => changes.filter((c) => c.action === action).map((c) => c.name);
  const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const parts: string[] = [];
  const made = names('made');
  const linked = names('linked');
  const on = names('on');
  const off = names('off');
  if (made.length) parts.push(`made an account for ${list(made)}`);
  if (linked.length) parts.push(`linked ${list(linked)}'s own account${linked.length > 1 ? 's' : ''}`);
  if (on.length) parts.push(`switched ${list(on)} back on`);
  if (off.length) parts.push(`switched ${list(off)} off`);
  const text = parts.join(' · ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function GroupPicker({ groups, selected, onChange }: { groups: Group[]; selected: Set<string>; onChange: (next: Set<string>) => void }) {
  if (!groups.length) {
    return <p className="text-sm text-muted">No groups yet - make one on the Groups page, then give the server to it here.</p>;
  }
  return (
    <div className="space-y-2 max-h-48 overflow-y-auto p-1">
      {groups.map((group) => {
        const on = selected.has(group.id);
        return (
          <button
            key={group.id}
            type="button"
            onClick={() => {
              const next = new Set(selected);
              if (on) next.delete(group.id); else next.add(group.id);
              onChange(next);
            }}
            className={`w-full flex items-center gap-3 p-3 rounded-xl text-left border transition-colors ${on ? 'sync-chip-on' : 'sync-chip-off'}`}
          >
            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: group.color || 'var(--color-primary)' }} />
            <span className="flex-1 min-w-0 font-medium truncate text-default">{group.name}</span>
            <span className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center ${on ? 'bg-primary border-primary' : 'border-default'}`}>
              {on && <span className="w-2 h-2 rounded-full bg-white" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function JellyfinServerModal({ isOpen, onClose, groups, server, onSaved }: {
  isOpen: boolean;
  onClose: () => void;
  groups: Group[];
  /** Changing one already added; adding a new one without. */
  server?: HouseholdServer | null;
  onSaved: () => void;
}) {
  const editing = !!server;
  const [address, setAddress] = useState('');
  const [checked, setChecked] = useState<{ serverUrl: string; display: string; quickConnect: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState('');
  const [method, setMethod] = useState<Method>('username');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [quick, setQuick] = useState<{ code: string; secret: string; device: string; serverUrl: string } | null>(null);
  const [quickState, setQuickState] = useState<'idle' | 'starting' | 'waiting' | 'approved' | 'expired'>('idle');
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => { if (poll.current) clearInterval(poll.current); poll.current = null; };

  useEffect(() => {
    if (!isOpen) { stopPoll(); return; }
    setAddress(''); setChecked(null); setName(server?.name || ''); setMethod('username'); setUsername(''); setPassword('');
    setShowPassword(false); setApiKey(''); setSelected(new Set(server?.groupIds || [])); setError(null);
    setQuick(null); setQuickState('idle'); setSaving(false); setSyncing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, server?.id]);
  useEffect(() => () => stopPoll(), []);

  const check = async () => {
    const value = address.trim();
    if (!value) { setError('Enter the server address'); return null; }
    if (checked && (value === checked.serverUrl || value === checked.display)) return checked;
    setChecking(true);
    setError(null);
    try {
      const info = await api.checkHouseholdServer(value);
      if (info.kind !== 'jellyfin') throw new Error(`That's ${info.kindLabel}, which can't make accounts for people - add a Jellyfin server here`);
      const next = { serverUrl: info.serverUrl, display: info.display, quickConnect: info.quickConnect };
      setChecked(next);
      setAddress(info.serverUrl);
      if (!name.trim()) setName(info.suggestedName || info.display);
      return next;
    } catch (e) {
      setChecked(null);
      setError((e as Error)?.message || 'Could not reach the server');
      return null;
    } finally {
      setChecking(false);
    }
  };

  const finish = async (body: Parameters<typeof api.addHouseholdServer>[0]) => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.addHouseholdServer(body);
      const said = describeChanges(result.changes || []);
      toast.success(said ? `${result.name} added · ${said}` : `${result.name} added`);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error)?.message || 'Could not add the server');
      if (method === 'quickconnect') setQuickState('expired');
    } finally {
      setSaving(false);
    }
  };

  const startQuick = async () => {
    const at = await check();
    if (!at) return;
    if (!at.quickConnect) { setError('Quick Connect is turned off on this server - use an API key or a username'); return; }
    stopPoll();
    setQuickState('starting');
    setError(null);
    try {
      const started = await api.householdServerQuickConnect(at.serverUrl);
      setQuick(started);
      setQuickState('waiting');
      poll.current = setInterval(async () => {
        try {
          const status = await api.householdServerQuickConnectStatus({ serverUrl: started.serverUrl, secret: started.secret, device: started.device });
          if (status.expired) { stopPoll(); setQuickState('expired'); return; }
          if (!status.authenticated) return;
          stopPoll();
          setQuickState('approved');
          await finish({ serverUrl: started.serverUrl, name: name.trim(), groupIds: [...selected], method: 'quickconnect', secret: started.secret, device: started.device });
        } catch { /* a blip isn't a failure; keep waiting */ }
      }, 3000);
    } catch (e) {
      setQuickState('idle');
      setError((e as Error)?.message || 'Could not start Quick Connect');
    }
  };

  const pick = (next: Method) => {
    setMethod(next);
    setError(null);
    if (next !== 'quickconnect') { stopPoll(); setQuick(null); setQuickState('idle'); }
  };

  const submit = async () => {
    if (editing && server) {
      setSaving(true);
      setError(null);
      try {
        await api.updateHouseholdServer(server.id, { name: name.trim(), groupIds: [...selected] });
        toast.success('Saved - sync a group to give its people their accounts');
        onSaved();
        onClose();
      } catch (e) {
        setError((e as Error)?.message || 'Could not save');
      } finally {
        setSaving(false);
      }
      return;
    }
    if (method === 'quickconnect') { startQuick(); return; }
    const at = await check();
    if (!at) return;
    if (method === 'apikey' && !apiKey.trim()) { setError('Paste the API key'); return; }
    if (method === 'username' && !username.trim()) { setError('Enter the administrator’s username'); return; }
    await finish({
      serverUrl: at.serverUrl, name: name.trim(), groupIds: [...selected], method,
      ...(method === 'apikey' ? { apiKey: apiKey.trim() } : { username: username.trim(), password }),
    });
  };

  const syncNow = async () => {
    if (!server) return;
    setSyncing(true);
    try {
      const { changes } = await api.syncHouseholdServer(server.id);
      const failed = changes.filter((c) => c.action === 'failed');
      const said = describeChanges(changes);
      if (failed.length) toast.error(failed[0].detail ? `${failed[0].name}: ${failed[0].detail}` : `Couldn't finish for ${failed.map((f) => f.name).join(', ')}`);
      else toast.success(said || 'Everyone already has their account');
      onSaved();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not sync');
    } finally {
      setSyncing(false);
    }
  };

  const remove = async () => {
    if (!server) return;
    try {
      await api.removeHouseholdServer(server.id);
      toast.success(`${server.name} removed`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not remove it');
    }
  };

  const seg = (m: Method, text: string) => (
    <button
      type="button"
      onClick={() => pick(m)}
      className={`flex-1 min-w-0 py-2 px-1 rounded-xl text-[13px] font-medium whitespace-nowrap border transition-colors ${method === m ? 'sync-chip-on text-default' : 'sync-chip-off text-muted'}`}
    >
      {text}
    </button>
  );

  return (
    <>
      <Modal isOpen={isOpen} onClose={() => { stopPoll(); onClose(); }} size="md">
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-bold text-default flex items-center gap-2.5">
              <JellyfinLogo size={24} /> {editing ? server?.name : 'Add a Jellyfin server'}
            </h2>
            <p className="text-sm text-muted mt-1">
              {editing
                ? `${server?.address} · everyone in the groups it's given to gets their own account on it, for any Jellyfin app.`
                : 'Everyone in the groups you give it to gets their own account on it, for any Jellyfin app.'}
            </p>
          </div>

          {!editing && (
            <div>
              <label htmlFor="jf-server-address" className={label}>Server address</label>
              <input
                id="jf-server-address"
                type="text"
                inputMode="url"
                autoComplete="url"
                value={address}
                onChange={(e) => { setAddress(e.target.value); setChecked(null); }}
                onBlur={() => { if (address.trim() && !checked) check(); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } }}
                placeholder="jellyfin.example.com"
                className={field}
              />
              {checking && <p className={hint}>Checking…</p>}
              {checked && !checking && <p className="text-xs mt-2 flex items-center gap-1 quick-approved"><CheckCircleIcon className="w-4 h-4" /> Found it</p>}
            </div>
          )}

          <div>
            <label htmlFor="jf-server-name" className={label}>Display name</label>
            <input id="jf-server-name" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Home Jellyfin" className={field} />
            <p className={hint}>What people see in SlickSync.{editing ? '' : ' Filled in from the server’s own name.'}</p>
          </div>

          {!editing && (
            <div>
              <span className={label}>Connect as an administrator</span>
              <div className="flex gap-1.5">
                {seg('quickconnect', 'Quick Connect')}
                {seg('apikey', 'API key')}
                {seg('username', 'Username')}
              </div>
              {method === 'username' && (
                <div className="space-y-3 mt-3">
                  <div>
                    <label htmlFor="jf-admin-user" className={label}>Username</label>
                    <input id="jf-admin-user" type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
                  </div>
                  <div>
                    <label htmlFor="jf-admin-pw" className={label}>Password <span className="font-normal text-muted">(optional)</span></label>
                    <div className="relative">
                      <input
                        id="jf-admin-pw"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="off"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Empty if it has none"
                        className={`${field} pr-12`}
                      />
                      <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-muted" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                        {showPassword ? <EyeSlashIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {method === 'apikey' && (
                <div className="mt-3">
                  <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key" className={field} aria-label="API key" />
                  <p className={hint}>Dashboard → API Keys on the server, then + to make one.</p>
                </div>
              )}
              {method === 'quickconnect' && (
                <div className="mt-3 text-center space-y-2">
                  {quickState === 'idle' && <p className="text-sm text-muted text-left">You&apos;ll get a code to approve in a Jellyfin app signed in as an administrator.</p>}
                  {quickState === 'starting' && <div className="py-4 flex justify-center"><span className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin text-primary" /></div>}
                  {(quickState === 'waiting' || quickState === 'approved') && quick && (
                    <>
                      <div className="py-3 rounded-2xl bg-surface-hover border border-default">
                        <div className="text-3xl font-bold tracking-[0.3em] font-mono text-default">{quick.code}</div>
                      </div>
                      <p className="text-sm text-muted">In a Jellyfin app signed in as an administrator: Settings, then Quick Connect.</p>
                      <div className={`flex items-center justify-center gap-2 text-sm ${quickState === 'approved' ? 'quick-approved' : 'text-muted'}`}>
                        {quickState === 'approved'
                          ? <><CheckCircleIcon className="w-5 h-5" /> Approved, adding…</>
                          : <><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Waiting for approval</>}
                      </div>
                    </>
                  )}
                  {quickState === 'expired' && (
                    <Button variant="secondary" leftIcon={<ArrowPathIcon className="w-4 h-4" />} onClick={startQuick}>Get a new code</Button>
                  )}
                </div>
              )}
              <p className={hint}>Jellyfin only lets administrators make accounts, so SlickSync makes each person&apos;s with this.</p>
            </div>
          )}

          <div>
            <span className={label}>Give it to groups</span>
            <GroupPicker groups={groups} selected={selected} onChange={setSelected} />
          </div>

          {error && <p className="text-sm text-error">{error}</p>}

          {editing && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="secondary" size="sm" leftIcon={<ArrowPathIcon className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />} onClick={syncNow} isLoading={syncing}>
                Sync now
              </Button>
              <Button variant="ghost" size="sm" leftIcon={<TrashIcon className="w-4 h-4" />} onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <Button variant="secondary" className="flex-1" onClick={() => { stopPoll(); onClose(); }}>Cancel</Button>
            <Button
              variant="primary"
              className="flex-1"
              onClick={submit}
              isLoading={saving}
              disabled={checking || (!editing && method === 'quickconnect' && (quickState === 'waiting' || quickState === 'starting' || quickState === 'approved'))}
            >
              {editing ? 'Save' : method === 'quickconnect' && quickState === 'idle' ? 'Get a code' : 'Add server'}
            </Button>
          </div>
        </div>
      </Modal>
      <ConfirmModal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => { setConfirmRemove(false); remove(); }}
        title={`Remove ${server?.name || 'this server'}?`}
        description="SlickSync stops managing it. The accounts on the server stay as they are - nobody is signed out of their apps - but SlickSync stops tracking what's watched through them."
        confirmText="Remove"
        variant="danger"
      />
    </>
  );
}
