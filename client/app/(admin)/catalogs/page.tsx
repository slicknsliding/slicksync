'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Button, Modal, PosterThumb, Badge, MediaDetailModal } from '@/components/ui';
import { AvatarPickerModal } from '@/components/modals/AvatarPickerModal';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import { api, CustomList, DescribedCatalogPreview, CustomListItem } from '@/lib/api';
import {
  RectangleStackIcon, PlusIcon, TrashIcon, PencilSquareIcon, ArrowDownTrayIcon, PhotoIcon, MapPinIcon, SparklesIcon,
} from '@heroicons/react/24/outline';
import { MapPinIcon as MapPinIconSolid, PlayIcon } from '@heroicons/react/24/solid';

// Matches AvatarPickerModal's own color-swatch formula exactly, so a
// catalog's solid-color cover reads as the same color the picker showed.
function coverColorStyle(colorIndex: number): React.CSSProperties {
  return { background: `color-mix(in srgb, var(--color-${colorIndex < 4 ? 'primary' : 'secondary'}) ${100 - (colorIndex % 4) * 25}%, white)` };
}

// Custom Lists (roadmap #7): named collections of titles. Create/rename/delete
// a list here; click one to open its own page at /catalogs/[id] (a real page, not
// a popup - browsing a list's contents is a destination, not a transient
// action). Titles are ADDED to a list from the "Add to list" control on a
// title's detail modal elsewhere.

export default function ListsPage() {
  const { layoutMode } = useLayoutMode();
  const router = useRouter();
  const [lists, setLists] = useState<CustomList[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<CustomList | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<CustomList | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showDescribe, setShowDescribe] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [coverPicker, setCoverPicker] = useState<CustomList | null>(null);
  // SIMKL has no named-list URL to paste (see server/utils/simklLists.js) -
  // import instead picks one of this account's SIMKL-linked users and pulls
  // their Plan to Watch, so this needs its own picker state alongside the
  // URL-based flow above.
  const [simklUsers, setSimklUsers] = useState<Array<{ id: string; username: string; avatarUrl: string | null; colorIndex: number | null }>>([]);
  const [simklUsersLoaded, setSimklUsersLoaded] = useState(false);
  const [selectedSimklUserId, setSelectedSimklUserId] = useState('');
  const [importingSimkl, setImportingSimkl] = useState(false);

  const load = useCallback(() => {
    api.getLists()
      .then((r) => setLists(Array.isArray(r) ? r : []))
      .catch(() => setLists([]))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!showImport || simklUsersLoaded) return;
    api.getSimklLinkedUsers()
      .then((users) => {
        setSimklUsers(users);
        if (users.length === 1) setSelectedSimklUserId(users[0].id);
      })
      .catch(() => setSimklUsers([]))
      .finally(() => setSimklUsersLoaded(true));
  }, [showImport, simklUsersLoaded]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const list = await api.createList(name);
      setNewName('');
      setShowCreate(false);
      toast.success(`Created "${name}"`);
      router.push(`/catalogs/${list.id}`);
    } catch { toast.error('Failed to create catalog'); }
  };

  const handleRename = async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      const updated = await api.updateList(renaming.id, { name });
      setLists((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setRenaming(null);
      toast.success('Renamed');
    } catch { toast.error('Failed to rename'); }
  };

  const handleImport = async () => {
    const url = importUrl.trim();
    if (!url) return;
    setImporting(true);
    try {
      const list = await api.importList(url, importName.trim() || undefined);
      setImportUrl('');
      setImportName('');
      setShowImport(false);
      toast.success(
        list.truncated
          ? `Imported ${list.items.length} of ${list.totalAvailable} titles (capped at ${list.items.length})`
          : `Imported "${list.name}" (${list.items.length} title${list.items.length !== 1 ? 's' : ''})`
      );
      router.push(`/catalogs/${list.id}`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to import catalog');
    } finally {
      setImporting(false);
    }
  };

  const handleImportSimkl = async () => {
    if (!selectedSimklUserId) return;
    setImportingSimkl(true);
    try {
      const list = await api.importListFromSimkl(selectedSimklUserId, importName.trim() || undefined);
      setImportName('');
      setSelectedSimklUserId('');
      setShowImport(false);
      toast.success(`Imported "${list.name}" (${list.items.length} title${list.items.length !== 1 ? 's' : ''})`);
      router.push(`/catalogs/${list.id}`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to import from SIMKL');
    } finally {
      setImportingSimkl(false);
    }
  };

  const handleTogglePin = async (list: CustomList) => {
    const next = !list.pinned;
    setLists((prev) => prev.map((l) => (l.id === list.id ? { ...l, pinned: next } : l)));
    try { await api.updateList(list.id, { pinned: next }); }
    catch { toast.error('Failed to update'); setLists((prev) => prev.map((l) => (l.id === list.id ? { ...l, pinned: !next } : l))); }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const list = deleting;
    setLists((prev) => prev.filter((l) => l.id !== list.id));
    setDeleting(null);
    try { await api.deleteList(list.id); toast.success(`Deleted "${list.name}"`); }
    catch { toast.error('Failed to delete'); load(); }
  };

  // AvatarPickerModal's onSave only includes the key(s) for the tab that was
  // actually saved (color tab sends both colorIndex + a clearing avatarUrl,
  // URL/upload tabs send only avatarUrl) - forward exactly that presence
  // through to the PATCH so the untouched field is left alone server-side.
  const handleCoverSave = async (data: { avatarUrl?: string | null; colorIndex?: number }) => {
    if (!coverPicker) return;
    const patch: { coverImageUrl?: string | null; coverColorIndex?: number | null } = {};
    if ('avatarUrl' in data) patch.coverImageUrl = data.avatarUrl ?? null;
    if ('colorIndex' in data) patch.coverColorIndex = data.colorIndex ?? null;
    const updated = await api.updateList(coverPicker.id, patch);
    setLists((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
  };

  const heading = { title: 'Catalogs', subtitle: 'Your custom collections of movies and shows.' };

  // Nuvio Collections entry point - deliberately not a card in the page
  // body (was too easy to miss as a full-width button there, then too
  // long as a full-width card). Lives in the header's `leading` slot
  // instead - opposite side from the bell/actions, compact, always visible
  // regardless of scroll position. Colors mirror the app's existing
  // two-tone Nuvio identity (Badge's `nuvio` variant) rather than the
  // generic primary/secondary palette, since this manages a connected
  // Nuvio account's own real external data, not a local catalog.
  const nuvioCollectionsButton = (
    <button
      type="button"
      onClick={() => router.push('/catalogs/nuvio-collections')}
      className="flex items-center gap-3 pl-3 pr-6 py-2.5 ml-[92px] rounded-full transition-transform hover:scale-105"
      style={{
        // A logo lockup (icon chip + wordmark), same shape as the app's own
        // Sidebar branding, sized up and given real breathing room per
        // feedback that the old plain-text pill read as an afterthought.
        // Dark fill + amber glow (rather than the theme's own primary/
        // secondary gradient) so this reads as Nuvio's own identity, not a
        // generic SlickSync nav pill - same reasoning as Badge's dedicated
        // `nuvio` variant elsewhere.
        background: 'linear-gradient(180deg, rgba(12,8,4,0.92), rgba(24,14,4,0.92))',
        border: '1.5px solid rgba(255,152,0,0.55)',
        boxShadow: '0 0 20px -4px rgba(255,152,0,0.45)',
      }}
    >
      <span
        className="flex items-center justify-center rounded-2xl shrink-0"
        style={{
          width: 44,
          height: 44,
          background: 'linear-gradient(135deg, #2E9FE0 0%, #6C5CE7 55%, #C24FE0 100%)',
        }}
      >
        <PlayIcon className="w-5 h-5 text-white ml-0.5" />
      </span>
      <span className="font-display font-bold text-xl tracking-tight" style={{ color: 'rgb(147, 197, 253)' }}>
        Nuvio Collections
      </span>
    </button>
  );

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={[{ label: 'Catalogs' }]} className="text-xl font-semibold" />}
          subtitle={heading.subtitle}
          leading={nuvioCollectionsButton}
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
        {layoutMode === 'nebula' && <NebulaPageHeading title={heading.title} subtitle={heading.subtitle} leading={nuvioCollectionsButton} />}

        <PageSection>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <RectangleStackIcon className="w-5 h-5 text-primary" />
              <h3 className="text-base font-semibold font-display text-default">
                {loaded ? `${lists.length} catalog${lists.length !== 1 ? 's' : ''}` : 'Catalogs'}
              </h3>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" leftIcon={<ArrowDownTrayIcon className="w-4 h-4" />} onClick={() => setShowImport(true)}>
                Import
              </Button>
              <Button variant="ghost" size="sm" leftIcon={<SparklesIcon className="w-4 h-4" />} onClick={() => setShowDescribe(true)}>
                Describe a catalog
              </Button>
              <Button variant="secondary" size="sm" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
                New catalog
              </Button>
            </div>
          </div>

          {loaded && lists.length === 0 && (
            <Card padding="lg" className="text-center">
              <RectangleStackIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
              <p className="text-sm text-muted">No catalogs yet.</p>
              <p className="text-xs text-subtle mt-1">Create one, then add titles from any movie or show&apos;s details.</p>
            </Card>
          )}

          {lists.length > 0 && (() => {
            // At most one hero - the pinned catalog with the most recent
            // activity if more than one happens to be pinned (see the
            // pinned field's own schema comment).
            const pinned = lists.filter((l) => l.pinned).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            const hero = pinned[0] || null;
            const rest = hero ? lists.filter((l) => l.id !== hero.id) : lists;

            // Action row is always visible (not hover-only) - hover has no
            // touch equivalent, so the original opacity-0 group-hover
            // treatment made Cover art/Rename/Delete completely unreachable
            // on mobile. Small enough not to compete with the title/count.
            // A catalog someone else shared with you is read-only here - no
            // pin/cover/rename/delete, since those all mutate a list you
            // don't own (the server already blocks the write, this just
            // avoids showing a control that would 404).
            const actionRow = (list: CustomList, size: 'sm' | 'lg') => (
              list.isOwner ? (
              <div className={`flex items-center gap-1 ${size === 'lg' ? 'bg-black/40 backdrop-blur-sm rounded-lg p-1' : ''}`}>
                <button
                  type="button"
                  title={list.pinned ? 'Unpin from top' : 'Pin to top'}
                  onClick={(e) => { e.stopPropagation(); handleTogglePin(list); }}
                  className={`p-1.5 rounded-lg transition-colors ${list.pinned ? 'text-primary' : `${size === 'lg' ? 'text-white/80 hover:text-white' : 'text-muted hover:text-default'} hover:bg-surface-hover`}`}
                >
                  {list.pinned ? <MapPinIconSolid className="w-4 h-4" /> : <MapPinIcon className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  title="Cover art"
                  onClick={(e) => { e.stopPropagation(); setCoverPicker(list); }}
                  className={`p-1.5 rounded-lg transition-colors ${size === 'lg' ? 'text-white/80 hover:text-white' : 'text-muted hover:text-default'} hover:bg-surface-hover`}
                >
                  <PhotoIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  title="Rename"
                  onClick={(e) => { e.stopPropagation(); setRenaming(list); setRenameValue(list.name); }}
                  className={`p-1.5 rounded-lg transition-colors ${size === 'lg' ? 'text-white/80 hover:text-white' : 'text-muted hover:text-default'} hover:bg-surface-hover`}
                >
                  <PencilSquareIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  title="Delete catalog"
                  onClick={(e) => { e.stopPropagation(); setDeleting(list); }}
                  className={`p-1.5 rounded-lg transition-colors hover:text-error ${size === 'lg' ? 'text-white/80' : 'text-muted'} hover:bg-surface-hover`}
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
              ) : (
                <Badge variant="muted" size="sm">Shared with you</Badge>
              )
            );

            return (
              <div className="space-y-4">
                {hero && (
                  <Card padding="none" className="overflow-hidden">
                    <button type="button" onClick={() => router.push(`/catalogs/${hero.id}`)} className="w-full text-left block relative group">
                      <div className="relative h-48 md:h-72 bg-black">
                        {hero.coverImageUrl ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={hero.coverImageUrl} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 opacity-40" />
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={hero.coverImageUrl} alt="" className="relative w-full h-full object-contain" />
                          </>
                        ) : hero.coverColorIndex !== null && hero.coverColorIndex !== undefined ? (
                          <div className="w-full h-full" style={coverColorStyle(hero.coverColorIndex)} />
                        ) : hero.items.length > 0 ? (
                          <div className="flex gap-1 w-full h-full">
                            {hero.items.slice(0, 4).map((it) => (
                              <PosterThumb key={it.id} item={it} className="flex-1 h-full" />
                            ))}
                          </div>
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <RectangleStackIcon className="w-10 h-10 text-subtle" />
                          </div>
                        )}
                        <div className="absolute inset-0" style={{ background: 'linear-gradient(0deg, rgba(0,0,0,0.75) 0%, transparent 45%)' }} />
                        <div className="absolute top-3 right-3">{actionRow(hero, 'lg')}</div>
                        <div className="absolute bottom-0 left-0 right-0 p-4 md:p-5">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="primary" size="sm">Featured</Badge>
                            {hero.isOwner && hero.shared && (
                              <Badge variant="muted" size="sm" title="Visible (read-only) to other accounts on this instance">Shared</Badge>
                            )}
                            {!hero.isOwner && <Badge variant="muted" size="sm">Shared with you</Badge>}
                            {hero.autoGenerated && (
                              <Badge variant="muted" size="sm" title="Auto-generated from your watch history">Auto</Badge>
                            )}
                          </div>
                          <p className="text-xl md:text-2xl font-display font-semibold text-white truncate">{hero.name}</p>
                          <p className="text-sm text-white/70">{hero.items.length} title{hero.items.length !== 1 ? 's' : ''}</p>
                        </div>
                      </div>
                    </button>
                  </Card>
                )}

                {rest.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {rest.map((list) => (
                      <Card key={list.id} padding="md">
                        <button
                          type="button"
                          onClick={() => router.push(`/catalogs/${list.id}`)}
                          className="w-full text-left"
                        >
                          {/* Custom cover (image or solid color) takes over the whole
                              strip; otherwise the up-to-4-poster collage / empty
                              placeholder from before. h-40 (was h-24) on the image
                              variant specifically - object-contain on a 2:3 poster
                              needs real height to read as anything but a tiny
                              centered sliver; the other two variants match it so
                              cards in the same grid row stay the same height. */}
                          {list.coverImageUrl ? (
                            // object-contain (not cover) - a tall poster jammed into
                            // this wide/short strip via object-cover crops down to
                            // an unrecognizable sliver of the middle of the image.
                            // The blurred duplicate behind it fills the letterbox
                            // bars instead of leaving them flat black.
                            <div className="relative mb-3 h-40 rounded-md overflow-hidden bg-black">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={list.coverImageUrl} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 opacity-40" />
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={list.coverImageUrl} alt="" className="relative w-full h-full object-contain" />
                            </div>
                          ) : list.coverColorIndex !== null && list.coverColorIndex !== undefined ? (
                            <div className="mb-3 h-40 rounded-md" style={coverColorStyle(list.coverColorIndex)} />
                          ) : (
                            <div className="flex gap-1 mb-3 h-40">
                              {list.items.length === 0 ? (
                                <div className="flex-1 rounded-md bg-surface-hover flex items-center justify-center">
                                  <RectangleStackIcon className="w-6 h-6 text-subtle" />
                                </div>
                              ) : (
                                list.items.slice(0, 4).map((it) => (
                                  <PosterThumb key={it.id} item={it} className="flex-1 h-full" />
                                ))
                              )}
                            </div>
                          )}
                          <div className="flex items-center gap-1.5">
                            <p className="text-sm font-semibold text-default truncate">{list.name}</p>
                            {list.isOwner && list.shared && (
                              <Badge variant="primary" size="sm" title="Visible (read-only) to other accounts on this instance">Shared</Badge>
                            )}
                            {list.autoGenerated && (
                              <Badge variant="muted" size="sm" title="Auto-generated from your watch history">Auto</Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted">{list.items.length} title{list.items.length !== 1 ? 's' : ''}</p>
                        </button>
                        <div className="flex items-center gap-1 mt-2">
                          {actionRow(list, 'sm')}
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </PageSection>
      </div>
      </div>

      {/* Create catalog */}
      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title="New catalog" size="sm">
        <div className="space-y-4">
          <input
            autoFocus
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            placeholder="e.g. Halloween Marathon"
            className="w-full px-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleCreate} disabled={!newName.trim()}>Create</Button>
          </div>
        </div>
      </Modal>

      {/* Import catalog from TMDb, MDBList, or a linked user's SIMKL Plan to
          Watch. TMDb/MDBList are URL-based (provider auto-detected); SIMKL
          has no named-list API yet (see server/utils/simklLists.js) so it
          picks a linked user instead of a URL. */}
      <Modal isOpen={showImport} onClose={() => setShowImport(false)} title="Import a catalog" size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Catalog URL</label>
            <input
              autoFocus
              type="text"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleImport(); }}
              placeholder="https://mdblist.com/lists/user/slug or themoviedb.org/list/123"
              className="w-full px-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
            />
            <p className="text-xs text-subtle mt-1.5">
              Supports MDBList and TMDb lists (movies only for TMDb). Requires an API key in Settings → External API Keys.
              This copies the list&apos;s current titles once — later changes to the source list won&apos;t appear here automatically.
            </p>
          </div>

          {simklUsers.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Or import from SIMKL</label>
              <select
                value={selectedSimklUserId}
                onChange={(e) => setSelectedSimklUserId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
              >
                <option value="">Select a SIMKL-linked user…</option>
                {simklUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>
              <p className="text-xs text-subtle mt-1.5">
                Pulls that user&apos;s SIMKL Plan to Watch — SIMKL doesn&apos;t expose named lists via API yet, this is the closest equivalent.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Name <span className="text-subtle font-normal">(optional — uses the source&apos;s name if blank)</span></label>
            <input
              type="text"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleImport(); }}
              placeholder="e.g. Halloween Marathon"
              className="w-full px-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowImport(false)} disabled={importing || importingSimkl}>Cancel</Button>
            {selectedSimklUserId ? (
              <Button variant="primary" size="sm" onClick={handleImportSimkl} disabled={importingSimkl}>
                {importingSimkl ? 'Importing…' : 'Import from SIMKL'}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleImport} disabled={!importUrl.trim() || importing}>
                {importing ? 'Importing…' : 'Import'}
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {showDescribe && (
        <DescribeCatalogModal
          onClose={() => setShowDescribe(false)}
          onSaved={(saved) => {
            setLists((prev) => [saved, ...prev]);
            setShowDescribe(false);
            toast.success(`Created "${saved.name}"`);
          }}
        />
      )}

      {/* Rename catalog */}
      <Modal isOpen={!!renaming} onClose={() => setRenaming(null)} title="Rename catalog" size="sm">
        <div className="space-y-4">
          <input
            autoFocus
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
            className="w-full px-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleRename} disabled={!renameValue.trim()}>Save</Button>
          </div>
        </div>
      </Modal>

      {/* Delete confirm */}
      <Modal isOpen={!!deleting} onClose={() => setDeleting(null)} title="Delete catalog" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">Delete <span className="font-medium text-default">{deleting?.name}</span>? This removes the catalog only — nothing about your watch history changes.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
          </div>
        </div>
      </Modal>

      {/* Cover art - same picker Settings/Users/Groups already use for
          avatars, repurposed for a catalog's own cover. */}
      {coverPicker && (
        <AvatarPickerModal
          isOpen={!!coverPicker}
          onClose={() => setCoverPicker(null)}
          name={coverPicker.name}
          currentAvatarUrl={coverPicker.coverImageUrl}
          currentColorIndex={coverPicker.coverColorIndex ?? 0}
          title=""
          previewShape="rect"
          size="lg"
          onSave={handleCoverSave}
        />
      )}
    </>
  );
}

// ---- Describe a catalog (natural-language) ---------------------------------
//
// Two steps, deliberately never collapsed into one: describe -> preview
// (nothing saved) -> review what the parser actually understood + the real
// results -> save. Skipping straight to save would mean the first time an
// admin learns the AI (or the keyword fallback) misread their request is
// after a wrong catalog already exists.
function DescribeCatalogModal({
  onClose, onSaved,
}: {
  onClose: () => void;
  onSaved: (list: CustomList) => void;
}) {
  const [description, setDescription] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<DescribedCatalogPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<CustomListItem | null>(null);

  const handlePreview = async () => {
    if (!description.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.previewDescribedCatalog(description.trim());
      setPreview(result);
      if (!name.trim()) {
        // A short default name from the description itself - trimmed to a
        // sane title length rather than dumping the whole sentence as the
        // catalog's name. Still just a starting point; the input below it
        // stays fully editable before save.
        const words = description.trim().split(/\s+/).slice(0, 6).join(' ');
        setName(words.charAt(0).toUpperCase() + words.slice(1));
      }
    } catch (err: any) {
      setError(err.message || 'Failed to generate a preview');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim() || !preview) return;
    setSaving(true);
    try {
      const saved = await api.saveDescribedCatalog({ name: name.trim(), description: description.trim(), items: preview.items });
      onSaved(saved);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save catalog');
    } finally {
      setSaving(false);
    }
  };

  const queryParts: string[] = [];
  if (preview) {
    if (preview.query.genres.length) queryParts.push(preview.query.genres.join('/'));
    if (preview.query.yearFrom && preview.query.yearTo && preview.query.yearFrom !== preview.query.yearTo) {
      queryParts.push(`${preview.query.yearFrom}-${preview.query.yearTo}`);
    } else if (preview.query.yearFrom) {
      queryParts.push(String(preview.query.yearFrom));
    }
    if (preview.query.maxRuntimeMinutes) queryParts.push(`under ${preview.query.maxRuntimeMinutes}m`);
    queryParts.push(preview.mediaType === 'tv' ? 'series' : 'movies');
  }

  return (
    <>
    <Modal isOpen onClose={onClose} title="Describe a catalog" size="lg">
      <div className="space-y-4">
        <div>
          <textarea
            autoFocus
            value={description}
            onChange={(e) => { setDescription(e.target.value); setPreview(null); }}
            placeholder='e.g. "A 90s neo-noir under two hours" or "cozy horror series"'
            rows={2}
            maxLength={500}
            className="w-full px-4 py-3 rounded-xl focus:outline-none resize-none"
            style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
          />
          <p className="text-xs text-muted mt-1.5">Genre, decade, runtime, movie or series - whatever you mention gets used. Already-watched titles are always excluded.</p>
        </div>

        {!preview && (
          <div className="flex justify-end">
            <Button variant="primary" onClick={handlePreview} isLoading={loading} disabled={!description.trim()}>
              Preview
            </Button>
          </div>
        )}

        {error && (
          <p className="text-sm p-3 rounded-lg bg-error-muted text-error">{error}</p>
        )}

        {preview && (
          <div className="space-y-4">
            <div className="p-3 rounded-xl bg-surface-hover">
              <p className="text-xs uppercase tracking-wide text-subtle mb-1">
                {preview.usedAi ? 'AI understood this as' : 'Understood as'}
              </p>
              <p className="text-sm text-default">
                {queryParts.length > 0 ? queryParts.join(' · ') : 'No specific filters detected - showing top-rated results'}
              </p>
              {!preview.usedAi && preview.aiError && (
                <p className="text-xs mt-1.5" style={{ color: 'var(--color-error)' }}>
                  Your configured AI key didn&apos;t work ({preview.aiError}) - used the built-in keyword parser instead. Check the model/base URL pairing in <Link href="/settings" className="underline hover:text-default">Settings</Link>.
                </p>
              )}
              {!preview.usedAi && !preview.aiError && (
                <p className="text-xs text-subtle mt-1.5">
                  Using the built-in keyword parser. <Link href="/settings" className="underline hover:text-default">Add an AI key in Settings</Link> for better understanding of nuanced descriptions.
                </p>
              )}
            </div>

            {preview.items.length === 0 ? (
              <p className="text-sm text-muted">No matches found - try rephrasing, or widening the runtime/decade.</p>
            ) : (
              <div className="max-h-96 overflow-y-auto grid grid-cols-4 sm:grid-cols-5 gap-3 p-1">
                {preview.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setDetailItem(item)}
                    className="text-left group"
                  >
                    <PosterThumb item={item} className="aspect-[2/3] transition-transform group-hover:scale-[1.03] group-hover:ring-2 group-hover:ring-primary" />
                    <p className="text-xs text-muted mt-1 truncate group-hover:text-default transition-colors" title={item.name}>{item.name}</p>
                  </button>
                ))}
              </div>
            )}

            {preview.items.length > 0 && (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Catalog name"
                className="w-full px-4 py-3 rounded-xl focus:outline-none"
                style={{ background: 'var(--color-surfaceHover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
              />
            )}

            <div className="flex justify-between gap-3">
              <Button variant="ghost" onClick={() => setPreview(null)}>Try again</Button>
              <div className="flex gap-3">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                {preview.items.length > 0 && (
                  <Button variant="primary" onClick={handleSave} isLoading={saving} disabled={!name.trim()}>
                    Save as Catalog
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
    {detailItem && (
      <MediaDetailModal
        isOpen={!!detailItem}
        onClose={() => setDetailItem(null)}
        itemId={detailItem.id}
        itemType={detailItem.type}
        fallbackTitle={detailItem.name}
        fallbackPoster={detailItem.poster || undefined}
      />
    )}
    </>
  );
}
