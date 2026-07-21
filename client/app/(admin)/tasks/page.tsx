'use client';

import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Header } from '@/components/layout/Header';
import { Button, Card, Badge, UserAvatar, ConfirmModal, Modal, Input } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaTopbar, NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { api, User, Group, AddonSnapshot, BackupFile } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import {
  ArrowPathIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  UserGroupIcon,
  UsersIcon,
  PuzzlePieceIcon,
  WrenchScrewdriverIcon,
  ClockIcon,
  FolderArrowDownIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  DocumentArrowDownIcon,
  DocumentArrowUpIcon,
  ArchiveBoxIcon,
  CalendarDaysIcon,
  UserIcon,
  HeartIcon,
  DocumentDuplicateIcon,
  PaperAirplaneIcon,
  ArrowUturnLeftIcon,
} from '@heroicons/react/24/outline';

// Task action card component
function TaskCard({
  icon,
  iconBg,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card padding="lg" className="mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconBg}`}>
          {icon}
        </div>
        <div>
          <h3 className="text-base font-semibold font-display text-default">{title}</h3>
          <p className="text-xs text-muted">{description}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        {children}
      </div>
    </Card>
  );
}

// Action button with loading state
function ActionButton({
  onClick,
  icon,
  label,
  loadingLabel,
  isLoading,
  variant = 'secondary',
  isDragging,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  loadingLabel?: string;
  isLoading?: boolean;
  variant?: 'secondary' | 'danger';
  isDragging?: boolean;
}) {
  return (
    <Button
      variant={variant === 'danger' ? 'danger' : 'secondary'}
      size="sm"
      onClick={onClick}
      isLoading={isLoading}
      leftIcon={!isLoading ? icon : undefined}
      className={isDragging ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface' : ''}
    >
      {isLoading ? (loadingLabel || 'Processing...') : label}
    </Button>
  );
}

export default function TasksPage() {
  const { layoutMode } = useLayoutMode();
  // State for loading indicators
  const [syncingUsers, setSyncingUsers] = useState(false);
  const [syncingGroups, setSyncingGroups] = useState(false);
  const [deletingUsers, setDeletingUsers] = useState(false);
  const [deletingGroups, setDeletingGroups] = useState(false);
  const [deletingAddons, setDeletingAddons] = useState(false);
  const [clearingUserAddons, setClearingUserAddons] = useState(false);
  const [importingAddons, setImportingAddons] = useState(false);
  const [isDraggingAddons, setIsDraggingAddons] = useState(false);
  const [importingConfig, setImportingConfig] = useState(false);
  const [isDraggingConfig, setIsDraggingConfig] = useState(false);
  const [reloadingAddons, setReloadingAddons] = useState(false);
  const [repairingAddons, setRepairingAddons] = useState(false);
  const [resettingConfig, setResettingConfig] = useState(false);
  const [isBackupRunning, setIsBackupRunning] = useState(false);
  const [isSyncRunning, setIsSyncRunning] = useState(false);
  const [isExportingLibrary, setIsExportingLibrary] = useState(false);
  const [isExportingHistory, setIsExportingHistory] = useState(false);
  const [isImportingHistory, setIsImportingHistory] = useState(false);
  const [isClearingLibrary, setIsClearingLibrary] = useState(false);
  const [isClearingHistory, setIsClearingHistory] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmConfig, setConfirmConfig] = useState({
    title: '',
    description: '',
    variant: 'default' as 'default' | 'warning' | 'danger',
    onConfirm: () => {},
  });
  const addonFileInputRef = useRef<HTMLInputElement | null>(null);
  const configFileInputRef = useRef<HTMLInputElement | null>(null);
  const historyFileInputRef = useRef<HTMLInputElement | null>(null);

  // Users for library/history export
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedHistoryUserId, setSelectedHistoryUserId] = useState('all');

  // Fetch users for the library/history export selectors (was never being loaded)
  useEffect(() => {
    api.getUsers()
      .then(setUsers)
      .catch((e: any) => {
        console.error('Failed to load users for Tasks selectors:', e);
      });
  }, []);

  // Addon Templates (Snapshots) - save a user's/group's current addon set,
  // deploy it to any user later. Backend (/api/snapshots) already existed
  // fully built but had no UI anywhere referencing it.
  const [groups, setGroups] = useState<Group[]>([]);
  const [snapshots, setSnapshots] = useState<AddonSnapshot[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [isCreateSnapshotOpen, setIsCreateSnapshotOpen] = useState(false);
  const [newSnapshotName, setNewSnapshotName] = useState('');
  const [newSnapshotDescription, setNewSnapshotDescription] = useState('');
  const [newSnapshotSourceType, setNewSnapshotSourceType] = useState<'user' | 'group'>('user');
  const [newSnapshotSourceId, setNewSnapshotSourceId] = useState('');
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [deployingSnapshot, setDeployingSnapshot] = useState<AddonSnapshot | null>(null);
  const [deployTargetUserId, setDeployTargetUserId] = useState('');
  const [isDeploying, setIsDeploying] = useState(false);
  const [deletingSnapshotId, setDeletingSnapshotId] = useState<string | null>(null);

  useEffect(() => {
    api.getGroups().then(setGroups).catch(() => {});
  }, []);

  const fetchSnapshots = () => {
    setLoadingSnapshots(true);
    api.getSnapshots()
      .then(setSnapshots)
      .catch((e: any) => toast.error(e.message || 'Failed to load addon templates'))
      .finally(() => setLoadingSnapshots(false));
  };
  useEffect(fetchSnapshots, []);

  // Restore from Backup - Automatic Backups already wrote timestamped
  // config-backup-*.json files to data/backup/, but nothing in the UI ever
  // listed, downloaded, or restored from them - only a manual "Backup Now"
  // trigger and a frequency picker existed.
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null);

  const fetchBackups = () => {
    setLoadingBackups(true);
    api.listBackups()
      .then(setBackups)
      .catch((e: any) => toast.error(e.message || 'Failed to load backups'))
      .finally(() => setLoadingBackups(false));
  };
  useEffect(fetchBackups, []);

  // Scheduling settings
  const [syncFrequency, setSyncFrequency] = useState('0');
  const [backupDays, setBackupDays] = useState(0);
  const [healthCheckMinutes, setHealthCheckMinutes] = useState(30);
  const [isHealthCheckLoading, setIsHealthCheckLoading] = useState(false);
  const [isRunningHealthCheck, setIsRunningHealthCheck] = useState(false);

// Metrics migration - DISABLED
  // const [migrationPreview, setMigrationPreview] = useState<{
  //   migrationStatus: { hasExistingData: boolean; alreadyMigrated: boolean; sessionsCount: number; episodesCount: number; activitiesCount: number };
  //   users: { userId: string; username: string; movies: number; shows: number; watchTimeHours: number }[];
  //   totals: { users: number; movies: number; shows: number; watchTimeHours: number; pendingMigration: boolean };
  // } | null>(null);
  // const [isLoadingMigration, setIsLoadingMigration] = useState(false);
  // const [isRunningMigration, setIsRunningMigration] = useState(false);
  // const [showMigrationConfirm, setShowMigrationConfirm] = useState(false);

  // // Metrics migration handlers
  // const handleLoadMigrationPreview = async () => {
  //   setIsLoadingMigration(true);
  //   try {
  //     const preview = await api.getMetricsMigrationPreview();
  //     setMigrationPreview(preview);
  //   } catch (e: any) {
  //     toast.error(e.message || 'Failed to load migration preview');
  //   } finally {
  //     setIsLoadingMigration(false);
  //   }
  // };
  //
  // const handleRunMigration = async () => {
  //   setIsRunningMigration(true);
  //   try {
  //     const result = await api.runMetricsMigration();
  //     if (result.migrated) {
  //       toast.success(`Migration complete: ${result.sessionsCreated} sessions, ${result.episodesCreated} episodes created`);
  //       setMigrationPreview(null);
  //       setShowMigrationConfirm(false);
  //     } else {
  //       toast.info(result.reason || 'Migration skipped');
  //     }
  //   } catch (e: any) {
  //     toast.error(e.message || 'Failed to run migration');
  //   } finally {
  //     setIsRunningMigration(false);
  //   }
  // };

  const openConfirm = (config: typeof confirmConfig) => {
    setConfirmConfig(config);
    setConfirmOpen(true);
  };

  /*
  // Metrics migration handlers
  const handleLoadMigrationPreview = async () => {
    setIsLoadingMigration(true);
    try {
      const preview = await api.getMetricsMigrationPreview();
      setMigrationPreview(preview);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load migration preview');
    } finally {
      setIsLoadingMigration(false);
    }
  };

  const handleRunMigration = async () => {
    setIsMigrating(true);
    try {
      const result = await api.runMetricsMigration();
      if (result.migrated) {
        toast.success(`Migration complete: ${result.sessionsCreated} sessions, ${result.episodesCreated} episodes created`);
        setMigrationPreview(null);
        setShowMigrationConfirm(false);
      } else {
        toast.success(result.reason === 'already_has_data' ? 'Data already migrated' : 'No data to migrate');
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to run migration');
    } finally {
      setIsMigrating(false);
    }
  };
  */

  // User actions
  const handleSyncAllUsers = async () => {
    setSyncingUsers(true);
    try {
      const result = await api.syncAllUsers();
      if (result.failed === 0) {
        toast.success(`Synced ${result.success} user${result.success !== 1 ? 's' : ''} successfully`);
      } else {
        toast.success(`Synced ${result.success} user${result.success !== 1 ? 's' : ''}, ${result.failed} failed`);
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to sync users');
    } finally {
      setSyncingUsers(false);
    }
  };

  const handleDeleteAllUsers = () => {
    openConfirm({
      title: 'Delete All Users',
      description: 'Are you sure you want to delete ALL users? This cannot be undone.',
      variant: 'danger',
      onConfirm: async () => {
        setDeletingUsers(true);
        try {
          const result = await api.deleteAllUsers();
          toast.success(`Deleted ${result.success} user${result.success !== 1 ? 's' : ''}`);
        } catch (e: any) {
          toast.error(e.message || 'Failed to delete users');
        } finally {
          setDeletingUsers(false);
        }
      },
    });
  };

  const handleClearAllUserAddons = () => {
    openConfirm({
      title: 'Clear All User Addons',
      description: 'Clear addons from ALL users? This will remove addons from users but keep the users and addons themselves.',
      variant: 'warning',
      onConfirm: async () => {
        setClearingUserAddons(true);
        try {
          const result = await api.clearAllUserAddons();
           toast.success(`Cleared addons from ${result.success} user${result.success !== 1 ? 's' : ''}`);
        } catch (e: any) {
          toast.error(e.message || 'Failed to clear user addons');
        } finally {
          setClearingUserAddons(false);
        }
      },
    });
  };

  // Group actions
  const handleSyncAllGroups = async () => {
    setSyncingGroups(true);
    try {
      const result = await api.syncAllGroups();
      if (result.failedGroups === 0) {
        toast.success(`Synced ${result.syncedGroups} group${result.syncedGroups !== 1 ? 's' : ''} (${result.totalUsersSynced} user${result.totalUsersSynced !== 1 ? 's' : ''})`);
      } else {
        toast.success(`Synced ${result.syncedGroups} group${result.syncedGroups !== 1 ? 's' : ''}, ${result.failedGroups} failed`);
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to sync groups');
    } finally {
      setSyncingGroups(false);
    }
  };

  const handleDeleteAllGroups = () => {
    openConfirm({
      title: 'Delete All Groups',
      description: 'Are you sure you want to delete ALL groups? This cannot be undone.',
      variant: 'danger',
      onConfirm: async () => {
        setDeletingGroups(true);
        try {
          const result = await api.deleteAllGroups();
           toast.success(`Deleted ${result.success} group${result.success !== 1 ? 's' : ''}`);
        } catch (e: any) {
          toast.error(e.message || 'Failed to delete groups');
        } finally {
          setDeletingGroups(false);
        }
      },
    });
  };

  // Addon actions
  const handleImportAddons = async (file: File) => {
    setImportingAddons(true);
    try {
      const result = await api.importAddons(file);
      toast.success(`Import complete: ${result.successful} successful, ${result.failed} failed, ${result.redundant} redundant`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to import addons');
    } finally {
      setImportingAddons(false);
    }
  };

  const handleExportAddons = async () => {
    try {
      const data = await api.exportAddons();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${date}-slicksync-addons.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Addons exported');
    } catch (e: any) {
      toast.error(e.message || 'Failed to export addons');
    }
  };

  const handleReloadAllAddons = async () => {
    setReloadingAddons(true);
    try {
      const result = await api.reloadAllAddons();
       toast.success(`Reloaded ${result.reloaded} addon${result.reloaded !== 1 ? 's' : ''}`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to reload addons');
    } finally {
      setReloadingAddons(false);
    }
  };

  const handleRepairAddons = async () => {
    setRepairingAddons(true);
    try {
      const result = await api.repairAddons();
       toast.success(`Repaired ${result.updated} of ${result.inspected} addon${result.inspected !== 1 ? 's' : ''}`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to repair addons');
    } finally {
      setRepairingAddons(false);
    }
  };

  const handleDeleteAllAddons = () => {
    openConfirm({
      title: 'Delete All Addons',
      description: 'Are you sure you want to delete ALL addons? This cannot be undone.',
      variant: 'danger',
      onConfirm: async () => {
        setDeletingAddons(true);
        try {
          const result = await api.deleteAllAddons();
           toast.success(`Deleted ${result.success} addon${result.success !== 1 ? 's' : ''}`);
        } catch (e: any) {
          toast.error(e.message || 'Failed to delete addons');
        } finally {
          setDeletingAddons(false);
        }
      },
    });
  };

  // Configuration actions
  const handleImportConfig = async (file: File) => {
    setImportingConfig(true);
    try {
      const result = await api.importConfig(file);
      const parts = [];
      if (result.users.created > 0) parts.push(`${result.users.created} user${result.users.created !== 1 ? 's' : ''}`);
      if (result.groups.created > 0) parts.push(`${result.groups.created} group${result.groups.created !== 1 ? 's' : ''}`);
      if (result.addons.created > 0) parts.push(`${result.addons.created} addon${result.addons.created !== 1 ? 's' : ''}`);
      toast.success(`Configuration imported${parts.length ? ': ' + parts.join(', ') : ''}`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to import configuration');
    } finally {
      setImportingConfig(false);
    }
  };

  const handleExportConfig = async () => {
    try {
      const data = await api.exportConfig();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const a = document.createElement('a');
      a.href = url;
      a.download = `${date}-slicksync-config.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Configuration exported');
    } catch (e: any) {
      toast.error(e.message || 'Failed to export configuration');
    }
  };

  const handleResetConfig = () => {
    openConfirm({
      title: 'Reset Configuration',
      description: 'Reset all configuration (users, groups, addons)? This cannot be undone.',
      variant: 'danger',
      onConfirm: async () => {
        setResettingConfig(true);
        try {
          await api.resetConfig();
          toast.success('Configuration reset');
        } catch (e: any) {
          toast.error(e.message || 'Failed to reset configuration');
        } finally {
          setResettingConfig(false);
        }
      },
    });
  };

  // Library export
  const handleExportLibrary = async () => {
    if (!selectedUserId) {
      toast.error('Please select a user');
      return;
    }
    setIsExportingLibrary(true);
    try {
      await api.backupUserLibrary(selectedUserId);
      toast.success('Library exported successfully');
    } catch (e: any) {
      toast.error(e.message || 'Failed to export library');
    } finally {
      setIsExportingLibrary(false);
    }
  };

  // History export
  const handleExportHistory = async () => {
    setIsExportingHistory(true);
    try {
      const userId = selectedHistoryUserId === 'all' ? undefined : selectedHistoryUserId;
      await api.exportHistory(userId);
      toast.success('History exported successfully');
    } catch (e: any) {
      toast.error(e.message || 'Failed to export history');
    } finally {
      setIsExportingHistory(false);
    }
  };

  // History import
  const handleImportHistory = async (file: File) => {
    setIsImportingHistory(true);
    try {
      const targetUserId = selectedHistoryUserId === 'all' ? undefined : selectedHistoryUserId;
      const result = await api.importHistory(file, targetUserId);
      const total = 
        (result.results?.watchSessions?.imported || 0) +
        (result.results?.episodeWatchHistory?.imported || 0) +
        (result.results?.watchActivity?.imported || 0);
      toast.success(`Imported ${total} history records`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to import history');
    } finally {
      setIsImportingHistory(false);
    }
  };

  // Clear library
  const handleClearLibrary = () => {
    if (!selectedUserId) {
      toast.error('Please select a user');
      return;
    }
    openConfirm({
      title: 'Clear Library',
      description: 'This will remove ALL items from the user\'s Stremio library. This action cannot be undone.',
      variant: 'danger',
      onConfirm: async () => {
        setIsClearingLibrary(true);
        try {
          const result = await api.clearUserLibrary(selectedUserId);
          toast.success(`Library cleared: ${result.deleted} items removed`);
        } catch (e: any) {
          toast.error(e.message || 'Failed to clear library');
        } finally {
          setIsClearingLibrary(false);
        }
      },
    });
  };

  // Clear history
  const handleClearHistory = () => {
    if (selectedHistoryUserId === 'all') {
      toast.error('Please select a specific user (not "All Users")');
      return;
    }
    openConfirm({
      title: 'Clear History',
      description: 'This will delete ALL local watch history for this user. This action cannot be undone.',
      variant: 'danger',
      onConfirm: async () => {
        setIsClearingHistory(true);
        try {
          const result = await api.clearUserHistory(selectedHistoryUserId);
          const total = 
            (result.deleted?.watchSessions || 0) +
            (result.deleted?.episodeWatchHistory || 0) +
            (result.deleted?.watchActivity || 0) +
            (result.deleted?.watchSnapshots || 0);
          toast.success(`History cleared: ${total} records deleted`);
        } catch (e: any) {
          toast.error(e.message || 'Failed to clear history');
        } finally {
          setIsClearingHistory(false);
        }
      },
    });
  };

  // Backup actions
  const handleBackupNow = async () => {
    setIsBackupRunning(true);
    try {
      await api.runBackupNow();
      toast.success('Backup started');
      fetchBackups();
    } catch (e: any) {
      toast.error(e.message || 'Failed to start backup');
    } finally {
      setIsBackupRunning(false);
    }
  };

  const handleBackupFrequencyChange = async (days: number) => {
    setBackupDays(days);
    try {
      await api.setBackupFrequency(days);
      toast.success('Backup schedule updated');
    } catch (e: any) {
      toast.error(e.message || 'Failed to update backup schedule');
    }
  };

  const formatBackupDate = (iso: string) => new Date(iso).toLocaleString();

  const handleDownloadBackup = async (filename: string) => {
    try {
      await api.downloadBackup(filename);
    } catch (e: any) {
      toast.error(e.message || 'Failed to download backup');
    }
  };

  // DESTRUCTIVE - replaces all current users/groups/addons. Reload after a
  // successful restore so every part of the app (this page included) picks
  // up the new data instead of continuing to show now-stale state.
  const handleRestoreBackup = (backup: BackupFile) => {
    openConfirm({
      title: 'Restore Backup',
      description: `This replaces ALL current users, groups, and addons with the contents of this backup (${formatBackupDate(backup.createdAt)}). Anything created or changed since then will be lost. This cannot be undone.`,
      variant: 'danger',
      onConfirm: async () => {
        setRestoringBackup(backup.filename);
        try {
          const result = await api.restoreBackup(backup.filename);
          toast.success(`Restored ${result.users.created + result.users.reused} users, ${result.groups.created + result.groups.reused} groups, ${result.addons.created + result.addons.reused} addons`);
          setTimeout(() => window.location.reload(), 1500);
        } catch (e: any) {
          toast.error(e.message || 'Failed to restore backup');
          setRestoringBackup(null);
        }
      },
    });
  };

  const handleDeleteBackup = (backup: BackupFile) => {
    openConfirm({
      title: 'Delete Backup',
      description: `Delete the backup from ${formatBackupDate(backup.createdAt)}? This cannot be undone.`,
      variant: 'danger',
      onConfirm: async () => {
        setDeletingBackup(backup.filename);
        try {
          await api.deleteBackup(backup.filename);
          toast.success('Backup deleted');
          fetchBackups();
        } catch (e: any) {
          toast.error(e.message || 'Failed to delete backup');
        } finally {
          setDeletingBackup(null);
        }
      },
    });
  };

  // Addon Template actions
  const handleCreateSnapshot = async () => {
    if (!newSnapshotName.trim() || !newSnapshotSourceId) {
      toast.error('Name and source are required');
      return;
    }
    setCreatingSnapshot(true);
    try {
      await api.createSnapshot({
        name: newSnapshotName.trim(),
        description: newSnapshotDescription.trim() || undefined,
        sourceType: newSnapshotSourceType,
        sourceId: newSnapshotSourceId,
      });
      toast.success('Template saved');
      setIsCreateSnapshotOpen(false);
      setNewSnapshotName('');
      setNewSnapshotDescription('');
      setNewSnapshotSourceId('');
      fetchSnapshots();
    } catch (e: any) {
      toast.error(e.message || 'Failed to save template');
    } finally {
      setCreatingSnapshot(false);
    }
  };

  const handleDeploySnapshot = async () => {
    if (!deployingSnapshot || !deployTargetUserId) return;
    setIsDeploying(true);
    try {
      const result = await api.deploySnapshot(deployingSnapshot.id, deployTargetUserId);
      toast.success(`Deployed ${result.deployed} addon${result.deployed !== 1 ? 's' : ''}${result.failed ? `, ${result.failed} failed` : ''}`);
      setDeployingSnapshot(null);
      setDeployTargetUserId('');
    } catch (e: any) {
      toast.error(e.message || 'Failed to deploy template');
    } finally {
      setIsDeploying(false);
    }
  };

  const handleDeleteSnapshot = (snapshot: AddonSnapshot) => {
    openConfirm({
      title: 'Delete Template',
      description: `Delete the "${snapshot.name}" template? This cannot be undone.`,
      variant: 'danger',
      onConfirm: async () => {
        setDeletingSnapshotId(snapshot.id);
        try {
          await api.deleteSnapshot(snapshot.id);
          toast.success('Template deleted');
          fetchSnapshots();
        } catch (e: any) {
          toast.error(e.message || 'Failed to delete template');
        } finally {
          setDeletingSnapshotId(null);
        }
      },
    });
  };

  // Sync actions
  const handleSyncNow = async () => {
    setIsSyncRunning(true);
    try {
      const result = await api.syncAllGroups();
      toast.success(`Sync completed: ${result.syncedGroups} synced, ${result.failedGroups} failed`);
    } catch (e: any) {
      toast.error(e.message || 'Failed to start sync');
    } finally {
      setIsSyncRunning(false);
    }
  };

  // Sync schedule
  const handleSyncFrequencyChange = async (frequency: string) => {
    setSyncFrequency(frequency);
    try {
      await api.updateSyncSettings({ 
        enabled: frequency !== '0', 
        frequency 
      });
      toast.success('Sync schedule updated');
    } catch (e: any) {
      toast.error(e.message || 'Failed to update sync schedule');
    }
  };

  // Addon health check schedule
  const handleHealthCheckIntervalChange = async (minutes: number) => {
    setHealthCheckMinutes(minutes);
    setIsHealthCheckLoading(true);
    try {
      await api.setAddonHealthCheckInterval(minutes);
      toast.success('Health check interval updated. Restart server to apply changes.');
    } catch (e: any) {
      toast.error(e.message || 'Failed to update health check interval');
    } finally {
      setIsHealthCheckLoading(false);
    }
  };

  const handleRunHealthCheckNow = async () => {
    setIsRunningHealthCheck(true);
    try {
      await api.runAddonHealthCheckNow();
      toast.success('Health check started');
    } catch (e: any) {
      toast.error(e.message || 'Failed to start health check');
    } finally {
      setIsRunningHealthCheck(false);
    }
  };

  // File input handlers
  const handleAddonFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImportAddons(file);
      e.target.value = '';
    }
  };

  const handleConfigFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImportConfig(file);
      e.target.value = '';
    }
  };

  const handleHistoryFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImportHistory(file);
      e.target.value = '';
    }
  };

  // Drag and drop handlers
  const handleAddonDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingAddons(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleImportAddons(file);
  };

  const handleConfigDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingConfig(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleImportConfig(file);
  };

  return (
    <>
      {layoutMode === 'nebula' ? (
        <NebulaTopbar />
      ) : (
        <Header
          title="Tasks"
          subtitle="Manage and export all your SlickSync data"
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-6 lg:p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : 'max-w-3xl'} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
      {layoutMode === 'nebula' && (
        <NebulaPageHeading title="Tasks" subtitle="Manage and export all your SlickSync data" />
      )}
        {/* Users */}
        <PageSection>
          <TaskCard
            icon={<UsersIcon className="w-5 h-5 text-secondary" />}
            iconBg="bg-secondary-muted"
            title="Users"
            description="Manage users and their data"
          >
            <ActionButton
              onClick={handleSyncAllUsers}
              icon={<ArrowPathIcon className="w-4 h-4" />}
              label="Sync All Users"
              loadingLabel="Syncing..."
              isLoading={syncingUsers}
            />
            <ActionButton
              onClick={handleDeleteAllUsers}
              icon={<TrashIcon className="w-4 h-4" />}
              label="Delete All Users"
              loadingLabel="Deleting..."
              isLoading={deletingUsers}
              variant="danger"
            />
            <ActionButton
              onClick={handleClearAllUserAddons}
              icon={<ArrowPathIcon className="w-4 h-4" />}
              label="Clear User Addons"
              loadingLabel="Clearing..."
              isLoading={clearingUserAddons}
            />
          </TaskCard>
        </PageSection>

        {/* Groups */}
        <PageSection delay={0.05}>
          <TaskCard
            icon={<UserGroupIcon className="w-5 h-5 text-primary" />}
            iconBg="bg-primary-muted"
            title="Groups"
            description="Manage groups and sync operations"
          >
            <ActionButton
              onClick={handleSyncAllGroups}
              icon={<ArrowPathIcon className="w-4 h-4" />}
              label="Sync All Groups"
              loadingLabel="Syncing..."
              isLoading={syncingGroups}
            />
            <ActionButton
              onClick={handleDeleteAllGroups}
              icon={<TrashIcon className="w-4 h-4" />}
              label="Delete All Groups"
              loadingLabel="Deleting..."
              isLoading={deletingGroups}
              variant="danger"
            />
          </TaskCard>
        </PageSection>

        {/* Addons */}
        <PageSection delay={0.1}>
          <TaskCard
            icon={<PuzzlePieceIcon className="w-5 h-5 text-success" />}
            iconBg="bg-success-muted"
            title="Addons"
            description="Import, export, and manage addons"
          >
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDraggingAddons(true); }}
              onDragLeave={() => setIsDraggingAddons(false)}
              onDrop={handleAddonDrop}
            >
              <ActionButton
                onClick={() => addonFileInputRef.current?.click()}
                icon={<ArrowDownTrayIcon className="w-4 h-4" />}
                label={isDraggingAddons ? 'Drop Addons' : 'Import Addons'}
                loadingLabel="Importing..."
                isLoading={importingAddons}
                isDragging={isDraggingAddons}
              />
            </div>
            <ActionButton
              onClick={handleExportAddons}
              icon={<ArrowUpTrayIcon className="w-4 h-4" />}
              label="Export Addons"
            />
            <ActionButton
              onClick={handleReloadAllAddons}
              icon={<ArrowPathIcon className="w-4 h-4" />}
              label="Reload All"
              loadingLabel="Reloading..."
              isLoading={reloadingAddons}
            />
            <ActionButton
              onClick={handleRepairAddons}
              icon={<WrenchScrewdriverIcon className="w-4 h-4" />}
              label="Repair"
              loadingLabel="Repairing..."
              isLoading={repairingAddons}
            />
            <ActionButton
              onClick={handleDeleteAllAddons}
              icon={<TrashIcon className="w-4 h-4" />}
              label="Delete All"
              loadingLabel="Deleting..."
              isLoading={deletingAddons}
              variant="danger"
            />
          </TaskCard>
          <input
            ref={addonFileInputRef}
            type="file"
            accept=".json"
            onChange={handleAddonFileChange}
            className="hidden"
          />
        </PageSection>

        {/* Addon Templates - the backend (/api/snapshots) already existed
            fully built (save a user's/group's current addon set, deploy it
            to any user later) but had no UI anywhere calling it. */}
        <PageSection delay={0.12}>
          <TaskCard
            icon={<DocumentDuplicateIcon className="w-5 h-5 text-secondary" />}
            iconBg="bg-secondary-muted"
            title="Addon Templates"
            description="Save a user's or group's addon set, deploy it to anyone"
          >
            <ActionButton
              onClick={() => setIsCreateSnapshotOpen(true)}
              icon={<DocumentDuplicateIcon className="w-4 h-4" />}
              label="Save New Template"
            />
          </TaskCard>
          {!loadingSnapshots && snapshots.length === 0 && (
            <p className="text-xs text-muted mb-6 -mt-3">No templates saved yet.</p>
          )}
          {snapshots.length > 0 && (
            <Card padding="lg" className="mb-6">
              <div className="space-y-2">
                {snapshots.map((snap) => {
                  const sourceName = snap.sourceType === 'user'
                    ? (users.find(u => u.id === snap.sourceId)?.name || users.find(u => u.id === snap.sourceId)?.email || 'Unknown user')
                    : (groups.find(g => g.id === snap.sourceId)?.name || 'Unknown group');
                  return (
                    <div key={snap.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-default bg-subtle">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-default truncate">{snap.name}</p>
                        <p className="text-xs text-muted truncate">
                          {snap.addonCount} addon{snap.addonCount !== 1 ? 's' : ''} &middot; {snap.sourceType === 'user' ? 'User' : 'Group'}: {sourceName} &middot; {new Date(snap.createdAt).toLocaleDateString()}
                        </p>
                        {snap.description && <p className="text-xs text-subtle truncate mt-0.5">{snap.description}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => { setDeployingSnapshot(snap); setDeployTargetUserId(''); }}
                          leftIcon={<PaperAirplaneIcon className="w-4 h-4" />}
                        >
                          Deploy
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleDeleteSnapshot(snap)}
                          isLoading={deletingSnapshotId === snap.id}
                          leftIcon={deletingSnapshotId !== snap.id ? <TrashIcon className="w-4 h-4" /> : undefined}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </PageSection>

        {/* Library */}
        <PageSection delay={0.15}>
          <Card padding="lg" className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-warning-muted">
                <FolderArrowDownIcon className="w-5 h-5 text-warning" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Library</h3>
                <p className="text-xs text-muted">Export a user's Stremio library</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-center">
              <div className="relative flex-1 min-w-[200px]">
                <select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="input-base px-3 py-2 w-full appearance-none pr-10 text-sm"
                >
                  <option value="">Select a user...</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email || user.id} ({user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'})
                    </option>
                  ))}
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                  <UserIcon className="w-4 h-4 text-muted" />
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleExportLibrary}
                isLoading={isExportingLibrary}
                leftIcon={!isExportingLibrary ? <ArrowUpTrayIcon className="w-4 h-4" /> : undefined}
                disabled={!selectedUserId}
              >
                {isExportingLibrary ? 'Exporting...' : 'Export'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleClearLibrary}
                isLoading={isClearingLibrary}
                leftIcon={!isClearingLibrary ? <TrashIcon className="w-4 h-4" /> : undefined}
                disabled={!selectedUserId}
              >
                {isClearingLibrary ? 'Clearing...' : 'Clear Library'}
              </Button>
            </div>
            {selectedUserId && (() => {
              const user = users.find(u => u.id === selectedUserId);
              if (!user) return null;
              return (
                <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-subtle">
                  <UserAvatar userId={user.id} name={user.name || user.email || 'U'} email={user.email} colorIndex={user.colorIndex} src={user.avatarUrl || undefined} size="sm" />
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-default truncate">{user.name || user.email || user.id}</p>
                      {user.email && user.name && (
                        <p className="text-xs text-muted truncate">{user.email}</p>
                      )}
                    </div>
                    <Badge variant={user.providerType === 'nuvio' ? 'nuvio' : 'stremio'} size="sm">
                      {user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'}
                    </Badge>
                  </div>
                </div>
              );
            })()}
          </Card>
        </PageSection>

        {/* History */}
        <PageSection delay={0.2}>
          <Card padding="lg" className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-rose-500/20">
                <ClockIcon className="w-5 h-5 text-rose-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">History</h3>
                <p className="text-xs text-muted">Import or export watch history and sessions</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-center">
              <div className="relative flex-1 min-w-[200px]">
                <select
                  value={selectedHistoryUserId}
                  onChange={(e) => setSelectedHistoryUserId(e.target.value)}
                  className="input-base px-3 py-2 w-full appearance-none pr-10 text-sm"
                >
                  <option value="all">All Users</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email || user.id} ({user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'})
                    </option>
                  ))}
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                  <UserIcon className="w-4 h-4 text-muted" />
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => historyFileInputRef.current?.click()}
                isLoading={isImportingHistory}
                leftIcon={!isImportingHistory ? <ArrowDownTrayIcon className="w-4 h-4" /> : undefined}
              >
                {isImportingHistory ? 'Importing...' : 'Import'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleExportHistory}
                isLoading={isExportingHistory}
                leftIcon={!isExportingHistory ? <ArrowUpTrayIcon className="w-4 h-4" /> : undefined}
              >
                {isExportingHistory ? 'Exporting...' : 'Export'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleClearHistory}
                isLoading={isClearingHistory}
                leftIcon={!isClearingHistory ? <TrashIcon className="w-4 h-4" /> : undefined}
                disabled={selectedHistoryUserId === 'all'}
              >
                {isClearingHistory ? 'Clearing...' : 'Clear History'}
              </Button>
            </div>
            {selectedHistoryUserId !== 'all' && (() => {
              const user = users.find(u => u.id === selectedHistoryUserId);
              if (!user) return null;
              return (
                <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-subtle">
                  <UserAvatar userId={user.id} name={user.name || user.email || 'U'} email={user.email} colorIndex={user.colorIndex} src={user.avatarUrl || undefined} size="sm" />
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-default truncate">{user.name || user.email || user.id}</p>
                      {user.email && user.name && (
                        <p className="text-xs text-muted truncate">{user.email}</p>
                      )}
                    </div>
                    <Badge variant={user.providerType === 'nuvio' ? 'nuvio' : 'stremio'} size="sm">
                      {user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'}
                    </Badge>
                  </div>
                </div>
              );
            })()}
            <p className="text-xs text-muted mt-3">
              {selectedHistoryUserId === 'all'
                ? 'Export all users\' watch history, or import history for existing users. Select a specific user to clear their history.'
                : 'Export or import watch history for the selected user only. Clear history will delete all local watch records.'}
            </p>
          </Card>
          <input
            ref={historyFileInputRef}
            type="file"
            accept=".json"
            onChange={handleHistoryFileChange}
            className="hidden"
          />
        </PageSection>

        {/* Configuration */}
        <PageSection delay={0.25}>
          <TaskCard
            icon={<Cog6ToothIcon className="w-5 h-5 text-indigo-400" />}
            iconBg="bg-indigo-500/20"
            title="Configuration"
            description="Import or export full configuration"
          >
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDraggingConfig(true); }}
              onDragLeave={() => setIsDraggingConfig(false)}
              onDrop={handleConfigDrop}
            >
              <ActionButton
                onClick={() => configFileInputRef.current?.click()}
                icon={<DocumentArrowDownIcon className="w-4 h-4" />}
                label={isDraggingConfig ? 'Drop Config' : 'Import Config'}
                loadingLabel="Importing..."
                isLoading={importingConfig}
                isDragging={isDraggingConfig}
              />
            </div>
            <ActionButton
              onClick={handleExportConfig}
              icon={<DocumentArrowUpIcon className="w-4 h-4" />}
              label="Export Config"
            />
            <ActionButton
              onClick={handleResetConfig}
              icon={<ExclamationTriangleIcon className="w-4 h-4" />}
              label="Reset Config"
              loadingLabel="Resetting..."
              isLoading={resettingConfig}
              variant="danger"
            />
          </TaskCard>
          <input
            ref={configFileInputRef}
            type="file"
            accept=".json"
            onChange={handleConfigFileChange}
            className="hidden"
          />
        </PageSection>

        {/* Automatic Backups */}
        <PageSection delay={0.3}>
          <Card padding="lg" className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-purple-500/20">
                <ArchiveBoxIcon className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Automatic Backups</h3>
                <p className="text-xs text-muted">Save configuration snapshots on a schedule</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={backupDays}
                onChange={(e) => handleBackupFrequencyChange(Number(e.target.value))}
                className="input-base px-3 py-2 flex-1 min-w-[180px] text-sm"
              >
                <option value={0}>Disabled</option>
                <option value={1}>Every day</option>
                <option value={7}>Every week</option>
                <option value={15}>Every 15 days</option>
                <option value={30}>Every month</option>
              </select>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBackupNow}
                isLoading={isBackupRunning}
                leftIcon={!isBackupRunning ? <ArrowPathIcon className="w-4 h-4" /> : undefined}
                title="Run backup now"
              >
                Backup Now
              </Button>
            </div>
            {backups.length > 0 ? (
              <div className="mt-4 pt-4 border-t border-default space-y-2 max-h-64 overflow-y-auto">
                {backups.map((backup) => (
                  <div key={backup.filename} className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-default bg-subtle">
                    <div className="min-w-0">
                      <p className="text-sm text-default truncate">{formatBackupDate(backup.createdAt)}</p>
                      <p className="text-xs text-muted">{(backup.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="sm" onClick={() => handleDownloadBackup(backup.filename)} title="Download">
                        <ArrowDownTrayIcon className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleRestoreBackup(backup)} isLoading={restoringBackup === backup.filename} title="Restore this backup">
                        {restoringBackup !== backup.filename && <ArrowUturnLeftIcon className="w-4 h-4" />}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteBackup(backup)} isLoading={deletingBackup === backup.filename} title="Delete">
                        {deletingBackup !== backup.filename && <TrashIcon className="w-4 h-4 text-error" />}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted mt-2">
                {loadingBackups ? 'Loading backups...' : 'No backups yet - click "Backup Now" or wait for the schedule. Files are saved under server folder: data/backup/'}
              </p>
            )}
          </Card>
        </PageSection>

        {/* Automatic Sync */}
        <PageSection delay={0.35}>
          <Card padding="lg" className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-cyan-500/20">
                <CalendarDaysIcon className="w-5 h-5 text-cyan-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Automatic Sync</h3>
                <p className="text-xs text-muted">Automatically sync groups on a schedule</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={syncFrequency}
                onChange={(e) => handleSyncFrequencyChange(e.target.value)}
                className="input-base px-3 py-2 flex-1 min-w-[180px] text-sm"
              >
                <option value="0">Disabled</option>
                <option value="1h">Every hour</option>
                <option value="1d">Every day</option>
                <option value="7d">Every 7 days</option>
                <option value="15d">Every 15 days</option>
                <option value="30d">Every 30 days</option>
              </select>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSyncNow}
                isLoading={isSyncRunning}
                leftIcon={!isSyncRunning ? <ArrowPathIcon className="w-4 h-4" /> : undefined}
                title="Run sync now"
              >
                Sync Now
              </Button>
            </div>
          </Card>
        </PageSection>

        {/* Addon Health Check */}
        <PageSection delay={0.375}>
          <Card padding="lg" className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-rose-500/20">
                <HeartIcon className="w-5 h-5 text-rose-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Addon Health Check</h3>
                <p className="text-xs text-muted">Monitor addon availability by checking manifests</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={healthCheckMinutes}
                onChange={(e) => handleHealthCheckIntervalChange(Number(e.target.value))}
                disabled={isHealthCheckLoading}
                className="input-base px-3 py-2 flex-1 min-w-[180px] text-sm"
              >
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
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRunHealthCheckNow}
                isLoading={isRunningHealthCheck}
                leftIcon={!isRunningHealthCheck ? <ArrowPathIcon className="w-4 h-4" /> : undefined}
                title="Run health check now"
              >
                Check Now
              </Button>
            </div>
            <p className="text-xs text-muted mt-2">
              Checks if addon manifests are reachable and tracks online/offline status
            </p>
          </Card>
        </PageSection>

{/*
        <PageSection delay={0.38}>
          <Card padding="lg" className="mb-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-500/20">
                <ArrowPathIcon className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Data Migration</h3>
                <p className="text-xs text-muted">Import old metrics from previous SlickSync version</p>
              </div>
            </div>
            
            {!migrationPreview ? (
              <div className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleLoadMigrationPreview}
                  isLoading={isLoadingMigration}
                  leftIcon={!isLoadingMigration ? <ArrowPathIcon className="w-4 h-4" /> : undefined}
                >
                  Check for Migration
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {migrationPreview.totals.pendingMigration ? (
                  <>
                    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                      <p className="text-sm text-amber-400 font-medium">Migration Available</p>
                      <p className="text-xs text-muted mt-1">
                        Found {migrationPreview.totals.movies} movies, {migrationPreview.totals.shows} shows, 
                        {migrationPreview.totals.watchTimeHours}h watch time across {migrationPreview.totals.users} users
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setShowMigrationConfirm(true)}
                      >
                        Migrate Now
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setMigrationPreview(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                    <p className="text-sm text-green-400 font-medium">Already Migrated</p>
                    <p className="text-xs text-muted mt-1">
                      {migrationPreview.migrationStatus.sessionsCount} sessions, {migrationPreview.migrationStatus.episodesCount} episodes
                    </p>
                  </div>
                )}
              </div>
            )}

            // Migration Confirm Modal
            {showMigrationConfirm && migrationPreview && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                <div className="bg-surface border border-default rounded-xl p-6 max-w-md w-full mx-4">
                  <h3 className="text-lg font-semibold text-default mb-2">Confirm Migration</h3>
                  <p className="text-sm text-muted mb-4">
                    This will import {migrationPreview.totals.movies} movies, {migrationPreview.totals.shows} shows, 
                    and {migrationPreview.totals.watchTimeHours}h of watch time into the new metrics system.
                  </p>
                  {migrationPreview.users.length > 0 && (
                    <div className="mb-4 max-h-40 overflow-y-auto">
                      <p className="text-xs text-muted mb-2">Users to migrate:</p>
                      {migrationPreview.users.slice(0, 5).map((u) => (
                        <div key={u.userId} className="text-xs text-default flex justify-between py-1">
                          <span>{u.username}</span>
                          <span className="text-muted">{u.movies + u.shows} items, {u.watchTimeHours}h</span>
                        </div>
                      ))}
                      {migrationPreview.users.length > 5 && (
                        <p className="text-xs text-muted">...and {migrationPreview.users.length - 5} more</p>
                      )}
                    </div>
                  )}
                  <div className="flex justify-end gap-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowMigrationConfirm(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleRunMigration}
                      isLoading={isRunningMigration}
                    >
                      Run Migration
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </PageSection>
        */}

        {/* Scheduled Tasks */}
        <PageSection delay={0.4}>
          <ScheduledTasksSection syncFrequency={syncFrequency} backupDays={backupDays} healthCheckMinutes={healthCheckMinutes} />
        </PageSection>
      </div>
      </div>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); confirmConfig.onConfirm(); }}
        title={confirmConfig.title}
        description={confirmConfig.description}
        variant={confirmConfig.variant}
        confirmText="Confirm"
      />

      {/* Save Addon Template */}
      <Modal
        isOpen={isCreateSnapshotOpen}
        onClose={() => setIsCreateSnapshotOpen(false)}
        title="Save Addon Template"
        description="Capture a user's or group's current addon set as a reusable template"
        size="md"
      >
        <div className="space-y-4">
          <Input
            label="Template Name"
            value={newSnapshotName}
            onChange={(e) => setNewSnapshotName(e.target.value)}
            placeholder="e.g. Standard Streaming Set"
            size="sm"
          />
          <Input
            label="Description (optional)"
            value={newSnapshotDescription}
            onChange={(e) => setNewSnapshotDescription(e.target.value)}
            placeholder="What's in this template?"
            size="sm"
          />
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>Source</label>
            <div className="flex gap-2 mb-2">
              <Button
                variant={newSnapshotSourceType === 'user' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => { setNewSnapshotSourceType('user'); setNewSnapshotSourceId(''); }}
              >
                User
              </Button>
              <Button
                variant={newSnapshotSourceType === 'group' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => { setNewSnapshotSourceType('group'); setNewSnapshotSourceId(''); }}
              >
                Group
              </Button>
            </div>
            <select
              value={newSnapshotSourceId}
              onChange={(e) => setNewSnapshotSourceId(e.target.value)}
              className="input-base px-3 py-2 w-full text-sm"
            >
              <option value="">Select a {newSnapshotSourceType}...</option>
              {(newSnapshotSourceType === 'user' ? users : groups).map((item: any) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.email || item.id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={() => setIsCreateSnapshotOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleCreateSnapshot} isLoading={creatingSnapshot}>
              Save Template
            </Button>
          </div>
        </div>
      </Modal>

      {/* Deploy Addon Template */}
      <Modal
        isOpen={!!deployingSnapshot}
        onClose={() => setDeployingSnapshot(null)}
        title={deployingSnapshot ? `Deploy "${deployingSnapshot.name}"` : 'Deploy Template'}
        description={deployingSnapshot ? `Push this template's ${deployingSnapshot.addonCount} addon${deployingSnapshot.addonCount !== 1 ? 's' : ''} onto a user's account` : undefined}
        size="md"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>Target User</label>
            <select
              value={deployTargetUserId}
              onChange={(e) => setDeployTargetUserId(e.target.value)}
              className="input-base px-3 py-2 w-full text-sm"
            >
              <option value="">Select a user...</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name || user.email || user.id} ({user.providerType === 'nuvio' ? 'Nuvio' : 'Stremio'})
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-warning">
            This replaces the target user&apos;s current addon set.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={() => setDeployingSnapshot(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleDeploySnapshot} isLoading={isDeploying} disabled={!deployTargetUserId}>
              Deploy
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// Scheduled Tasks Section Component
function ScheduledTasksSection({ syncFrequency, backupDays, healthCheckMinutes }: { syncFrequency: string; backupDays: number; healthCheckMinutes: number }) {
  // Calculate next run times
  const getNextSyncTime = (): Date | null => {
    if (syncFrequency === '0') return null;
    const now = new Date();
    const next = new Date(now);
    
    switch (syncFrequency) {
      case '1h':
        next.setHours(next.getHours() + 1, 0, 0, 0);
        break;
      case '1d':
        next.setDate(next.getDate() + 1);
        next.setHours(0, 0, 0, 0);
        break;
      case '7d':
        next.setDate(next.getDate() + (7 - next.getDay()));
        next.setHours(0, 0, 0, 0);
        break;
      case '15d':
        next.setDate(next.getDate() + 15);
        next.setHours(0, 0, 0, 0);
        break;
      case '30d':
        next.setMonth(next.getMonth() + 1, 1);
        next.setHours(0, 0, 0, 0);
        break;
      default:
        return null;
    }
    return next;
  };

  const getNextBackupTime = (): Date | null => {
    if (backupDays === 0) return null;
    const now = new Date();
    const next = new Date(now);
    next.setDate(next.getDate() + backupDays);
    next.setHours(3, 0, 0, 0); // Assume backups run at 3 AM
    return next;
  };

  const formatNextRun = (date: Date | null): string => {
    if (!date) return 'Not scheduled';
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffHours < 1) return 'In less than an hour';
    if (diffHours < 24) return `In ${diffHours} hour${diffHours !== 1 ? 's' : ''}`;
    if (diffDays === 1) return 'Tomorrow';
    return `In ${diffDays} days`;
  };

  const formatDateTime = (date: Date | null): string => {
    if (!date) return '-';
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const getNextHealthCheckTime = (): Date | null => {
    if (healthCheckMinutes < 1) return null;
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(next.getMinutes() + healthCheckMinutes);
    return next;
  };

  const formatHealthCheckFrequency = (minutes: number): string => {
    if (minutes < 60) return `Every ${minutes} minutes`;
    if (minutes === 60) return 'Every hour';
    if (minutes < 1440) return `Every ${Math.floor(minutes / 60)} hours`;
    return 'Every 24 hours';
  };

  const nextSyncTime = getNextSyncTime();
  const nextBackupTime = getNextBackupTime();
  const nextHealthCheckTime = getNextHealthCheckTime();

  // Build list of scheduled tasks
  const scheduledTasks = [];
  
  if (nextSyncTime) {
    scheduledTasks.push({
      id: 'sync',
      name: 'Automatic Sync',
      description: 'Sync all groups with their users',
      nextRun: nextSyncTime,
      icon: <ArrowPathIcon className="w-5 h-5 text-cyan-400" />,
      iconBg: 'bg-cyan-500/20',
      frequency: syncFrequency === '1h' ? 'Every hour' : 
                 syncFrequency === '1d' ? 'Daily' :
                 syncFrequency === '7d' ? 'Weekly' :
                 syncFrequency === '15d' ? 'Every 15 days' : 'Monthly',
    });
  }

  if (nextBackupTime) {
    scheduledTasks.push({
      id: 'backup',
      name: 'Automatic Backup',
      description: 'Save configuration snapshot',
      nextRun: nextBackupTime,
      icon: <ArchiveBoxIcon className="w-5 h-5 text-purple-400" />,
      iconBg: 'bg-purple-500/20',
      frequency: backupDays === 1 ? 'Daily' :
                 backupDays === 7 ? 'Weekly' :
                 backupDays === 15 ? 'Every 15 days' : 'Monthly',
    });
  }

  if (nextHealthCheckTime) {
    scheduledTasks.push({
      id: 'healthcheck',
      name: 'Addon Health Check',
      description: 'Check addon manifest availability',
      nextRun: nextHealthCheckTime,
      icon: <HeartIcon className="w-5 h-5 text-rose-400" />,
      iconBg: 'bg-rose-500/20',
      frequency: formatHealthCheckFrequency(healthCheckMinutes),
    });
  }

  // Sort by next run time
  scheduledTasks.sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime());

  if (scheduledTasks.length === 0) {
    return (
      <Card padding="lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-surface-hover">
            <ClockIcon className="w-5 h-5 text-muted" />
          </div>
          <div>
            <h3 className="text-base font-semibold font-display text-default">Scheduled Tasks</h3>
            <p className="text-xs text-muted">No automatic tasks configured</p>
          </div>
        </div>
        <p className="text-sm text-muted">
          Enable automatic sync or backup schedules above to see upcoming tasks here.
        </p>
      </Card>
    );
  }

  return (
    <Card padding="lg">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-surface-hover">
          <ClockIcon className="w-5 h-5 text-muted" />
        </div>
        <div>
          <h3 className="text-base font-semibold font-display text-default">Scheduled Tasks</h3>
          <p className="text-xs text-muted">{scheduledTasks.length} upcoming task{scheduledTasks.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
      
      <div className="space-y-3">
        {scheduledTasks.map((task) => (
          <div
            key={task.id}
            className="flex items-center gap-4 p-3 rounded-xl bg-surface-hover border border-default"
          >
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${task.iconBg}`}>
              {task.icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium text-default truncate">{task.name}</h4>
                <Badge variant="muted" size="sm">{task.frequency}</Badge>
              </div>
              <p className="text-xs text-muted">{task.description}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium text-primary">{formatNextRun(task.nextRun)}</p>
              <p className="text-xs text-subtle">{formatDateTime(task.nextRun)}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
