'use client';

// "Who is this?" under a Now Playing card for a stream from an address that
// isn't the household's (server/utils/unknownDevices.js). It opens in the
// same box as Sync history: when that address was first seen and how much it
// has watched, the household's people as tiles (pick one and the device's
// streams are theirs from then on), and what to do about a device nobody
// knows - change the AIOStreams password, or mark it fine.

import { useRef, useState, type SVGProps } from 'react';
import { toast } from '@/components/ui/Toast';
import { api, type User } from '@/lib/api';
import { ActionPill } from '@/components/user/ActionPill';
import { HistoryPopup } from '@/components/ui/HistoryPopup';
import { UserAvatar } from '@/components/ui';

export interface UnknownDevice {
  address: string;
  firstSeen: string;
  titles: number;
  aiostreamsPage: string | null;
}

export function QuestionGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M8.8 8.6a3.3 3.3 0 1 1 4.9 2.9c-1 .55-1.7 1.25-1.7 2.4v.4" />
      <path d="M12 18.4h.01" />
    </svg>
  );
}

/** The "?" picture in place of a person's, on the card's who-line. */
export function UnknownDeviceMark() {
  return (
    <span
      aria-hidden="true"
      className="w-6 h-6 rounded-full inline-flex items-center justify-center shrink-0 text-warning"
      style={{ border: '1.5px dashed currentColor', background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)' }}
    >
      <QuestionGlyph className="w-3.5 h-3.5" />
    </span>
  );
}

const dateText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export function UnknownDevicePill({ device }: { device: UnknownDevice }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<User[] | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = () => {
    setOpen((v) => !v);
    if (!people) api.getUsers().then(setPeople).catch(() => setPeople([]));
  };

  const claimFor = async (person: User) => {
    setBusy(true);
    try {
      await api.saveDeviceClaim(device.address, person.id);
      toast.success(`It’s ${person.username}`, { line: 'What this device watches is theirs from now on.' });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  };

  const markFine = async () => {
    setBusy(true);
    try {
      await api.markDeviceKnown(device.address);
      toast.success('Got it', { line: 'This device won’t be called unknown again.' });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  };

  const titles = `${device.titles} ${device.titles === 1 ? 'title' : 'titles'}`;
  return (
    <span className="inline-flex max-w-full min-w-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <ActionPill ref={button} icon={QuestionGlyph} tone="warn" open={open} onClick={toggle}>
        Who is this?
      </ActionPill>
      <HistoryPopup
        open={open}
        anchor={() => button.current?.getBoundingClientRect() ?? null}
        pointer="start"
        onClose={() => setOpen(false)}
        title="Unknown device"
        line="It is streaming with your AIOStreams login from an internet address none of your people use."
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl px-3 py-2" style={{ background: 'var(--color-surface-hover)' }}>
              <p className="text-[11px] text-subtle">First seen</p>
              <p className="text-sm text-default font-medium">{dateText(device.firstSeen)}</p>
            </div>
            <div className="rounded-xl px-3 py-2" style={{ background: 'var(--color-surface-hover)' }}>
              <p className="text-[11px] text-subtle">Watched since</p>
              <p className="text-sm text-default font-medium">{titles}</p>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-default">Is it one of your people?</p>
            {people === null ? (
              <p className="text-xs text-muted">Loading…</p>
            ) : people.length === 0 ? (
              <p className="text-xs text-muted">No people to pick from.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {people.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={busy}
                    onClick={() => claimFor(p)}
                    className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-left border border-default text-xs text-default min-w-0 hover:border-primary/50 disabled:opacity-60"
                    style={{ background: 'var(--color-surface-hover)' }}
                  >
                    <UserAvatar userId={p.id} name={p.username} email={p.email} colorIndex={p.colorIndex} src={p.useGravatar ? undefined : (p.avatarUrl ?? undefined)} useGravatar={p.useGravatar} size="xs" />
                    <span className="truncate">{p.username}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-[11px] text-subtle">Pick them and what this device watches is theirs from now on.</p>
          </div>
          <div className="space-y-2 pt-3" style={{ borderTop: '1px solid var(--color-surface-border)' }}>
            <p className="text-xs font-semibold text-default">Don’t know it?</p>
            <p className="text-xs text-muted">Change your AIOStreams password. Everything signed in with the old one stops, your own apps too, until they get the new one.</p>
            <div className="flex flex-wrap gap-2">
              {device.aiostreamsPage && (
                <a href={device.aiostreamsPage} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ background: 'var(--color-primary)' }}>
                  Open AIOStreams
                </a>
              )}
              <button type="button" disabled={busy} onClick={markFine} className="px-3 py-1.5 rounded-lg border border-default text-xs text-default disabled:opacity-60">
                It’s fine, don’t ask again
              </button>
            </div>
          </div>
        </div>
      </HistoryPopup>
    </span>
  );
}
