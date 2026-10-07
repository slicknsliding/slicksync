'use client';

// "Notifications on this device", on a person's own Settings page. Off until
// they turn it on; then this device is told when their sign-in stops working
// (with a tap straight to signing in again), ten minutes before a daily limit
// or bedtime pauses their streaming, and when it does. Their devices only -
// the admin's push is separate (server: PersonPushSubscription), so turning
// this off removes this person's registration and never unsubscribes the
// browser itself, which the admin may also be using on this device.

import { useEffect, useState } from 'react';
import { ToggleSwitch } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { userPush } from '@/lib/user-api';
import { urlBase64ToUint8Array } from '@/components/ui/PushNotificationToggle';

export function PersonPushRow({ userId, authKey }: { userId: string | null; authKey: string | null }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ok = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    setSupported(ok);
    if (!ok || !userId || !authKey) return;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        const status = await userPush.status(userId, authKey, sub?.endpoint);
        setAvailable(status.enabled && !!status.publicKey);
        setOn(status.subscribed && Notification.permission === 'granted');
      } catch {
        setAvailable(false);
      }
    })();
  }, [userId, authKey]);

  const turnOn = async () => {
    if (!userId || !authKey) return;
    setBusy(true);
    try {
      const status = await userPush.status(userId, authKey);
      if (!status.enabled || !status.publicKey) throw new Error('Notifications aren’t available on this server');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site in your browser');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(status.publicKey) });
      await userPush.subscribe(userId, authKey, sub.toJSON());
      setOn(true);
      toast.success('Notifications are on for this device');
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not turn notifications on');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (!userId || !authKey) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) await userPush.unsubscribe(userId, authKey, sub.endpoint);
      setOn(false);
      toast.success('Notifications are off for this device');
    } catch (e) {
      toast.error((e as Error)?.message || 'Could not turn notifications off');
    } finally {
      setBusy(false);
    }
  };

  // Nothing to offer: say so only when the browser is the reason.
  if (supported === null || (supported && available === false)) return null;

  return (
    <div className="flex items-center justify-between gap-4 p-4 rounded-lg mb-4" style={{ background: 'var(--color-surface-elevated)' }}>
      <div className="flex-1 min-w-0">
        <h3 className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>
          Notifications on this device
        </h3>
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {supported
            ? 'If your sign-in stops working, and ten minutes before a daily limit or bedtime pauses your streaming.'
            : 'This browser can’t show notifications. On an iPhone, add SlickSync to your Home Screen first.'}
        </p>
      </div>
      {supported && (
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-sm font-medium" style={{ color: on ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
            {on ? 'On' : 'Off'}
          </span>
          <ToggleSwitch checked={on} onChange={() => (on ? turnOff() : turnOn())} disabled={busy || available !== true} />
        </div>
      )}
    </div>
  );
}
