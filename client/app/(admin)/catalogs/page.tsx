'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Button, Modal, PosterThumb } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import { api, CustomList } from '@/lib/api';
import {
  RectangleStackIcon, PlusIcon, TrashIcon, PencilSquareIcon, ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';

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
  const [importUrl, setImportUrl] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    api.getLists()
      .then((r) => setLists(Array.isArray(r) ? r : []))
      .catch(() => setLists([]))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { load(); }, [load]);

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

  const handleDelete = async () => {
    if (!deleting) return;
    const list = deleting;
    setLists((prev) => prev.filter((l) => l.id !== list.id));
    setDeleting(null);
    try { await api.deleteList(list.id); toast.success(`Deleted "${list.name}"`); }
    catch { toast.error('Failed to delete'); load(); }
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
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-transform hover:scale-105"
      style={{
        background: 'linear-gradient(115deg, rgba(56, 89, 158, 0.22) 0%, rgba(56, 89, 158, 0.22) 50%, rgba(255, 152, 0, 0.10) 50%, rgba(255, 152, 0, 0.10) 100%)',
        color: 'rgb(186, 208, 240)',
        border: '1px solid rgba(186, 208, 240, 0.25)',
      }}
    >
      Nuvio Collections
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

          {lists.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {lists.map((list) => (
                <Card key={list.id} padding="md" className="group">
                  <button
                    type="button"
                    onClick={() => router.push(`/catalogs/${list.id}`)}
                    className="w-full text-left"
                  >
                    {/* Poster strip: up to 4 covers, or a placeholder. */}
                    <div className="flex gap-1 mb-3 h-24">
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
                    <p className="text-sm font-semibold text-default truncate">{list.name}</p>
                    <p className="text-xs text-muted">{list.items.length} title{list.items.length !== 1 ? 's' : ''}</p>
                  </button>
                  <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      title="Rename"
                      onClick={() => { setRenaming(list); setRenameValue(list.name); }}
                      className="p-1.5 rounded-lg text-muted hover:text-default hover:bg-surface-hover transition-colors"
                    >
                      <PencilSquareIcon className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      title="Delete catalog"
                      onClick={() => setDeleting(list)}
                      className="p-1.5 rounded-lg text-muted hover:text-error hover:bg-surface-hover transition-colors"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
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

      {/* Import catalog from TMDb or MDBList - provider auto-detected from the URL. */}
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
              Supports MDBList and TMDb lists (movies only for TMDb). Requires an API key in Settings → SlickTrax.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Name <span className="text-subtle font-normal">(optional — uses the source list&apos;s name if blank)</span></label>
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
            <Button variant="ghost" size="sm" onClick={() => setShowImport(false)} disabled={importing}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleImport} disabled={!importUrl.trim() || importing}>
              {importing ? 'Importing…' : 'Import'}
            </Button>
          </div>
        </div>
      </Modal>

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
    </>
  );
}
