'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Button, Modal, MediaDetailModal, Badge } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import {
  api, User, StremioAddon, NuvioProfile, NuvioCollection, NuvioCollectionFolder, NuvioCatalogSource,
} from '@/lib/api';
import {
  ArrowLeftIcon, PlusIcon, TrashIcon, ChevronDownIcon, ChevronRightIcon,
  ArrowUpIcon, ArrowDownIcon, RectangleStackIcon, FolderIcon, SparklesIcon,
} from '@heroicons/react/24/outline';

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
  genres: [
    { title: 'Action', aliases: ['action'] },
    { title: 'Comedy', aliases: ['comedy'] },
    { title: 'Drama', aliases: ['drama'] },
    { title: 'Horror', aliases: ['horror'] },
    { title: 'Sci-Fi', aliases: ['sci-fi', 'science fiction'] },
    { title: 'Animation', aliases: ['animation', 'anime'] },
    { title: 'Documentary', aliases: ['documentary'] },
    { title: 'Thriller', aliases: ['thriller'] },
    { title: 'Romance', aliases: ['romance'] },
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

export default function NuvioCollectionsPage() {
  const { layoutMode } = useLayoutMode();
  const router = useRouter();

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

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<{ kind: 'collection' | 'folder'; collectionId: string; folderId?: string } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const [pickerTarget, setPickerTarget] = useState<PickerTarget>(null);
  const [pickerAddonId, setPickerAddonId] = useState<string | null>(null);
  const [pickerCatalog, setPickerCatalog] = useState<{ id: string; type: string; name?: string } | null>(null);
  const [pickerPreview, setPickerPreview] = useState<{ id: string; type: string; name: string; poster: string | null }[]>([]);
  const [pickerPreviewLoading, setPickerPreviewLoading] = useState(false);
  const [detail, setDetail] = useState<{ id: string; type: string; name: string; poster?: string | null } | null>(null);

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
    };
  }, [addons]);

  useEffect(() => {
    api.getUsers()
      .then((r) => setUsers(Array.isArray(r) ? r : []))
      .catch(() => setUsers([]))
      .finally(() => setUsersLoading(false));
  }, []);

  const resetDownstream = () => {
    setProfiles([]);
    setSelectedProfileIndex(null);
    setCollections([]);
    setSavedSnapshot('[]');
    setAddons([]);
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

  const reorderFolder = (collectionId: string, index: number, dir: -1 | 1) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: moveItem(c.folders || [], index, dir),
    })));
  };

  const addSource = (collectionId: string, folderId: string, source: NuvioCatalogSource) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: (c.folders || []).map((f) => (f.id !== folderId ? f : {
        ...f,
        catalogSources: [...(f.catalogSources || []), source],
      })),
    })));
  };

  const removeSource = (collectionId: string, folderId: string, index: number) => {
    setCollections((prev) => prev.map((c) => (c.id !== collectionId ? c : {
      ...c,
      folders: (c.folders || []).map((f) => (f.id !== folderId ? f : {
        ...f,
        catalogSources: (f.catalogSources || []).filter((_, i) => i !== index),
      })),
    })));
  };

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

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
          <Card padding="lg" className="mb-6">
            <div className="flex flex-wrap gap-4 items-end">
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
                {!usersLoading && nuvioUsers.length === 0 && (
                  <p className="text-xs text-subtle mt-1.5">No Nuvio-connected users yet.</p>
                )}
              </div>

              {selectedUserId && profiles.length > 1 && (
                <div className="flex-1 min-w-[180px]">
                  <label className="block text-xs font-medium text-muted mb-1.5">Profile</label>
                  <select
                    value={selectedProfileIndex ?? ''}
                    onChange={(e) => handleSelectProfile(selectedUserId, Number(e.target.value))}
                    className="input-base px-3 py-2 w-full appearance-none pr-10 text-sm"
                  >
                    <option value="" disabled>Select a profile...</option>
                    {profiles.map((p) => (
                      <option key={p.profile_index} value={p.profile_index}>{p.name || `Profile ${p.profile_index}`}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {selectedUser && (
              <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-subtle">
                <Badge variant="nuvio" size="sm">Nuvio</Badge>
                <p className="text-sm text-default truncate">{selectedUser.name || selectedUser.email}</p>
                {profilesLoading && <p className="text-xs text-muted">Loading profiles...</p>}
              </div>
            )}
          </Card>

          {selectedProfileIndex !== null && (
            collectionsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-surface-hover animate-pulse" />)}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
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
                ) : (
                  <div className="space-y-3">
                    {collections.map((collection, cIndex) => (
                      <Card key={collection.id} padding="md">
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => toggle(collection.id)} className="p-1 text-subtle hover:text-default">
                            {expanded[collection.id] ? <ChevronDownIcon className="w-4 h-4" /> : <ChevronRightIcon className="w-4 h-4" />}
                          </button>
                          <input
                            value={collection.title}
                            onChange={(e) => updateCollection(collection.id, { title: e.target.value })}
                            className="flex-1 px-2 py-1 rounded-lg bg-transparent text-sm font-semibold text-default border border-transparent hover:border-default focus:border-primary focus:outline-none"
                          />
                          <span className="text-xs text-subtle shrink-0">{(collection.folders || []).length} folder{(collection.folders || []).length !== 1 ? 's' : ''}</span>
                          <button type="button" onClick={() => reorderCollection(cIndex, -1)} disabled={cIndex === 0} className="p-1 text-subtle hover:text-default disabled:opacity-30">
                            <ArrowUpIcon className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => reorderCollection(cIndex, 1)} disabled={cIndex === collections.length - 1} className="p-1 text-subtle hover:text-default disabled:opacity-30">
                            <ArrowDownIcon className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => setDeleting({ kind: 'collection', collectionId: collection.id })} className="p-1 text-subtle hover:text-error">
                            <TrashIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {expanded[collection.id] && (
                          <div className="mt-3 pl-6 space-y-2 border-l border-default">
                            {(collection.folders || []).map((folder, fIndex) => (
                              <div key={folder.id} className="rounded-lg border border-default p-2.5 bg-subtle">
                                <div className="flex items-center gap-2">
                                  <button type="button" onClick={() => toggle(folder.id)} className="p-1 text-subtle hover:text-default">
                                    {expanded[folder.id] ? <ChevronDownIcon className="w-3.5 h-3.5" /> : <ChevronRightIcon className="w-3.5 h-3.5" />}
                                  </button>
                                  <FolderIcon className="w-4 h-4 text-subtle shrink-0" />
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
                                      const { addonName, catalogName } = describeSource(source);
                                      const genreSuffix = source.genre && source.genre !== 'none' ? ` — ${source.genre}` : '';
                                      return (
                                        <div key={sIndex} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-md bg-surface-hover">
                                          <span className="flex-1 truncate text-default">
                                            {catalogName}{genreSuffix} <span className="text-subtle">· {addonName} ({source.type})</span>
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
