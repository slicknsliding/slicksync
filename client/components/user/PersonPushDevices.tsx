'use client';

// "Your devices", under the notifications switch on a person's Settings page:
// every device that gets their alerts, as tiles, so each can be given a name
// ("Kitchen tablet") or removed. Folded away until opened. Rename turns the
// tile itself into the name box (no popup); the bin removes it after asking.
// Their own devices only, whichever sign-in they have - notifications belong to
// the person, not to Stremio, Nuvio, Jellyfin or AIOStreams.

import { useEffect, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, ComputerDesktopIcon, DevicePhoneMobileIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Button, ConfirmModal, Input } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { formatRelativeTime } from '@/lib/relativeTime';
import { userPush, type PersonPushDevice } from '@/lib/user-api';

// A friendly guess from the browser's own description, for a device that has
// never been named.
function guessDeviceName(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  const browser = /Firefox/.test(ua) ? 'Firefox'
    : /Edg\//.test(ua) ? 'Edge'
    : /Chrome|CriOS/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari'
    : 'Browser';
  if (/iPhone|iPod/.test(ua)) return `iPhone - ${browser}`;
  if (/iPad/.test(ua)) return `iPad - ${browser}`;
  if (/Android/.test(ua)) return `Android - ${browser}`;
  if (/Macintosh/.test(ua)) return `Mac - ${browser}`;
  if (/Windows/.test(ua)) return `Windows - ${browser}`;
  if (/Linux/.test(ua)) return `Linux - ${browser}`;
  return browser;
}
const isPhone = (ua: string | null) => !!ua && /iPhone|iPad|iPod|Android/.test(ua);
const nameOf = (d: PersonPushDevice) => d.label || guessDeviceName(d.userAgent);

function seenLine(d: PersonPushDevice): string {
  const seen = formatRelativeTime(d.lastSeenAt);
  if (seen) return `Last seen ${seen.charAt(0).toLowerCase()}${seen.slice(1)}`;
  return `Added ${new Date(d.createdAt).toLocaleDateString()}`;
}

export function PersonPushDevices({ userId, authKey, refreshKey, onRemoved }: {
  userId: string | null;
  authKey: string | null;
  /** Changes when this device turns notifications on or off, so the list is read again. */
  refreshKey: unknown;
  /** A device was removed: the switch above asks the server again, in case it was this one. */
  onRemoved: () => void;
}) {
  const [devices, setDevices] = useState<PersonPushDevice[] | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PersonPushDevice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId || !authKey) return;
    let stale = false;
    (async () => {
      try {
        let endpoint: string | undefined;
        try {
          // Time-boxed: Safari can leave this lookup pending, and the list
          // must still show (it is where you remove your other devices).
          const lookup = (async () => {
            const reg = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
            return (await reg?.pushManager?.getSubscription())?.endpoint;
          })();
          endpoint = await Promise.race([lookup, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000))]);
        } catch { /* this browser has no registration to mark */ }
        const r = await userPush.devices(userId, authKey, endpoint);
        if (!stale) setDevices(r.devices);
      } catch {
        if (!stale) setDevices((cur) => cur ?? []);
      }
    })();
    return () => { stale = true; };
  }, [userId, authKey, refreshKey]);

  const remove = async () => {
    if (!removing || !userId || !authKey) return;
    setBusy(true);
    try {
      await userPush.removeDevice(userId, authKey, removing.id);
      setDevices((cur) => (cur || []).filter((d) => d.id !== removing.id));
      toast.success(removing.current ? `Removed ${nameOf(removing)}. Notifications are off on this device.` : `Removed ${nameOf(removing)}`);
      setRemoving(null);
      onRemoved();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not remove that device');
    } finally {
      setBusy(false);
    }
  };

  // Nothing registered: nothing to manage.
  if (!devices || devices.length === 0) return null;

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setEditing(null); }}
        aria-expanded={open}
        aria-controls="person-devices"
        className="w-full flex items-center gap-3 px-4 py-3.5 rounded-lg text-left"
        style={{ background: 'var(--color-surface-elevated)' }}
      >
        <span className="font-medium" style={{ color: 'var(--color-text)' }}>Your devices</span>
        <span className="min-w-[22px] h-[22px] px-1.5 rounded-full flex items-center justify-center text-xs border border-default" style={{ color: 'var(--color-text-muted)' }}>{devices.length}</span>
        <span className="flex-1" />
        {open ? <ChevronDownIcon className="w-5 h-5 text-muted" /> : <ChevronRightIcon className="w-5 h-5 text-muted" />}
      </button>

      {open && (
        <ul id="person-devices" className="mt-2 space-y-2">
          {devices.map((d) => (
            <li key={d.id}>
              {editing === d.id && userId && authKey ? (
                <RenameTile
                  device={d}
                  userId={userId}
                  authKey={authKey}
                  onDone={(label) => {
                    if (label !== undefined) setDevices((cur) => (cur || []).map((x) => (x.id === d.id ? { ...x, label } : x)));
                    setEditing(null);
                  }}
                />
              ) : (
                <DeviceTile device={d} onRename={() => setEditing(d.id)} onRemove={() => setRemoving(d)} />
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal
        isOpen={!!removing}
        onClose={() => { if (!busy) setRemoving(null); }}
        onConfirm={remove}
        title={removing ? `Remove ${nameOf(removing)}?` : ''}
        description={removing?.current
          ? 'This is the device you are using. It stops getting your alerts and its switch turns off. You can turn it on again any time.'
          : 'It stops getting your alerts. Turning notifications on from that device adds it again.'}
        confirmText="Remove"
        variant="danger"
        isLoading={busy}
      />
    </div>
  );
}

function DeviceTile({ device, onRename, onRemove }: { device: PersonPushDevice; onRename: () => void; onRemove: () => void }) {
  const Icon = isPhone(device.userAgent) ? DevicePhoneMobileIcon : ComputerDesktopIcon;
  return (
    <div
      className={`w-full flex items-center gap-3 p-3 rounded-xl border ${device.current ? 'border-[var(--color-primary)]' : 'border-default'}`}
      style={{ background: 'var(--color-surface-elevated)' }}
    >
      <span className="hidden sm:flex w-10 h-10 shrink-0 rounded-lg items-center justify-center" style={{ background: 'var(--color-surface)' }}>
        <Icon className="w-5 h-5 text-muted" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>{nameOf(device)}</span>
        <span className="block text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
          {device.current && <span className="font-medium" style={{ color: 'var(--color-primary)' }}>This device · </span>}
          {seenLine(device)}
        </span>
      </span>
      <button
        type="button"
        onClick={onRename}
        className="shrink-0 inline-flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full border border-default text-sm font-medium hover:bg-surface-hover transition-colors"
        style={{ color: 'var(--color-text)' }}
      >
        <PencilIcon className="w-4 h-4" />
        Rename
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${nameOf(device)}`}
        title="Remove"
        className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full border border-default hover:bg-surface-hover transition-colors"
        style={{ color: 'var(--color-error)' }}
      >
        <TrashIcon className="w-4 h-4" />
      </button>
    </div>
  );
}

function RenameTile({ device, userId, authKey, onDone }: {
  device: PersonPushDevice;
  userId: string;
  authKey: string;
  /** The new label (null = back to the guessed name), or undefined when cancelled. */
  onDone: (label?: string | null) => void;
}) {
  const [name, setName] = useState(nameOf(device));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy || !name.trim()) return;
    const label = name.trim();
    // Left as the guess it is no name at all: back to the default.
    const store = label === guessDeviceName(device.userAgent) ? '' : label;
    setBusy(true);
    try {
      await userPush.renameDevice(userId, authKey, device.id, store);
      toast.success('Device renamed');
      onDone(store || null);
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not rename that device');
      setBusy(false);
    }
  };

  return (
    <div className="p-3 rounded-xl border border-[var(--color-primary)]" style={{ background: 'var(--color-surface-elevated)' }}>
      <label htmlFor={`device-name-${device.id}`} className="block text-xs mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Name this device</label>
      {/* 16px text: anything smaller makes a phone zoom in while typing. */}
      <Input
        id={`device-name-${device.id}`}
        value={name}
        maxLength={60}
        autoFocus
        className="text-base"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(); }}
      />
      <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-subtle)' }}>A name you will recognise, like Kitchen tablet.</p>
      <div className="flex gap-2 justify-end mt-3">
        <Button type="button" variant="secondary" size="md" disabled={busy} onClick={() => onDone()}>Cancel</Button>
        <Button type="button" variant="primary" size="md" isLoading={busy} disabled={busy || !name.trim()} onClick={save}>Save name</Button>
      </div>
    </div>
  );
}
