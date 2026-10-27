'use client';

// "Import your watch history", under "Your Data" in a person's Settings. The
// whole tile opens a popup beside it, in three steps: choose the files, see
// what would be added (nothing is written yet), then the summary. It is the
// admin's import on their own page, for their own history only; it fills
// SlickSync's history and writes nothing back into Stremio, Nuvio, Jellyfin
// or AIOStreams, so it is the same for every sign-in.

import { useRef, useState } from 'react';
import { ArrowUpTrayIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { HistoryImportFlow, type HistoryImportFlowHandle } from '@/components/user/HistoryImportFlow';
import { userHistoryImport } from '@/lib/user-api';

export function HistoryImportTile({ userId, authKey }: { userId: string; authKey: string }) {
  const tileRef = useRef<HTMLButtonElement>(null);
  const flowRef = useRef<HistoryImportFlowHandle>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={tileRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`w-full flex items-center gap-3.5 p-4 rounded-lg mt-3 text-left transition-colors hover:bg-surface-hover ${open ? 'ring-1 ring-[var(--color-primary)]' : ''}`}
        style={{ background: 'var(--color-surface-elevated)' }}
      >
        <span className="w-9 h-9 shrink-0 rounded-[10px] flex items-center justify-center" style={{ background: 'var(--color-primary-muted)', color: 'var(--color-primary)' }}>
          <ArrowUpTrayIcon className="w-5 h-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium" style={{ color: 'var(--color-text)' }}>Import your watch history</span>
          <span className="block text-sm mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Bring in an IMDb, Letterboxd, Trakt or Netflix export. You see what will be added first.
          </span>
        </span>
        <ChevronRightIcon className="w-[18px] h-[18px] shrink-0 text-muted" />
      </button>

      <HistoryImportFlow
        ref={flowRef}
        anchorRef={tileRef}
        open={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        send={(kind, file) => userHistoryImport.send(kind, userId, authKey, file)}
        title="Import your watch history"
        pickStep={(
          <div>
            <p className="text-sm text-muted">
              Bring in an export from another service &mdash; get yours from{' '}
              <a href="https://www.imdb.com/exports/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">IMDb</a>,{' '}
              <a href="https://letterboxd.com/settings/data/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Letterboxd</a>, or{' '}
              <a href="https://trakt.tv/settings/data" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Trakt</a>.
            </p>
            <p className="text-sm text-muted mt-2">
              IMDb and Letterboxd give you a CSV you can import directly. Trakt gives you a ZIP &mdash; unzip it and select every file inside at once; only the history and ratings JSON actually carry anything importable, everything else is skipped automatically. Netflix (Account &rarr; Viewing activity &rarr; Download all), TV Time, Plex/Tautulli and Movary CSV exports work through the same button too. Movies and their ratings are imported; episode history is skipped.
            </p>
            <div className="mt-3">
              <Button variant="secondary" size="sm" leftIcon={<ArrowUpTrayIcon className="w-4 h-4" />} onClick={() => flowRef.current?.pick()}>
                Import history
              </Button>
            </div>
            <p className="text-xs text-subtle mt-3">Nothing is added until you have seen what is in your files.</p>
          </div>
        )}
      />
    </>
  );
}
