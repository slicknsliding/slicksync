'use client';

// Nuvio Collections in the v2 page design: whose Nuvio and which profile as
// one button, Save changes as the one obvious button (the header says when
// there are unsaved changes), each collection as a section of folder tiles
// with an "Add a folder" tile. Export, import, templates, Home rows and Copy
// rows onto... sit in ⋯. The page owns the data, handlers and modals; this
// only draws them. A collection's order is real data (it is the order on the
// Nuvio home screen), so collections fold here but are moved with Move up and
// Move down in their own ⋯, not with Arrange.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownIcon, ArrowDownTrayIcon, ArrowUpIcon, ArrowUpTrayIcon, Bars3BottomLeftIcon,
  ChevronDownIcon, ChevronRightIcon, DocumentDuplicateIcon, EyeIcon, ExclamationTriangleIcon, FolderIcon,
  LinkIcon, MapPinIcon, PlusIcon, QuestionMarkCircleIcon, RectangleStackIcon, SparklesIcon, TrashIcon,
} from '@heroicons/react/24/outline';
import {
  DndContext, closestCenter, SortableContext, useSortable, useSortableSensors, CSS,
} from '@/components/ui';
import { Avatar } from '@/components/ui/Avatar';
import { rectSortingStrategy } from '@dnd-kit/sortable';
import { restrictToParentElement } from '@dnd-kit/modifiers';
import type { DragEndEvent } from '@dnd-kit/core';
import type { NuvioCollection, NuvioCollectionFolder, NuvioCatalogSource, NuvioProfile, User } from '@/lib/api';
import { useNameFolds } from '@/lib/arrange';
import { V2Button, V2Status } from './V2Bits';
import { V2DetailHead, V2MoreMenu, V2Tiles, type V2MenuItem } from './V2Detail';

type PreviewItems = { id: string; type: string; name: string; poster: string | null }[];

export type NuvioV2Props = {
  usersLoading: boolean;
  nuvioUsers: User[];
  selectedUser: User | null;
  selectedUserId: string;
  onSelectUser: (id: string) => void;
  profiles: NuvioProfile[];
  profilesLoading: boolean;
  selectedProfileIndex: number | null;
  onSelectProfile: (userId: string, profileIndex: number) => void;
  collections: NuvioCollection[];
  collectionsLoading: boolean;
  isDirty: boolean;
  saving: boolean;
  onSave: () => void;
  onAddCollection: () => void;
  // ⋯ menu
  hasCollections: boolean;
  otherProfiles: NuvioProfile[];
  homeRowsArmed: number | null;
  homeRowsBusy: boolean;
  onTemplates: () => void;
  onImport: () => void;
  onExport: () => void;
  onPasteCode: () => void;
  onCreateCode: () => void;
  onWhere: () => void;
  onEditRows: () => void;
  onCopyRows: (profileIndex: number) => void;
  onTips: () => void;
  // Collections
  previewByFolder: Record<string, PreviewItems>;
  previewLoadingIds: Set<string>;
  brokenFolderIds: Set<string>;
  describeSource: (s: NuvioCatalogSource) => { linked: boolean; addonName: string; found: boolean };
  onRename: (collectionId: string, title: string) => void;
  onReorder: (cIndex: number, dir: -1 | 1) => void;
  onDeleteCollection: (collectionId: string) => void;
  onCopyCollection: (c: NuvioCollection) => void;
  onTogglePin: (c: NuvioCollection) => void;
  onPreview: (c: NuvioCollection) => void;
  onAddFolder: (collectionId: string) => void;
  onOpenFolder: (collectionId: string, folderId: string) => void;
  onDeleteFolder: (collectionId: string, folderId: string) => void;
  onFolderDragEnd: (collectionId: string) => (event: DragEndEvent) => void;
  /** The home-row editor, drawn by the page, shown instead of the collections while editing rows. */
  editor: ReactNode;
};

const TILE = 'flex items-center gap-3 min-w-0 rounded-2xl border border-[var(--color-surface-border)] bg-[var(--color-surface)] p-2.5';
const ADD_TILE = 'flex items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--color-surface-border)] px-3.5 py-3 min-h-[66px] text-muted hover:text-default hover:border-[var(--color-primary)] transition-colors cursor-pointer';

function profileName(p: NuvioProfile) {
  return p.name || `Profile ${p.profile_index}`;
}

/** Whose Nuvio and which profile: one button that opens the list. */
function AccountPill({ p }: { p: NuvioV2Props }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const u = p.selectedUser;
  const uname = u?.name || u?.email || p.selectedUserId;
  const prof = p.profiles.find((x) => x.profile_index === p.selectedProfileIndex);
  const sub = prof ? profileName(prof) : p.profilesLoading ? 'Loading profiles…' : 'Pick a profile';

  return (
    <div ref={ref} className="relative inline-block max-w-full">
      <button
        type="button"
        className="v2-btn"
        style={{ padding: '6px 12px 6px 6px', gap: 10, maxWidth: '100%' }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch account or profile"
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={uname} email={u?.email} src={u?.avatarUrl || undefined} useGravatar={u?.useGravatar} colorIndex={u?.colorIndex} size="sm" />
        <span className="text-left min-w-0">
          <b className="block text-[13.5px] truncate">{uname}</b>
          <span className="block text-muted text-[12px] truncate">{sub}</span>
        </span>
        <ChevronDownIcon className="w-4 h-4 shrink-0 text-muted" />
      </button>
      {open && (
        <div role="menu" className="arrange-menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 'auto', zIndex: 40, width: 280, maxWidth: '86vw', maxHeight: '60vh', overflowY: 'auto' }}>
          {p.nuvioUsers.map((x) => {
            const isSel = x.id === p.selectedUserId;
            const name = x.name || x.email || x.id;
            return (
              <div key={x.id}>
                <button
                  type="button"
                  role="menuitem"
                  className="arrange-menu-item"
                  onClick={() => { if (isSel) return; p.onSelectUser(x.id); }}
                >
                  <Avatar name={name} email={x.email} src={x.avatarUrl || undefined} useGravatar={x.useGravatar} colorIndex={x.colorIndex} size="xs" />
                  <span className="truncate flex-1 text-left">{name}</span>
                  {isSel && <span className="text-muted text-[12px]">Current</span>}
                </button>
                {isSel && (p.profilesLoading ? (
                  <div className="px-3 py-2 text-[12.5px] text-muted">Loading profiles…</div>
                ) : p.profiles.length > 1 ? (
                  <div className="pl-5">
                    {p.profiles.map((pr) => (
                      <button
                        key={pr.profile_index}
                        type="button"
                        role="menuitemradio"
                        aria-checked={p.selectedProfileIndex === pr.profile_index}
                        className="arrange-menu-item"
                        onClick={() => { setOpen(false); p.onSelectProfile(p.selectedUserId, pr.profile_index); }}
                      >
                        <span className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: pr.avatar_color_hex || 'var(--color-surface-hover)' }} />
                        <span className="truncate flex-1 text-left">{profileName(pr)}</span>
                        {p.selectedProfileIndex === pr.profile_index && <span className="text-muted text-[12px]">Open</span>}
                      </button>
                    ))}
                  </div>
                ) : null)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A folder: its posters, its name, where it pulls from. Drag to reorder, click to open. */
function FolderCard({ folder, p, onOpen, onDelete }: {
  folder: NuvioCollectionFolder;
  p: NuvioV2Props;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: folder.id });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition: isDragging ? 'none' : transition, zIndex: isDragging ? 50 : undefined };
  const sources = folder.catalogSources || [];
  const n = sources.length;
  const items = p.previewByFolder[folder.id] || [];
  const loading = p.previewLoadingIds.has(folder.id);
  const broken = p.brokenFolderIds.has(folder.id);
  const cover = typeof folder.coverImageUrl === 'string' && folder.coverImageUrl ? folder.coverImageUrl : null;
  const posters = items.filter((i) => i.poster).slice(0, 3);

  let line: ReactNode;
  if (n === 0) line = <span style={{ color: 'var(--color-warning, #f59e0b)' }}>Won’t appear in Nuvio yet</span>;
  else if (broken) line = <span style={{ color: 'var(--color-warning, #f59e0b)' }}>Needs attention</span>;
  else {
    const first = p.describeSource(sources[0]);
    if (n === 1) line = first.linked ? 'Linked catalog · keeps itself up to date' : `From ${first.addonName}`;
    else line = `${n} sources`;
  }

  return (
    <div ref={setNodeRef} style={style} className={`relative ${isDragging ? 'opacity-50' : ''}`}>
      <div className={TILE}>
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
          title="Open this folder (drag to reorder)"
          {...attributes}
          {...listeners}
        >
          <span className="flex gap-[3px] w-[62px] h-[46px] shrink-0 rounded-md overflow-hidden bg-[var(--color-surface-hover)] items-center justify-center">
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cover} alt="" className="w-full h-full object-cover" />
            ) : posters.length > 0 ? (
              posters.map((it) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={it.id} src={it.poster as string} alt="" className="flex-1 min-w-0 h-full object-cover" />
              ))
            ) : loading ? (
              <span className="w-4 h-4 border-2 border-subtle border-t-transparent rounded-full animate-spin" />
            ) : (
              <FolderIcon className="w-6 h-6 text-subtle" />
            )}
          </span>
          <span className="flex-1 min-w-0">
            <b className="block text-[14px] truncate text-default">{folder.title || 'Untitled folder'}</b>
            <span className="block text-muted text-[12px] truncate">{line}</span>
          </span>
          {(broken || n === 0) && <ExclamationTriangleIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-warning, #f59e0b)' }} />}
        </button>
        <V2MoreMenu
          label={`${folder.title || 'Folder'} options`}
          items={[
            { label: 'Open', icon: <EyeIcon className="w-4 h-4" />, onClick: onOpen },
            { label: 'Delete folder', icon: <TrashIcon className="w-4 h-4" />, danger: true, onClick: onDelete },
          ]}
        />
      </div>
    </div>
  );
}

/** One collection: its name (type to rename), how many folders, ⋯, and its folder tiles. */
function CollectionBox({ collection, cIndex, p }: { collection: NuvioCollection; cIndex: number; p: NuvioV2Props }) {
  const sensors = useSortableSensors();
  const [folded, setFolded] = useState(false);
  const nameTap = useNameFolds().on;
  const folders = useMemo(() => collection.folders || [], [collection.folders]);
  const attention = folders.filter((f) => p.brokenFolderIds.has(f.id) || (f.catalogSources || []).length === 0).length;
  const pinned = !!collection.pinToTop;
  const last = cIndex >= p.collections.length - 1;

  const more: V2MenuItem[] = [
    { label: 'Preview layout', icon: <EyeIcon className="w-4 h-4" />, disabled: folders.every((f) => (f.catalogSources || []).length === 0), onClick: () => p.onPreview(collection) },
    { label: pinned ? 'Unpin from top' : 'Pin to top of home screen', icon: <MapPinIcon className="w-4 h-4" />, onClick: () => p.onTogglePin(collection) },
    { label: 'Copy to another profile', icon: <DocumentDuplicateIcon className="w-4 h-4" />, disabled: p.otherProfiles.length === 0, onClick: () => p.onCopyCollection(collection) },
    { label: 'Move up', icon: <ArrowUpIcon className="w-4 h-4" />, disabled: cIndex === 0, onClick: () => p.onReorder(cIndex, -1) },
    { label: 'Move down', icon: <ArrowDownIcon className="w-4 h-4" />, disabled: last, onClick: () => p.onReorder(cIndex, 1) },
    { label: 'Delete collection', icon: <TrashIcon className="w-4 h-4" />, danger: true, onClick: () => p.onDeleteCollection(collection.id) },
  ];

  const addFolder = (
    <button type="button" className={ADD_TILE} onClick={() => p.onAddFolder(collection.id)}>
      <PlusIcon className="w-4 h-4" />
      Add a folder
    </button>
  );

  return (
    <section className="arrange-section" aria-label={collection.title || 'Collection'}>
      <div
        className={`flex items-center gap-2.5 min-w-0${nameTap ? ' cursor-pointer' : ''}`}
        onClick={nameTap ? (e) => { if ((e.target as HTMLElement).closest('a, button, input, select, textarea, [role=menu]')) return; setFolded((v) => !v); } : undefined}
      >
        <button
          type="button"
          className="arrange-icon"
          aria-label={folded ? 'Unfold this collection' : 'Fold this collection'}
          aria-expanded={!folded}
          onClick={() => setFolded((v) => !v)}
        >
          {folded ? <ChevronRightIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
        </button>
        <input
          value={collection.title}
          onChange={(e) => p.onRename(collection.id, e.target.value)}
          aria-label="Collection name"
          placeholder="Collection name"
          className="flex-1 min-w-0 text-lg font-semibold bg-transparent border border-transparent hover:border-[var(--color-surface-border)] focus:border-[var(--color-primary)] focus:outline-none rounded-lg px-2 py-0.5 text-default"
        />
        <span className="text-muted text-[13px] shrink-0 max-sm:hidden">
          {folders.length} folder{folders.length === 1 ? '' : 's'}
          {pinned ? ' · pinned to top' : ''}
          {attention > 0 ? <span style={{ color: 'var(--color-warning, #f59e0b)' }}> · {attention} need{attention === 1 ? 's' : ''} attention</span> : null}
        </span>
        <V2MoreMenu label={`${collection.title || 'Collection'} options`} items={more} />
      </div>
      {!folded && (
        <div className="mt-3">
          {folders.length === 0 ? (
            <V2Tiles wide={3}>{addFolder}</V2Tiles>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={p.onFolderDragEnd(collection.id)} modifiers={[restrictToParentElement]}>
              <SortableContext items={folders.map((f) => f.id)} strategy={rectSortingStrategy}>
                <V2Tiles wide={3}>
                  {folders.map((f) => (
                    <FolderCard
                      key={f.id}
                      folder={f}
                      p={p}
                      onOpen={() => p.onOpenFolder(collection.id, f.id)}
                      onDelete={() => p.onDeleteFolder(collection.id, f.id)}
                    />
                  ))}
                  {addFolder}
                </V2Tiles>
              </SortableContext>
            </DndContext>
          )}
        </div>
      )}
    </section>
  );
}

export function NuvioCollectionsV2(p: NuvioV2Props) {
  const hasProfile = p.selectedProfileIndex !== null;
  const nC = p.collections.length;
  const prof = p.profiles.find((x) => x.profile_index === p.selectedProfileIndex);

  const more: V2MenuItem[] = hasProfile ? [
    { label: 'Use a template', icon: <SparklesIcon className="w-4 h-4" />, onClick: p.onTemplates },
    { label: 'Edit this profile’s home rows', icon: <Bars3BottomLeftIcon className="w-4 h-4" />, onClick: p.onEditRows },
    ...p.otherProfiles.map((o) => ({
      label: p.homeRowsBusy && p.homeRowsArmed === null
        ? 'Copying…'
        : p.homeRowsArmed === o.profile_index
          ? `Choose again to overwrite ${profileName(o)}`
          : `Copy rows onto ${profileName(o)}`,
      icon: <DocumentDuplicateIcon className="w-4 h-4" />,
      disabled: p.homeRowsBusy,
      onClick: () => p.onCopyRows(o.profile_index),
    })),
    { label: 'Import from JSON…', icon: <ArrowUpTrayIcon className="w-4 h-4" />, onClick: p.onImport },
    { label: 'Export as JSON', icon: <ArrowDownTrayIcon className="w-4 h-4" />, disabled: !p.hasCollections, onClick: p.onExport },
    { label: 'Paste a code…', icon: <LinkIcon className="w-4 h-4" />, onClick: p.onPasteCode },
    { label: 'Create a code…', icon: <LinkIcon className="w-4 h-4" />, disabled: !p.hasCollections, onClick: p.onCreateCode },
    { label: 'Where do I use these?', icon: <QuestionMarkCircleIcon className="w-4 h-4" />, onClick: p.onWhere },
    { label: 'Tips', icon: <QuestionMarkCircleIcon className="w-4 h-4" />, onClick: p.onTips },
  ] : [];

  const status = hasProfile
    ? (p.isDirty ? <V2Status tone="warn">Unsaved changes</V2Status> : <V2Status tone="ok">Saved</V2Status>)
    : undefined;
  const facts = hasProfile
    ? `${nC} collection${nC === 1 ? '' : 's'}${prof ? ` · ${profileName(prof)}` : ''}`
    : 'the rows on a Nuvio home screen';

  const head = (
    <V2DetailHead
      lead={<span className="w-[58px] h-[58px] rounded-2xl flex items-center justify-center text-white" style={{ background: 'linear-gradient(135deg,#6366f1,#a855f7)' }}><RectangleStackIcon className="w-7 h-7" /></span>}
      title="Nuvio Collections"
      status={status}
      facts={facts}
      actions={hasProfile ? (
        <>
          <V2Button primary onClick={p.onSave} disabled={!p.isDirty || p.saving}>{p.saving ? 'Saving' : 'Save changes'}</V2Button>
          <V2Button icon={<PlusIcon className="w-4 h-4" />} onClick={p.onAddCollection}>Add collection</V2Button>
        </>
      ) : undefined}
      more={more}
    />
  );

  // No account yet: the Nuvio sign-ins as tiles.
  if (!p.selectedUserId) {
    return (
      <>
        {head}
        <section className="arrange-section" aria-label="Nuvio account">
          <h2 className="text-lg font-semibold mb-3">Choose a Nuvio account</h2>
          {p.usersLoading ? (
            <V2Tiles wide={3}>{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-[66px] rounded-2xl bg-surface-hover animate-pulse" />)}</V2Tiles>
          ) : p.nuvioUsers.length === 0 ? (
            <p className="text-sm text-muted">No Nuvio-connected people yet.</p>
          ) : (
            <V2Tiles wide={3}>
              {p.nuvioUsers.map((u) => {
                const name = u.name || u.email || u.id;
                return (
                  <button key={u.id} type="button" className="v2-tool" onClick={() => p.onSelectUser(u.id)}>
                    <Avatar name={name} email={u.email} src={u.avatarUrl || undefined} useGravatar={u.useGravatar} colorIndex={u.colorIndex} size="md" />
                    <span className="flex-1 min-w-0 text-left">
                      <b className="block text-[14.5px] truncate text-default">{name}</b>
                      {u.email && u.name && <span className="block text-muted text-[12.5px] truncate">{u.email}</span>}
                    </span>
                  </button>
                );
              })}
            </V2Tiles>
          )}
        </section>
      </>
    );
  }

  return (
    <>
      {head}
      <div className="mb-5"><AccountPill p={p} /></div>
      {hasProfile && p.editor}
      {hasProfile && !p.editor && (
        p.collectionsLoading ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-2xl bg-surface-hover animate-pulse" />)}</div>
        ) : nC === 0 ? (
          <div className="v2-box v2-box-pad text-center">
            <RectangleStackIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
            <p className="text-sm text-muted mb-3">No collections yet on this profile.</p>
            <V2Button primary icon={<PlusIcon className="w-4 h-4" />} onClick={p.onAddCollection}>Add collection</V2Button>
          </div>
        ) : (
          <div className="space-y-6">
            {p.collections.map((c, i) => <CollectionBox key={c.id} collection={c} cIndex={i} p={p} />)}
          </div>
        )
      )}
    </>
  );
}
