'use client';

import { toast } from '@/components/ui/Toast';
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

  toast.success(`Deleted ${label}`, {
    line: 'It’s in the Trash for 30 days.',
    actions: [{
      label: 'Undo',
      onClick: async () => {
        try {
          await api.restoreFromTrash(trashId);
          toast.success(`Restored ${label}`);
          onRestored?.();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : `Could not restore ${label}`);
        }
      },
    }],
    // Longer than a normal toast: an undo you did not have time to read is
    // not an undo. It stays recoverable from Trash for 30 days regardless.
    duration: 8000,
  });
}

// A deleted person. The delete route archives them to the Trash but doesn't
// hand back the Trash item's id, so it is looked up here: the newest person
// in the Trash with this name. No match (or the Trash can't be read) falls
// back to the plain success toast, which has no Undo to offer.
export async function showPersonDeletedWithUndo(name: string, onRestored?: () => void) {
  let trashId: string | null = null;
  try {
    const items = await api.getTrash();
    // Newest first. The label is their username (or email); when it reads
    // differently from the name on screen, the person deleted in the last
    // half minute is the one just removed.
    const people = items.filter((i) => i.kind === 'user');
    const hit = people.find((i) => i.label === name)
      ?? people.find((i) => Date.now() - new Date(i.deletedAt).getTime() < 30000);
    trashId = hit?.id ?? null;
  } catch { /* the Trash couldn't be read: no Undo to offer */ }
  if (!trashId) {
    toast.success(`${name} deleted successfully`);
    return;
  }
  const id = trashId;
  toast.success(`${name} is in the Trash`, {
    line: 'Back for 30 days from Tasks → Trash',
    actions: [{
      label: 'Undo',
      onClick: async () => {
        try {
          await api.restoreFromTrash(id);
          toast.success(`${name} is back`);
          onRestored?.();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : `Could not bring ${name} back`);
        }
      },
    }],
    duration: 8000,
  });
}
