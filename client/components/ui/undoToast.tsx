'use client';

import { toast } from 'react-hot-toast';
import { api } from '@/lib/api';

// "Deleted X — Undo" toast.
//
// The whole point of Trash is that a mistaken delete costs one click to
// reverse; a Trash page nobody knows exists does not deliver that. This puts
// the undo directly in the confirmation of the thing that just happened.
//
// Falls back to a plain success toast when there is no trashId - a delete
// that could not be archived (see the routes' own fallback) genuinely has no
// undo, and offering a button that would fail is worse than not offering one.

export function showDeletedWithUndo(
  label: string,
  trashId: string | null | undefined,
  onRestored?: () => void,
) {
  if (!trashId) {
    toast.success(`Deleted ${label}`);
    return;
  }

  toast.custom(
    (t) => (
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
      >
        <span className="text-sm" style={{ color: 'var(--color-text)' }}>
          Deleted <strong>{label}</strong>
        </span>
        <button
          type="button"
          className="text-sm font-medium underline"
          style={{ color: 'var(--color-primary)' }}
          onClick={async () => {
            toast.dismiss(t.id);
            try {
              await api.restoreFromTrash(trashId);
              toast.success(`Restored ${label}`);
              onRestored?.();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : `Could not restore ${label}`);
            }
          }}
        >
          Undo
        </button>
      </div>
    ),
    // Longer than a normal toast: an undo you did not have time to read is
    // not an undo. It stays recoverable from Trash for 30 days regardless.
    { duration: 8000 },
  );
}
