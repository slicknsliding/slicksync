'use client';

// The v2 detail pages (an addon, a group) let their title and description be
// changed right where they are read: a small pencil beside each turns both into
// fields with one tick and one cross. `useTitleEdit` hands back the two pieces
// the page drops into V2DetailHead: the title, and the description line.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, PencilIcon, XMarkIcon } from '@heroicons/react/24/outline';

export type TitlePatch = { name?: string; description?: string };

const FIELD_W = 'min(560px, calc(100vw - 180px))';

export function useTitleEdit({ name, description, canEdit, onSave, descriptionHint = 'Add a description', label = 'name' }: {
  name: string;
  description?: string | null;
  /** False while the page is still loading. */
  canEdit: boolean;
  /** Only the fields that changed. Return false to keep the fields open (the save failed). */
  onSave: (patch: TitlePatch) => Promise<boolean | void> | boolean | void;
  descriptionHint?: string;
  label?: string;
}): { title: ReactNode; description: ReactNode; editing: boolean } {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [n, setN] = useState(name);
  const [d, setD] = useState(description || '');
  const focusDesc = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    (focusDesc.current ? descRef.current : nameRef.current)?.focus();
    (focusDesc.current ? descRef.current : nameRef.current)?.select();
  }, [editing]);

  const start = (toDescription: boolean) => {
    focusDesc.current = toDescription;
    setN(name);
    setD(description || '');
    setEditing(true);
  };
  const cancel = () => setEditing(false);
  const save = async () => {
    const nextName = n.trim();
    const nextDesc = d.trim();
    if (!nextName) return;
    const patch: TitlePatch = {};
    if (nextName !== name) patch.name = nextName;
    if (nextDesc !== (description || '')) patch.description = nextDesc;
    if (!patch.name && patch.description === undefined) { setEditing(false); return; }
    setSaving(true);
    try {
      const ok = await onSave(patch);
      if (ok !== false) setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); void save(); }
    if (e.key === 'Escape') cancel();
  };

  const pencil = (aria: string, toDescription: boolean, small?: boolean) => (
    <button
      type="button"
      className="arrange-icon"
      style={small ? { width: 26, height: 26, borderRadius: 8, verticalAlign: 'middle' } : { verticalAlign: 'middle' }}
      aria-label={aria}
      title={aria}
      onClick={() => start(toDescription)}
    >
      <PencilIcon className="w-4 h-4" />
    </button>
  );

  if (editing) {
    return {
      editing,
      title: (
        <span className="flex items-center gap-2" style={{ width: FIELD_W }}>
          <input
            ref={nameRef}
            value={n}
            maxLength={120}
            aria-label={`Change the ${label}`}
            onChange={(e) => setN(e.target.value)}
            onKeyDown={keys}
            className="input-base min-w-0 flex-1 px-3 py-1.5 font-bold"
            style={{ fontSize: 24 }}
          />
          <button type="button" className="arrange-icon shrink-0" aria-label="Save" title="Save" disabled={saving || !n.trim()} onClick={() => void save()}>
            <CheckIcon className="w-4 h-4" />
          </button>
          <button type="button" className="arrange-icon shrink-0" aria-label="Cancel" title="Cancel" onClick={cancel}>
            <XMarkIcon className="w-4 h-4" />
          </button>
        </span>
      ),
      description: (
        <input
          ref={descRef}
          value={d}
          maxLength={500}
          placeholder={descriptionHint}
          aria-label="Change the description"
          onChange={(e) => setD(e.target.value)}
          onKeyDown={keys}
          className="input-base px-3 py-1.5 text-[14px] block"
          style={{ width: `min(${FIELD_W}, 100%)`, maxWidth: FIELD_W }}
        />
      ),
    };
  }
  return {
    editing,
    title: (
      <>
        {name}
        {canEdit && <> {pencil(`Change the ${label}`, false)}</>}
      </>
    ),
    description: description
      ? (
        <span className="text-muted text-[14.5px] min-w-0" style={{ overflowWrap: 'anywhere' }}>
          {description}
          {canEdit && <> {pencil('Change the description', true, true)}</>}
        </span>
      )
      : canEdit
        ? (
          <button type="button" className="text-muted text-[13.5px] hover:text-default text-left" onClick={() => start(true)}>
            {descriptionHint}
          </button>
        )
        : null,
  };
}

/** For a page that can't call the hook (it has returned early before here): the same pieces, by render prop. */
export function V2TitleEdit({ children, ...opts }: Parameters<typeof useTitleEdit>[0] & {
  children: (parts: { title: ReactNode; description: ReactNode; editing: boolean }) => ReactNode;
}) {
  return <>{children(useTitleEdit(opts))}</>;
}
