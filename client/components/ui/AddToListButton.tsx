'use client';

import { useState, useCallback, useEffect } from 'react';
import { RectangleStackIcon, PlusIcon, CheckIcon } from '@heroicons/react/24/outline';
import { api, CustomList } from '@/lib/api';
import { toast } from '@/components/ui/Toast';

type CatalogItem = { id: string; type: 'movie' | 'series'; name: string; poster?: string | null };

// Shared picker body - fetches the account's catalogs on mount, lets you
// toggle the current title into any of them, and create a new one inline.
// Extracted so both AddToListButton's own dropdown (media detail modal) and
// Discover's right-click "Add to Catalogs" menu item render the exact same
// logic instead of two copies drifting apart.
export function CatalogPickerMenu({
  item, onBack, onDone,
}: {
  item: CatalogItem;
  /** Present when this picker replaces another menu's content in place
   *  (Discover's right-click menu) - renders a "← Back" row above the list. */
  onBack?: () => void;
  /** Fires after a successful toggle/create - callers that close their own
   *  menu on any action (Discover's right-click menu) pass close() here. */
  onDone?: () => void;
}) {
  const [lists, setLists] = useState<CustomList[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creatingName, setCreatingName] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    // getLists() now also returns catalogs OTHER accounts have shared with
    // this one (read-only) - this picker adds/removes titles, a write, so
    // it must only ever offer catalogs this account actually owns. Every
    // write route already 404s for a non-owner regardless, but filtering
    // here keeps a shared-with-you catalog from even appearing as a
    // pickable target in the first place.
    api.getLists()
      .then((r) => setLists(Array.isArray(r) ? r.filter((l) => l.isOwner) : []))
      .catch(() => setLists([]))
      .finally(() => setLoaded(true));
  }, []);

  const inList = (list: CustomList) => list.items.some((i) => i.id === item.id);

  const handleToggle = async (list: CustomList) => {
    setBusyId(list.id);
    try {
      if (inList(list)) {
        const updated = await api.removeFromList(list.id, item.id);
        setLists((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
        toast.success(`Removed from "${list.name}"`);
      } else {
        const updated = await api.addToList(list.id, { id: item.id, type: item.type, name: item.name, poster: item.poster });
        setLists((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
        toast.success(`Added to "${list.name}"`);
      }
      onDone?.();
    } catch { toast.error('Failed to update catalog'); }
    finally { setBusyId(null); }
  };

  const handleCreate = async () => {
    const name = creatingName.trim();
    if (!name) return;
    try {
      const list = await api.createList(name);
      const updated = await api.addToList(list.id, { id: item.id, type: item.type, name: item.name, poster: item.poster });
      setLists((prev) => [updated, ...prev]);
      setCreatingName('');
      setShowCreate(false);
      toast.success(`Added to "${name}"`);
      onDone?.();
    } catch { toast.error('Failed to create catalog'); }
  };

  return (
    <>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover transition-colors text-left border-b border-default mb-1"
        >
          ← Back
        </button>
      )}
      {!loaded ? (
        <p className="text-xs text-muted px-2 py-2">Loading…</p>
      ) : (
        <>
          {lists.length === 0 && !showCreate && (
            <p className="text-xs text-muted px-2 py-2">No catalogs yet.</p>
          )}
          {lists.map((list) => {
            const active = inList(list);
            return (
              <button
                key={list.id}
                type="button"
                disabled={busyId === list.id}
                onClick={() => handleToggle(list)}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-default hover:bg-surface-hover transition-colors text-left"
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${active ? 'bg-primary border-primary' : 'border-default'}`}>
                  {active && <CheckIcon className="w-3 h-3 text-white" />}
                </span>
                <span className="flex-1 min-w-0 truncate">{list.name}</span>
                <span className="text-xs text-subtle">{list.items.length}</span>
              </button>
            );
          })}

          {showCreate ? (
            <div className="p-1.5 border-t border-default mt-1">
              <input
                autoFocus
                type="text"
                value={creatingName}
                onChange={(e) => setCreatingName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
                placeholder="New catalog name"
                className="w-full px-2 py-1.5 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-primary hover:bg-surface-hover transition-colors text-left border-t border-default mt-1"
            >
              <PlusIcon className="w-4 h-4" />
              New catalog…
            </button>
          )}
        </>
      )}
    </>
  );
}

// "Add to catalog" control for the media detail modal (roadmap #7). Thin
// trigger + popover wrapper around CatalogPickerMenu above.
export function AddToListButton({ item }: { item: CatalogItem }) {
  const [open, setOpen] = useState(false);
  const toggleOpen = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-surface-hover text-default hover:bg-primary/20 hover:text-primary transition-colors"
      >
        <RectangleStackIcon className="w-4 h-4" />
        Add to catalog
      </button>

      {open && (
        <>
          {/* Click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 mt-2 w-60 z-50 rounded-xl bg-surface border border-default shadow-xl p-1.5 max-h-72 overflow-y-auto">
            <CatalogPickerMenu item={item} />
          </div>
        </>
      )}
    </div>
  );
}
