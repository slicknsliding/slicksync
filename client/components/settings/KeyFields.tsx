'use client';

import { useEffect, useRef, useState } from 'react';
import { ShieldCheckIcon, Squares2X2Icon, XMarkIcon } from '@heroicons/react/24/outline';

// Optional failover key paired with one of the four metadata providers.
// Only offered once a primary key exists (a backup with nothing to back up
// is just a confusing second box), and collapsed behind a link until asked
// for, so the common one-key setup looks exactly as it always did.
// The backup is used only when the health check has actually found the
// primary failing or rate-limited - see server/utils/listImport.js.

// Key Pool editor - extra keys beyond the primary/backup pair. Same compact
// chip-then-expand pattern as BackupKeyField above (and the same click-away
// collapse), because the page's sizing complaints were heard: nothing here
// takes space until asked for. With any pool keys present, lookups rotate
// across every healthy key instead of hammering the primary - three free
// MDBList keys become one pooled allowance.
export function PoolKeysField({
  field, keys, primaryFilled, onSave,
}: {
  field: string;
  keys: string[];
  primaryFilled: boolean;
  onSave: (next: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!primaryFilled) return null;

  const commit = async (next: string[]) => {
    setSaving(true);
    try { await onSave(next); } finally { setSaving(false); }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ml-2 ${keys.length > 0 ? 'keyset-on' : 'keyset-off'}`}
      >
        <Squares2X2Icon className="w-3.5 h-3.5" />
        {keys.length > 0 ? `Key pool (${keys.length})` : 'Add key pool'}
      </button>
    );
  }

  return (
    <div ref={wrapRef} className="mt-2 inline-block align-top rounded-lg p-2.5" style={{ background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)', maxWidth: '22rem' }}>
      <p className="text-[11px] mb-1.5" style={{ color: 'var(--color-text-subtle)' }}>
        Extra keys - lookups rotate across every healthy key, spreading the quota
      </p>
      {keys.map((k, i) => (
        <div key={`${k}-${i}`} className="flex items-center gap-1.5 mb-1">
          <code className="text-xs truncate flex-1" style={{ color: 'var(--color-text-muted)' }}>{'\u2022'.repeat(6)}{k.slice(-4)}</code>
          <button
            type="button"
            onClick={() => commit(keys.filter((_, idx) => idx !== i))}
            disabled={saving}
            title="Remove this key"
            aria-label="Remove this key"
            className="p-1 rounded transition-colors shrink-0"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <XMarkIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5 mt-1.5">
        <input
          type="text"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) { commit([...keys, draft.trim()]); setDraft(''); }
          }}
          placeholder="Paste a key, press Enter"
          autoComplete="off"
          spellCheck={false}
          data-field={field}
          className="input-base px-2 py-1 text-xs w-52"
        />
      </div>
    </div>
  );
}

export function BackupKeyField({
  field, value, primaryFilled, onChange, onSave,
}: {
  field: string;
  value: string;
  primaryFilled: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hasValue = !!value.trim();

  // Collapses when focus or a click goes elsewhere on the page. This is a
  // secondary field most people never touch, so leaving it expanded until
  // manually closed just left clutter behind on a page that already has a
  // lot of it. The input's own onBlur saves first, so collapsing never
  // discards a value that was being typed.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!primaryFilled) return null;

  return (
    <div ref={wrapRef} className="mt-1.5">
      {!open ? (
        // Sized to its content rather than the full panel width - it is a
        // secondary control and should not read as another key field.
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${hasValue ? 'keyset-ok' : 'keyset-off'}`}
        >
          <ShieldCheckIcon className="w-3.5 h-3.5" />
          {hasValue ? 'Backup key set' : 'Add backup key'}
        </button>
      ) : (
        <div className="inline-flex items-center gap-1.5 max-w-full">
          <input
            type="text"
            value={value}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
            onBlur={onSave}
            placeholder="Backup key"
            autoComplete="off"
            spellCheck={false}
            data-field={field}
            className="input-base px-2.5 py-1.5 text-xs w-56 max-w-full"
          />
          {hasValue && (
            <button
              type="button"
              onClick={() => { onChange(''); setTimeout(onSave, 0); }}
              title="Remove backup key"
              aria-label="Remove backup key"
              className="p-1.5 rounded-md transition-colors shrink-0"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <XMarkIcon className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-[11px] shrink-0" style={{ color: 'var(--color-text-subtle)' }}>
            used if the key above fails
          </span>
        </div>
      )}
    </div>
  );
}
