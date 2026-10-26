'use client';

// "Your devices", under the notifications switch on a person's Settings page:
// every device that gets their alerts, as tiles, so each can be given a name
// ("Kitchen tablet") or removed. Folded away until opened. A tile opens a small
// popup beside it with Rename and Remove. Their own devices only, whichever
// sign-in they have - notifications belong to the person, not to Stremio,
// Nuvio, Jellyfin or AIOStreams.

import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, ComputerDesktopIcon, DevicePhoneMobileIcon } from '@heroicons/react/24/outline';
import { Button, Input } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';
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

export function PersonPushDevices({ userId, authKey, refreshKey, onRemovedThisDevice }: {
  userId: string | null;
  authKey: string | null;
  /** Changes when this device turns notifications on or off, so the list is read again. */
  refreshKey: unknown;
  /** The device they are using was removed: its switch should read Off. */
  onRemovedThisDevice: () => void;
}) {
  const [devices, setDevices] = useState<PersonPushDevice[] | null>(null);
  const [open, setOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!userId || !authKey) return;
    let stale = false;
    (async () => {
      try {
        let endpoint: string | undefined;
        try {
          const reg = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
          endpoint = (await reg?.pushManager?.getSubscription())?.endpoint;
        } catch { /* this browser has no registration to mark */ }
        const r = await userPush.devices(userId, authKey, endpoint);
        if (!stale) setDevices(r.devices);
      } catch {
        if (!stale) setDevices((cur) => cur ?? []);
      }
    })();
    return () => { stale = true; };
  }, [userId, authKey, refreshKey]);

  // Nothing registered: nothing to manage.
  if (!devices || devices.length === 0) return null;
  const menuDevice = devices.find((d) => d.id === menuFor) || null;

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setMenuFor(null); }}
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
          {devices.map((d) => {
            const Icon = isPhone(d.userAgent) ? DevicePhoneMobileIcon : ComputerDesktopIcon;
            return (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={(e) => {
                    anchor.current = e.currentTarget;
                    setMenuFor((cur) => (cur === d.id ? null : d.id));
                  }}
                  aria-haspopup="dialog"
                  aria-expanded={menuFor === d.id}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors hover:bg-surface-hover ${menuFor === d.id ? 'border-[var(--color-primary)]' : 'border-default'}`}
                  style={{ background: 'var(--color-surface-elevated)' }}
                >
                  <span className="w-10 h-10 shrink-0 rounded-lg flex items-center justify-center" style={{ background: 'var(--color-surface)' }}>
                    <Icon className="w-5 h-5 text-muted" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>{nameOf(d)}</span>
                    <span className="block text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{seenLine(d)}</span>
                  </span>
                  {d.current && (
                    <span className="shrink-0 px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: 'var(--color-primary-muted)', color: 'var(--color-primary)' }}>This device</span>
                  )}
                  <ChevronRightIcon className="w-4 h-4 shrink-0 text-muted" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open && menuDevice && (
        <DevicePopup
          key={menuDevice.id}
          anchorRef={anchor}
          device={menuDevice}
          userId={userId as string}
          authKey={authKey as string}
          onClose={() => setMenuFor(null)}
          onRenamed={(label) => setDevices((cur) => (cur || []).map((d) => (d.id === menuDevice.id ? { ...d, label } : d)))}
          onRemoved={() => {
            setDevices((cur) => (cur || []).filter((d) => d.id !== menuDevice.id));
            if (menuDevice.current) onRemovedThisDevice();
          }}
        />
      )}
    </div>
  );
}

function DevicePopup({ anchorRef, device, userId, authKey, onClose, onRenamed, onRemoved }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  device: PersonPushDevice;
  userId: string;
  authKey: string;
  onClose: () => void;
  onRenamed: (label: string | null) => void;
  onRemoved: () => void;
}) {
  const [name, setName] = useState(nameOf(device));
  const [busy, setBusy] = useState<'rename' | 'remove' | null>(null);

  const rename = async () => {
    if (busy) return;
    const label = name.trim();
    // Left as the guess it is no name at all: back to the default.
    const store = label === guessDeviceName(device.userAgent) ? '' : label;
    setBusy('rename');
    try {
      await userPush.renameDevice(userId, authKey, device.id, store);
      onRenamed(store || null);
      toast.success('Device renamed');
      onClose();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not rename that device');
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy('remove');
    try {
      await userPush.removeDevice(userId, authKey, device.id);
      onRemoved();
      toast.success(`Removed ${nameOf(device)}`);
      onClose();
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not remove that device');
      setBusy(null);
    }
  };

  return (
    <AnchoredPopup anchorRef={anchorRef} onClose={onClose} title={nameOf(device)} width={320}>
      <label htmlFor="device-name" className="block text-xs mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Name</label>
      <Input
        id="device-name"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') rename(); }}
      />
      <div className="grid grid-cols-2 gap-2 mt-3">
        <Button type="button" variant="primary" size="md" isLoading={busy === 'rename'} disabled={!!busy} onClick={rename}>Rename</Button>
        <Button type="button" variant="danger" size="md" isLoading={busy === 'remove'} disabled={!!busy} onClick={remove}>Remove</Button>
      </div>
      {device.current && (
        <p className="text-xs mt-2.5" style={{ color: 'var(--color-text-subtle)' }}>This is the device you are using. Removing it stops its alerts until you turn them on again.</p>
      )}
    </AnchoredPopup>
  );
}
