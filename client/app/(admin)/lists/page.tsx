'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Button, MediaDetailModal, Modal } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import { api, CustomList, CustomListItem } from '@/lib/api';
import {
  RectangleStackIcon, PlusIcon, TrashIcon, PencilSquareIcon,
  FilmIcon, TvIcon, XMarkIcon,
} from '@heroicons/react/24/outline';

// Custom Lists (roadmap #7): named collections of titles. Create/rename/delete
// a list here; open one to browse its titles (each opens the same
// MediaDetailModal used across the app) and remove titles. Titles are ADDED to
// a list from the "Add to list" control on a title's detail modal elsewhere.

function PosterThumb({ item, className = '' }: { item: CustomListItem; className?: string }) {
  return (
    <div className={`rounded-md overflow-hidden bg-surface-hover flex items-center justify-center ${className}`}>
      {item.poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.poster} alt="" className="w-full h-full object-cover" />
      ) : (
        item.type === 'series'
          ? <TvIcon className="w-5 h-5 text-subtle" />
          : <FilmIcon className="w-5 h-5 text-subtle" />
      )}
    </div>
  );
}

export default function ListsPage() {
  const { layoutMode } = useLayoutMode();
  const [lists, setLists] = useState<CustomList[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [openList, setOpenList] = useState<CustomList | null>(null);
  const [detail, setDetail] = useState<CustomListItem | null>(null);
  const [renaming, setRenaming] = useState<CustomList | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<CustomList | null>(null);

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
      setLists((prev) => [list, ...prev]);
      setNewName('');
      setShowCreate(false);
      toast.success(`Created "${name}"`);
    } catch { toast.error('Failed to create list'); }
  };

  const handleRename = async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      const updated = await api.updateList(renaming.id, { name });
      setLists((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      if (openList?.id === updated.id) setOpenList(updated);
      setRenaming(null);
      toast.success('Renamed');
    } catch { toast.error('Failed to rename'); }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const list = deleting;
    setLists((prev) => prev.filter((l) => l.id !== list.id));
    if (openList?.id === list.id) setOpenList(null);
    setDeleting(null);
    try { await api.deleteList(list.id); toast.success(`Deleted "${list.name}"`); }
    catch { toast.error('Failed to delete'); load(); }
  };

  const handleRemoveItem = async (list: CustomList, item: CustomListItem) => {
    const updated = { ...list, items: list.items.filter((i) => i.id !== item.id) };
    setOpenList(updated);
    setLists((prev) => prev.map((l) => (l.id === list.id ? updated : l)));
    try { await api.removeFromList(list.id, item.id); }
    catch { toast.error('Failed to remove'); load(); }
  };

  const heading = { title: 'Lists', subtitle: 'Your custom collections of movies and shows.' };

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={[{ label: 'Lists' }]} className="text-xl font-semibold" />}
          subtitle={heading.subtitle}
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
        {layoutMode === 'nebula' && <NebulaPageHeading title={heading.title} subtitle={heading.subtitle} />}

        <PageSection>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <RectangleStackIcon className="w-5 h-5 text-primary" />
              <h3 className="text-base font-semibold font-display text-default">
                {loaded ? `${lists.length} list${lists.length !== 1 ? 's' : ''}` : 'Lists'}
              </h3>
            </div>
            <Button variant="secondary" size="sm" leftIcon={<PlusIcon className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
              New list
            </Button>
          </div>

          {loaded && lists.length === 0 && (
            <Card padding="lg" className="text-center">
              <RectangleStackIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
              <p className="text-sm text-muted">No lists yet.</p>
              <p className="text-xs text-subtle mt-1">Create one, then add titles from any movie or show&apos;s details.</p>
            </Card>
          )}

          {lists.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {lists.map((list) => (
                <Card key={list.id} padding="md" className="group">
                  <button
                    type="button"
                    onClick={() => setOpenList(list)}
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
                      title="Delete list"
                      onClick={() => setDeleting(list)}
                      className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-surface-hover transition-colors"
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

      {/* Create list */}
      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title="New list" size="sm">
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

      {/* Rename list */}
      <Modal isOpen={!!renaming} onClose={() => setRenaming(null)} title="Rename list" size="sm">
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
      <Modal isOpen={!!deleting} onClose={() => setDeleting(null)} title="Delete list" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">Delete <span className="font-medium text-default">{deleting?.name}</span>? This removes the list only — nothing about your watch history changes.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
          </div>
        </div>
      </Modal>

      {/* Open a list: browse + remove titles */}
      <Modal isOpen={!!openList} onClose={() => setOpenList(null)} title={openList?.name || 'List'} size="lg">
        {openList && (
          openList.items.length === 0 ? (
            <p className="text-sm text-muted py-6 text-center">
              No titles yet — open any movie or show and use &quot;Add to list&quot;.
            </p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-h-[70vh] overflow-y-auto pr-1">
              {openList.items.map((item) => (
                <div key={item.id} className="relative group">
                  <button type="button" onClick={() => setDetail(item)} className="w-full text-left">
                    <PosterThumb item={item} className="w-full aspect-[2/3]" />
                    <p className="text-xs text-default truncate mt-1">{item.name}</p>
                  </button>
                  <button
                    type="button"
                    title="Remove from list"
                    onClick={() => handleRemoveItem(openList, item)}
                    className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <XMarkIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </Modal>

      {detail && (
        <MediaDetailModal
          isOpen={!!detail}
          onClose={() => setDetail(null)}
          itemId={detail.id}
          itemType={detail.type}
          fallbackTitle={detail.name}
          fallbackPoster={detail.poster || undefined}
        />
      )}
    </>
  );
}
