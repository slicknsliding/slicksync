'use client';

import { useCallback, useEffect, useState } from 'react';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { beginSave, SavedTick } from '@/lib/savedTick';
import { V2Rows, V2SetRow, V2Switch } from '@/components/v2/SettingsV2';

type Channels = { push: boolean; bell: boolean; discord: boolean };

// Settings -> Notifications: where Vault alerts go (a key about to expire, a
// failed check). Push and the bell are the main channels; Discord only
// shows once a webhook is set. All start on, which is what happened before
// these switches existed. The master "Vault notifications" switch still
// decides whether Vault alerts are sent at all.

/** `look` picks the row style of the page design it sits in. */
export function VaultAlertSwitches({ look, hasWebhook, masterOn }: { look: 'classic' | 'v2'; hasWebhook: boolean; masterOn: boolean }) {
  const [value, setValue] = useState<Channels | null>(null);

  useEffect(() => {
    api.getVaultAlerts().then(setValue).catch(() => setValue({ push: true, bell: true, discord: true }));
  }, []);

  const flip = useCallback((key: keyof Channels, next: boolean) => {
    const saved = beginSave();
    const before = value;
    setValue((v) => (v ? { ...v, [key]: next } : v));
    api.setVaultAlerts({ [key]: next })
      .then((r) => { setValue(r); saved(); })
      .catch((e) => {
        setValue(before);
        toast.error((e instanceof Error && e.message) || 'Failed to save setting');
      });
  }, [value]);

  if (!value) return null;
  const rows: Array<{ key: keyof Channels; title: string; line: string }> = [
    { key: 'push', title: 'Vault alerts by push', line: 'To your phone and browser' },
    { key: 'bell', title: 'Vault alerts in the bell', line: 'In SlickSync' },
    ...(hasWebhook ? [{ key: 'discord' as const, title: 'Vault alerts on Discord', line: 'To your webhook' }] : []),
  ];
  const lead = masterOn
    ? 'Choose where a key about to expire, a failed check or a backup key taking over is announced.'
    : 'Turn on Vault notifications first. Then choose where these alerts go.';

  if (look === 'v2') {
    return (
      <div className="mt-3">
        <V2Rows>
          <V2SetRow title="Vault alerts" line={lead} />
          {rows.map((r) => (
            <V2SetRow
              key={r.key}
              title={r.title}
              line={r.line}
              disabled={!masterOn}
              control={<V2Switch on={value[r.key]} onChange={(v) => flip(r.key, v)} label={`Turn ${r.title.toLowerCase()} ${value[r.key] ? 'off' : 'on'}`} disabled={!masterOn} />}
            />
          ))}
        </V2Rows>
      </div>
    );
  }

  return (
    <div className="space-y-3 pl-4 border-l-2 border-default">
      <p className="text-xs text-muted">{lead}</p>
      {rows.map((r) => (
        <div key={r.key} data-setting={r.title} className={`flex items-center justify-between p-4 rounded-lg bg-subtle ${masterOn ? '' : 'opacity-50 pointer-events-none'}`}>
          <div>
            <p className="font-medium text-sm text-default">{r.title}</p>
            <p className="text-xs text-muted">{r.line}</p>
          </div>
          <SavedTick id={r.title} className="ml-auto mr-3" />
          <ToggleSwitch checked={value[r.key]} onChange={() => flip(r.key, !value[r.key])} title={r.title} disabled={!masterOn} />
        </div>
      ))}
    </div>
  );
}
