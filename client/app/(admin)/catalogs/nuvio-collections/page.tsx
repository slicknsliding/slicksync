'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import {
  Card, Button, Modal, MediaDetailModal, Badge,
  DndContext, closestCenter, SortableContext, useSortable, useSortableSensors, CSS,
} from '@/components/ui';
import { rectSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { restrictToParentElement } from '@dnd-kit/modifiers';
import type { DragEndEvent } from '@dnd-kit/core';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { useDefaultViewMode } from '@/lib/viewMode';
import { toast } from '@/components/ui/Toast';
import {
  api, User, StremioAddon, NuvioProfile, NuvioCollection, NuvioCollectionFolder, NuvioCatalogSource,
} from '@/lib/api';
import {
  ArrowLeftIcon, PlusIcon, TrashIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon,
  ArrowUpIcon, ArrowDownIcon, RectangleStackIcon, FolderIcon, SparklesIcon,
  DocumentDuplicateIcon, PhotoIcon, ExclamationTriangleIcon, MapPinIcon,
  EllipsisVerticalIcon, PencilSquareIcon,
} from '@heroicons/react/24/outline';
import { MapPinIcon as MapPinIconSolid } from '@heroicons/react/24/solid';
import { AvatarPickerModal } from '@/components/modals/AvatarPickerModal';

// Starter templates - genre folders built from each catalog's own "genre"
// extra parameter, not from separate per-genre catalogs. Confirmed two ways
// this session: real installed addons expose genre as a filter VALUE on one
// broad catalog (manifest.catalogs[].extra: [{name:'genre', options:[...]}])
// rather than one catalog per genre, and real Collections data already
// carries a `genre` field on each catalogSource entry for exactly this
// reason. An earlier version of this feature matched by catalog NAME
// keywords instead (e.g. hunting for a catalog literally named "Action" or
// "Netflix") - that failed against a real test account (0 of 9 folders
// matched) because AIOMetadata's actual catalogs are generic/aggregated
// ("Mix Of Movies", "TMDB + TVDB"), and "streaming service" folders in a
// real account turned out to be hand-curated mdblist picks with no signal
// in the catalog name at all - not something automatable, so that template
// was dropped rather than shipped as something that mostly shows "0
// matches."
interface GenreTemplateSlot {
  title: string;
  aliases: string[]; // matched case-insensitively against a catalog's own genre option value
}

const GENRE_TEMPLATE: { id: string; title: string; description: string; genres: GenreTemplateSlot[] } = {
  id: 'genres',
  title: 'Genres',
  description: "One folder per genre, using each matching catalog's own genre filter - not a separate catalog per genre.",
  // Broader than TMDb's own genre list (the usual source addons draw their
  // own genre-extra options from) plus a couple of common regional/style
  // groupings (Anime, Korean) real accounts turned out to actually have as
  // their own distinct catalogs, not folded into Animation - splitting
  // those two out matched a real account exactly (13 real matches) where
  // the earlier combined 9-entry list undershot it. Genres with zero
  // matching sources on a given account are dropped automatically (see
  // the filter below), so listing more candidates than any one account
  // will use is free - it only ever produces MORE useful folders, never
  // empty ones.
  genres: [
    { title: 'Action', aliases: ['action'] },
    { title: 'Adventure', aliases: ['adventure'] },
    { title: 'Animation', aliases: ['animation'] },
    { title: 'Anime', aliases: ['anime'] },
    { title: 'Comedy', aliases: ['comedy'] },
    { title: 'Crime', aliases: ['crime'] },
    { title: 'Documentary', aliases: ['documentary'] },
    { title: 'Drama', aliases: ['drama'] },
    { title: 'Family', aliases: ['family'] },
    { title: 'Fantasy', aliases: ['fantasy'] },
    { title: 'Horror', aliases: ['horror'] },
    { title: 'Korean', aliases: ['korean'] },
    { title: 'Music', aliases: ['music', 'musical'] },
    { title: 'Mystery', aliases: ['mystery'] },
    { title: 'Romance', aliases: ['romance'] },
    { title: 'Sci-Fi', aliases: ['sci-fi', 'science fiction'] },
    { title: 'Thriller', aliases: ['thriller'] },
    { title: 'War', aliases: ['war'] },
    { title: 'Western', aliases: ['western'] },
  ],
};

function matchGenreSources(aliases: string[], addons: StremioAddon[]): NuvioCatalogSource[] {
  const matches: NuvioCatalogSource[] = [];
  for (const addon of addons) {
    const addonId = addon.manifest?.id || addon.transportUrl;
    for (const cat of addon.manifest?.catalogs || []) {
      const genreExtra = cat.extra?.find((e) => e.name === 'genre');
      const matchedOption = (genreExtra?.options || []).find((opt) =>
        aliases.some((a) => opt.toLowerCase() === a || opt.toLowerCase().includes(a))
      );
      if (matchedOption) {
        matches.push({ addonId, type: cat.type, catalogId: cat.id, genre: matchedOption });
      }
    }
  }
  return matches;
}

// Nuvio's own native "Collections" - the home-screen folder/catalog-source
// organizer in the real Nuvio app, live-synced against the account itself
// (via sync_pull_collections/sync_push_collections on the same backend
// server/providers/nuvio.js already talks to for library/addons). Distinct
// from this app's local Catalogs lists one level up.
//
// v1 scope is deliberately narrow: title/folders/catalogSources only - the
// structural fields this feature exists to edit, all fully working
// end-to-end. Every other field a real Collection can carry (pinToTop,
// viewMode, coverImageUrl, tileShape, focusGifEnabled, ...) is a Nuvio-app-
// only visual effect with no way to preview from here, so v1 leaves them
// alone entirely rather than shipping an unverifiable toggle. Critically,
// those fields are preserved untouched through edit-and-save (see the
// spread-only mutation helpers below) - editing a title must never silently
// delete a real account's existing settings for the rest.

type PickerTarget = { collectionId: string; folderId: string } | null;

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);
}

function moveItem<T>(arr: T[], index: number, dir: -1 | 1): T[] {
  const next = [...arr];
  const target = index + dir;
  if (target < 0 || target >= next.length) return arr;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// Fresh ids for the collection and every folder inside it, so pasting a
// copy into a target profile never collides with (or aliases) the source's
// own ids. catalogSources carry no id of their own - copied as-is.
function deepCopyCollection(c: NuvioCollection): NuvioCollection {
  return {
    ...c,
    id: newId(),
    folders: (c.folders || []).map((f) => ({ ...f, id: newId(), catalogSources: [...(f.catalogSources || [])] })),
  };
}

type PreviewFolderItems = { id: string; type: string; name: string; poster: string | null }[];

// One grid tile: a single hero poster from the folder's own cached preview
// (ambient - no click needed, which is the actual fix for "the preview icon
// is too small") with the title/source-count on a solid bottom band for
// real contrast regardless of the poster's own colors, and a hover overlay
// that clearly labels the tile as a preview (per feedback: the old 2x2
// multi-poster collage read as "too busy," and it wasn't obvious this tile
// was even clickable). Delete sits as an absolutely-positioned sibling
// button, not nested inside the clickable tile, so a click on it never also
// counts as a click on the tile (see CatalogGridCard in catalogs/[id] for
// the same structure) - drag reorder and the open-folder click coexist
// safely because useSortableSensors' PointerSensor has an 8px activation
// distance, so a plain click never crosses the threshold to start a drag.
function FolderTile({
  folder, previewItems, previewLoading, hasBrokenSource, coverOverride, onOpen, onDelete,
}: {
  folder: NuvioCollectionFolder;
  previewItems?: PreviewFolderItems;
  previewLoading: boolean;
  hasBrokenSource: boolean;
  coverOverride?: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: folder.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? 'none' : transition,
    zIndex: isDragging ? 50 : undefined,
  };
  const sourceCount = (folder.catalogSources || []).length;
  const items = previewItems || [];
  const hero = items[0];
  const heroPoster = coverOverride || hero?.poster;

  return (
    <div ref={setNodeRef} style={style} className={`relative group ${isDragging ? 'opacity-50' : ''}`}>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left rounded-xl overflow-hidden border border-default hover:border-primary/50 transition-colors bg-subtle"
        {...attributes}
        {...listeners}
      >
        <div className="relative aspect-[4/3] bg-surface-hover">
          {heroPoster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={heroPoster} alt="" className="w-full h-full object-cover" />
          ) : sourceCount === 0 || items.length === 0 ? (
            <div className="w-full h-full flex items-center justify-center">
              {previewLoading ? (
                <div className="w-5 h-5 border-2 border-subtle border-t-transparent rounded-full animate-spin" />
              ) : (
                <FolderIcon className="w-8 h-8 text-subtle" />
              )}
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-subtle p-2 text-center">{hero?.name}</div>
          )}

          {/* Hover overlay - explicit "Preview" label + icon, so the tile
              unambiguously reads as clickable instead of relying on the
              cursor alone. */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center gap-1.5 text-white">
              <EyeIcon className="w-6 h-6" />
              <span className="text-xs font-semibold">Preview</span>
            </div>
          </div>

          {/* Solid band (not just a gradient) so title/count stay readable
              against any poster's own colors. */}
          <div className="absolute inset-x-0 bottom-0 bg-black/85 px-2.5 py-2">
            <p className="text-sm font-semibold text-white truncate">{folder.title}</p>
            <p className="text-xs text-white/80 flex items-center gap-1">
              {sourceCount} source{sourceCount !== 1 ? 's' : ''}
              {hasBrokenSource && <span className="text-warning font-medium">· needs attention</span>}
            </p>
          </div>

          {/* Always visible, not hover-only - a broken source is worth
              noticing at a glance, same reasoning as the old tiny preview
              icon that got missed entirely. */}
          {hasBrokenSource && (
            <div title="A source in this folder no longer resolves" className="absolute top-1.5 left-1.5 p-1.5 rounded-lg bg-warning/90 text-black">
              <ExclamationTriangleIcon className="w-4 h-4" />
            </div>
          )}
        </div>
      </button>
      <button
        type="button"
        title="Delete folder"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-1.5 right-1.5 p-1.5 rounded-lg bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-error"
      >
        <TrashIcon className="w-4 h-4" />
      </button>
    </div>
  );
}

// Labeled dropdown for a collection's own actions (pin/copy/reorder/delete) -
// replaces a row of bare icon buttons that real feedback confirmed nobody
// could identify without hovering for a tooltip (no touch equivalent), and
// which visibly overflowed/got clipped on mobile at typical collection-
// header widths. One fixed-width trigger button can never overflow the
// same way a variable-length icon row could.
function CollectionActionsMenu({
  isPinned, canMoveUp, canMoveDown, canCopy, onTogglePin, onCopy, onMoveUp, onMoveDown, onDelete,
}: {
  isPinned: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canCopy: boolean;
  onTogglePin: () => void;
  onCopy: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const item = (label: string, icon: React.ReactNode, onClick: () => void, opts?: { disabled?: boolean; danger?: boolean }) => (
    <button
      type="button"
      disabled={opts?.disabled}
      onClick={() => { onClick(); setOpen(false); }}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none ${opts?.danger ? 'text-error hover:bg-error/10' : 'text-default hover:bg-surface-hover'}`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        title="Collection actions"
        onClick={() => setOpen((v) => !v)}
        className="p-1.5 rounded-lg text-muted hover:text-default hover:bg-surface-hover transition-colors"
      >
        <EllipsisVerticalIcon className="w-5 h-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 rounded-xl border border-default bg-surface shadow-xl z-20 p-1.5">
          {item(isPinned ? 'Unpin from top' : 'Pin to top of home screen', isPinned ? <MapPinIconSolid className="w-4 h-4 text-primary" /> : <MapPinIcon className="w-4 h-4" />, onTogglePin)}
          {item('Copy to another profile', <DocumentDuplicateIcon className="w-4 h-4" />, onCopy, { disabled: !canCopy })}
          {item('Move up', <ArrowUpIcon className="w-4 h-4" />, onMoveUp, { disabled: !canMoveUp })}
          {item('Move down', <ArrowDownIcon className="w-4 h-4" />, onMoveDown, { disabled: !canMoveDown })}
          <div className="my-1 border-t border-default" />
          {item('Delete collection', <TrashIcon className="w-4 h-4" />, onDelete, { danger: true })}
        </div>
      )}
    </div>
  );
}

// One collection: header (rename/reorder/copy/delete, all at a real hit-
// target size instead of the old cramped w-3.5 icon row) plus a responsive
// grid of FolderTiles instead of an always-expanded indented list - the
// actual "make it feel like a grid, not a list" change. A dedicated
// component (rather than inlining this in a .map()) so useSortableSensors -
// a hook - can be called once per collection's own DndContext, each
// collection reordering its folders independently of every other one.
function CollectionSection({
  collection, cIndex, collectionsLength, otherProfilesCount,
  previewByFolder, previewLoadingIds, brokenFolderIds,
  onRename, onReorder, onDelete, onCopy, onAddFolder, onOpenFolder, onDeleteFolder, onFolderDragEnd, onTogglePin,
}: {
  collection: NuvioCollection;
  cIndex: number;
  collectionsLength: number;
  otherProfilesCount: number;
  previewByFolder: Record<string, PreviewFolderItems>;
  previewLoadingIds: Set<string>;
  brokenFolderIds: Set<string>;
  onRename: (title: string) => void;
  onReorder: (dir: -1 | 1) => void;
  onDelete: () => void;
  onCopy: () => void;
  onAddFolder: () => void;
  onOpenFolder: (folderId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onFolderDragEnd: (event: DragEndEvent) => void;
  onTogglePin: () => void;
}) {
  const sensors = useSortableSensors();
  const folders = collection.folders || [];
  const isPinned = !!collection.pinToTop;
  const brokenFolderCount = folders.filter((f) => brokenFolderIds.has(f.id)).length;

  return (
    <Card padding="lg" className="mb-4">
      <div className="flex items-center gap-2 mb-4">
        {/* Deliberately no collection-level cover editor here - real
            feedback was that a cover picker at this level is confusing
            clutter, since the thing anyone actually wants to customize is
            each individual FOLDER inside a collection (Netflix, Prime,
            etc - see FolderTile's own cover picker for that). Removed
            2026-08-05, not just restyled - a folder-level-only earlier
            pass here missed the actual ask twice before landing on this. */}
        <input
          value={collection.title}
          onChange={(e) => onRename(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-transparent text-base font-semibold text-default border border-transparent hover:border-default focus:border-primary focus:outline-none"
        />
        <span className="text-xs text-subtle shrink-0 mr-1">
          {folders.length} folder{folders.length !== 1 ? 's' : ''}
          {brokenFolderCount > 0 && <span className="text-warning ml-1">· {brokenFolderCount} need{brokenFolderCount === 1 ? 's' : ''} attention</span>}
        </span>
        <CollectionActionsMenu
          isPinned={isPinned}
          canMoveUp={cIndex > 0}
          canMoveDown={cIndex < collectionsLength - 1}
          canCopy={otherProfilesCount > 0}
          onTogglePin={onTogglePin}
          onCopy={onCopy}
          onMoveUp={() => onReorder(-1)}
          onMoveDown={() => onReorder(1)}
          onDelete={onDelete}
        />
      </div>

      {folders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-default p-6 text-center">
          <p className="text-sm text-muted mb-3">No folders yet.</p>
          <Button variant="secondary" size="sm" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={onAddFolder}>Add folder</Button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onFolderDragEnd} modifiers={[restrictToParentElement]}>
          <SortableContext items={folders.map((f) => f.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {folders.map((folder) => (
                <FolderTile
                  key={folder.id}
                  folder={folder}
                  previewItems={previewByFolder[folder.id]}
                  previewLoading={previewLoadingIds.has(folder.id)}
                  hasBrokenSource={brokenFolderIds.has(folder.id)}
                  coverOverride={typeof folder.coverImageUrl === 'string' ? folder.coverImageUrl : undefined}
                  onOpen={() => onOpenFolder(folder.id)}
                  onDelete={() => onDeleteFolder(folder.id)}
                />
              ))}
              <button
                type="button"
                onClick={onAddFolder}
                className="aspect-[4/3] rounded-xl border border-dashed border-default hover:border-primary/50 flex flex-col items-center justify-center gap-1.5 text-subtle hover:text-default transition-colors"
              >
                <PlusIcon className="w-6 h-6" />
                <span className="text-xs font-medium">Add folder</span>
              </button>
            </div>
          </SortableContext>
        </DndContext>
      )}
    </Card>
  );
}

export default function NuvioCollectionsPage() {
  const { layoutMode } = useLayoutMode();
  const router = useRouter();
  // Shared app-wide grid/list preference (Settings -> Themes), same hook
  // Activity/Addons/Users/etc. already use - defaults to 'grid' when unset.
  // Deliberately no page-level toggle for it here - it follows the global
  // Settings choice silently, same as every other page that reads it.
  const { viewMode } = useDefaultViewMode();
  // List mode only: which collection/folder rows are expanded, mirroring
  // the original inline nested-list UX exactly (grid mode has no notion of
  // "expanded" - each folder is its own always-visible tile).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState('');

  const [profiles, setProfiles] = useState<NuvioProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [selectedProfileIndex, setSelectedProfileIndex] = useState<number | null>(null);

  const [collections, setCollections] = useState<NuvioCollection[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState('[]');
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [addons, setAddons] = useState<StremioAddon[]>([]);
  const [addonsLoading, setAddonsLoading] = useState(false);

  const [deleting, setDeleting] = useState<{ kind: 'collection' | 'folder'; collectionId: string; folderId?: string } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const [pickerTarget, setPickerTarget] = useState<PickerTarget>(null);
  const [pickerAddonId, setPickerAddonId] = useState<string | null>(null);
  const [pickerCatalog, setPickerCatalog] = useState<{ id: string; type: string; name?: string } | null>(null);
  const [pickerPreview, setPickerPreview] = useState<{ id: string; type: string; name: string; poster: string | null }[]>([]);
  const [pickerPreviewLoading, setPickerPreviewLoading] = useState(false);
  const [detail, setDetail] = useState<{ id: string; type: string; name: string; poster?: string | null } | null>(null);

  // Per-folder preview cache - powers both the ambient poster-collage tile
  // thumbnail (ever-visible, no click needed - the actual fix for "the
  // preview icon is too small") and the folder detail modal's larger poster
  // row. Read-only: no setCollections call anywhere in this flow, so it
  // can't touch the unsaved-changes/dirty-state guard at all. Prefetched
  // automatically per-folder (see the effect below) rather than gated
  // behind an explicit "Preview" click.
  const [previewByFolder, setPreviewByFolder] = useState<Record<string, PreviewFolderItems>>({});
  const [previewLoadingIds, setPreviewLoadingIds] = useState<Set<string>>(new Set());

  // Which folder's detail modal (rename / sources / live preview row) is
  // open - clicking a grid tile opens this instead of the old always-
  // expanded inline nested list.
  const [folderDetail, setFolderDetail] = useState<{ collectionId: string; folderId: string } | null>(null);
  // Sources and Preview are tabs, not stacked sections - a folder with a
  // lot of preview posters otherwise pushed Sources far enough down that
  // reaching "Add source" needed scrolling every time, the actual place
  // most of the editing happens. Defaults to Sources for exactly that
  // reason; Preview is one click away, not the default landing view.
  const [folderDetailTab, setFolderDetailTab] = useState<'sources' | 'preview'>('sources');

  // List mode only - the original per-collection "Preview layout" button
  // (all folders at once). Reads straight from the same ambient
  // previewByFolder cache the grid tiles already populate - no separate
  // fetch-on-click needed the way the pre-redesign version had, since the
  // prefetch effect above already loads every folder's preview regardless
  // of which view mode is active.
  const [previewCollection, setPreviewCollection] = useState<NuvioCollection | null>(null);

  // Copy a Collection to another profile - writes immediately (not staged
  // in local `collections` state) since there's no "current session" for a
  // profile you're not actively viewing to hold a draft in.
  const [copyTarget, setCopyTarget] = useState<NuvioCollection | null>(null);
  const [copyingToIndex, setCopyingToIndex] = useState<number | null>(null);

  // Which collection's cover-image picker is open. coverImageUrl is a real
  // field Nuvio's own app reads (unlike most other unedited Collection
  // fields - see the big comment above this component) so it's worth a
  // real editor, reusing the same AvatarPickerModal Catalogs already uses.

  // Per-folder cover - coverImageUrl is a real field on the folder object
  // itself (confirmed via a real exported Collections JSON: each folder has
  // its own coverImageUrl, alongside tileShape/focusGifUrl/hideTitle - not
  // just a collection-level field). Read/write it the same way the
  // collection-level cover already does, straight on the folder object via
  // updateFolder, so it round-trips through setNuvioCollections like every
  // other real field here. (An earlier version of this stored the override
  // client-side only in localStorage on the mistaken assumption that no such
  // field existed - fixed once the real field turned up.)
  const [coverPickerFolder, setCoverPickerFolder] = useState<{ collectionId: string; folderId: string } | null>(null);

  const isDirty = JSON.stringify(collections) !== savedSnapshot;
  const nuvioUsers = useMemo(() => users.filter((u) => u.providerType === 'nuvio'), [users]);
  const selectedUser = nuvioUsers.find((u) => u.id === selectedUserId) || null;

  // Sources are stored as bare {addonId, type, catalogId} - resolves to a
  // real, readable name using the addon manifests already loaded for the
  // source picker, instead of showing raw ids like "aio-metadata ·
  // mdblist.88328". Falls back to the raw id only when the addon/catalog
  // can no longer be found (e.g. the addon was since removed).
  const describeSource = useCallback((source: NuvioCatalogSource) => {
    const addon = addons.find((a) => a.manifest?.id === source.addonId);
    const catalog = addon?.manifest?.catalogs?.find((c) => c.id === source.catalogId && c.type === source.type);
    return {
      addonName: addon?.name || addon?.manifest?.name || source.addonId,
      catalogName: catalog?.name || source.catalogId,
      // False when the addon was removed, or is still installed but no
      // longer exposes this catalog (renamed/removed catalog id) - a real
      // failure mode since a source is only ever a bare {addonId,
      // catalogId} pointer, nothing here validates it stays resolvable
      // over time. Only meaningful once `addons` has actually loaded -
      // during the loading window itself, treat every source as fine
      // rather than flashing a false "broken" state before data arrives.
      found: addonsLoading || !!catalog,
    };
  }, [addons, addonsLoading]);

  // A folder is broken if ANY of its sources no longer resolve - checked
  // once per folder (not per source) since that's the granularity the grid
  // tile and collection-level indicators need.
  const folderHasBrokenSource = useCallback((folder: NuvioCollectionFolder) => {
    if (addonsLoading) return false;
    return (folder.catalogSources || []).some((s) => !describeSource(s).found);
  }, [addonsLoading, describeSource]);

  useEffect(() => {
    api.getUsers()
      .then((r) => setUsers(Array.isArray(r) ? r : []))
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false));
  }, []);

  // Prefetches an ambient poster-collage preview for every folder that has
  // sources and isn't already cached (or already loading) - runs whenever
  // collections or addons change, but only fires per folder once, since a
  // cache hit is a no-op. addSource/removeSource evict a folder's cache
  // entry below, which is what lets an edited folder's tile refresh here on
  // the next render instead of showing a stale collage.
  useEffect(() => {
    if (addons.length === 0) return;
    const toFetch = collections
      .flatMap((c) => c.folders || [])
      .filter((f) => (f.catalogSources || []).length > 0 && !(f.id in previewByFolder) && !previewLoadingIds.has(f.id));
    if (toFetch.length === 0) return;

    setPreviewLoadingIds((prev) => new Set([...prev, ...toFetch.map((f) => f.id)]));
    toFetch.forEach(async (folder) => {
      const results = await Promise.all((folder.catalogSources || []).map(async (source) => {
        const addon = addons.find((a) => a.manifest?.id === source.addonId);
        if (!addon?.transportUrl || !selectedUserId) return [];
        try {
          const r = await api.getNuvioCatalogPreview(selectedUserId, addon.transportUrl, source.type, source.catalogId);
          return r.items || [];
        } catch {
          return [];
        }
      }));
      const seen = new Set<string>();
      const merged: PreviewFolderItems = [];
      for (const items of results) {
        for (const item of items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          merged.push(item);
        }
      }
      setPreviewByFolder((prev) => ({ ...prev, [folder.id]: merged }));
      setPreviewLoadingIds((prev) => { const next = new Set(prev); next.delete(folder.id); return next; });
    });
  }, [collections, addons, selectedUserId, previewByFolder, previewLoadingIds]);

  const resetDownstream = () => {
    setProfiles([]);
    setSelectedProfileIndex(null);
    setCollections([]);
    setSavedSnapshot('[]');
    setAddons([]);
    setPreviewByFolder({});
    setPreviewLoadingIds(new Set());
  };

  const handleSelectUser = (userId: string) => {
    if (isDirty && !confirm('Discard unsaved Collections changes?')) return;
    setSelectedUserId(userId);
    resetDownstream();
    if (!userId) return;
    setProfilesLoading(true);
    api.getNuvioProfiles(userId)
      .then((r) => {
        const list = r.profiles || [];
        setProfiles(list);
        if (list.length === 1) handleSelectProfile(userId, list[0].profile_index);
      })
      .catch((e: any) => toast.error(e.message || 'Failed to load Nuvio profiles'))
      .finally(() => setProfilesLoading(false));
    setAddonsLoading(true);
    api.getUserStremioAddons(userId)
      .then((r) => setAddons(Array.isArray(r) ? r : []))
      .catch(() => setAddons([]))
      .finally(() => setAddonsLoading(false));
  };

  const handleSelectProfile = (userId: string, profileIndex: number) => {
    if (isDirty && collections.length > 0 && !confirm('Discard unsaved Collections changes?')) return;
    setSelectedProfileIndex(profileIndex);
    setPreviewByFolder({});
    setPreviewLoadingIds(new Set());
    setCollectionsLoading(true);
    api.getNuvioCollections(userId, profileIndex)
      .then((r) => {
        const list = r.collections || [];
        setCollections(list);
        setSavedSnapshot(JSON.stringify(list));
      })
      .catch((e: any) => toast.error(e.message || 'Failed to load Collections'))
      .finally(() => setCollectionsLoading(false));
  };

  const handleSave = async () => {
    if (!selectedUserId || selectedProfileIndex === null) return;
    setSaving(true);
    try {
      await api.setNuvioCollections(selectedUserId, selectedProfileIndex, collections);
      setSavedSnapshot(JSON.stringify(collections));
      toast.success('Collections saved');
    } catch (e: any) {
      toast.error(e.message || 'Failed to save Collections');
    } finally {
      setSaving(false);
    }
  };

  // --- Mutation helpers - always spread the existing object first so any
  // field this editor doesn't know about (pinToTop, viewMode, ...) survives
  // untouched. ---

  const addCollection = () => {
    setCollections((prev) => [...prev, { id: newId(), title: 'New Collection', folders: [] }]);
  };

  // Builds folders only for genre slots that actually matched a real
  // genre-filterable catalog in this account's own installed addons - never
  // an empty/fake placeholder folder just because the template listed it.
  const applyGenreTemplate = () => {
    const folders = GENRE_TEMPLATE.genres
      .map((slot) => ({ id: newId(), title: slot.title, catalogSources: matchGenreSources(slot.aliases, addons) }))
      .filter((f) => f.catalogSources.length > 0);
    if (folders.length === 0) {
      toast.error('No genre-filterable catalogs found in your installed addons');
      return;
    }
    setCollections((prev) => [...prev, { id: newId(), title: GENRE_TEMPLATE.title, folders }]);
    setTemplatesOpen(false);
    toast.success(`Added "${GENRE_TEMPLATE.title}" (${folders.length} of ${GENRE_TEMPLATE.genres.length} folders matched)`);
  };

  const updateCollection = (id: string, patch: Partial<NuvioCollection>) => {
    setCollections((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeCollection = (id: string) => {
    setCollections((prev) => prev.filter((c) => c.id !== id));
  };

  const reorderCollection = (index: number, dir: -1 | 1) => {
    setCollections((prev) => moveItem(prev, index, dir));
  };

  const addFolder = (collectionId: string) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: [...(c.folders || []), { id: newId(), title: 'New Folder', catalogSources: [] }],
    })));
  };

  const updateFolder = (collectionId: string, folderId: string, patch: Partial<NuvioCollectionFolder>) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: (c.folders || []).map((f) => (f.id === folderId ? { ...f, ...patch } : f)),
    })));
  };

  const removeFolder = (collectionId: string, folderId: string) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: (c.folders || []).filter((f) => f.id !== folderId),
    })));
  };

  // List mode only - grid mode reorders folders via drag-and-drop
  // (handleFolderDragEnd) instead.
  const reorderFolder = (collectionId: string, index: number, dir: -1 | 1) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: moveItem(c.folders || [], index, dir),
    })));
  };

  // Evicts a folder's cached preview so the prefetch effect treats it as a
  // cache miss again and re-fetches - otherwise the grid tile's ambient
  // collage (and the folder detail modal's preview row) would keep showing
  // stale items after a source is added or removed.
  const invalidateFolderPreview = (folderId: string) => {
    setPreviewByFolder((prev) => {
      if (!(folderId in prev)) return prev;
      const next = { ...prev };
      delete next[folderId];
      return next;
    });
  };

  const addSource = (collectionId: string, folderId: string, source: NuvioCatalogSource) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: (c.folders || []).map((f) => (f.id !== folderId ? f : {
        ...f,
        catalogSources: [...(f.catalogSources || []), source],
      })),
    })));
    invalidateFolderPreview(folderId);
  };

  const removeSource = (collectionId: string, folderId: string, index: number) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: (c.folders || []).map((f) => (f.id !== folderId ? f : {
        ...f,
        catalogSources: (f.catalogSources || []).filter((_, i) => i !== index),
      })),
    })));
    invalidateFolderPreview(folderId);
  };

  // --- Source picker ---

  const openPicker = (collectionId: string, folderId: string) => {
    setPickerTarget({ collectionId, folderId });
    setPickerAddonId(null);
    setPickerCatalog(null);
    setPickerPreview([]);
  };

  const pickerAddon = addons.find((a) => a.manifest?.id === pickerAddonId) || null;

  const handlePickCatalog = useCallback((catalog: { id: string; type: string; name?: string }) => {
    setPickerCatalog(catalog);
    if (!selectedUserId || !pickerAddon?.transportUrl) return;
    setPickerPreviewLoading(true);
    api.getNuvioCatalogPreview(selectedUserId, pickerAddon.transportUrl, catalog.type, catalog.id)
      .then((r) => setPickerPreview(r.items || []))
      .catch(() => setPickerPreview([]))
      .finally(() => setPickerPreviewLoading(false));
  }, [selectedUserId, pickerAddon]);

  const confirmAddSource = () => {
    if (!pickerTarget || !pickerAddon || !pickerCatalog) return;
    addSource(pickerTarget.collectionId, pickerTarget.folderId, {
      addonId: pickerAddon.manifest?.id || pickerAddon.transportUrl,
      type: pickerCatalog.type,
      catalogId: pickerCatalog.id,
    });
    setPickerTarget(null);
  };

  // Folder tiles drag-reorder within their own collection's grid - purely
  // local state like every other edit here, persisted only on Save changes.
  const handleFolderDragEnd = (collectionId: string) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setCollections((prev) => prev.map((c) => {
      if (c.id !== collectionId) return c;
      const folders = c.folders || [];
      const oldIndex = folders.findIndex((f) => f.id === active.id);
      const newIndex = folders.findIndex((f) => f.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return c;
      return { ...c, folders: arrayMove(folders, oldIndex, newIndex) };
    }));
  };

  // Which folders have at least one source that no longer resolves - a
  // Set (not a per-folder callback prop) so CollectionSection/FolderTile
  // stay plain data-in components, computed once per addons/collections
  // change instead of re-walking every folder's sources on every render.
  const brokenFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of collections) {
      for (const f of (c.folders || [])) {
        if (folderHasBrokenSource(f)) ids.add(f.id);
      }
    }
    return ids;
  }, [collections, folderHasBrokenSource]);

  // --- Copy a Collection to another profile ---

  const otherProfiles = profiles.filter((p) => p.profile_index !== selectedProfileIndex);

  const handleCopyTo = useCallback(async (targetProfileIndex: number) => {
    if (!copyTarget || !selectedUserId) return;
    setCopyingToIndex(targetProfileIndex);
    try {
      const r = await api.getNuvioCollections(selectedUserId, targetProfileIndex);
      const targetCollections = r.collections || [];
      const updated = [...targetCollections, deepCopyCollection(copyTarget)];
      await api.setNuvioCollections(selectedUserId, targetProfileIndex, updated);
      const targetName = profiles.find((p) => p.profile_index === targetProfileIndex)?.name || `Profile ${targetProfileIndex}`;
      toast.success(`Copied "${copyTarget.title}" to ${targetName}`);
      setCopyTarget(null);
    } catch (e: any) {
      toast.error(e.message || 'Failed to copy Collection');
    } finally {
      setCopyingToIndex(null);
    }
  }, [copyTarget, selectedUserId, profiles]);

  // --- Layout ---

  const backButton = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={() => router.push('/catalogs')}>
      Back
    </Button>
  );

  const saveAction = (
    <Button variant="primary" size="sm" onClick={handleSave} isLoading={saving} disabled={!isDirty || selectedProfileIndex === null}>
      Save changes
    </Button>
  );

  const detailActions = (
    <div className="flex items-center gap-2">
      {backButton}
      {selectedProfileIndex !== null && saveAction}
    </div>
  );

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={[{ label: 'Catalogs', href: '/catalogs' }, { label: 'Nuvio Collections' }]} className="text-xl font-semibold" />}
          subtitle="Organize a Nuvio account's own home-screen collections"
          actions={detailActions}
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
        {layoutMode === 'nebula' && (
          <NebulaPageHeading title="Nuvio Collections" subtitle="Organize a Nuvio account's own home-screen collections" leading={backButton} actions={selectedProfileIndex !== null ? saveAction : undefined} />
        )}

        <PageSection>
          {/* One row, not a picker followed by a card that just repeats the
              picker: account select, profile select (only shown when
              there's a real choice or it's loading), and the Nuvio badge
              all live together here - a separate "confirmation" card
              below used to restate the same account info a second time
              for no reason. */}
          <Card padding="lg" className="mb-6">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[220px]">
                <label className="block text-xs font-medium text-muted mb-1.5">Nuvio account</label>
                <select
                  value={selectedUserId}
                  onChange={(e) => handleSelectUser(e.target.value)}
                  disabled={usersLoading}
                  className="input-base px-3 py-2 w-full appearance-none pr-10 text-sm"
                >
                  <option value="">{usersLoading ? 'Loading...' : 'Select a Nuvio user...'}</option>
                  {nuvioUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.name || u.email || u.id}</option>
                  ))}
                </select>
              </div>

              {selectedUserId && (profiles.length > 1 || profilesLoading) && (
                <div className="w-[200px]">
                  <label className="block text-xs font-medium text-muted mb-1.5">Profile</label>
                  <select
                    value={selectedProfileIndex ?? ''}
                    onChange={(e) => handleSelectProfile(selectedUserId, Number(e.target.value))}
                    disabled={profilesLoading}
                    className="input-base px-3 py-2 w-full appearance-none pr-10 text-sm"
                  >
                    <option value="" disabled>{profilesLoading ? 'Loading...' : 'Select a profile...'}</option>
                    {profiles.map((p) => (
                      <option key={p.profile_index} value={p.profile_index}>{p.name || `Profile ${p.profile_index}`}</option>
                    ))}
                  </select>
                </div>
              )}

              {selectedUser && (
                <Badge variant="nuvio" size="sm" className="mb-2.5">Nuvio</Badge>
              )}
            </div>

            {!usersLoading && nuvioUsers.length === 0 && (
              <p className="text-xs text-subtle mt-2">No Nuvio-connected users yet.</p>
            )}
          </Card>

          {selectedProfileIndex !== null && (
            collectionsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-surface-hover animate-pulse" />)}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                  <p className="text-sm text-muted">{collections.length} collection{collections.length !== 1 ? 's' : ''}{isDirty && <span className="text-warning ml-2">(unsaved changes)</span>}</p>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" leftIcon={<SparklesIcon className="w-4 h-4" />} onClick={() => setTemplatesOpen(true)}>
                      Use a template
                    </Button>
                    <Button variant="secondary" size="sm" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={addCollection}>
                      Add collection
                    </Button>
                  </div>
                </div>

                {collections.length === 0 ? (
                  <Card padding="lg" className="text-center">
                    <RectangleStackIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
                    <p className="text-sm text-muted">No collections yet on this profile.</p>
                  </Card>
                ) : viewMode === 'grid' ? (
                  collections.map((collection, cIndex) => (
                    <CollectionSection
                      key={collection.id}
                      collection={collection}
                      cIndex={cIndex}
                      collectionsLength={collections.length}
                      otherProfilesCount={otherProfiles.length}
                      previewByFolder={previewByFolder}
                      previewLoadingIds={previewLoadingIds}
                      brokenFolderIds={brokenFolderIds}
                      onRename={(title) => updateCollection(collection.id, { title })}
                      onReorder={(dir) => reorderCollection(cIndex, dir)}
                      onDelete={() => setDeleting({ kind: 'collection', collectionId: collection.id })}
                      onCopy={() => setCopyTarget(collection)}
                      onAddFolder={() => addFolder(collection.id)}
                      onOpenFolder={(folderId) => { setFolderDetail({ collectionId: collection.id, folderId }); setFolderDetailTab('sources'); }}
                      onDeleteFolder={(folderId) => setDeleting({ kind: 'folder', collectionId: collection.id, folderId })}
                      onFolderDragEnd={handleFolderDragEnd(collection.id)}
                      onTogglePin={() => updateCollection(collection.id, { pinToTop: !collection.pinToTop })}
                    />
                  ))
                ) : (
                  // Original list layout, unchanged - kept for anyone who
                  // preferred it, per explicit request. Folder/source
                  // reorder uses the up/down arrows (reorderFolder) here
                  // instead of grid mode's drag-and-drop, and the
                  // collection-level "Preview layout" eye button reads from
                  // the same ambient previewByFolder cache grid mode's
                  // tiles use rather than doing its own fetch.
                  <div className="space-y-3">
                    {collections.map((collection, cIndex) => (
                      <Card key={collection.id} padding="md">
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => toggleExpanded(collection.id)} className="p-1 text-subtle hover:text-default">
                            {expanded[collection.id] ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                          </button>
                          <input
                            value={collection.title}
                            onChange={(e) => updateCollection(collection.id, { title: e.target.value })}
                            className="flex-1 px-2 py-1 rounded-lg bg-transparent text-sm font-semibold text-default border border-transparent hover:border-default focus:border-primary focus:outline-none"
                          />
                          <span className="text-xs text-subtle shrink-0">{(collection.folders || []).length} folder{(collection.folders || []).length !== 1 ? 's' : ''}</span>
                          <button
                            type="button"
                            title="Preview layout"
                            onClick={() => setPreviewCollection(collection)}
                            disabled={(collection.folders || []).every((f) => (f.catalogSources || []).length === 0)}
                            className="p-1 text-subtle hover:text-default disabled:opacity-30"
                          >
                            <EyeIcon className="w-3.5 h-3.5" />
                          </button>
                          <CollectionActionsMenu
                            isPinned={!!collection.pinToTop}
                            canMoveUp={cIndex > 0}
                            canMoveDown={cIndex < collections.length - 1}
                            canCopy={otherProfiles.length > 0}
                            onTogglePin={() => updateCollection(collection.id, { pinToTop: !collection.pinToTop })}
                            onCopy={() => setCopyTarget(collection)}
                            onMoveUp={() => reorderCollection(cIndex, -1)}
                            onMoveDown={() => reorderCollection(cIndex, 1)}
                            onDelete={() => setDeleting({ kind: 'collection', collectionId: collection.id })}
                          />
                        </div>

                        {expanded[collection.id] && (
                          <div className="mt-3 pl-6 space-y-2 border-l border-default">
                            {(collection.folders || []).map((folder, fIndex) => (
                              <div key={folder.id} className="rounded-lg border border-default p-2.5 bg-subtle">
                                <div className="flex items-center gap-2">
                                  <button type="button" onClick={() => toggleExpanded(folder.id)} className="p-1 text-subtle hover:text-default">
                                    {expanded[folder.id] ? <ChevronDownIcon className="w-3.5 h-3.5" /> : <ChevronRightIcon className="w-3.5 h-3.5" />}
                                  </button>
                                  {brokenFolderIds.has(folder.id) ? (
                                    <span title="A source in this folder no longer resolves" className="shrink-0">
                                      <ExclamationTriangleIcon className="w-4 h-4 text-warning" />
                                    </span>
                                  ) : (
                                    <FolderIcon className="w-4 h-4 text-subtle shrink-0" />
                                  )}
                                  <input
                                    value={folder.title}
                                    onChange={(e) => updateFolder(collection.id, folder.id, { title: e.target.value })}
                                    className="flex-1 px-2 py-1 rounded-lg bg-transparent text-sm text-default border border-transparent hover:border-default focus:border-primary focus:outline-none"
                                  />
                                  <span className="text-xs text-subtle shrink-0">{(folder.catalogSources || []).length} source{(folder.catalogSources || []).length !== 1 ? 's' : ''}</span>
                                  <button type="button" onClick={() => reorderFolder(collection.id, fIndex, -1)} disabled={fIndex === 0} className="p-1 text-subtle hover:text-default disabled:opacity-30">
                                    <ArrowUpIcon className="w-3 h-3" />
                                  </button>
                                  <button type="button" onClick={() => reorderFolder(collection.id, fIndex, 1)} disabled={fIndex === (collection.folders || []).length - 1} className="p-1 text-subtle hover:text-default disabled:opacity-30">
                                    <ArrowDownIcon className="w-3 h-3" />
                                  </button>
                                  <button type="button" onClick={() => setDeleting({ kind: 'folder', collectionId: collection.id, folderId: folder.id })} className="p-1 text-subtle hover:text-error">
                                    <TrashIcon className="w-3 h-3" />
                                  </button>
                                </div>

                                {expanded[folder.id] && (
                                  <div className="mt-2 pl-6 space-y-1.5">
                                    {(folder.catalogSources || []).map((source, sIndex) => {
                                      const { addonName, catalogName, found } = describeSource(source);
                                      const genreSuffix = source.genre && source.genre !== 'none' ? ` — ${source.genre}` : '';
                                      return (
                                        <div key={sIndex} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-md bg-surface-hover">
                                          {!found && <ExclamationTriangleIcon className="w-3.5 h-3.5 text-warning shrink-0" />}
                                          <span className="flex-1 truncate text-default">
                                            {found ? (
                                              <>{catalogName}{genreSuffix} <span className="text-subtle">· {addonName} ({source.type})</span></>
                                            ) : (
                                              <span className="text-warning">Source not found <span className="text-subtle">· addon removed or catalog no longer exists</span></span>
                                            )}
                                          </span>
                                          <button type="button" onClick={() => removeSource(collection.id, folder.id, sIndex)} className="text-subtle hover:text-error shrink-0">
                                            <TrashIcon className="w-3 h-3" />
                                          </button>
                                        </div>
                                      );
                                    })}
                                    <Button variant="ghost" size="sm" leftIcon={<PlusIcon className="w-3.5 h-3.5" />} onClick={() => openPicker(collection.id, folder.id)}>
                                      Add source
                                    </Button>
                                  </div>
                                )}
                              </div>
                            ))}
                            <Button variant="ghost" size="sm" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={() => addFolder(collection.id)}>
                              Add folder
                            </Button>
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </>
            )
          )}
        </PageSection>
      </div>
      </div>

      {/* Floating save bar - fixed to the viewport so it's reachable without
          scrolling back to the header, however far down a long Collections
          list (some real accounts have 10+ folders) you've scrolled while
          editing. The header's own Save button stays too (muscle memory /
          consistency with every other detail page), this is purely an
          always-reachable second entry point for the exact same action. */}
      <AnimatePresence>
        {isDirty && selectedProfileIndex !== null && (
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50"
          >
            <div className="flex items-center gap-4 px-6 py-4 rounded-2xl shadow-2xl bg-surface border border-default backdrop-blur-xl">
              <span className="text-sm text-warning">Unsaved changes</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCollections(JSON.parse(savedSnapshot))}
                  disabled={saving}
                >
                  Discard
                </Button>
                <Button variant="primary" size="sm" onClick={handleSave} isLoading={saving}>
                  Save changes
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete confirmation */}
      <Modal isOpen={!!deleting} onClose={() => setDeleting(null)} title={deleting?.kind === 'folder' ? 'Delete folder' : 'Delete collection'} size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {deleting?.kind === 'folder'
              ? 'Delete this folder and its sources? This only changes what you\'re about to save - nothing happens on the Nuvio account until you click Save changes.'
              : 'Delete this collection and everything in it? This only changes what you\'re about to save - nothing happens on the Nuvio account until you click Save changes.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (!deleting) return;
                if (deleting.kind === 'collection') removeCollection(deleting.collectionId);
                else if (deleting.folderId) removeFolder(deleting.collectionId, deleting.folderId);
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>

      {/* Starter templates - previews real match counts against this
          account's own installed addons before anything is added, so
          there's never a surprise empty folder. */}
      <Modal isOpen={templatesOpen} onClose={() => setTemplatesOpen(false)} title="Use a template" size="lg">
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Folders are only added where a real match is found in your installed addons - nothing is guessed or left empty.
          </p>
          {addonsLoading && <p className="text-sm text-muted">Loading your installed addons...</p>}
          {!addonsLoading && (() => {
            const matchedGenres = GENRE_TEMPLATE.genres.filter((slot) => matchGenreSources(slot.aliases, addons).length > 0);
            return (
              <Card padding="md">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-default">{GENRE_TEMPLATE.title}</p>
                    <p className="text-xs text-muted">{GENRE_TEMPLATE.description}</p>
                    <p className="text-xs text-subtle mt-1">
                      {matchedGenres.length} of {GENRE_TEMPLATE.genres.length} genres match your installed addons
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={applyGenreTemplate} disabled={matchedGenres.length === 0}>
                    Add
                  </Button>
                </div>
              </Card>
            );
          })()}
        </div>
      </Modal>

      {/* Source picker */}
      <Modal isOpen={!!pickerTarget} onClose={() => setPickerTarget(null)} title="Add a catalog source" size="lg">
        <div className="space-y-4">
          {addonsLoading ? (
            <p className="text-sm text-muted">Loading installed addons...</p>
          ) : addons.length === 0 ? (
            <p className="text-sm text-muted text-center py-6">This account has no installed addons to pick a catalog from yet.</p>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Addon</label>
                <select
                  value={pickerAddonId || ''}
                  onChange={(e) => { setPickerAddonId(e.target.value || null); setPickerCatalog(null); setPickerPreview([]); }}
                  className="input-base px-3 py-2 w-full appearance-none pr-10 text-sm"
                >
                  <option value="">Select an addon...</option>
                  {addons.map((a) => (
                    <option key={a.manifest?.id || a.transportUrl} value={a.manifest?.id}>{a.name || a.manifest?.name || 'Unknown'}</option>
                  ))}
                </select>
              </div>

              {pickerAddon && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Catalog</label>
                  {(pickerAddon.manifest?.catalogs || []).length === 0 ? (
                    <p className="text-xs text-subtle">This addon has no catalogs.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {(pickerAddon.manifest?.catalogs || []).map((cat: any) => (
                        <button
                          key={`${cat.type}:${cat.id}`}
                          type="button"
                          onClick={() => handlePickCatalog(cat)}
                          className={`text-left px-3 py-2 rounded-lg border text-xs transition-colors ${pickerCatalog?.id === cat.id && pickerCatalog?.type === cat.type ? 'border-primary bg-primary/10' : 'border-default hover:border-primary/50'}`}
                        >
                          <p className="font-medium text-default truncate">{cat.name || cat.id}</p>
                          <p className="text-subtle">{cat.type}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {pickerCatalog && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Preview</label>
                  {pickerPreviewLoading ? (
                    <div className="flex gap-2">
                      {[...Array(6)].map((_, i) => <div key={i} className="w-16 aspect-[2/3] rounded-md bg-surface-hover animate-pulse" />)}
                    </div>
                  ) : pickerPreview.length === 0 ? (
                    <p className="text-xs text-subtle">No preview available for this catalog.</p>
                  ) : (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {pickerPreview.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setDetail(item)}
                          title={item.name}
                          className="w-16 shrink-0 aspect-[2/3] rounded-md overflow-hidden bg-surface-hover"
                        >
                          {item.poster ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.poster} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] text-subtle p-1 text-center">{item.name}</div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" size="sm" onClick={() => setPickerTarget(null)}>Cancel</Button>
                <Button variant="primary" size="sm" onClick={confirmAddSource} disabled={!pickerCatalog}>Add source</Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Folder detail - clicking a grid tile opens this: rename, a live
          preview row (same cached data the tile's own ambient collage
          already uses), and the source list/picker - replaces both the old
          always-expanded inline nested list and the separate collection-
          wide "Preview" modal in one place. */}
      {(() => {
        const activeCollection = folderDetail ? collections.find((c) => c.id === folderDetail.collectionId) : null;
        const activeFolder = activeCollection?.folders?.find((f) => f.id === folderDetail?.folderId) || null;
        const items = folderDetail ? (previewByFolder[folderDetail.folderId] || []) : [];
        const isLoadingPreview = folderDetail ? previewLoadingIds.has(folderDetail.folderId) : false;

        const hero = items[0];
        // hero.poster is string | null (see PreviewFolderItems), not
        // string | undefined - <img src> only accepts the latter (a
        // previous string | null here broke a production build the same
        // way, see posterUrl.ts's own comment on this exact gotcha).
        const modalHeroPoster = (typeof activeFolder?.coverImageUrl === 'string' ? activeFolder.coverImageUrl : null) || hero?.poster || undefined;

        return (
          <Modal isOpen={!!folderDetail} onClose={() => setFolderDetail(null)} size="lg" backdropImage={modalHeroPoster}>
            {activeFolder && folderDetail && (
              <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      title="Change folder cover"
                      onClick={() => setCoverPickerFolder({ collectionId: folderDetail.collectionId, folderId: folderDetail.folderId })}
                      className="group relative shrink-0 w-20 h-20 rounded-xl overflow-hidden border border-default hover:border-primary/50 transition-colors bg-surface-hover"
                    >
                      {modalHeroPoster ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={modalHeroPoster} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <PhotoIcon className="w-6 h-6 text-subtle" />
                        </div>
                      )}
                      {/* Always-visible, not hover-only - a hover cue alone
                          is invisible on touch devices with no way to
                          discover the thumbnail is clickable. */}
                      <div
                        className="absolute bottom-1 right-1 w-6 h-6 rounded-full flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform"
                        style={{ background: 'var(--color-primary)' }}
                      >
                        <PencilSquareIcon className="w-3.5 h-3.5 text-white" />
                      </div>
                    </button>
                    <input
                      value={activeFolder.title}
                      onChange={(e) => updateFolder(folderDetail.collectionId, folderDetail.folderId, { title: e.target.value })}
                      placeholder="Folder title"
                      className="flex-1 bg-transparent text-2xl font-display font-semibold text-default border-b border-transparent hover:border-default focus:border-primary focus:outline-none pb-1 mt-2"
                    />
                  </div>

                  {/* Tabs, not stacked sections - a folder with a lot of
                      preview posters otherwise pushed "Add source" far
                      enough down that reaching it needed scrolling every
                      single time. */}
                  <div className="flex gap-1 p-1 rounded-xl bg-surface-hover w-fit">
                    <button
                      type="button"
                      onClick={() => setFolderDetailTab('sources')}
                      className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${folderDetailTab === 'sources' ? 'bg-surface text-default shadow-sm' : 'text-muted hover:text-default'}`}
                    >
                      Sources{(activeFolder.catalogSources || []).length > 0 ? ` (${(activeFolder.catalogSources || []).length})` : ''}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFolderDetailTab('preview')}
                      className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${folderDetailTab === 'preview' ? 'bg-surface text-default shadow-sm' : 'text-muted hover:text-default'}`}
                    >
                      Preview
                    </button>
                  </div>

                  {folderDetailTab === 'sources' ? (
                    <div>
                      {(activeFolder.catalogSources || []).length === 0 ? (
                        <p className="text-sm text-subtle mb-2">No sources in this folder.</p>
                      ) : (
                        <div className="space-y-1.5 mb-2">
                          {(activeFolder.catalogSources || []).map((source, sIndex) => {
                            const { addonName, catalogName, found } = describeSource(source);
                            const genreSuffix = source.genre && source.genre !== 'none' ? ` — ${source.genre}` : '';
                            return (
                              <div key={sIndex} className="flex items-center gap-3 text-sm px-3 py-2.5 rounded-xl bg-surface-hover">
                                {found ? (
                                  <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${source.type === 'movie' ? 'bg-primary' : 'bg-secondary'}`} />
                                ) : (
                                  <ExclamationTriangleIcon className="w-4 h-4 text-warning shrink-0" />
                                )}
                                <span className="flex-1 truncate text-default">
                                  {found ? (
                                    <>{catalogName}{genreSuffix} <span className="text-subtle text-xs">· {addonName} ({source.type})</span></>
                                  ) : (
                                    <span className="text-warning">Source not found <span className="text-subtle text-xs">· addon removed or catalog no longer exists</span></span>
                                  )}
                                </span>
                                <button type="button" onClick={() => removeSource(folderDetail.collectionId, folderDetail.folderId, sIndex)} className="p-1.5 rounded-lg text-subtle hover:text-error hover:bg-surface shrink-0">
                                  <TrashIcon className="w-4 h-4" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <Button variant="ghost" size="sm" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={() => openPicker(folderDetail.collectionId, folderDetail.folderId)}>
                        Add source
                      </Button>
                    </div>
                  ) : (
                    <div>
                      {items.length > 0 && <p className="text-xs text-subtle mb-2">{items.length} title{items.length !== 1 ? 's' : ''}</p>}
                      {(activeFolder.catalogSources || []).length === 0 ? (
                        <div className="rounded-xl border border-dashed border-default py-6 text-center">
                          <p className="text-sm text-muted">No sources yet - add one from the Sources tab to see a preview here.</p>
                        </div>
                      ) : isLoadingPreview ? (
                        <div className="flex flex-wrap gap-2.5">
                          {[...Array(6)].map((_, i) => <div key={i} className="w-20 aspect-[2/3] rounded-lg bg-surface-hover animate-pulse" />)}
                        </div>
                      ) : items.length === 0 ? (
                        <p className="text-sm text-subtle">No preview available for this folder&apos;s sources.</p>
                      ) : (
                        <div className="flex flex-wrap gap-2.5">
                          {items.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setDetail(item)}
                              title={item.name}
                              className="group w-20 shrink-0 aspect-[2/3] rounded-lg overflow-hidden bg-surface-hover ring-1 ring-transparent hover:ring-primary/60 transition-all hover:scale-[1.03]"
                            >
                              {item.poster ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={item.poster} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-[10px] text-subtle p-1.5 text-center leading-tight">{item.name}</div>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex justify-end pt-2 border-t border-default">
                    <Button variant="ghost" size="sm" onClick={() => setFolderDetail(null)}>Done</Button>
                  </div>
              </div>
            )}
          </Modal>
        );
      })()}

      {/* List mode only - the original per-collection preview, reading
          straight from the ambient previewByFolder cache (see
          previewCollection's own comment above). */}
      <Modal isOpen={!!previewCollection} onClose={() => setPreviewCollection(null)} title={`Preview: ${previewCollection?.title || ''}`} size="lg">
        <div className="space-y-4">
          {(previewCollection?.folders || []).length === 0 ? (
            <p className="text-sm text-muted text-center py-6">This collection has no folders yet.</p>
          ) : (
            (previewCollection?.folders || []).map((folder) => {
              const items = previewByFolder[folder.id] || [];
              const loading = previewLoadingIds.has(folder.id);
              return (
                <div key={folder.id}>
                  <p className="text-xs font-medium text-muted mb-1.5">{folder.title} <span className="text-subtle">({items.length})</span></p>
                  {(folder.catalogSources || []).length === 0 ? (
                    <p className="text-xs text-subtle">No sources in this folder.</p>
                  ) : loading ? (
                    <div className="flex gap-2">
                      {[...Array(6)].map((_, i) => <div key={i} className="w-16 aspect-[2/3] rounded-md bg-surface-hover animate-pulse" />)}
                    </div>
                  ) : items.length === 0 ? (
                    <p className="text-xs text-subtle">No preview available for this folder&apos;s sources.</p>
                  ) : (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setDetail(item)}
                          title={item.name}
                          className="w-16 shrink-0 aspect-[2/3] rounded-md overflow-hidden bg-surface-hover"
                        >
                          {item.poster ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.poster} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[10px] text-subtle p-1 text-center">{item.name}</div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </Modal>

      {/* Folder cover - real Nuvio-native field (folder.coverImageUrl), same
          as the collection-level cover above. */}
      {coverPickerFolder && (() => {
        const folder = collections.find((c) => c.id === coverPickerFolder.collectionId)?.folders?.find((f) => f.id === coverPickerFolder.folderId);
        return (
          <AvatarPickerModal
            isOpen={!!coverPickerFolder}
            onClose={() => setCoverPickerFolder(null)}
            name={folder?.title || 'Folder'}
            currentAvatarUrl={typeof folder?.coverImageUrl === 'string' ? folder.coverImageUrl : null}
            nuvioCoversUserId={selectedUserId || undefined}
            title=""
            previewShape="rect"
            size="full"
            onSave={async (data) => {
              if (!('avatarUrl' in data)) { setCoverPickerFolder(null); return; }
              updateFolder(coverPickerFolder.collectionId, coverPickerFolder.folderId, { coverImageUrl: data.avatarUrl ?? null });
              setCoverPickerFolder(null);
            }}
          />
        );
      })()}

      {/* Copy a Collection to another profile - writes immediately on
          confirm (see handleCopyTo's own comment for why). */}
      <Modal isOpen={!!copyTarget} onClose={() => setCopyTarget(null)} title={`Copy "${copyTarget?.title || ''}" to...`} size="sm">
        <div className="space-y-2">
          {otherProfiles.length === 0 ? (
            <p className="text-sm text-muted">No other profiles on this account.</p>
          ) : (
            otherProfiles.map((p) => (
              <button
                key={p.profile_index}
                type="button"
                onClick={() => handleCopyTo(p.profile_index)}
                disabled={copyingToIndex !== null}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-default hover:border-primary/50 text-left text-sm text-default transition-colors disabled:opacity-50"
              >
                <span>{p.name || `Profile ${p.profile_index}`}</span>
                {copyingToIndex === p.profile_index && <span className="text-xs text-subtle">Copying...</span>}
              </button>
            ))
          )}
          <div className="flex justify-end pt-2">
            <Button variant="ghost" size="sm" onClick={() => setCopyTarget(null)}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {detail && (
        <MediaDetailModal
          isOpen={!!detail}
          onClose={() => setDetail(null)}
          itemId={detail.id}
          itemType={detail.type as 'movie' | 'series'}
          fallbackTitle={detail.name}
          fallbackPoster={detail.poster || undefined}
        />
      )}
    </>
  );
}
