'use client';

import Head from 'next/head';
import { useState, useCallback, useEffect, useMemo, useRef, Fragment } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { Button, Card, Avatar, AvatarColorSwatches, UserAvatar, AvatarGroup, Badge, SearchInput, Input, ConfirmModal, SyncBadge, ToggleSwitch, ContextMenu, useContextMenu, SelectAllCheckbox, SelectionCheckbox, PageToolbar } from '@/components/ui';
import { Dialog, DialogPanel } from '@headlessui/react';
import { StaggerContainer, StaggerItem } from '@/components/layout/PageContainer';
import { NebulaPageHeading, NebulaCompactStatCard, NEBULA_GLASS_CLASS, nebulaGlassStyle, NebulaGlassStripe } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import { api, Group, User } from '@/lib/api';
import { useLastKnown } from '@/lib/hooks/useLastKnown';
import { useDefaultViewMode } from '@/lib/viewMode';
import { useIsTV } from '@/lib/hooks/useIsTV';
import { useLongPress } from '@/lib/hooks/useLongPress';
import { TVPageProvider } from '@/components/tv/TVPageProvider';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { TVLink } from '@/components/tv/TVLink';
import { useSortableDragState } from '@/components/ui/DragSortable';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { useVaultDrag } from '@/components/providers/VaultDragContext';
import { usePageArrangement, usePageDesign } from '@/lib/arrange';
import { ArrangeBar, ArrangeButton, HiddenTray } from '@/components/ui/Arrange';
import { GroupsV2, type V2GroupCard } from '@/components/v2/GroupsV2';
import {
  PlusIcon,
  ArrowPathIcon,
  UsersIcon,
  PuzzlePieceIcon,
  EllipsisVerticalIcon,
  TrashIcon,
  CheckIcon,
  XMarkIcon,
  EyeIcon,
  DocumentDuplicateIcon,
  Bars3Icon,
} from '@heroicons/react/24/outline';

// Group display type
interface GroupDisplay {
  id: string;
  name: string;
  description?: string;
  color?: string;
  colorIndex?: number;
  avatarUrl?: string | null;
  users: Array<{ name: string; id: string }>;
  addonCount: number;
  userCount: number; // Total user count from API
  isActive?: boolean;
}

const colorOptions = [
  '#7c3aed', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#f43f5e', // rose
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
];

export default function GroupsPage() {
  const { layoutMode } = useLayoutMode();
  const isTV = useIsTV();
  const Wrapper = isTV ? TVPageProvider : Fragment;
  const [searchQuery, setSearchQuery] = useState('');
  const { viewMode, setViewMode } = useDefaultViewMode();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Data state
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Instant navigation: last-known groups and users shown at once while
  // the fetch below refreshes them - see useLastKnown's comment.
  useLastKnown<Group[]>('/groups', (cached) => { setGroups(cached); setIsLoading(false); });
  useLastKnown<User[]>('/users', (cached) => setUsers(cached));
  const [error, setError] = useState<Error | null>(null);

  // Multi-select state - NO isSelectMode, just selectedIds
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Single item delete state (for quick action menu)
  const [deleteTarget, setDeleteTarget] = useState<GroupDisplay | null>(null);

  // Clone state
  const [cloneTarget, setCloneTarget] = useState<GroupDisplay | null>(null);

  // Fetch groups and users
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [groupsData, usersData] = await Promise.all([
          api.getGroups(),
          api.getUsers(),
        ]);
        setGroups(groupsData);
        setUsers(usersData);
      } catch (err) {
        setError(err as Error);
        toast.error('Failed to load groups');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  // Transform groups for display
  const groupsDisplay = useMemo<GroupDisplay[]>(() => {
    const userMap = new Map(users.map(u => [u.id, u]));

    return groups.map(group => {
      // Parse userIds (can be JSON string or array) and get user names
      let userIds: string[] = [];
      try {
        if (typeof group.userIds === 'string') {
          userIds = JSON.parse(group.userIds);
        } else if (Array.isArray(group.userIds)) {
          userIds = group.userIds;
        }
      } catch (e) {
        console.error('Error parsing group userIds:', e);
        userIds = [];
      }

      const groupUsers = userIds
        .map(id => {
          const user = userMap.get(id);
          return user ? { name: user.name || user.username || 'Unknown', id: user.id, email: user.email } : null;
        })
        .filter(Boolean) as Array<{ name: string; id: string; email?: string }>;

      // Derive color from colorIndex if color is not provided
      const groupColor = group.color || (group.colorIndex !== undefined ? colorOptions[group.colorIndex % colorOptions.length] : colorOptions[0]);

      return {
        id: group.id,
        name: group.name,
        description: group.description,
        color: groupColor,
        colorIndex: group.colorIndex,
        avatarUrl: group.avatarUrl,
        users: groupUsers,
        addonCount: group.addons || 0, // Use count from API
        userCount: group.users || groupUsers.length, // Use API count, fallback to parsed list length
        // Carried through explicitly. This object is what the card renders
        // from, and without it every card read an undefined status - drawn
        // as active whatever the group really was, and a click always sent
        // "activate", so no group could be switched off from this page.
        isActive: group.isActive !== false,
      };
    });
  }, [groups, users]);

  const filteredGroups = groupsDisplay.filter(group =>
    group.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    group.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Register this page's drag-end logic with the layout-level DndContext,
  // same shared mechanism Addons/Users/Vault already use.
  const { registerDragEndHandler } = useVaultDrag();
  useEffect(() => {
    const handleDragEnd = (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = filteredGroups.findIndex(g => g.id === active.id);
      const newIndex = filteredGroups.findIndex(g => g.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reorderedIds = filteredGroups.map(g => g.id);
      const [movedId] = reorderedIds.splice(oldIndex, 1);
      reorderedIds.splice(newIndex, 0, movedId);
      setGroups(prev => {
        const byId = new Map(prev.map(g => [g.id, g]));
        const reorderedGroups = reorderedIds.map(id => byId.get(id)).filter((g): g is Group => !!g);
        const rest = prev.filter(g => !reorderedIds.includes(g.id));
        return [...reorderedGroups, ...rest];
      });
      api.reorderGroups(reorderedIds).catch((err: any) => {
        toast.error(err.message || 'Failed to save new order');
      });
    };
    return registerDragEndHandler(handleDragEnd);
  }, [filteredGroups, registerDragEndHandler]);

  // Nebula's stat row - real totals from the same groupsDisplay data already rendered.
  const totalMembers = groupsDisplay.reduce((sum, g) => sum + (g.userCount || 0), 0);

  // v2: a card per group with its people and addons; Arrange moves and hides
  // groups on this page (lib/arrange.tsx).
  const { design } = usePageDesign();
  const v2 = design === 'v2' && !isTV;
  const groupArrange = usePageArrangement('groups', useMemo(() => filteredGroups.map((g) => g.id), [filteredGroups]));
  const [groupAddonNames, setGroupAddonNames] = useState<Record<string, string[]>>({});
  const [syncingGroupIds, setSyncingGroupIds] = useState<Set<string>>(new Set());
  const groupIdsKey = groups.map((g) => g.id).join(',');
  useEffect(() => {
    if (!v2 || !groupIdsKey) return;
    let cancelled = false;
    Promise.all(groupIdsKey.split(',').map((id) => api.getGroupAddons(id)
      .then((list) => [id, list.map((a) => a.name)] as const)
      .catch(() => [id, null] as const)))
      .then((pairs) => {
        if (cancelled) return;
        const next: Record<string, string[]> = {};
        for (const [id, names] of pairs) if (names) next[id] = names;
        setGroupAddonNames(next);
      });
    return () => { cancelled = true; };
  }, [v2, groupIdsKey]);
  const v2Groups = useMemo<V2GroupCard[]>(() => {
    const userById = new Map(users.map((u) => [u.id, u]));
    const rawById = new Map(groups.map((g) => [g.id, g]));
    return filteredGroups.map((g) => ({
      id: g.id,
      name: g.name,
      colorIndex: g.colorIndex,
      isActive: g.isActive !== false,
      lastSyncedAt: rawById.get(g.id)?.lastSyncedAt ?? null,
      addonCount: g.addonCount,
      addonNames: groupAddonNames[g.id],
      people: g.users.map((p) => {
        const u = userById.get(p.id);
        return { id: p.id, name: u?.username || p.name, email: u?.email, avatarUrl: (u as { avatarUrl?: string | null } | undefined)?.avatarUrl, useGravatar: u?.useGravatar, colorIndex: u?.colorIndex };
      }),
    }));
  }, [filteredGroups, users, groups, groupAddonNames]);
  const v2Subtitle = `${groups.length} group${groups.length === 1 ? '' : 's'} · ${totalMembers} ${totalMembers === 1 ? 'person' : 'people'}`;
  const totalGroupAddons = groupsDisplay.reduce((sum, g) => sum + (g.addonCount || 0), 0);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredGroups.map(g => g.id)));
  }, [filteredGroups]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleSyncSelected = useCallback(async () => {
    setIsSyncing(true);
    const ids = Array.from(selectedIds);
    let success = 0;

    for (const id of ids) {
      try {
        await api.syncGroup(id);
        success++;
      } catch (err) {
        console.error('Failed to sync group:', err);
      }
    }

    setIsSyncing(false);
    if (success > 0) {
      toast.success(`Synced ${success} group${success !== 1 ? 's' : ''} successfully`);
    }
    setSelectedIds(new Set());
    // Refresh groups
    try {
      const groupsData = await api.getGroups();
      setGroups(groupsData);
    } catch (err) {
      console.error('Failed to refresh groups:', err);
    }
  }, [selectedIds]);

  const handleDeleteSelected = useCallback(async () => {
    setIsDeleting(true);
    const ids = Array.from(selectedIds);
    let success = 0;

    for (const id of ids) {
      try {
        await api.deleteGroup(id);
        success++;
      } catch (err) {
        console.error('Failed to delete group:', err);
      }
    }

    setIsDeleting(false);
    setIsDeleteModalOpen(false);
    if (success > 0) {
      toast.success(`Deleted ${success} group${success !== 1 ? 's' : ''} successfully`);
      // Refresh groups
      try {
        const groupsData = await api.getGroups();
        setGroups(groupsData);
      } catch (err) {
        console.error('Failed to refresh groups:', err);
      }
    }
    setSelectedIds(new Set());
  }, [selectedIds]);

  // Delete single group (from quick action menu)
  const handleDeleteSingle = useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await api.deleteGroup(deleteTarget.id);
      toast.success(`${deleteTarget.name} deleted successfully`);
      // Refresh groups
      try {
        const groupsData = await api.getGroups();
        setGroups(groupsData);
      } catch (err) {
        console.error('Failed to refresh groups:', err);
      }
    } catch (err) {
      toast.error(`Failed to delete ${deleteTarget.name}`);
      console.error('Failed to delete group:', err);
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget]);

  const hasSelection = selectedIds.size > 0;

  const handleSyncAllGroups = async () => {
    setIsSyncing(true);
    try {
      const groupIds = groups.map(g => g.id);
      let success = 0;
      for (const id of groupIds) {
        try {
          await api.syncGroup(id);
          success++;
        } catch (err) {
          console.error('Failed to sync group:', err);
        }
      }
      if (success > 0) {
        toast.success(`Synced ${success} group${success !== 1 ? 's' : ''} successfully`);
      }
      const groupsData = await api.getGroups();
      setGroups(groupsData);
    } catch (err: any) {
      toast.error(err.message || 'Failed to sync all groups');
    } finally {
      setIsSyncing(false);
    }
  };

  const syncAllGroupsButtonInner = (
    <Button
      variant="secondary"
      leftIcon={<ArrowPathIcon className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />}
      onClick={handleSyncAllGroups}
      disabled={isSyncing}
    >
      {isSyncing ? 'Syncing...' : 'Sync All'}
    </Button>
  );
  const syncAllGroupsButton = isTV ? (
    <TVFocusable onEnterPress={handleSyncAllGroups}>{syncAllGroupsButtonInner}</TVFocusable>
  ) : v2 ? (
    <div className="flex items-center gap-2"><ArrangeButton arrange={groupArrange} />{syncAllGroupsButtonInner}</div>
  ) : syncAllGroupsButtonInner;
  const subtitle = isLoading ? 'Loading...' : v2 ? v2Subtitle : `${groups.length} group${groups.length !== 1 ? 's' : ''}`;

  return (
    <Wrapper>
      <Head>
        <title>SlickSync - Groups</title>
      </Head>
      {layoutMode !== 'nebula' && (
        <Header
          title="Groups"
          subtitle={subtitle}
          actions={syncAllGroupsButton}
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(120rem, 92vw)' } : undefined}>
      {layoutMode === 'nebula' && (
        <NebulaPageHeading
          title="Groups"
          subtitle={subtitle}
          actions={syncAllGroupsButton}
        />
      )}
      {layoutMode === 'nebula' && !v2 && (
        <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-5">
          <NebulaCompactStatCard label="Total Groups" value={isLoading ? '...' : groups.length} icon={<UsersIcon className="w-4 h-4 md:w-6 md:h-6" />} colorIndex={0} />
          <NebulaCompactStatCard label="Total Members" value={isLoading ? '...' : totalMembers} icon={<UsersIcon className="w-4 h-4 md:w-6 md:h-6" />} colorIndex={1} />
          <NebulaCompactStatCard label="Addons Assigned" value={isLoading ? '...' : totalGroupAddons} icon={<PuzzlePieceIcon className="w-4 h-4 md:w-6 md:h-6" />} colorIndex={0} />
        </div>
      )}
      {v2 && <ArrangeBar arrange={groupArrange} />}
      <div className={layoutMode === 'nebula' && !v2 ? `${NEBULA_GLASS_CLASS} p-5` : ''} style={layoutMode === 'nebula' && !v2 ? nebulaGlassStyle : undefined}>
      {layoutMode === 'nebula' && !v2 && <NebulaGlassStripe />}
        {/* Filters */}
        <PageToolbar
          selectionConfig={{
            totalCount: filteredGroups.length,
            selectedCount: selectedIds.size,
            onSelectAll: selectAll,
            onDeselectAll: deselectAll,
          }}
          searchConfig={{
            value: searchQuery,
            onChange: (value) => setSearchQuery(value),
            placeholder: 'Search groups...',
          }}
          primaryAction={(() => {
            const btn = (
              <Button
                variant="primary"
                leftIcon={<PlusIcon className="w-5 h-5" />}
                onClick={() => setIsCreateModalOpen(true)}
              >
                Add
              </Button>
            );
            return isTV ? <TVFocusable onEnterPress={() => setIsCreateModalOpen(true)}>{btn}</TVFocusable> : btn;
          })()}
        />

        {/* Loading state */}
        {isLoading ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center mb-4 bg-surface-hover">
              <div className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin text-primary" />
            </div>
            <p className="text-muted">Loading groups...</p>
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center mb-4 bg-surface-hover">
              <XMarkIcon className="w-8 h-8 text-error" />
            </div>
            <h3 className="text-lg font-medium mb-2 text-default">Error Loading Groups</h3>
            <p className="text-muted mb-4">{error.message}</p>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {/* Groups Grid/List - v2 draws its own cards. */}
            {v2 ? (
              <div className="mt-4">
                <GroupsV2
                  groups={v2Groups}
                  arrange={groupArrange}
                  view={viewMode === 'list' ? 'list' : 'grid'}
                  syncing={syncingGroupIds}
                  onSync={async (g) => {
                    setSyncingGroupIds((prev) => new Set(prev).add(g.id));
                    try {
                      await api.syncGroup(g.id);
                      toast.success(`Synced ${g.name}`);
                      setGroups(await api.getGroups());
                    } catch (err) {
                      toast.error(`Couldn’t sync ${g.name}`, { line: err instanceof Error ? err.message : undefined });
                    } finally {
                      setSyncingGroupIds((prev) => { const n = new Set(prev); n.delete(g.id); return n; });
                    }
                  }}
                />
                <HiddenTray arrange={groupArrange} labelOf={(id) => groupsDisplay.find((g) => g.id === id)?.name ?? 'A group'}
                  note="Hidden only here: the group keeps syncing as normal. Tap one to bring it back." />
              </div>
            ) : (
            <LayoutGroup>
              <AnimatePresence mode="popLayout">
                {viewMode === 'grid' ? (
                  <StaggerContainer key="grid" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    <AnimatePresence mode="popLayout">
                      <SortableContext items={filteredGroups.map(g => g.id)} strategy={rectSortingStrategy}>
                      {filteredGroups.map((group) => (
                        <SortableGroupWrapper key={group.id} id={group.id}>
                          {(dragHandleProps) => (
                        <StaggerItem>
                          <GroupCard
                            group={group}
                            isSelected={selectedIds.has(group.id)}
                            onToggleSelect={() => toggleSelect(group.id)}
                            onDelete={() => setDeleteTarget(group)}
                            onClone={() => setCloneTarget(group)}
                            onToggleStatus={(groupId, newStatus) => {
                              setGroups(prev => prev.map(g =>
                                g.id === groupId
                                  ? { ...g, isActive: newStatus }
                                  : g
                              ));
                            }}
                            focusable={isTV}
                            dragHandleProps={dragHandleProps}
                          />
                        </StaggerItem>
                          )}
                        </SortableGroupWrapper>
                      ))}
                      </SortableContext>
                    </AnimatePresence>
                  </StaggerContainer>
                ) : (
                  <motion.div
                    key="list"
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="rounded-2xl overflow-hidden bg-surface border border-default overflow-x-auto"
                  >
                    <table className="w-full min-w-[500px]">
                      <thead>
                        <tr className="border-b border-default">
                          <th className="w-8" aria-hidden="true" />
                          <th className="px-4 py-4 text-left w-12">
                            <div
                              className={`w-5 h-5 rounded border-2 flex items-center justify-center cursor-pointer transition-all ${hasSelection && selectedIds.size === filteredGroups.length
                                  ? 'bg-primary-solid border-primary-solid'
                                  : 'border-default hover:border-primary'
                                }`}
                              onClick={() => hasSelection && selectedIds.size === filteredGroups.length ? deselectAll() : selectAll()}
                            >
                              {hasSelection && selectedIds.size === filteredGroups.length && (
                                <CheckIcon className="w-3 h-3 text-white" />
                              )}
                            </div>
                          </th>
                          <th className="px-6 py-4 text-left text-sm font-medium text-muted">Group</th>
                          <th className="px-6 py-4 text-left text-sm font-medium text-muted">Members</th>
                          <th className="px-6 py-4 text-left text-sm font-medium text-muted">Addons</th>
                          <th className="px-6 py-4 text-left text-sm font-medium text-muted">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        <SortableContext items={filteredGroups.map(g => g.id)} strategy={verticalListSortingStrategy}>
                        <AnimatePresence mode="popLayout">
                          {filteredGroups.map((group) => (
                            <SortableGroupRow
                              key={group.id}
                              id={group.id}
                              onClick={() => toggleSelect(group.id)}
                              className={`transition-colors border-b border-default cursor-pointer ${selectedIds.has(group.id) ? 'bg-primary-muted' : 'hover:bg-white/5'
                                }`}
                            >
                              <td className="px-4 py-4">
                                <div
                                  className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${selectedIds.has(group.id)
                                      ? 'bg-primary-solid border-primary-solid'
                                      : 'border-default'
                                    }`}
                                >
                                  {selectedIds.has(group.id) && (
                                    <CheckIcon className="w-3 h-3 text-white" />
                                  )}
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <TVLink
                                  href={`/groups/${group.id}`}
                                  className="flex items-center gap-3 group"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Avatar
                                    name={group.name}
                                    size="md"
                                    src={group.avatarUrl || undefined}
                                    colorIndex={group.colorIndex ?? 0}
                                  />
                                  <div>
                                    <p className="font-medium transition-colors group-hover:text-primary text-default truncate" style={{ maxWidth: '200px' }}>
                                      {group.name}
                                    </p>
                                    <p className="text-sm text-muted truncate" style={{ maxWidth: '200px' }}>
                                      {group.description || 'No description'}
                                    </p>
                                  </div>
                                </TVLink>
                              </td>
                              <td className="px-6 py-4 text-muted">
                                <span className="flex items-center gap-1.5">
                                  <UsersIcon className="w-4 h-4 text-secondary" />
                                  {group.userCount} member{group.userCount !== 1 ? 's' : ''}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-muted">
                                <span className="flex items-center gap-1.5">
                                  <PuzzlePieceIcon className="w-4 h-4 text-secondary" />
                                  {group.addonCount} addon{group.addonCount !== 1 ? 's' : ''}
                                </span>
                              </td>
                              <td className="px-6 py-4">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  leftIcon={<ArrowPathIcon className="w-4 h-4" />}
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      await api.syncGroup(group.id);
                                      toast.success(`Synced ${group.name} successfully`);
                                    } catch (err: any) {
                                      toast.error(err.message || `Failed to sync ${group.name}`);
                                    }
                                  }}
                                >
                                  Sync
                                </Button>
                              </td>
                            </SortableGroupRow>
                          ))}
                        </AnimatePresence>
                        </SortableContext>
                      </tbody>
                    </table>
                  </motion.div>
                )}
              </AnimatePresence>
            </LayoutGroup>
            )}

            {/* Empty state */}
            {filteredGroups.length === 0 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center py-16"
              >
                <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center mb-4 bg-surface-hover">
                  <UsersIcon className="w-8 h-8 text-subtle" />
                </div>
                <h3 className="text-lg font-medium mb-2 text-default">No groups found</h3>
                <p className="mb-6 text-muted">
                  {searchQuery ? 'Try adjusting your search' : 'Get started by creating your first group'}
                </p>
                {!searchQuery && (
                  <Button variant="primary" onClick={() => setIsCreateModalOpen(true)}>
                    Create Group
                  </Button>
                )}
              </motion.div>
            )}
          </>
        )}
      </div>
      </div>
      </div>

      {/* Floating Action Bar */}
      <AnimatePresence>
        {hasSelection && (
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50"
          >
            <div className="flex items-center gap-4 px-6 py-4 rounded-2xl shadow-2xl bg-surface border border-default backdrop-blur-xl">
              <div className="flex items-center gap-2 pr-4 border-r border-default">
                <div className="w-8 h-8 rounded-lg bg-primary-muted flex items-center justify-center">
                  <span className="text-sm font-bold text-primary">{selectedIds.size}</span>
                </div>
                <span className="text-sm text-muted">selected</span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<ArrowPathIcon className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />}
                  onClick={handleSyncSelected}
                  isLoading={isSyncing}
                >
                  Sync
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  leftIcon={<TrashIcon className="w-4 h-4" />}
                  onClick={() => setIsDeleteModalOpen(true)}
                >
                  Delete
                </Button>
              </div>

              <button
                onClick={deselectAll}
                className="p-2 rounded-lg text-muted hover:bg-surface-hover transition-colors"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Add Button - Mobile Only */}
      <button
        onClick={() => setIsCreateModalOpen(true)}
        className="lg:hidden fixed bottom-4 right-4 z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-lg bg-surface border border-default nav-item-hover-pill"
        style={{ boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)' }}
      >
        <PlusIcon className="w-6 h-6" />
      </button>

      {/* Create Group Modal */}
      <CreateGroupModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />

      {/* Delete Confirmation Modal (bulk) */}
      <ConfirmModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={handleDeleteSelected}
        title="Delete Groups"
        description={`Are you sure you want to delete ${selectedIds.size} group${selectedIds.size !== 1 ? 's' : ''}? This will remove all member associations but won't delete the users themselves.`}
        confirmText={isDeleting ? 'Deleting...' : 'Delete Groups'}
        variant="danger"
        isLoading={isDeleting}
      />

      {/* Delete Confirmation Modal (single) */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteSingle}
        title="Delete Group"
        description={`Are you sure you want to delete "${deleteTarget?.name}"? This will remove all member associations but won't delete the users themselves.`}
        confirmText={isDeleting ? 'Deleting...' : 'Delete Group'}
        variant="danger"
        isLoading={isDeleting}
      />

      {/* Clone Group Modal */}
      {cloneTarget && (
        <CloneGroupModal
          isOpen={!!cloneTarget}
          onClose={() => setCloneTarget(null)}
          group={cloneTarget}
        />
      )}
    </Wrapper>
  );
}

// Only itemProps (position/transform tracking, no listeners) goes on the
// outer wrapper - dragHandleProps is threaded into GroupCard as a prop,
// rendered there as a small dedicated grab handle. Same pattern as Addons'
// SortableAddonWrapper / Users' SortableUserWrapper.
function SortableGroupWrapper({ id, children }: { id: string; children: (dragHandleProps: Record<string, unknown>) => React.ReactNode }) {
  const { dragHandleProps, itemProps } = useSortableDragState(id);
  return (
    <div ref={itemProps.ref} className={itemProps.className} style={itemProps.style}>
      {children(dragHandleProps)}
    </div>
  );
}

// List-view counterpart - renders its own dedicated handle cell. Same
// pattern as Addons' SortableAddonRow / Users' SortableUserRow.
function SortableGroupRow({ id, onClick, className, children }: { id: string; onClick?: () => void; className?: string; children: React.ReactNode }) {
  const { dragHandleProps, itemProps } = useSortableDragState(id);
  return (
    <motion.tr
      ref={itemProps.ref as unknown as React.Ref<HTMLTableRowElement>}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={itemProps.style}
      className={`${className || ''} ${itemProps.className}`}
      onClick={onClick}
    >
      <td className="pl-4 py-4 w-8" onClick={(e) => e.stopPropagation()}>
        <div {...dragHandleProps} className="p-1 rounded hover:bg-surface-hover cursor-grab active:cursor-grabbing inline-flex text-subtle hover:text-default" title="Drag to reorder">
          <Bars3Icon className="w-4 h-4" />
        </div>
      </td>
      {children}
    </motion.tr>
  );
}

// Group Card Component - single click opens, long press/right-click shows menu
function GroupCard({
  group,
  isSelected,
  onToggleSelect,
  onDelete,
  onClone,
  onToggleStatus,
  focusable = false,
  dragHandleProps,
}: {
  group: GroupDisplay;
  isSelected: boolean;
  onToggleSelect: () => void;
  onDelete: () => void;
  onClone: () => void;
  onToggleStatus?: (groupId: string, newStatus: boolean) => void;
  /** TV mode: wraps the card in a D-pad-focusable container, Enter/OK opens
   *  the same detail page a click would. */
  focusable?: boolean;
  /** Dedicated grab handle (top-left), same pattern as Addons/Users. */
  dragHandleProps?: Record<string, unknown>;
}) {
  const { isOpen, position, handleContextMenu, close } = useContextMenu();
  const [showActions, setShowActions] = useState(false);

  // Single click opens detail page
  const handleClick = (e: React.MouseEvent) => {
    if (showActions) {
      setShowActions(false);
      return;
    }
    window.location.href = `/groups/${group.id}`;
  };

  // Long-press → context menu on mobile - a plain JS timer, not the DOM
  // `contextmenu` event, since iOS Safari doesn't reliably synthesize that
  // from a touch-and-hold the way desktop browsers do from a real
  // right-click (see useLongPress's own comment).
  const longPress = useLongPress({
    onLongPress: (e, x, y) => {
      setShowActions(true);
      handleContextMenu(e, x, y);
    },
  });

  const handleSync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    close();
    toast.success(`Syncing ${group.name}...`);
  };

  const handleClone = async (e: React.MouseEvent) => {
    e.stopPropagation();
    close();
    onClone();
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    close();
    onDelete();
  };

  const cardElement = (
      <Card
        variant="interactive"
        padding="md"
        // Two rows: picture, name and switch on top; then the member and
        // addon counts with the sync status, and the select box at the end.
        className={`group cursor-pointer tap-card ${isSelected ? 'ring-2 ring-primary' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        {...longPress}
      >
        <div className="flex items-center gap-2.5">
          {dragHandleProps && (
            <div
              {...dragHandleProps}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className="shrink-0 p-1.5 rounded-lg text-subtle hover:text-default hover:bg-surface-hover cursor-grab active:cursor-grabbing"
              title="Drag to reorder"
            >
              <Bars3Icon className="w-4 h-4" />
            </div>
          )}
          <Avatar
            name={group.name}
            size="md"
            src={group.avatarUrl || undefined}
            colorIndex={group.colorIndex ?? 0}
          />
          <Link
            href={`/groups/${group.id}`}
            className="flex-1 min-w-0 font-semibold truncate transition-colors hover:text-primary text-default"
            onClick={(e) => e.stopPropagation()}
          >
            {group.name}
          </Link>
          <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <ToggleSwitch
              checked={group.isActive !== false}
              onChange={async () => {
                try {
                  // Derived from exactly what the switch is showing, so the
                  // click always does the opposite of what the user can see.
                  const newStatus = !(group.isActive !== false);
                  await api.toggleGroupStatus(group.id, newStatus);
                  toast.success(`Group ${newStatus ? 'activated' : 'deactivated'}`);
                  onToggleStatus?.(group.id, newStatus);
                } catch (err: any) {
                  toast.error(err.message || `Failed to toggle ${group.name}`);
                }
              }}
            />
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted whitespace-nowrap min-w-0">
            <span className="flex items-center gap-1.5">
              <UsersIcon className="w-4 h-4 text-secondary" />
              {group.userCount} user{group.userCount !== 1 ? 's' : ''}
            </span>
            <span className="flex items-center gap-1.5">
              <PuzzlePieceIcon className="w-4 h-4 text-secondary" />
              {group.addonCount} addon{group.addonCount !== 1 ? 's' : ''}
            </span>
            <SyncBadge
              groupId={group.id}
              onSync={async (id) => {
                try {
                  await api.syncGroup(id);
                  toast.success(`Synced ${group.name} successfully`);
                } catch (err: any) {
                  toast.error(err.message || `Failed to sync ${group.name}`);
                }
              }}
              size="sm"
            />
          </div>
          <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <SelectionCheckbox
              checked={isSelected}
              onChange={onToggleSelect}
            />
          </div>
        </div>
      </Card>
  );

  return (
    <>
      {focusable ? (
        <TVFocusable onEnterPress={() => { window.location.href = `/groups/${group.id}`; }}>
          {cardElement}
        </TVFocusable>
      ) : cardElement}

      <ContextMenu isOpen={isOpen} position={position} onClose={close}>
        <Link
          href={`/groups/${group.id}`}
          className="flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
          onClick={(e) => { e.stopPropagation(); close(); }}
        >
          <EyeIcon className="w-4 h-4" />
          View Details
        </Link>
        <button
          onClick={handleSync}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <ArrowPathIcon className="w-4 h-4" />
          Sync Group
        </button>
        <button
          onClick={handleClone}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-surface-hover transition-colors"
        >
          <DocumentDuplicateIcon className="w-4 h-4" />
          Clone Group
        </button>
        <div className="my-1 border-t border-default" />
        <button
          onClick={handleDelete}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-error-muted transition-colors"
        >
          <TrashIcon className="w-4 h-4" />
          Delete
        </button>
      </ContextMenu>
    </>
  );
}

// Create Group Modal - Premium styled
function CreateGroupModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedColorIndex, setSelectedColorIndex] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setTimeout(() => {
        setName('');
        setDescription('');
        setSelectedColorIndex(0);
        setShowSuccess(false);
      }, 300);
    }
  }, [isOpen]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('Please enter a group name');
      return;
    }

    setIsLoading(true);
    try {
      const newGroup = await api.createGroup({
        name: name.trim(),
        description: description.trim() || undefined,
        colorIndex: selectedColorIndex,
      } as any);
      setShowSuccess(true);
      setTimeout(() => {
        onClose();
        if (newGroup?.id) {
          window.location.href = `/groups/${newGroup.id}`;
        } else {
          window.location.reload();
        }
      }, 800);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create group');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <Dialog open={isOpen} onClose={onClose} className="relative z-50">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0"
            style={{
              background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.85) 100%)',
              backdropFilter: 'blur(8px)'
            }}
          />

          <div className="fixed inset-0 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            >
              <DialogPanel
                className="w-full overflow-hidden"
                style={{
                  background: 'var(--color-surface)',
                  borderRadius: '24px',
                  border: '1px solid var(--color-surface-border)',
                  boxShadow: '0 0 0 1px rgba(255,255,255,0.05), 0 40px 80px -20px rgba(0,0,0,0.5)',
                  maxWidth: '512px'
                }}
              >
                {/* Decorative header gradient */}
                <div
                  className="h-1.5 w-full"
                  style={{
                    background: 'linear-gradient(90deg, var(--color-primary) 0%, color-mix(in srgb, var(--color-primary) 60%, var(--color-secondary)) 50%, var(--color-secondary) 100%)'
                  }}
                />

                <div className="p-8">
                  <AnimatePresence mode="wait">
                    {!showSuccess ? (
                      <motion.div
                        key="form"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                      >
                        {/* Header */}
                        <div className="text-center mb-8">
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: 'spring', delay: 0.1 }}
                            className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center"
                            style={{
                              background: 'linear-gradient(135deg, var(--color-primary) 0%, color-mix(in srgb, var(--color-primary) 70%, var(--color-secondary)) 100%)',
                              boxShadow: '0 8px 32px -8px var(--color-primary)'
                            }}
                          >
                            <UsersIcon className="w-8 h-8 text-white" />
                          </motion.div>
                          <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--color-text)' }}>
                            Create New Group
                          </h2>
                          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                            Organize users and manage shared addons
                          </p>
                        </div>

                        {/* Form */}
                        <div className="space-y-5">
                          <div>
                            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
                              Group Name <span style={{ color: 'var(--color-error)' }}>*</span>
                            </label>
                            <input
                              type="text"
                              placeholder="e.g., Family, Premium, Movies"
                              value={name}
                              onChange={(e) => setName(e.target.value)}
                              className="w-full px-4 py-3.5 rounded-xl transition-all duration-200 focus:outline-none"
                              style={{
                                background: 'var(--color-subtle)',
                                border: '1px solid var(--color-surface-border)',
                                color: 'var(--color-text)'
                              }}
                            />
                          </div>

                          <div>
                            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
                              Description
                            </label>
                            <input
                              type="text"
                              placeholder="Brief description of this group"
                              value={description}
                              onChange={(e) => setDescription(e.target.value)}
                              className="w-full px-4 py-3.5 rounded-xl transition-all duration-200 focus:outline-none"
                              style={{
                                background: 'var(--color-subtle)',
                                border: '1px solid var(--color-surface-border)',
                                color: 'var(--color-text)'
                              }}
                            />
                          </div>

                          <div>
                            <label className="block text-sm font-medium mb-3" style={{ color: 'var(--color-text-muted)' }}>
                              Group Color
                            </label>
                            <AvatarColorSwatches value={selectedColorIndex} onChange={setSelectedColorIndex} />
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-3 mt-8">
                          <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 py-3.5 text-sm font-medium rounded-xl transition-colors"
                            style={{
                              background: 'var(--color-subtle)',
                              color: 'var(--color-text)'
                            }}
                          >
                            Cancel
                          </button>
                          <Button
                            variant="primary"
                            className="flex-1"
                            onClick={handleSubmit}
                            isLoading={isLoading}
                          >
                            Create Group
                          </Button>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="success"
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-center py-8"
                      >
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', delay: 0.1, damping: 10 }}
                          className="w-20 h-20 mx-auto mb-6 rounded-full flex items-center justify-center"
                          style={{
                            background: 'linear-gradient(135deg, var(--color-secondary) 0%, color-mix(in srgb, var(--color-secondary) 80%, var(--color-primary)) 100%)',
                            boxShadow: '0 12px 40px -8px var(--color-secondary)'
                          }}
                        >
                          <CheckIcon className="w-10 h-10 text-white" />
                        </motion.div>
                        <h3 className="text-2xl font-bold mb-2" style={{ color: 'var(--color-text)' }}>
                          Group Created!
                        </h3>
                        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                          {name} is ready to use
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </DialogPanel>
            </motion.div>
          </div>
        </Dialog>
      )}
    </AnimatePresence>
  );
}

// Clone Group Modal
function CloneGroupModal({
  isOpen,
  onClose,
  group,
}: {
  isOpen: boolean;
  onClose: () => void;
  group: GroupDisplay;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [name, setName] = useState(`${group.name} (Copy)`);
  const [description, setDescription] = useState(group.description || '');
  const [selectedColorIndex, setSelectedColorIndex] = useState(0);
  const [includeUsers, setIncludeUsers] = useState(false);

  // Initialize from group
  useEffect(() => {
    if (isOpen && group) {
      setName(`${group.name} (Copy)`);
      setDescription(group.description || '');
      setSelectedColorIndex(group.colorIndex ?? 0);
    }
  }, [isOpen, group]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('Please enter a group name');
      return;
    }

    setIsLoading(true);
    try {
      const newGroup = await api.createGroup({
        name: name.trim(),
        description: description.trim() || undefined,
        colorIndex: selectedColorIndex,
      } as any);

      if (includeUsers && group.users.length > 0) {
        for (const user of group.users) {
          try {
            await api.addUserToGroup(newGroup.id, user.id);
          } catch (err) {
            console.error('Failed to add user to cloned group:', err);
          }
        }
      }

      toast.success('Group cloned successfully');
      onClose();
      window.location.reload();
    } catch (err: any) {
      toast.error(err.message || 'Failed to clone group');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <Dialog open={isOpen} onClose={onClose} className="relative z-50">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0"
            style={{
              background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.85) 100%)',
              backdropFilter: 'blur(8px)'
            }}
          />

          <div className="fixed inset-0 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            >
              <DialogPanel
                className="w-full overflow-hidden"
                style={{
                  background: 'var(--color-surface)',
                  borderRadius: '24px',
                  border: '1px solid var(--color-surface-border)',
                  boxShadow: '0 0 0 1px rgba(255,255,255,0.05), 0 40px 80px -20px rgba(0,0,0,0.5)',
                  maxWidth: '512px'
                }}
              >
                <div
                  className="h-1.5 w-full"
                  style={{
                    background: 'linear-gradient(90deg, var(--color-primary) 0%, color-mix(in srgb, var(--color-primary) 60%, var(--color-secondary)) 50%, var(--color-secondary) 100%)'
                  }}
                />

                <div className="p-8">
                  <div className="text-center mb-8">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', delay: 0.1 }}
                      className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center"
                      style={{
                        background: 'linear-gradient(135deg, var(--color-primary) 0%, color-mix(in srgb, var(--color-primary) 70%, var(--color-secondary)) 100%)',
                        boxShadow: '0 8px 32px -8px var(--color-primary)'
                      }}
                    >
                      <DocumentDuplicateIcon className="w-8 h-8 text-white" />
                    </motion.div>
                    <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--color-text)' }}>
                      Clone Group
                    </h2>
                    <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                      Create a copy of "{group.name}"
                    </p>
                  </div>

                  <div className="space-y-5">
                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
                        Group Name <span style={{ color: 'var(--color-error)' }}>*</span>
                      </label>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full px-4 py-3.5 rounded-xl transition-all duration-200 focus:outline-none"
                        style={{
                          background: 'var(--color-subtle)',
                          border: '1px solid var(--color-surface-border)',
                          color: 'var(--color-text)'
                        }}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
                        Description
                      </label>
                      <input
                        type="text"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="w-full px-4 py-3.5 rounded-xl transition-all duration-200 focus:outline-none"
                        style={{
                          background: 'var(--color-subtle)',
                          border: '1px solid var(--color-surface-border)',
                          color: 'var(--color-text)'
                        }}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-3" style={{ color: 'var(--color-text-muted)' }}>
                        Group Color
                      </label>
                      <AvatarColorSwatches value={selectedColorIndex} onChange={setSelectedColorIndex} />
                    </div>

                    <motion.button
                      type="button"
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      onClick={() => setIncludeUsers(!includeUsers)}
                      className={`w-full flex items-center gap-3 p-4 rounded-xl transition-all cursor-pointer ${includeUsers ? 'opt-row-on' : 'opt-row-off'}`}
                    >
                      <div
                        className={`w-5 h-5 rounded-md flex items-center justify-center transition-all ${includeUsers ? 'opt-box-on' : 'opt-box-off'}`}
                      >
                        {includeUsers && <CheckIcon className="w-3 h-3 text-white" />}
                      </div>
                      <div className="text-left">
                        <p className="font-medium" style={{ color: 'var(--color-text)' }}>Include Users</p>
                        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                          Copy all {group.users.length} user{group.users.length !== 1 ? 's' : ''} to the new group
                        </p>
                      </div>
                    </motion.button>
                  </div>

                  <div className="flex gap-3 mt-8">
                    <button
                      type="button"
                      onClick={onClose}
                      className="flex-1 py-3.5 text-sm font-medium rounded-xl transition-colors"
                      style={{
                        background: 'var(--color-subtle)',
                        color: 'var(--color-text)'
                      }}
                    >
                      Cancel
                    </button>
                    <Button
                      variant="primary"
                      className="flex-1"
                      onClick={handleSubmit}
                      isLoading={isLoading}
                    >
                      Clone Group
                    </Button>
                  </div>
                </div>
              </DialogPanel>
            </motion.div>
          </div>
        </Dialog>
      )}
    </AnimatePresence>
  );
}
