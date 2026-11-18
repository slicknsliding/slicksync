'use client';

// The Superadmin page's Alerts and Panel sign-ins sections. Both start closed,
// like the Audit log. Same privacy boundary as the rest of the page: alerts
// carry counts and a short account id, sign-ins a shortened address and the
// browser family - see server/utils/superadminAlerts.js.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, ToggleSwitch } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { V2Status } from '@/components/v2/V2Bits';
import { urlBase64ToUint8Array } from '@/components/ui/PushNotificationToggle';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';
const WARN = 'var(--color-warning, #f59e0b)';

type AlertType = 'signupSurge' | 'fastGrowth' | 'wrongPasswords';
interface AlertSettings { signupSurge: boolean; fastGrowth: boolean; wrongPasswords: boolean; discord: boolean }
interface AlertEntry { id: string; type: AlertType; count: number; shortId: string | null; address: string | null; day: string; at: string | null }
interface AlertsState {
  settings: AlertSettings;
  discordConfigured: boolean;
  push: { available: boolean; publicKey: string | null };
  today: string;
  recent: AlertEntry[];
}
interface SigninEntry { id: string; ok: boolean; count: number; address: string; browser: string; firstAt: string; lastAt: string; current: boolean }

/** A YYYY-MM-DD day as a date, e.g. 11/17/2026. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { timeZone: 'UTC' });
}
const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const formatTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// "11/16/2026, 9:58–10:02 PM" for a run of wrong passwords.
function formatRun(firstAt: string, lastAt: string): string {
  const start = formatWhen(firstAt);
  if (new Date(lastAt).getTime() - new Date(firstAt).getTime() < 60 * 1000) return start;
  if (new Date(firstAt).toDateString() !== new Date(lastAt).toDateString()) return `${start} – ${formatWhen(lastAt)}`;
  const end = formatTime(lastAt);
  const suffix = end.split(' ').pop() || '';
  const trimmed = suffix && /[^\d:]/.test(suffix) && start.endsWith(` ${suffix}`) ? start.slice(0, -suffix.length - 1) : start;
  return `${trimmed}–${end}`;
}

function SectionToggle({ open, onClick, label, extra }: { open: boolean; onClick: () => void; label: string; extra?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open} className="text-sm font-medium text-muted hover:text-default transition-colors">
      {open ? '▾' : '▸'} {label}{extra}
    </button>
  );
}

function SettingRow({ title, text, children }: { title: string; text: ReactNode; children?: ReactNode }) {
  return (
    <div className="v2-row">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-default">{title}</p>
        <p className="text-xs text-muted">{text}</p>
      </div>
      {children}
    </div>
  );
}

function EntryRow({ title, text, when, warn }: { title: ReactNode; text: string; when: string; warn?: boolean }) {
  return (
    <div className="v2-row">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-default" style={warn ? { color: WARN } : undefined}>{title}</p>
        <p className="text-xs text-muted">{text}</p>
      </div>
      <span className="text-xs text-subtle shrink-0">{when}</span>
    </div>
  );
}

const ALERT_TITLE: Record<AlertType, string> = {
  signupSurge: 'Sign-up surge',
  fastGrowth: 'Fast-growing account',
  wrongPasswords: 'Wrong passwords',
};

function alertDetail(a: AlertEntry): string {
  if (a.type === 'signupSurge') return `${a.count} new accounts within an hour`;
  if (a.type === 'fastGrowth') return `${a.shortId} added ${a.count} records`;
  return `${a.count} tries from ${a.address || 'several addresses'}`;
}

async function post(path: string, body: unknown) {
  return fetch(`${API_BASE}/superadmin${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function AlertsSection() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AlertsState | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<keyof AlertSettings | null>(null);
  // Only ever rendered in the browser (the page waits for the sign-in check).
  const [pushSupported] = useState(() => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  // Loaded with the page (it's small) so the closed heading can say how many
  // came today; load() is the retry when that failed.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/superadmin/alerts`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      setData(await res.json());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/superadmin/alerts`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Failed'))))
      .then((d) => { if (live) { setData(d); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  // Is this browser already getting the alerts?
  useEffect(() => {
    if (!pushSupported) return;
    navigator.serviceWorker.getRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then(async (sub) => {
        if (!sub) return;
        const res = await post('/alerts/push/status', { endpoint: sub.endpoint });
        const d = await res.json().catch(() => ({}));
        setPushOn(!!d.subscribed);
      })
      .catch(() => {});
  }, [pushSupported]);

  const flip = async (key: keyof AlertSettings) => {
    if (!data || saving) return;
    const next = !data.settings[key];
    setData({ ...data, settings: { ...data.settings, [key]: next } });
    setSaving(key);
    try {
      const res = await fetch(`${API_BASE}/superadmin/alerts`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next }),
      });
      if (!res.ok) throw new Error('Failed');
      const d = await res.json();
      setData((cur) => (cur ? { ...cur, settings: d.settings } : cur));
    } catch {
      setData((cur) => (cur ? { ...cur, settings: { ...cur.settings, [key]: !next } } : cur));
      toast.error('Couldn’t save that switch');
    } finally {
      setSaving(null);
    }
  };

  const turnOnPush = async () => {
    if (!data?.push.available || !data.push.publicKey) {
      toast.error('Push isn’t available on this server');
      return;
    }
    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error('This browser didn’t allow notifications');
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      // A browser has one push subscription for this site. Reuse it if the
      // account signed in here already turned push on, so both keep working.
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(data.push.publicKey) });
      const res = await post('/alerts/push', { subscription: sub.toJSON() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || 'Couldn’t turn on push');
      setPushOn(true);
      toast.success('Alerts will pop up on this browser');
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Couldn’t turn on push');
    } finally {
      setPushBusy(false);
    }
  };

  // Only stops the panel's alerts here; the browser's subscription stays for
  // the account's own notifications.
  const turnOffPush = async () => {
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        const res = await post('/alerts/push/remove', { endpoint: sub.endpoint });
        if (!res.ok) throw new Error('Failed');
      }
      setPushOn(false);
    } catch {
      toast.error('Couldn’t turn off push');
    } finally {
      setPushBusy(false);
    }
  };

  const todayCount = data ? data.recent.filter((r) => r.day === data.today).length : 0;

  let pushText: string = 'Alerts pop up on this device, even with the page closed.';
  let pushControl: ReactNode = pushOn
    ? <ToggleSwitch checked onChange={turnOffPush} disabled={pushBusy} />
    : <Button variant="ghost" size="sm" onClick={turnOnPush} isLoading={pushBusy}>Turn on</Button>;
  if (!pushSupported) { pushText = 'This browser can’t show push alerts.'; pushControl = null; }
  else if (data && !data.push.available) { pushText = 'Push isn’t available on this server.'; pushControl = null; }

  return (
    <div className="mt-6">
      <SectionToggle
        open={open}
        onClick={() => { setOpen(!open); if (!open && failed) load(); }}
        label="Alerts"
        extra={todayCount > 0 ? <>{' '}<span className="font-normal text-subtle">· {todayCount} today</span></> : null}
      />
      {open && (!data ? (
        <p className="text-sm text-muted mt-2">{failed ? 'Couldn’t load alerts.' : 'Loading…'}</p>
      ) : (
        <>
          <p className="text-xs text-muted mt-1 mb-2.5">Counts and short account IDs only. Never names, emails or what anyone watches.</p>
          <div className="v2-list">
            <SettingRow title="Sign-up surge" text="10 or more new accounts within an hour.">
              <ToggleSwitch checked={data.settings.signupSurge} onChange={() => flip('signupSurge')} disabled={!!saving} />
            </SettingRow>
            <SettingRow title="Fast-growing account" text="An account adds 200 or more records in a day. Watch history isn’t counted.">
              <ToggleSwitch checked={data.settings.fastGrowth} onChange={() => flip('fastGrowth')} disabled={!!saving} />
            </SettingRow>
            <SettingRow title="Wrong passwords" text="5 or more wrong passwords for this page within 15 minutes.">
              <ToggleSwitch checked={data.settings.wrongPasswords} onChange={() => flip('wrongPasswords')} disabled={!!saving} />
            </SettingRow>
            <SettingRow title="Push to this browser" text={pushText}>{pushControl}</SettingRow>
            {data.discordConfigured ? (
              <SettingRow title="Discord" text="Uses the webhook you already have for new sign-ups.">
                <ToggleSwitch checked={data.settings.discord} onChange={() => flip('discord')} disabled={!!saving} />
              </SettingRow>
            ) : (
              <SettingRow title="Discord" text="Not set up. Add SUPERADMIN_NOTIFY_WEBHOOK_URL to the server’s settings to use it.">
                <V2Status tone="off">Not set up</V2Status>
              </SettingRow>
            )}
          </div>
          <p className="text-[13px] font-semibold mt-4 mb-2" style={{ color: 'var(--color-text)' }}>Recent</p>
          <div className="v2-list">
            {data.recent.length === 0 ? (
              <p className="text-sm text-muted p-6 text-center">No alerts yet.</p>
            ) : data.recent.map((a) => (
              <EntryRow key={a.id} title={ALERT_TITLE[a.type] || 'Alert'} text={alertDetail(a)} when={a.at ? formatWhen(a.at) : formatDay(a.day)} />
            ))}
          </div>
        </>
      ))}
    </div>
  );
}

export function PanelSigninsSection() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<SigninEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Loaded the first time it's opened, like the Audit log.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/superadmin/signins`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const d = await res.json();
      setEntries(d.entries || []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && (entries === null || failed)) load();
  };

  return (
    <div className="mt-6">
      <SectionToggle open={open} onClick={toggle} label="Panel sign-ins" />
      {open && (
        entries === null ? (
          <p className="text-sm text-muted mt-2">{failed ? 'Couldn’t load the sign-ins.' : 'Loading…'}</p>
        ) : (
          <>
            <p className="text-xs text-muted mt-1 mb-2.5">Sign-ins to this page, kept for 90 days. The end of each address is hidden.</p>
            <div className="v2-list">
              {entries.length === 0 ? (
                <p className="text-sm text-muted p-6 text-center">No sign-ins recorded yet.</p>
              ) : entries.map((e) => (
                <EntryRow
                  key={e.id}
                  warn={!e.ok}
                  title={e.ok
                    ? <>Signed in{e.current && <span className="text-xs font-normal text-subtle"> · this browser</span>}</>
                    : e.count > 1 ? `${e.count} wrong passwords` : 'Wrong password'}
                  text={`${e.address} · ${e.browser}`}
                  when={e.ok ? formatWhen(e.firstAt) : formatRun(e.firstAt, e.lastAt)}
                />
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
}
