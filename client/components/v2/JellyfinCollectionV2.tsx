'use client';

// One Jellyfin collection in the v2 page design: its posters as its picture,
// Saved as its status (it saves as you go), Add titles as the one button, a
// search to add titles, the poster grid, and the catalogs it is built from as
// chips. Rename, the cover address and Remove sit in ⋯. The page owns the
// data, handlers and modals; this lays them out.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PencilSquareIcon, PhotoIcon, PlusIcon, Squares2X2Icon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { ArrangeBar, ArrangeButton, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import { usePageArrangement } from '@/lib/arrange';
import { V2Button, V2Status } from './V2Bits';
import { V2DetailHead, type V2MenuItem } from './V2Detail';

/** The collection's picture: its first posters side by side, or its one cover. */
export function JfCollectionCover({ posters, cover }: { posters: string[]; cover?: string | null }) {
  const box = 'w-[118px] h-16 rounded-lg shrink-0 overflow-hidden';
  if (cover) {
    return (
      <div className={`${box} bg-[var(--color-surface-hover)]`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={cover} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }
  if (posters.length === 0) {
    return <div className={`${box} bg-[var(--color-surface-hover)] flex items-center justify-center`}><Squares2X2Icon className="w-6 h-6 text-subtle" /></div>;
  }
  return (
    <div className={`${box} flex gap-1`}>
      {posters.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={`${src}-${i}`} src={src} alt="" className="flex-1 min-w-0 h-full object-cover rounded-md" />
      ))}
    </div>
  );
}

/** The catalogs a collection is built from, as chips (tap the cross to take one out), and a chip to add another. */
export function JfCatalogChips({ chosen, options, onRemove, onAdd, note }: {
  chosen: { id: string; name: string }[];
  options: { id: string; name: string; titles: number }[];
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
  note?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div>
      <div className="flex gap-2 flex-wrap items-center">
        {chosen.length === 0 && <span className="text-muted text-[13px]">No catalogs yet.</span>}
        {chosen.map((c) => (
          <span key={c.id} className="v2-chip" style={{ gap: 6, padding: '4px 6px 4px 11px', fontSize: 13 }}>
            {c.name}
            <button type="button" className="arrange-icon" style={{ width: 20, height: 20 }} aria-label={`Take ${c.name} out`} title="Take this catalog out" onClick={() => onRemove(c.id)}>
              <XMarkIcon className="w-3.5 h-3.5" />
            </button>
          </span>
        ))}
        <div ref={ref} className="relative">
          <button type="button" className="v2-chip" style={{ borderStyle: 'dashed', cursor: 'pointer', fontSize: 13, padding: '4px 11px' }} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            + Add a catalog
          </button>
          {open && (
            <div role="menu" className="arrange-menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 'auto', zIndex: 40, width: 260, maxWidth: '80vw', maxHeight: '50vh', overflowY: 'auto' }}>
              {options.length === 0 ? (
                <div className="px-3 py-2 text-[13px] text-muted">Every catalog is in already.</div>
              ) : options.map((o) => (
                <button key={o.id} type="button" role="menuitem" className="arrange-menu-item" onClick={() => { setOpen(false); onAdd(o.id); }}>
                  <span className="truncate flex-1 text-left">{o.name}</span>
                  <span className="text-muted text-[12px]">{o.titles}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {note && <div className="text-muted text-[12.5px] mt-2.5">{note}</div>}
    </div>
  );
}

export function JfCollectionV2({
  isNew, ready, title, count, cover, creating, onCreate, onAddTitles, onRemove,
  search, titlesBody, titlesNote, catalogs, details,
}: {
  isNew: boolean;
  ready: boolean;
  title: string;
  count: number;
  cover: ReactNode;
  creating: boolean;
  onCreate: () => void;
  onAddTitles: () => void;
  onRemove: () => void;
  /** The search box and its results. */
  search: ReactNode;
  titlesBody: ReactNode;
  titlesNote?: string;
  catalogs: ReactNode;
  /** Name and cover address. */
  details: ReactNode;
}) {
  const arrange = usePageArrangement('jellyfin-collection', ['titles', 'catalogs', 'details'], { defaultFolded: ['details'] });

  const focusField = (id: string) => {
    arrange.fold('details', false);
    setTimeout(() => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      el?.scrollIntoView({ block: 'center' });
      el?.focus();
    }, 60);
  };

  const more: V2MenuItem[] = isNew ? [] : [
    { label: 'Rename', icon: <PencilSquareIcon className="w-4 h-4" />, onClick: () => focusField('aio-col-name') },
    { label: 'Cover image address', icon: <PhotoIcon className="w-4 h-4" />, onClick: () => focusField('aio-col-cover') },
    { label: 'Remove collection', icon: <TrashIcon className="w-4 h-4" />, danger: true, disabled: !ready, onClick: onRemove },
  ];

  const head = (
    <V2DetailHead
      lead={cover}
      title={title}
      status={isNew ? undefined : <V2Status tone="ok">Saved</V2Status>}
      facts={isNew ? 'a collection in AIOStreams’ apps' : `${count} title${count === 1 ? '' : 's'} · changes save as you go`}
      actions={isNew ? (
        <V2Button primary onClick={onCreate} disabled={creating}>{creating ? 'Creating' : 'Create'}</V2Button>
      ) : (
        <>
          <ArrangeButton arrange={arrange} />
          <V2Button primary icon={<PlusIcon className="w-4 h-4" />} onClick={onAddTitles} disabled={!ready}>Add titles</V2Button>
        </>
      )}
      more={more}
    />
  );

  if (isNew) {
    return (
      <>
        {head}
        <div className="v2-box v2-box-pad">{details}</div>
        <p className="text-sm text-muted text-center mt-4">Name it and press Create &ndash; then search for titles to put in it.</p>
      </>
    );
  }

  const sections: Record<string, ReactNode> = {
    titles: (
      <ArrangeSection key="titles" arrange={arrange} id="titles" title="In this collection" meta={titlesNote} noun="section">
        {titlesBody}
      </ArrangeSection>
    ),
    catalogs: (
      <ArrangeSection key="catalogs" arrange={arrange} id="catalogs" title="Built from catalogs" noun="section">
        {catalogs}
      </ArrangeSection>
    ),
    details: (
      <ArrangeSection key="details" arrange={arrange} id="details" title="Name and cover" noun="section">
        <div className="v2-box v2-box-pad">{details}</div>
      </ArrangeSection>
    ),
  };

  return (
    <>
      {head}
      <ArrangeBar arrange={arrange} />
      {search}
      <div className="space-y-6">{arrange.shown.map((k) => sections[k] ?? null)}</div>
      <div className="mt-4">
        <HiddenTray arrange={arrange} labelOf={(id) => (id === 'titles' ? 'In this collection' : id === 'catalogs' ? 'Built from catalogs' : 'Name and cover')} />
      </div>
    </>
  );
}
