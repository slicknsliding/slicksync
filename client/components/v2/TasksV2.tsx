'use client';

// The Tasks page in the v2 page design: what runs by itself first (each with
// whether it is on and a Run now), then the tools used now and then as tiles
// with one button each. The page keeps every handler, list and dialog; this
// only draws them. Anything that needs its own controls (pick a person, type
// a passphrase) opens in a panel; Delete all and Reset sit in each tile's ⋯.

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowDownTrayIcon, ArrowPathIcon, ArrowUpTrayIcon, ArrowsRightLeftIcon, ArchiveBoxIcon, ArrowUturnLeftIcon,
  BoltIcon, CheckCircleIcon, ClockIcon, Cog6ToothIcon, DocumentArrowDownIcon,
  DocumentDuplicateIcon, ExclamationTriangleIcon, EyeIcon, EyeSlashIcon, FolderArrowDownIcon, HeartIcon,
  LinkIcon, LockClosedIcon, PaperAirplaneIcon, PuzzlePieceIcon, TrashIcon, UserIcon,
  UsersIcon, WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { Badge, Button, Modal, UserAvatar } from '@/components/ui';
import { ArrangeBar, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import { api, type AddonSnapshot, type BackupFile, type Group, type User } from '@/lib/api';
import { displayEmail, providerBadgeVariant, providerTypeLabel } from '@/lib/providers';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/Toast';
import { V2MoreMenu, type V2MenuItem } from './V2Detail';
import { V2Button, V2Status } from './V2Bits';

export const TASK_SECTIONS = [
  { key: 'schedules', label: 'Runs by itself' },
  { key: 'everyday', label: 'Everyday' },
  { key: 'data', label: 'Your data' },
  { key: 'safe', label: 'Keeping it safe' },
] as const;

export type TasksV2Props = {
  arrange: PageArrange;
  users: User[];
  groups: Group[];

  // Schedules
  syncFrequency: string;
  backupDays: number;
  healthCheckMinutes: number;
  isHealthCheckLoading: boolean;
  onSyncFrequency: (v: string) => void;
  onBackupDays: (n: number) => void;
  onHealthMinutes: (n: number) => void;

  // Busy flags
  busy: {
    syncingUsers: boolean; syncingGroups: boolean; reloadingAddons: boolean; repairingAddons: boolean;
    importingAddons: boolean; importingConfig: boolean; isBackupRunning: boolean; isRunningHealthCheck: boolean;
    isExportingLibrary: boolean; isClearingLibrary: boolean; isExportingHistory: boolean; isImportingHistory: boolean;
    isClearingHistory: boolean; isExportingDrk: boolean; isImportingDrk: boolean; isOfferingMigration: boolean;
    isReceivingMigration: boolean;
  };

  // Everyday and data actions (the page's own handlers)
  onSyncAllUsers: () => void;
  onDeleteAllUsers: () => void;
  onClearUserAddons: () => void;
  onSyncAllGroups: () => void;
  onDeleteAllGroups: () => void;
  onReloadAddons: () => void;
  onRepairAddons: () => void;
  onExportAddons: () => void;
  onDeleteAllAddons: () => void;
  onAddonDrop: (e: React.DragEvent) => void;
  onPickAddonFile: () => void;
  onOpenAutomation: () => void;
  onExportConfig: () => void;
  onResetConfig: () => void;
  onConfigDrop: (e: React.DragEvent) => void;
  onPickConfigFile: () => void;
  onOpenMaintenance: () => void;
  onBackupNow: () => void;
  onRunHealthCheck: () => void;

  // Library
  selectedUserId: string;
  onSelectUser: (id: string) => void;
  onExportLibrary: () => void;
  onClearLibrary: () => void;

  // History
  selectedHistoryUserId: string;
  onSelectHistoryUser: (id: string) => void;
  onPickHistoryFile: () => void;
  onExportHistory: () => void;
  onClearHistory: () => void;

  // Templates
  snapshots: AddonSnapshot[];
  loadingSnapshots: boolean;
  deletingSnapshotId: string | null;
  onNewTemplate: () => void;
  onImportTemplateCode: () => void;
  onShareTemplate: (s: AddonSnapshot) => void;
  onDeployTemplate: (s: AddonSnapshot) => void;
  onDeleteTemplate: (s: AddonSnapshot) => void;

  // Backups
  backups: BackupFile[];
  loadingBackups: boolean;
  restoringBackup: string | null;
  deletingBackup: string | null;
  formatBackupDate: (iso: string) => string;
  onDownloadBackup: (filename: string) => void;
  onUserRestore: (b: BackupFile) => void;
  onRestoreBackup: (b: BackupFile) => void;
  onDeleteBackup: (b: BackupFile) => void;

  // Recovery kit
  kitExportPassphrase: string;
  onKitExportPassphrase: (v: string) => void;
  kitImportPassphrase: string;
  onKitImportPassphrase: (v: string) => void;
  onPickKitFile: () => void;
  onExportKit: () => void;

  // Move to a new server
  migrationCode: string | null;
  receiveCode: string;
  onReceiveCode: (v: string) => void;
  onOfferMigration: () => void;
  onReceiveMigration: () => void;
};

type Panel = 'library' | 'history' | 'templates' | 'backups' | 'kit' | 'move' | 'sched-sync' | 'sched-backup' | 'sched-health';

const userName = (u: User) => u.name || displayEmail(u.email) || u.id;

const SYNC_LABEL: Record<string, string> = { '0': 'Not scheduled', '1h': 'Every hour', '1d': 'Every day', '7d': 'Every 7 days', '15d': 'Every 15 days', '30d': 'Every 30 days' };
const backupLabel = (d: number) => (d === 1 ? 'Every day' : d === 7 ? 'Every week' : d === 15 ? 'Every 15 days' : d === 30 ? 'Every month' : d > 0 ? `Every ${d} days` : 'Not scheduled');
const healthLabel = (m: number) => (m < 1 ? 'Not scheduled' : m < 60 ? `Every ${m} minutes` : m === 60 ? 'Every hour' : m < 1440 ? `Every ${Math.floor(m / 60)} hours` : 'Every 24 hours');

// Next runs, worked out the same way as Classic's Scheduled Tasks list.
function nextSync(f: string): Date | null {
  const n = new Date();
  switch (f) {
    case '1h': n.setHours(n.getHours() + 1, 0, 0, 0); break;
    case '1d': n.setDate(n.getDate() + 1); n.setHours(0, 0, 0, 0); break;
    case '7d': n.setDate(n.getDate() + (7 - n.getDay())); n.setHours(0, 0, 0, 0); break;
    case '15d': n.setDate(n.getDate() + 15); n.setHours(0, 0, 0, 0); break;
    case '30d': n.setMonth(n.getMonth() + 1, 1); n.setHours(0, 0, 0, 0); break;
    default: return null;
  }
  return n;
}
function nextBackup(days: number): Date | null {
  if (days === 0) return null;
  const n = new Date();
  n.setDate(n.getDate() + days);
  n.setHours(3, 0, 0, 0);
  return n;
}
function nextHealth(min: number): Date | null {
  if (min < 1) return null;
  const n = new Date();
  n.setMinutes(n.getMinutes() + min);
  return n;
}
function nextLine(d: Date | null): string {
  if (!d) return '';
  const ms = d.getTime() - Date.now();
  const h = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);
  const rel = h < 1 ? 'in less than an hour' : h < 24 ? `in ${h} hour${h !== 1 ? 's' : ''}` : days === 1 ? 'tomorrow' : `in ${days} days`;
  return ` · next ${rel} (${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})`;
}

/** One task: icon, name, one line, then an optional state, its one button and its ⋯. */
function TaskTile({ icon, title, line, state, button, more, dropProps }: {
  icon: ReactNode;
  title: string;
  line: ReactNode;
  state?: ReactNode;
  button?: ReactNode;
  more?: V2MenuItem[];
  dropProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <div className="v2-tool flex-wrap" style={{ alignItems: 'center' }} {...dropProps}>
      <span className="v2-tool-icon">{icon}</span>
      <div className="flex-1 min-w-[150px]">
        <div className="font-semibold text-[14.5px] text-default">{title}</div>
        <div className="text-muted text-[12.5px] mt-0.5">{line}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-auto">
        {state}
        {button}
        {more && more.length > 0 && <V2MoreMenu items={more} label={`More for ${title}`} />}
      </div>
    </div>
  );
}

const ic = 'w-4 h-4';

function UserSelect({ value, onChange, users, allLabel }: { value: string; onChange: (id: string) => void; users: User[]; allLabel: string }) {
  return (
    <div className="relative flex-1 min-w-[200px]">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="input-base px-3 py-2 w-full appearance-none pr-10 text-sm">
        {allLabel.startsWith('Select') ? <option value="">{allLabel}</option> : <option value="all">{allLabel}</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>{userName(u)} ({providerTypeLabel(u.providerType)})</option>
        ))}
      </select>
      <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"><UserIcon className="w-4 h-4 text-muted" /></div>
    </div>
  );
}

function UserCard({ user }: { user: User }) {
  return (
    <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-subtle">
      <UserAvatar userId={user.id} name={user.name || user.email || 'U'} email={user.email} colorIndex={user.colorIndex} src={user.avatarUrl || undefined} useGravatar={user.useGravatar} size="sm" />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-default truncate">{userName(user)}</p>
          {user.email && user.name && <p className="text-xs text-muted truncate">{displayEmail(user.email)}</p>}
        </div>
        <Badge variant={providerBadgeVariant(user)} size="sm">{providerTypeLabel(user.providerType)}</Badge>
      </div>
    </div>
  );
}

function PassphraseField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative flex-1">
      <input type={visible ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="input-base px-3 py-2 text-sm w-full pr-9" />
      <button type="button" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Hide passphrase' : 'Show passphrase'} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle hover:text-default">
        {visible ? <EyeSlashIcon className={ic} /> : <EyeIcon className={ic} />}
      </button>
    </div>
  );
}

export function TasksV2(p: TasksV2Props) {
  const { arrange, busy } = p;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [synced, setSynced] = useState<{ userId: string; name: string }[]>([]);
  useEffect(() => {
    api.getWatchSyncOverview().then((r) => setSynced(r.synced || [])).catch(() => {});
  }, []);

  // A panel closes before a dialog of the page's own opens over it.
  const then = (fn: () => void) => () => { setPanel(null); fn(); };

  const newest = p.backups[0];
  const schedulesOn = (p.syncFrequency !== '0' ? 1 : 0) + (p.backupDays > 0 ? 1 : 0) + (p.healthCheckMinutes > 0 ? 1 : 0);
  const on = (yes: boolean) => <V2Status tone={yes ? 'live' : 'off'}>{yes ? 'On' : 'Off'}</V2Status>;

  const dropFor = (onDrop: (e: React.DragEvent) => void): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => e.preventDefault(),
    onDrop,
  });

  const sections: Record<string, { meta?: string; body: ReactNode }> = {
    schedules: {
      meta: `${schedulesOn} on`,
      body: (
        <div className="v2-tiles v2-tiles-2">
          <TaskTile
            icon={<ArrowPathIcon className="w-[18px] h-[18px]" />}
            title="Sync every group"
            line={`${SYNC_LABEL[p.syncFrequency] || p.syncFrequency}${nextLine(nextSync(p.syncFrequency))}`}
            state={on(p.syncFrequency !== '0')}
            button={<V2Button disabled={busy.syncingGroups} onClick={p.onSyncAllGroups}>{busy.syncingGroups ? 'Syncing…' : 'Run now'}</V2Button>}
            more={[
              { label: 'Change schedule', icon: <ClockIcon className={ic} />, onClick: () => setPanel('sched-sync') },
              { label: 'Delete all groups', icon: <TrashIcon className={ic} />, onClick: p.onDeleteAllGroups, danger: true },
            ]}
          />
          <TaskTile
            icon={<ArchiveBoxIcon className="w-[18px] h-[18px]" />}
            title="Backup"
            line={p.backupDays > 0 ? `${backupLabel(p.backupDays)}${nextLine(nextBackup(p.backupDays))}${newest ? ` · last ran ${p.formatBackupDate(newest.createdAt)}` : ''}` : 'Not scheduled'}
            state={on(p.backupDays > 0)}
            button={<V2Button disabled={busy.isBackupRunning} onClick={p.onBackupNow}>{busy.isBackupRunning ? 'Backing up…' : 'Run now'}</V2Button>}
            more={[{ label: 'Change schedule', icon: <ClockIcon className={ic} />, onClick: () => setPanel('sched-backup') }]}
          />
          <TaskTile
            icon={<HeartIcon className="w-[18px] h-[18px]" />}
            title="Check addons"
            line={`${healthLabel(p.healthCheckMinutes)}${nextLine(nextHealth(p.healthCheckMinutes))}`}
            state={on(p.healthCheckMinutes > 0)}
            button={<V2Button disabled={busy.isRunningHealthCheck} onClick={p.onRunHealthCheck}>{busy.isRunningHealthCheck ? 'Checking…' : 'Run now'}</V2Button>}
            more={[{ label: 'Change schedule', icon: <ClockIcon className={ic} />, onClick: () => setPanel('sched-health') }]}
          />
          <TaskTile
            icon={<WrenchScrewdriverIcon className="w-[18px] h-[18px]" />}
            title="Maintenance"
            line="Off-site backups, database upkeep and updates"
            button={<V2Button onClick={p.onOpenMaintenance}>Open</V2Button>}
          />
        </div>
      ),
    },
    everyday: {
      body: (
        <div className="v2-tiles v2-tiles-2">
          <TaskTile
            icon={<UsersIcon className="w-[18px] h-[18px]" />}
            title="Sync everyone"
            line="Push every person’s addons now"
            button={<V2Button disabled={busy.syncingUsers} onClick={p.onSyncAllUsers}>{busy.syncingUsers ? 'Syncing…' : 'Sync'}</V2Button>}
            more={[
              { label: 'Clear user addons', icon: <ArrowPathIcon className={ic} />, onClick: p.onClearUserAddons },
              { label: 'Delete all people', icon: <TrashIcon className={ic} />, onClick: p.onDeleteAllUsers, danger: true },
            ]}
          />
          <TaskTile
            icon={<PuzzlePieceIcon className="w-[18px] h-[18px]" />}
            title="Addons"
            line="Reload, repair, import or export"
            button={<V2Button disabled={busy.reloadingAddons} onClick={p.onReloadAddons}>{busy.reloadingAddons ? 'Reloading…' : 'Reload all'}</V2Button>}
            dropProps={dropFor(p.onAddonDrop)}
            more={[
              { label: busy.importingAddons ? 'Importing…' : 'Import addons', icon: <ArrowDownTrayIcon className={ic} />, onClick: p.onPickAddonFile, disabled: busy.importingAddons },
              { label: 'Export addons', icon: <ArrowUpTrayIcon className={ic} />, onClick: p.onExportAddons },
              { label: busy.repairingAddons ? 'Repairing…' : 'Repair', icon: <WrenchScrewdriverIcon className={ic} />, onClick: p.onRepairAddons, disabled: busy.repairingAddons },
              { label: 'Delete all addons', icon: <TrashIcon className={ic} />, onClick: p.onDeleteAllAddons, danger: true },
            ]}
          />
          <TaskTile
            icon={<BoltIcon className="w-[18px] h-[18px]" />}
            title="Automation"
            line="When something happens, do something about it"
            button={<V2Button onClick={p.onOpenAutomation}>Rules</V2Button>}
          />
          <TaskTile
            icon={<ArrowsRightLeftIcon className="w-[18px] h-[18px]" />}
            title="AIOSync"
            line={synced.length > 0
              ? `Kept in step for ${synced.map((s) => s.name).join(', ')}`
              : 'Copy watched titles and resume points between sign-ins'}
            button={<Link href="/tasks/aiosync" className="v2-btn">Open</Link>}
          />
        </div>
      ),
    },
    data: {
      body: (
        <div className="v2-tiles v2-tiles-2">
          <TaskTile
            icon={<FolderArrowDownIcon className="w-[18px] h-[18px]" />}
            title="Libraries"
            line="Export someone’s Stremio or Nuvio library"
            button={<V2Button onClick={() => setPanel('library')}>Export</V2Button>}
          />
          <TaskTile
            icon={<ClockIcon className="w-[18px] h-[18px]" />}
            title="Watch history"
            line="Import or export, for one person or everyone"
            button={<V2Button onClick={() => setPanel('history')}>Open</V2Button>}
          />
          <TaskTile
            icon={<DocumentDuplicateIcon className="w-[18px] h-[18px]" />}
            title="Addon templates"
            line={p.snapshots.length > 0 ? `${p.snapshots.length} saved · share one as a code` : 'None saved yet · share one as a code'}
            button={<V2Button onClick={() => setPanel('templates')}>Open</V2Button>}
            more={[
              { label: 'Save new template', icon: <DocumentDuplicateIcon className={ic} />, onClick: p.onNewTemplate },
              { label: 'Import from code', icon: <LinkIcon className={ic} />, onClick: p.onImportTemplateCode },
            ]}
          />
          <TaskTile
            icon={<Cog6ToothIcon className="w-[18px] h-[18px]" />}
            title="Configuration"
            line="Export everything, or start over"
            button={<V2Button onClick={p.onExportConfig}>Export</V2Button>}
            dropProps={dropFor(p.onConfigDrop)}
            more={[
              { label: busy.importingConfig ? 'Importing…' : 'Import config', icon: <DocumentArrowDownIcon className={ic} />, onClick: p.onPickConfigFile, disabled: busy.importingConfig },
              { label: 'Reset config', icon: <ExclamationTriangleIcon className={ic} />, onClick: p.onResetConfig, danger: true },
            ]}
          />
        </div>
      ),
    },
    safe: {
      body: (
        <div className="v2-tiles v2-tiles-2">
          <TaskTile
            icon={<ArchiveBoxIcon className="w-[18px] h-[18px]" />}
            title="Backups"
            line={p.backups.length > 0 ? `${p.backups.length} kept · newest ${p.formatBackupDate(newest.createdAt)}` : (p.loadingBackups ? 'Loading…' : 'None yet')}
            button={<V2Button onClick={() => setPanel('backups')}>Open</V2Button>}
          />
          <TaskTile
            icon={<LockClosedIcon className="w-[18px] h-[18px]" />}
            title="Recovery kit"
            line="Everything you need if this server is lost"
            button={<V2Button onClick={() => setPanel('kit')}>Export</V2Button>}
          />
          <TaskTile
            icon={<ArrowsRightLeftIcon className="w-[18px] h-[18px]" />}
            title="Move to a new server"
            line="Bring this install to another machine"
            button={<V2Button onClick={() => setPanel('move')}>Start</V2Button>}
          />
        </div>
      ),
    },
  };

  const schedModal = (id: Panel, title: string, select: ReactNode) => (
    <Modal isOpen={panel === id} onClose={() => setPanel(null)} title={title} size="sm">
      <div className="space-y-3">
        {select}
        <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={() => setPanel(null)}>Done</Button></div>
      </div>
    </Modal>
  );

  const selectedUser = p.users.find((u) => u.id === p.selectedUserId);
  const selectedHistoryUser = p.users.find((u) => u.id === p.selectedHistoryUserId);

  return (
    <>
      <ArrangeBar arrange={arrange} />
      {arrange.shown.map((key) => {
        const def = TASK_SECTIONS.find((s) => s.key === key);
        const s = sections[key];
        if (!def || !s) return null;
        return <ArrangeSection key={key} arrange={arrange} id={key} title={def.label} meta={s.meta} noun="section">{s.body}</ArrangeSection>;
      })}
      <HiddenTray arrange={arrange} labelOf={(id) => `${TASK_SECTIONS.find((s) => s.key === id)?.label ?? 'Section'} (section)`} />

      {schedModal('sched-sync', 'Sync every group', (
        <select value={p.syncFrequency} onChange={(e) => p.onSyncFrequency(e.target.value)} className="input-base px-3 py-2 w-full text-sm" aria-label="How often groups sync">
          <option value="0">Disabled</option>
          <option value="1h">Every hour</option>
          <option value="1d">Every day</option>
          <option value="7d">Every 7 days</option>
          <option value="15d">Every 15 days</option>
          <option value="30d">Every 30 days</option>
        </select>
      ))}
      {schedModal('sched-backup', 'Backup', (
        <select value={p.backupDays} onChange={(e) => p.onBackupDays(Number(e.target.value))} className="input-base px-3 py-2 w-full text-sm" aria-label="How often to back up">
          <option value={0}>Disabled</option>
          <option value={1}>Every day</option>
          <option value={7}>Every week</option>
          <option value={15}>Every 15 days</option>
          <option value={30}>Every month</option>
        </select>
      ))}
      {schedModal('sched-health', 'Check addons', (
        <>
          <select value={p.healthCheckMinutes} onChange={(e) => p.onHealthMinutes(Number(e.target.value))} disabled={p.isHealthCheckLoading} className="input-base px-3 py-2 w-full text-sm" aria-label="How often to check addons">
            <option value={0}>Disabled</option>
            <option value={5}>Every 5 minutes</option>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
            <option value={180}>Every 3 hours</option>
            <option value={360}>Every 6 hours</option>
            <option value={720}>Every 12 hours</option>
            <option value={1440}>Every 24 hours</option>
          </select>
          <p className="text-xs text-muted">Checks that each addon’s manifest answers and tracks which are online.</p>
        </>
      ))}

      <Modal isOpen={panel === 'library'} onClose={() => setPanel(null)} title="Libraries" size="md">
        <p className="text-sm text-muted mb-3">Export someone’s Stremio or Nuvio library.</p>
        <div className="flex flex-wrap gap-3 items-center">
          <UserSelect value={p.selectedUserId} onChange={p.onSelectUser} users={p.users} allLabel="Select a user..." />
          <Button variant="secondary" size="sm" onClick={p.onExportLibrary} isLoading={busy.isExportingLibrary} leftIcon={!busy.isExportingLibrary ? <ArrowUpTrayIcon className={ic} /> : undefined} disabled={!p.selectedUserId}>
            {busy.isExportingLibrary ? 'Exporting...' : 'Export'}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={then(p.onClearLibrary)}
            isLoading={busy.isClearingLibrary}
            leftIcon={!busy.isClearingLibrary ? <TrashIcon className={ic} /> : undefined}
            // Clearing reaches into a Stremio account only.
            disabled={!p.selectedUserId || (selectedUser?.providerType || 'stremio') !== 'stremio'}
            title={p.selectedUserId && (selectedUser?.providerType || 'stremio') !== 'stremio' ? 'Clearing a library works for Stremio accounts only' : undefined}
          >
            {busy.isClearingLibrary ? 'Clearing...' : 'Clear Library'}
          </Button>
        </div>
        {selectedUser && <UserCard user={selectedUser} />}
      </Modal>

      <Modal isOpen={panel === 'history'} onClose={() => setPanel(null)} title="Watch history" size="md">
        <p className="text-sm text-muted mb-3">Import or export watch history and sessions.</p>
        <div className="flex flex-wrap gap-3 items-center">
          <UserSelect value={p.selectedHistoryUserId} onChange={p.onSelectHistoryUser} users={p.users} allLabel="All Users" />
          <Button variant="secondary" size="sm" onClick={p.onPickHistoryFile} isLoading={busy.isImportingHistory} leftIcon={!busy.isImportingHistory ? <ArrowDownTrayIcon className={ic} /> : undefined}>
            {busy.isImportingHistory ? 'Importing...' : 'Import'}
          </Button>
          <Button variant="secondary" size="sm" onClick={p.onExportHistory} isLoading={busy.isExportingHistory} leftIcon={!busy.isExportingHistory ? <ArrowUpTrayIcon className={ic} /> : undefined}>
            {busy.isExportingHistory ? 'Exporting...' : 'Export'}
          </Button>
          <Button variant="danger" size="sm" onClick={then(p.onClearHistory)} isLoading={busy.isClearingHistory} leftIcon={!busy.isClearingHistory ? <TrashIcon className={ic} /> : undefined} disabled={p.selectedHistoryUserId === 'all'}>
            {busy.isClearingHistory ? 'Clearing...' : 'Clear History'}
          </Button>
        </div>
        {p.selectedHistoryUserId !== 'all' && selectedHistoryUser && <UserCard user={selectedHistoryUser} />}
        <p className="text-xs text-muted mt-3">
          {p.selectedHistoryUserId === 'all'
            ? 'Export all users’ watch history, or import history for existing users. Select a specific user to clear their history.'
            : 'Export or import watch history for the selected user only. Clear history will delete all local watch records.'}
        </p>
      </Modal>

      <Modal isOpen={panel === 'templates'} onClose={() => setPanel(null)} title="Addon templates" size="lg">
        <p className="text-sm text-muted mb-3">Save a user’s or group’s addon set, then deploy it to anyone.</p>
        <div className="flex flex-wrap gap-2 mb-4">
          <Button variant="secondary" size="sm" onClick={then(p.onNewTemplate)} leftIcon={<DocumentDuplicateIcon className={ic} />}>Save New Template</Button>
          <Button variant="secondary" size="sm" onClick={then(p.onImportTemplateCode)} leftIcon={<LinkIcon className={ic} />}>Import from Code</Button>
        </div>
        {!p.loadingSnapshots && p.snapshots.length === 0 && <p className="text-xs text-muted">No templates saved yet.</p>}
        <div className="space-y-2">
          {p.snapshots.map((snap) => {
            const sourceName = snap.sourceType === 'user'
              ? (p.users.find((u) => u.id === snap.sourceId)?.name || displayEmail(p.users.find((u) => u.id === snap.sourceId)?.email) || 'Unknown user')
              : (p.groups.find((g) => g.id === snap.sourceId)?.name || 'Unknown group');
            return (
              <div key={snap.id} className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-default bg-subtle">
                <div className="min-w-0 flex-1 basis-[200px]">
                  <p className="text-sm font-medium text-default truncate">{snap.name}</p>
                  <p className="text-xs text-muted truncate">
                    {snap.addonCount} addon{snap.addonCount !== 1 ? 's' : ''} &middot; {snap.sourceType === 'user' ? 'User' : 'Group'}: {sourceName} &middot; {new Date(snap.createdAt).toLocaleDateString()}
                  </p>
                  {snap.description && <p className="text-xs text-subtle truncate mt-0.5">{snap.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="ghost" size="sm" onClick={then(() => p.onShareTemplate(snap))} leftIcon={<LinkIcon className={ic} />} title="Turn this template into a copy-paste share code">Share</Button>
                  <Button variant="secondary" size="sm" onClick={then(() => p.onDeployTemplate(snap))} leftIcon={<PaperAirplaneIcon className={ic} />}>Deploy</Button>
                  <Button variant="danger" size="sm" onClick={then(() => p.onDeleteTemplate(snap))} isLoading={p.deletingSnapshotId === snap.id} leftIcon={p.deletingSnapshotId !== snap.id ? <TrashIcon className={ic} /> : undefined}>Delete</Button>
                </div>
              </div>
            );
          })}
        </div>
      </Modal>

      <Modal isOpen={panel === 'backups'} onClose={() => setPanel(null)} title="Backups" size="md">
        <div className="flex items-center gap-3 mb-3">
          <p className="text-sm text-muted flex-1">Saved configuration snapshots.</p>
          <Button variant="secondary" size="sm" onClick={p.onBackupNow} isLoading={busy.isBackupRunning} leftIcon={!busy.isBackupRunning ? <ArrowPathIcon className={ic} /> : undefined} title="Run backup now">Backup Now</Button>
        </div>
        {p.backups.length > 0 ? (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {p.backups.map((backup) => (
              <div key={backup.filename} className="flex flex-wrap items-center justify-between gap-3 p-2.5 rounded-lg border border-default bg-subtle">
                <div className="min-w-0">
                  <p className="text-sm text-default truncate">{p.formatBackupDate(backup.createdAt)}</p>
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs text-muted">{(backup.size / 1024).toFixed(1)} KB</p>
                    {backup.validation && (backup.validation.valid ? (
                      <span className="flex items-center gap-1 text-xs text-success" title="This backup would restore cleanly">
                        <CheckCircleIcon className="w-3.5 h-3.5" />
                        {backup.validation.counts ? `${backup.validation.counts.users}u/${backup.validation.counts.groups}g/${backup.validation.counts.addons}a` : 'Valid'}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-error" title={backup.validation.issues.join('\n')}>
                        <ExclamationTriangleIcon className="w-3.5 h-3.5" />
                        {backup.validation.issues.length} issue{backup.validation.issues.length === 1 ? '' : 's'}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => p.onDownloadBackup(backup.filename)} title="Download"><ArrowDownTrayIcon className={ic} /></Button>
                  <Button variant="ghost" size="sm" onClick={then(() => p.onUserRestore(backup))} title="Restore just one user from this backup"><UserIcon className={ic} /></Button>
                  <Button variant="ghost" size="sm" onClick={then(() => p.onRestoreBackup(backup))} isLoading={p.restoringBackup === backup.filename} title="Restore this backup">
                    {p.restoringBackup !== backup.filename && <ArrowUturnLeftIcon className={ic} />}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={then(() => p.onDeleteBackup(backup))} isLoading={p.deletingBackup === backup.filename} title="Delete">
                    {p.deletingBackup !== backup.filename && <TrashIcon className="w-4 h-4 text-error" />}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">{p.loadingBackups ? 'Loading backups...' : 'No backups yet - click “Backup Now” or wait for the schedule. Files are saved under server folder: data/backup/'}</p>
        )}
      </Modal>

      <Modal isOpen={panel === 'kit'} onClose={() => setPanel(null)} title="Recovery kit" size="md">
        <p className="text-sm text-muted mb-4">Users, groups, addons and the Vault in one passphrase-protected file you keep. It restores onto a fresh install even after this server is gone.</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Export</label>
            <div className="flex flex-wrap items-center gap-2">
              <PassphraseField value={p.kitExportPassphrase} onChange={p.onKitExportPassphrase} placeholder="Choose a passphrase (12+ characters)" />
              <Button variant="secondary" size="sm" onClick={p.onExportKit} isLoading={busy.isExportingDrk} leftIcon={!busy.isExportingDrk ? <ArrowDownTrayIcon className={ic} /> : undefined}>Download Kit</Button>
            </div>
            <p className="text-[11px] text-subtle mt-1">Write this passphrase down somewhere safe - it’s the only thing standing between this file and every credential in Vault, and it can’t be recovered if lost.</p>
          </div>
          <div className="pt-3 border-t border-default">
            <label className="block text-xs font-medium text-muted mb-1.5">Restore</label>
            <div className="flex flex-wrap items-center gap-2">
              <PassphraseField value={p.kitImportPassphrase} onChange={p.onKitImportPassphrase} placeholder="Passphrase this kit was exported with" />
              <Button variant="danger" size="sm" onClick={() => {
                if (p.kitImportPassphrase.trim().length === 0) { toast.error('Enter the passphrase this kit was exported with first'); return; }
                setPanel(null);
                p.onPickKitFile();
              }} isLoading={busy.isImportingDrk} leftIcon={!busy.isImportingDrk ? <ArrowUpTrayIcon className={ic} /> : undefined}>Choose Kit File</Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal isOpen={panel === 'move'} onClose={() => setPanel(null)} title="Move to a new server" size="lg">
        <p className="text-sm text-muted">One code moves everything, live, no file to handle - for when the old server is still running. If it is already gone, restore a recovery kit instead.</p>
        <div className="grid gap-4 sm:grid-cols-2 mt-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">This is the OLD server</label>
            <p className="text-xs text-subtle mb-2">Generate a code here, paste it on the new instance. Single-use, dies in 15 minutes, and the new server fetches directly from this one - both must be able to reach each other.</p>
            <Button variant="secondary" size="sm" onClick={p.onOfferMigration} isLoading={busy.isOfferingMigration}>Generate migration code</Button>
            {p.migrationCode && (
              <div className="flex items-center gap-2 mt-2">
                <code className="flex-1 p-2 bg-surface-hover rounded-lg text-xs text-subtle break-all font-mono">{p.migrationCode}</code>
                <Button variant="ghost" size="sm" aria-label="Copy code" onClick={async () => { (await copyToClipboard(p.migrationCode!)) ? toast.success('Code copied') : toast.error('Couldn’t copy the code', { line: 'Select the text and copy it by hand.' }); }}>
                  <DocumentDuplicateIcon className={ic} />
                </Button>
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">This is the NEW server</label>
            <p className="text-xs text-subtle mb-2">Paste the code from the old instance. This REPLACES everything currently here - meant for a fresh install.</p>
            <div className="flex items-center gap-2">
              <input value={p.receiveCode} onChange={(e) => p.onReceiveCode(e.target.value)} placeholder="slickmig1.…" autoComplete="off" spellCheck={false} className="input-base flex-1 min-w-0 px-3 py-2 text-sm font-mono" />
              <Button variant="primary" size="sm" onClick={then(p.onReceiveMigration)} isLoading={busy.isReceivingMigration} disabled={!p.receiveCode.trim()}>Receive</Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}

