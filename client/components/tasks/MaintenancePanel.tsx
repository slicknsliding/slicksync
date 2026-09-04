'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, ToggleSwitch } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api, BackupTargets, DbMaintenanceSettings, UpdateCapability } from '@/lib/api';
import { TrashPanel } from './TrashPanel';
import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

// Everything that keeps an instance healthy without anyone watching it:
// where backups go besides this box, what the database does to look after
// itself, and applying an update. Grouped in one panel on the Tasks page
// because they're the same job - and because none of them are things
// anyone wants a dashboard for; they're set once and then forgotten.
//
// Every destructive capability here is off by default and says plainly
// what it does. Nothing in this panel is required for SlickSync to work.

function relative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours > 0) return `${hours}h ago`;
  return 'just now';
}

const inputClass = 'w-full px-3 py-2 rounded-lg text-sm border border-transparent focus:border-primary focus:outline-none';
const inputStyle = { background: 'var(--color-surface-hover)', color: 'var(--color-text)' } as const;

export function MaintenancePanel() {
  // History Doctor - scan is read-only; repair re-scans server-side (see
  // utils/historyDoctor.js) rather than trusting ids from this page.
  const [historyScan, setHistoryScan] = useState<Awaited<ReturnType<typeof api.scanHistory>> | null>(null);
  const [scanningHistory, setScanningHistory] = useState(false);
  const [repairingHistory, setRepairingHistory] = useState(false);
  const runHistoryScan = async () => {
    setScanningHistory(true);
    try {
      setHistoryScan(await api.scanHistory());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'History scan failed');
    } finally {
      setScanningHistory(false);
    }
  };
  const runHistoryRepair = async () => {
    setRepairingHistory(true);
    try {
      const res = await api.repairHistory();
      toast.success(`Removed ${res.removed} bad record${res.removed === 1 ? '' : 's'}`);
      setHistoryScan(await api.scanHistory());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'History repair failed');
    } finally {
      setRepairingHistory(false);
    }
  };

  const [targets, setTargets] = useState<BackupTargets | null>(null);
  const [maint, setMaint] = useState<DbMaintenanceSettings | null>(null);
  const [capability, setCapability] = useState<UpdateCapability | null>(null);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [autoUpdateHour, setAutoUpdateHour] = useState(4);
  const saveAutoUpdate = async (enabled: boolean, hour: number) => {
    setAutoUpdateEnabled(enabled);
    setAutoUpdateHour(hour);
    try {
      await api.updateSyncSettings({ autoUpdateEnabled: enabled, autoUpdateHour: hour });
      toast.success(enabled ? `Automatic updates on - daily at ${String(hour).padStart(2, '0')}:00` : 'Automatic updates off');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    }
  };
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      api.getBackupTargets().then(setTargets).catch(() => setTargets(null));
      api.getDbMaintenance().then(setMaint).catch(() => setMaint(null));
      api.getUpdateCapability().then(setCapability).catch(() => setCapability(null));
      api.getSyncSettings().then((ss) => {
        setAutoUpdateEnabled(ss.autoUpdateEnabled === true);
        if (Number.isInteger(ss.autoUpdateHour)) setAutoUpdateHour(ss.autoUpdateHour as number);
      }).catch(() => {});
    }, 0);
    return () => clearTimeout(id);
  }, []);

  const saveTargets = async (patch: Partial<BackupTargets>) => {
    setBusy('targets');
    try {
      setTargets(await api.saveBackupTargets(patch));
      toast.success('Backup target saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (action: 'integrity' | 'vacuum' | 'prune' | 'pruneNotifications') => {
    setBusy(action);
    try {
      const result = await api.runDbMaintenance(action);
      if (action === 'integrity') {
        const ok = (result as { ok?: boolean }).ok;
        if (ok) toast.success('Database integrity verified - no problems found');
        else toast.error('Integrity check found problems - restore from a backup');
      } else if (action === 'prune') {
        const r = result as { healthHistoryDeleted?: number; automationRunsDeleted?: number };
        toast.success(`Pruned ${(r.healthHistoryDeleted || 0) + (r.automationRunsDeleted || 0)} old log rows`);
      } else if (action === 'pruneNotifications') {
        const r = result as { notificationsDeleted?: number; days?: number };
        toast.success(`Cleared ${r.notificationsDeleted || 0} read notifications older than ${r.days} days`);
      } else {
        toast.success('Database compacted');
      }
      setMaint(await api.getDbMaintenance());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const toggleMaint = async (key: 'vacuumEnabled' | 'integrityCheckEnabled' | 'pruneLogsEnabled' | 'pruneNotificationsEnabled', value: boolean) => {
    try {
      setMaint(await api.saveDbMaintenance({ [key]: value }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const saveNotifDays = async (raw: string) => {
    const days = Math.round(Number(raw));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      toast.error('Days must be between 1 and 365');
      return;
    }
    if (days === maint?.pruneNotificationsDays) return;
    try {
      setMaint(await api.saveDbMaintenance({ pruneNotificationsDays: days }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  return (
    <div className="space-y-5">
      {/* --- Off-site backups --- */}
      <Card padding="lg">
        <h3 className="text-base font-semibold text-default mb-1">Off-site backups</h3>
        <p className="text-xs text-muted mb-4">
          Scheduled backups are written next to the database they protect. Sending a copy somewhere else is what
          covers losing the whole machine.
        </p>
        {!targets ? (
          <p className="text-sm text-muted">Not available on this instance.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Destination</label>
                <select
                  value={targets.type}
                  onChange={(e) => saveTargets({ type: e.target.value as BackupTargets['type'] })}
                  className={inputClass}
                  style={inputStyle}
                >
                  <option value="none">Local only</option>
                  <option value="s3">S3 (AWS, B2, R2, MinIO…)</option>
                  <option value="webdav">WebDAV (Nextcloud, rsync.net…)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Keep locally <span className="text-subtle">(0 = keep all)</span>
                </label>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  defaultValue={targets.keepLocal}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (n !== targets.keepLocal) saveTargets({ keepLocal: n });
                  }}
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
            </div>

            {targets.type === 's3' && (
              <div className="grid grid-cols-2 gap-3">
                {([
                  ['bucket', 'Bucket'], ['region', 'Region'],
                  ['endpoint', 'Endpoint (blank for AWS)'], ['prefix', 'Path prefix'],
                  ['accessKeyId', 'Access key ID'], ['secretAccessKey', 'Secret access key'],
                ] as Array<[keyof BackupTargets['s3'], string]>).map(([key, label]) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-muted mb-1">{label}</label>
                    <input
                      type={key === 'secretAccessKey' ? 'password' : 'text'}
                      defaultValue={targets.s3[key]}
                      onBlur={(e) => { if (e.target.value !== targets.s3[key]) saveTargets({ s3: { ...targets.s3, [key]: e.target.value } }); }}
                      spellCheck={false}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </div>
                ))}
              </div>
            )}

            {targets.type === 'webdav' && (
              <div className="grid grid-cols-2 gap-3">
                {([['url', 'Folder URL'], ['username', 'Username'], ['password', 'Password']] as Array<[keyof BackupTargets['webdav'], string]>).map(([key, label]) => (
                  <div key={key}>
                    <label className="block text-xs font-medium text-muted mb-1">{label}</label>
                    <input
                      type={key === 'password' ? 'password' : 'text'}
                      defaultValue={targets.webdav[key]}
                      onBlur={(e) => { if (e.target.value !== targets.webdav[key]) saveTargets({ webdav: { ...targets.webdav, [key]: e.target.value } }); }}
                      spellCheck={false}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </div>
                ))}
              </div>
            )}

            {targets.type !== 'none' && (
              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-[11px] text-subtle">
                  A failed upload never fails the backup - the local copy is already written, and you get a
                  notification rather than silence.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy === 'test'}
                  onClick={async () => {
                    setBusy('test');
                    try {
                      const r = await api.testBackupTarget();
                      if (r.ok) toast.success('Target reachable - test file uploaded');
                      else toast.error(r.error || 'Target test failed');
                    } finally { setBusy(null); }
                  }}
                >
                  {busy === 'test' ? 'Testing…' : 'Test target'}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* --- Recently deleted --- */}
      <TrashPanel />

      {/* --- History Doctor --- */}
      <Card padding="lg">
        <h3 className="text-base font-semibold text-default mb-1">Watch history check</h3>
        <p className="text-xs text-muted mb-4">
          Looks for watch records that are provably wrong - duplicates copied between providers, or rows belonging to a user that no longer exists. Scanning never changes anything.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="secondary" size="sm" onClick={runHistoryScan} isLoading={scanningHistory}>
            {historyScan ? 'Scan again' : 'Scan history'}
          </Button>
          {historyScan && historyScan.counts.total > 0 && (
            <Button variant="primary" size="sm" onClick={runHistoryRepair} isLoading={repairingHistory}>
              Fix {historyScan.counts.total} issue{historyScan.counts.total === 1 ? '' : 's'}
            </Button>
          )}
        </div>

        {historyScan && (
          <div className="mt-3">
            {historyScan.counts.total === 0 ? (
              <p className="text-sm text-muted">No problems found - watch history looks clean.</p>
            ) : (
              <>
                <p className="text-sm text-default mb-2">
                  Found {historyScan.counts.total}: {historyScan.counts.cross_provider_duplicate} duplicate{historyScan.counts.cross_provider_duplicate === 1 ? '' : 's'}, {historyScan.counts.orphaned} orphaned.
                </p>
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {historyScan.findings.slice(0, 50).map((f) => (
                    <div key={f.id} className="p-2.5 rounded-lg" style={{ background: 'var(--color-surface-hover)' }}>
                      <p className="text-sm text-default">{f.summary}</p>
                      <p className="text-xs text-muted mt-0.5">{f.detail}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted mt-2">
                  Fixing deletes only these redundant rows. The original watch record each duplicate was copied from is kept.
                </p>
              </>
            )}
          </div>
        )}
      </Card>

      {/* --- Database upkeep --- */}
      <Card padding="lg">
        <h3 className="text-base font-semibold text-default mb-1">Database upkeep</h3>
        <p className="text-xs text-muted mb-4">
          Runs on its own in the background. Nothing here touches watch history, users, catalogs, or the Vault.
        </p>
        {!maint || maint.available === false ? (
          <p className="text-sm text-muted">Not applicable on this instance.</p>
        ) : (
          <div className="space-y-3">
            <MaintRow
              title="Integrity checks"
              detail={`Read-only - verifies the database file is not corrupted. Last run ${relative(maint.lastIntegrityCheckAt)}${maint.lastIntegrityOk === false ? ' and FAILED' : maint.lastIntegrityOk ? ' - healthy' : ''}.`}
              enabled={maint.integrityCheckEnabled}
              onToggle={(v) => toggleMaint('integrityCheckEnabled', v)}
              onRun={() => runAction('integrity')}
              running={busy === 'integrity'}
              status={maint.lastIntegrityOk === false ? 'bad' : maint.lastIntegrityOk ? 'good' : null}
            />
            <MaintRow
              title="Compact the database"
              detail={`Reclaims space left behind by deletions. Skipped automatically if the disk is too full to do it safely. Last run ${relative(maint.lastVacuumAt)}.`}
              enabled={maint.vacuumEnabled}
              onToggle={(v) => toggleMaint('vacuumEnabled', v)}
              onRun={() => runAction('vacuum')}
              running={busy === 'vacuum'}
            />
            <MaintRow
              title="Trim old logs"
              detail={`Caps addon health-check history and automation run history, which otherwise grow forever. Only those two - never anything a feature reads by date. Last run ${relative(maint.lastPruneAt)}.`}
              enabled={maint.pruneLogsEnabled}
              onToggle={(v) => toggleMaint('pruneLogsEnabled', v)}
              onRun={() => runAction('prune')}
              running={busy === 'prune'}
            />
            <MaintRow
              title="Clear old read notifications"
              detail={`Bell notifications you've already read are cleared once they're older than the cutoff. Unread ones are never touched, no matter how old. Last run ${relative(maint.lastNotificationsPruneAt)}.`}
              enabled={maint.pruneNotificationsEnabled}
              onToggle={(v) => toggleMaint('pruneNotificationsEnabled', v)}
              onRun={() => runAction('pruneNotifications')}
              running={busy === 'pruneNotifications'}
              extra={
                <label className="flex items-center gap-1.5 text-xs text-muted mt-1.5">
                  Older than
                  <input
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={maint.pruneNotificationsDays}
                    onBlur={(e) => saveNotifDays(e.target.value)}
                    className="w-14 px-1.5 py-0.5 rounded text-xs text-center"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                  />
                  days
                </label>
              }
            />
          </div>
        )}
      </Card>

      {/* --- Updates --- */}
      <Card padding="lg">
        <h3 className="text-base font-semibold text-default mb-1">Applying updates</h3>
        {!capability ? (
          <p className="text-sm text-muted">Checking…</p>
        ) : capability.canSelfUpdate ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              This instance can update itself: it backs up first, downloads the new image, then restarts into it.
              A watchdog stays behind for the switch - if the new version fails its health check within two
              minutes, the previous image is restored automatically. The restart takes a few seconds and
              everyone is briefly disconnected.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy === 'update'}
              onClick={async () => {
                setBusy('update');
                try {
                  const r = await api.applyUpdate();
                  toast.success(r.note || 'Update started');
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Update failed');
                } finally { setBusy(null); }
              }}
            >
              {busy === 'update' ? 'Updating…' : 'Back up and update now'}
            </Button>
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-surface-hover">
              <div className="min-w-0">
                <p className="text-sm font-medium text-default">Update automatically</p>
                <p className="text-xs text-muted mt-0.5">
                  Checks once a day at{' '}
                  <select
                    value={autoUpdateHour}
                    onChange={(e) => saveAutoUpdate(autoUpdateEnabled, Number(e.target.value))}
                    className="inline-block px-1 py-0.5 rounded text-xs"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                  {' '}and applies new releases on its own - backup first, watchdog rollback if the new version fails its health check.
                </p>
              </div>
              <ToggleSwitch
                checked={autoUpdateEnabled}
                onChange={() => saveAutoUpdate(!autoUpdateEnabled, autoUpdateHour)}
                title="Toggle automatic updates"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy === 'rollback'}
              onClick={async () => {
                setBusy('rollback');
                try {
                  const r = await api.rollbackUpdate();
                  toast.success(r.note || 'Rollback started');
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Rollback failed');
                } finally { setBusy(null); }
              }}
            >
              {busy === 'rollback' ? 'Rolling back…' : 'Roll back to the previous version'}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted">{capability.reason || 'Updating from here is not available.'}</p>
            <p className="text-xs text-muted">Update from the host instead:</p>
            <code className="block text-xs font-mono px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text)' }}>
              docker compose pull &amp;&amp; docker compose up -d
            </code>
            <p className="text-[11px] text-subtle">
              Updating in place needs the Docker socket mounted into this container, which grants it full control
              of the host&apos;s Docker - a deliberate trade, so it is never enabled for you.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function MaintRow({ title, detail, enabled, onToggle, onRun, running, status, extra }: {
  title: string;
  detail: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  onRun: () => void;
  running: boolean;
  status?: 'good' | 'bad' | null;
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-default flex items-center gap-1.5">
          {title}
          {status === 'good' && <CheckCircleIcon className="w-4 h-4" style={{ color: 'var(--color-success)' }} />}
          {status === 'bad' && <ExclamationTriangleIcon className="w-4 h-4" style={{ color: 'var(--color-error)' }} />}
        </p>
        <p className="text-xs text-muted mt-0.5">{detail}</p>
        {extra}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button variant="ghost" size="sm" onClick={onRun} disabled={running}>
          {running ? 'Running…' : 'Run now'}
        </Button>
        {/* ToggleSwitch's onChange takes no argument - it just signals a
            flip, so the new value is derived here. */}
        <ToggleSwitch checked={enabled} onChange={() => onToggle(!enabled)} />
      </div>
    </div>
  );
}
