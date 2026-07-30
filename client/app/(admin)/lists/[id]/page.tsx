'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { Card, Button, Modal, MediaDetailModal, PosterThumb } from '@/components/ui';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { toast } from '@/components/ui/Toast';
import { api, CustomList, CustomListItem } from '@/lib/api';
import {
  RectangleStackIcon, PencilSquareIcon, TrashIcon, XMarkIcon, ArrowLeftIcon,
} from '@heroicons/react/24/outline';

// A list's own page (roadmap #7 follow-up) - opening a list is a destination,
// not a transient popup, so it gets a real route (/lists/[id]) with a URL you
// can bookmark/share/back-button out of, same as /groups/[id] or /users/[id].
// Individual titles inside still open the shared MediaDetailModal - that part
// IS a quick preview, unlike the list itself.
export default function ListDetailPage() {
  const { layoutMode } = useLayoutMode();
  const params = useParams();
  const router = useRouter();
  const listId = params.id as string;

  const [list, setList] = useState<CustomList | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [detail, setDetail] = useState<CustomListItem | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setIsLoading(true);
    api.getLists()
      .then((all) => {
        const found = all.find((l) => l.id === listId) || null;
        setList(found);
        setNotFound(!found);
      })
      .catch(() => setNotFound(true))
      .finally(() => setIsLoading(false));
  }, [listId]);
  useEffect(() => { if (listId) load(); }, [listId, load]);

  const handleRename = async () => {
    if (!list) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      const updated = await api.updateList(list.id, { name });
      setList(updated);
      setRenaming(false);
      toast.success('Renamed');
    } catch { toast.error('Failed to rename'); }
  };

  const handleDelete = async () => {
    if (!list) return;
    try {
      await api.deleteList(list.id);
      toast.success(`Deleted "${list.name}"`);
      router.push('/lists');
    } catch { toast.error('Failed to delete'); }
  };

  const handleRemoveItem = async (item: CustomListItem) => {
    if (!list) return;
    const updated = { ...list, items: list.items.filter((i) => i.id !== item.id) };
    setList(updated);
    try { await api.removeFromList(list.id, item.id); }
    catch { toast.error('Failed to remove'); load(); }
  };

  const title = isLoading ? 'Loading…' : notFound ? 'List not found' : (list?.name || 'List');
  const subtitle = isLoading ? '' : notFound ? '' : `${list?.items.length || 0} title${list?.items.length !== 1 ? 's' : ''}`;

  // Explicit navigation to /lists (not router.back()) - back should always
  // land on the Lists index in one hop, regardless of how this page was
  // reached, per feedback that clicking "Lists" in the nav to get back felt
  // like backtracking.
  const backButton = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={() => router.push('/lists')}>
      Back
    </Button>
  );

  // Nebula: Back sits alone in the heading's left column (see `leading`
  // below) - Rename/Delete stay grouped with the bell on the right, since
  // "leave this list" reads as a different kind of action from "edit it".
  // The sidebar Header below has no such left column, so it keeps Back
  // bundled with the other actions - there's nothing to separate it from.
  const editActions = list && !isLoading && !notFound ? (
    <div className="flex items-center gap-2">
      <Button variant="secondary" size="sm" leftIcon={<PencilSquareIcon className="w-4 h-4" />} onClick={() => { setRenameValue(list.name); setRenaming(true); }}>
        Rename
      </Button>
      <Button variant="danger" size="sm" leftIcon={<TrashIcon className="w-4 h-4" />} onClick={() => setDeleting(true)}>
        Delete
      </Button>
    </div>
  ) : null;

  const detailActions = editActions ? (
    <div className="flex items-center gap-2">
      {backButton}
      {editActions}
    </div>
  ) : backButton;

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={
            <Breadcrumbs
              items={[{ label: 'Lists', href: '/lists' }, { label: title }]}
              className="text-xl font-semibold"
            />
          }
          subtitle={subtitle}
          actions={detailActions}
        />
      )}

      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
      <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: '72rem' } : undefined}>
        {layoutMode === 'nebula' && (
          <NebulaPageHeading title={title} subtitle={subtitle || 'Lists'} leading={backButton} actions={editActions} />
        )}

        <PageSection>
          {notFound ? (
            <Card padding="lg" className="text-center">
              <RectangleStackIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
              <p className="text-sm text-muted">This list doesn&apos;t exist (it may have been deleted).</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => router.push('/lists')}>Back to Lists</Button>
            </Card>
          ) : isLoading ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="aspect-[2/3] rounded-md bg-surface-hover animate-pulse" />
              ))}
            </div>
          ) : list && list.items.length === 0 ? (
            <Card padding="lg" className="text-center">
              <RectangleStackIcon className="w-10 h-10 mx-auto text-subtle mb-3" />
              <p className="text-sm text-muted">No titles yet.</p>
              <p className="text-xs text-subtle mt-1">Open any movie or show and use &quot;Add to list&quot;.</p>
            </Card>
          ) : list ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
              {list.items.map((item) => (
                <div key={item.id} className="relative group">
                  <button type="button" onClick={() => setDetail(item)} className="w-full text-left">
                    <PosterThumb item={item} className="w-full aspect-[2/3]" />
                    <p className="text-xs text-default truncate mt-1">{item.name}</p>
                  </button>
                  <button
                    type="button"
                    title="Remove from list"
                    onClick={() => handleRemoveItem(item)}
                    className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <XMarkIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </PageSection>
      </div>
      </div>

      <Modal isOpen={renaming} onClose={() => setRenaming(false)} title="Rename list" size="sm">
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
            <Button variant="ghost" size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleRename} disabled={!renameValue.trim()}>Save</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={deleting} onClose={() => setDeleting(false)} title="Delete list" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">Delete <span className="font-medium text-default">{list?.name}</span>? This removes the list only — nothing about your watch history changes.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
          </div>
        </div>
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
