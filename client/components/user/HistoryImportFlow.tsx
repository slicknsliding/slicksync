'use client';

// The popup of a watch-history import, shared by a person's own Settings tile
// (HistoryImportTile) and the admin's card on a person's page. Steps: choose
// the files, see what would be added (nothing is written yet), then the
// summary. The caller says how a file is sent (a preview or the real import);
// this holds everything else, so both places look and behave the same.
//
// It owns the hidden file input. With `pickStep` the popup's first step is
// that content (the member's tile opens the popup first). Without it the
// caller opens the picker itself (handle.pick()), and the popup opens by
// itself once files are chosen, anchored to whatever was pressed.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { AnchoredPopup } from '@/components/user/AnchoredPopup';
import type { HistoryImportFileResult } from '@/lib/user-api';

const TILES_SHOWN = 6;

type Step = 'pick' | 'reading' | 'preview' | 'importing' | 'done';

interface Preview {
  files: File[];
  unusable: string[];
  toAdd: number;
  alreadyThere: number;
  skipped: number;
  unresolved: string[];
  truncated: boolean;
  lookupsCapped: boolean;
  titles: { id: string; name: string; watchedAt: string }[];
}

interface Summary {
  imported: number;
  skipped: number;
  filesProcessed: number;
  filesUsed: number;
  truncated: boolean;
  unresolved: string[];
  unusable: string[];
}

const formatDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export interface HistoryImportFlowHandle {
  /** Opens the file chooser. */
  pick: () => void;
}

export const HistoryImportFlow = forwardRef<HistoryImportFlowHandle, {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Sends one file: a preview (nothing written) or the real import. A file with nothing importable should throw an error whose `status` is 400. */
  send: (kind: 'preview' | 'import', file: File) => Promise<HistoryImportFileResult>;
  title: string;
  /** Whose history it is, for the wording of the counts. */
  owner?: 'your' | 'their';
  /** The first step's content, when the popup opens before any file is chosen. */
  pickStep?: React.ReactNode;
  width?: number;
}>(function HistoryImportFlow({ anchorRef, open, onOpen, onClose, send, title, owner = 'your', pickStep, width = 380 }, handle) {
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const [step, setStep] = useState<Step>('pick');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  useImperativeHandle(handle, () => ({ pick: () => fileRef.current?.click() }), []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const close = () => {
    onClose();
    // A finished or abandoned run starts fresh next time; one still running is left to finish.
    if (step !== 'reading' && step !== 'importing') {
      setStep('pick');
      setPreview(null);
      setSummary(null);
    }
  };

  // Without a first step of its own there is nothing to go back to: a failed run just closes.
  const backToStart = () => {
    setStep('pick');
    if (!pickStep) onClose();
  };

  const isUnusable = (e: unknown) => (e as { status?: number } | null)?.status === 400;

  const readFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setStep('reading');
    setPreview(null);
    setSummary(null);
    onOpen();
    const usable: File[] = [];
    const unusable: string[] = [];
    const add = new Set<string>();
    const there = new Set<string>();
    const titles = new Map<string, { id: string; name: string; watchedAt: string }>();
    const unresolved: string[] = [];
    let skipped = 0;
    let truncated = false;
    let lookupsCapped = false;
    try {
      for (const file of files) {
        let r: HistoryImportFileResult;
        try {
          r = await send('preview', file);
        } catch (e) {
          // A file that holds nothing importable is named, not fatal; anything else stops.
          if (isUnusable(e)) { unusable.push(file.name); continue; }
          throw e;
        }
        usable.push(file);
        (r.ids || []).forEach((id) => add.add(id));
        (r.existingIds || []).forEach((id) => there.add(id));
        (r.titles || []).forEach((t) => { if (!titles.has(t.id)) titles.set(t.id, t); });
        unresolved.push(...(r.unresolvedTitles || []));
        skipped += r.skipped;
        truncated = truncated || r.truncated;
        lookupsCapped = lookupsCapped || r.lookupsCapped;
      }
      if (!alive.current) return;
      // A title the first file adds is already there for the next.
      add.forEach((id) => there.delete(id));
      setPreview({
        files: usable,
        unusable,
        toAdd: add.size,
        alreadyThere: there.size,
        skipped,
        unresolved: unresolved.slice(0, 20),
        truncated,
        lookupsCapped,
        titles: [...titles.values()].filter((t) => add.has(t.id)),
      });
      setStep('preview');
    } catch (e) {
      if (!alive.current) return;
      toast.error((e as Error)?.message || 'Could not read those files');
      backToStart();
    }
  };

  const runImport = async () => {
    if (!preview || step !== 'preview') return;
    setStep('importing');
    let imported = 0;
    let skipped = 0;
    let truncated = false;
    const unresolved: string[] = [];
    const unusable = [...preview.unusable];
    let used = 0;
    try {
      for (const file of preview.files) {
        try {
          const r = await send('import', file);
          imported += r.added;
          skipped += r.skipped;
          truncated = truncated || r.truncated;
          unresolved.push(...(r.unresolvedTitles || []));
          used++;
        } catch (e) {
          if (isUnusable(e)) { unusable.push(file.name); continue; }
          throw e;
        }
      }
      if (!alive.current) return;
      setSummary({
        imported,
        skipped,
        filesProcessed: preview.files.length + preview.unusable.length,
        filesUsed: used,
        truncated,
        unresolved: unresolved.slice(0, 20),
        unusable,
      });
      setStep('done');
    } catch (e) {
      if (!alive.current) return;
      toast.error((e as Error)?.message || 'Could not import those files');
      // Whatever landed before the failure is kept; start again from the files.
      setPreview(null);
      backToStart();
    }
  };

  const more = preview ? Math.max(0, preview.toAdd - Math.min(TILES_SHOWN, preview.titles.length)) : 0;

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv,.json,application/json"
        multiple
        className="hidden"
        data-testid="history-import-input"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          void readFiles(files);
        }}
      />

      {open && (
        <AnchoredPopup anchorRef={anchorRef} onClose={close} title={title} width={width}>
          {step === 'pick' && pickStep}

          {(step === 'reading' || step === 'importing') && (
            <p className="text-sm text-muted py-4" role="status">
              {step === 'reading' ? 'Reading your files...' : 'Importing...'}
            </p>
          )}

          {step === 'preview' && preview && (
            <div>
              <div className="flex gap-1.5 flex-wrap mb-3">
                {preview.files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="px-2.5 py-1 rounded-full text-xs" style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-muted)' }}>{f.name}</span>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 mb-3.5">
                {[
                  { n: preview.toAdd, label: 'to add' },
                  { n: preview.alreadyThere, label: `already in ${owner} history` },
                  { n: preview.skipped, label: 'skipped' },
                ].map((c) => (
                  <div key={c.label} className="rounded-lg p-2.5" style={{ background: 'var(--color-surface-hover)' }}>
                    <div className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>{c.n}</div>
                    <div className="text-xs leading-snug text-muted">{c.label}</div>
                  </div>
                ))}
              </div>
              {preview.titles.length > 0 && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {preview.titles.slice(0, TILES_SHOWN).map((t) => (
                      <div key={t.id} className="flex items-center gap-2.5 p-2.5 rounded-lg min-w-0" style={{ background: 'var(--color-surface-hover)' }}>
                        <span className="shrink-0 w-[30px] h-[42px] rounded-md" style={{ background: 'var(--color-primary-muted)' }} aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>{t.name}</span>
                          <span className="block text-xs text-muted">{formatDay(t.watchedAt)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                  {more > 0 && <p className="text-xs text-muted mt-2">And {more} more.</p>}
                </>
              )}
              {preview.toAdd === 0 && (
                <p className="text-sm text-muted">{preview.alreadyThere > 0 ? `Everything in these files is already in ${owner} history.` : 'Nothing in these files can be added.'}</p>
              )}
              {preview.unresolved.length > 0 && (
                <p className="text-muted text-xs mt-2">Couldn&apos;t resolve: {preview.unresolved.join(', ')}</p>
              )}
              {preview.lookupsCapped && (
                <p className="text-muted text-xs mt-2">Some titles had no IMDb ID and were left out to keep within the household&apos;s lookup allowance. Import again afterwards to try the rest.</p>
              )}
              {preview.truncated && <p className="text-muted text-xs mt-2">A file was larger than the 2,000-row import cap.</p>}
              {preview.unusable.length > 0 && (
                <p className="text-muted text-xs mt-2">No importable entries in: {preview.unusable.join(', ')}</p>
              )}
              <div className="flex gap-2 mt-3.5">
                <Button variant="primary" size="sm" onClick={runImport} disabled={preview.toAdd === 0}>
                  {`Import ${preview.toAdd} title${preview.toAdd === 1 ? '' : 's'}`}
                </Button>
                <Button variant="secondary" size="sm" onClick={close}>Cancel</Button>
              </div>
              <p className="text-xs text-subtle mt-2.5">Nothing is added until you press Import. What {owner === 'your' ? 'you' : 'they'} already have stays as it is.</p>
            </div>
          )}

          {step === 'done' && summary && (
            <div>
              <div className="p-3 rounded-lg text-sm" style={{ background: 'var(--color-surface-hover)' }}>
                <p className="text-default">
                  Imported <strong>{summary.imported}</strong> title{summary.imported === 1 ? '' : 's'}
                  {summary.filesProcessed > 1 && ` from ${summary.filesUsed} of ${summary.filesProcessed} files`}
                  {summary.skipped > 0 && ` (${summary.skipped} skipped)`}
                  {summary.truncated && ' - a file was larger than the 2,000-row import cap'}
                </p>
                {summary.unresolved.length > 0 && (
                  <p className="text-muted text-xs mt-1.5">Couldn&apos;t resolve: {summary.unresolved.join(', ')}</p>
                )}
                {summary.unusable.length > 0 && (
                  <p className="text-muted text-xs mt-1.5">No importable entries in: {summary.unusable.join(', ')}</p>
                )}
              </div>
              <div className="mt-3.5">
                <Button variant="secondary" size="sm" onClick={close}>Done</Button>
              </div>
            </div>
          )}
        </AnchoredPopup>
      )}
    </>
  );
});
