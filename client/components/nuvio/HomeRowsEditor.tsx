'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Badge,
  DndContext, closestCenter, SortableContext, useSortable, useSortableSensors, CSS,
} from '@/components/ui';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { restrictToParentElement } from '@dnd-kit/modifiers';
import type { DragEndEvent } from '@dnd-kit/core';
import { toast } from '@/components/ui/Toast';
import { api, NuvioHomeRow } from '@/lib/api';
import { Bars3Icon, EyeIcon, EyeSlashIcon, PencilIcon } from '@heroicons/react/24/outline';

// Editor for a Nuvio profile's home-screen row arrangement - the order rows
// appear in, what each is called, and which are hidden. That arrangement is
// a synced per-profile blob in Nuvio's own backend (see
// server/utils/nuvioHomeLayout.js); the client owns no UI for rearranging it
// beyond dragging on the device itself, and one bad write from any client
// wipes the lot, which is why the layout guard snapshots it.
//
// Two lists on purpose: rows the arrangement already knows about (draggable,
// in their real order) and catalogs the account installs that the
// arrangement has never mentioned - a fresh profile has plenty of the
// latter, because the client only records a preference once a row has been
// touched. Adding one moves it into the arranged list at the end.

interface Props {
  userId: string;
  profileId: number;
  profileName: string;
  /** Returns to the collections view - this is a view on that page, not a dialog. */
  onDone: () => void;
}

function SortableRow({
  row, index, onRename, onToggle, onRemove,
}: {
  row: NuvioHomeRow;
  index: number;
  onRename: (index: number, title: string) => void;
  onToggle: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  const id = `${row.addon_id}:${row.type}:${row.catalog_id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const [editing, setEditing] = useState(false);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : row.enabled ? 1 : 0.55,
        background: 'var(--color-surface-hover)',
      }}
      className="flex items-center gap-2 p-2.5 rounded-xl"
    >
      <button type="button" className="cursor-grab touch-none shrink-0 text-muted" {...attributes} {...listeners} aria-label="Drag to reorder">
        <Bars3Icon className="w-4 h-4" />
      </button>
      <span className="text-xs text-subtle w-6 shrink-0 text-center">{index + 1}</span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            defaultValue={row.custom_title}
            placeholder={row.catalogName}
            onBlur={(e) => { onRename(index, e.target.value); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="w-full px-2 py-1 rounded text-sm"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
          />
        ) : (
          <p className="text-sm text-default truncate">
            {row.custom_title || row.catalogName}
            {row.custom_title && <span className="text-xs text-subtle"> (was {row.catalogName})</span>}
          </p>
        )}
        <p className="text-xs text-muted truncate">
          {row.addonName}
          {row.orphaned && <Badge variant="error" size="sm" className="ml-1.5">addon not installed</Badge>}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={() => setEditing(true)} className="p-1.5 rounded-lg text-muted hover:text-default hover:bg-surface-hover" title="Rename this row">
          <PencilIcon className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => onToggle(index)}
          className="p-1.5 rounded-lg text-muted hover:text-default hover:bg-surface-hover"
          title={row.enabled ? 'Hide this row on the device' : 'Show this row again'}
        >
          {row.enabled ? <EyeIcon className="w-4 h-4" /> : <EyeSlashIcon className="w-4 h-4" />}
        </button>
        {row.orphaned && (
          <Button variant="ghost" size="sm" onClick={() => onRemove(index)}>Remove</Button>
        )}
      </div>
    </div>
  );
}

export function HomeRowsEditor({ userId, profileId, profileName, onDone }: Props) {
  const [rows, setRows] = useState<NuvioHomeRow[]>([]);
  const [unarranged, setUnarranged] = useState<NuvioHomeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const sensors = useSortableSensors();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getNuvioHomeLayout(userId, profileId);
      setRows(r.items || []);
      setUnarranged(r.unarranged || []);
      setDirty(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read the home layout');
    } finally {
      setLoading(false);
    }
  }, [userId, profileId]);

  useEffect(() => { load(); }, [load]);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const idOf = (r: NuvioHomeRow) => `${r.addon_id}:${r.type}:${r.catalog_id}`;
    const from = rows.findIndex((r) => idOf(r) === active.id);
    const to = rows.findIndex((r) => idOf(r) === over.id);
    if (from < 0 || to < 0) return;
    setRows((prev) => arrayMove(prev, from, to));
    setDirty(true);
  };

  const rename = (index: number, title: string) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, custom_title: title.trim() } : r)));
    setDirty(true);
  };
  const toggle = (index: number) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, enabled: !r.enabled } : r)));
    setDirty(true);
  };
  const remove = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };
  const add = (row: NuvioHomeRow) => {
    setRows((prev) => [...prev, { ...row, arranged: true }]);
    setUnarranged((prev) => prev.filter((r) => !(r.addon_id === row.addon_id && r.type === row.type && r.catalog_id === row.catalog_id)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveNuvioHomeLayout(userId, profileId, rows);
      toast.success(`Home layout saved - ${r.rows} row${r.rows === 1 ? '' : 's'} pushed to ${profileName}`);
      setDirty(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save the home layout');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={onDone}>
                Collections
              </Button>
              <h3 className="text-base font-semibold text-default">Home rows · {profileName}</h3>
            </div>
            <p className="text-xs text-muted mt-1">
              Drag to reorder the rows on this profile&apos;s Nuvio home screen, rename any of them, or hide the
              ones you never use. Saving pushes the whole arrangement to the account; the layout guard snapshots
              it first, so a bad save is recoverable.
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={save} isLoading={saving} disabled={!dirty || rows.length === 0}>
            Save arrangement
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted py-6 text-center">Reading the current arrangement…</p>
        ) : (
          <>
            <div className="max-h-[58vh] overflow-y-auto pr-1">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToParentElement]}>
                <SortableContext items={rows.map((r) => `${r.addon_id}:${r.type}:${r.catalog_id}`)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-1.5">
                    {rows.map((row, i) => (
                      <SortableRow
                        key={`${row.addon_id}:${row.type}:${row.catalog_id}`}
                        row={row}
                        index={i}
                        onRename={rename}
                        onToggle={toggle}
                        onRemove={remove}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
              {rows.length === 0 && (
                <p className="text-sm text-muted py-6 text-center">
                  This profile has no synced arrangement yet - add rows below to create one.
                </p>
              )}
            </div>

            {unarranged.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
                  Not yet arranged ({unarranged.length})
                </p>
                <p className="text-xs text-muted mb-2">
                  Catalogs this account installs that the saved arrangement has never mentioned. They still show on
                  the device in its own default order - add one here to place it deliberately.
                </p>
                <div className="max-h-[20vh] overflow-y-auto space-y-1 pr-1">
                  {unarranged.map((row) => (
                    <div key={`${row.addon_id}:${row.type}:${row.catalog_id}`} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--color-surface-hover)' }}>
                      <span className="min-w-0 truncate text-xs text-default">
                        {row.catalogName} <span className="text-muted">· {row.addonName}</span>
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => add(row)}>Add</Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-[11px] text-subtle">
                {dirty ? 'Unsaved changes - nothing reaches the device until you save.' : 'No changes yet.'}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onDone}>{dirty ? 'Discard' : 'Back'}</Button>
                <Button variant="primary" size="sm" onClick={save} isLoading={saving} disabled={!dirty || rows.length === 0}>
                  Save arrangement
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
