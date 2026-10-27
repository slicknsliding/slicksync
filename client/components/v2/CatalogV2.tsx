'use client';

// One catalog's page in the v2 page design: the catalog's own cover as its
// picture, its name with a pill, a line of facts, Suggest titles and Share up
// top (everything else in ⋯), then a toolbar to find, sort and select titles
// over the poster grid (the grid itself stays in the page).

import { useState, type ReactNode } from 'react';
import {
  RectangleStackIcon, PencilSquareIcon, TrashIcon, SparklesIcon, PhotoIcon, ArrowUpTrayIcon,
  ArrowPathIcon, ShareIcon, ShieldExclamationIcon, GlobeAltIcon, FunnelIcon, EyeIcon, EyeSlashIcon,
  MagnifyingGlassIcon, CheckCircleIcon, XCircleIcon, ClipboardDocumentIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { Modal, PosterThumb, SelectAllCheckbox } from '@/components/ui';
import type { CustomList } from '@/lib/api';
import { V2DetailHead, type V2MenuItem } from './V2Detail';
import { V2Button } from './V2Bits';

// A solid-colour cover is drawn by the page (same formula as the Catalogs
// index), so the caller hands in how to paint it.
function Cover({ list, coverStyle }: { list: CustomList; coverStyle: (i: number) => React.CSSProperties }) {
  const box = 'w-[118px] h-16 rounded-lg shrink-0';
  if (list.coverImageUrl) {
    return (
      <div className={`${box} relative overflow-hidden bg-black`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={list.coverImageUrl} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }
  if (list.coverColorIndex !== null && list.coverColorIndex !== undefined) {
    return <div className={box} style={coverStyle(list.coverColorIndex)} />;
  }
  if (list.items.length === 0) {
    return (
      <div className={`${box} bg-surface-hover flex items-center justify-center`}>
        <RectangleStackIcon className="w-6 h-6 text-subtle" />
      </div>
    );
  }
  return (
    <div className={`${box} flex gap-1`}>
      {list.items.slice(0, 4).map((it) => <PosterThumb key={it.id} item={it} className="flex-1 h-full rounded-md" />)}
    </div>
  );
}

type Handlers = {
  onSuggest: () => void;
  onRename: () => void;
  onCoverArt: () => void;
  onContentRating: () => void;
  onSmartRule: () => void;
  onRefresh: () => void;
  onRestoreRemoval: () => void;
  onToggleShared: () => void;
  onDelete: () => void;
  onShareCode: () => void;
  onPublish: () => void;
  onExportMdblist: () => void;
  onExportSimkl: () => void;
};

export function CatalogV2Head({ list, coverStyle, handlers: h }: {
  list: CustomList;
  coverStyle: (i: number) => React.CSSProperties;
  handlers: Handlers;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const n = list.items.length;
  const refreshes = list.smartRuleJson || (list.importSourceUrl && list.autoRefresh)
    ? `refreshes ${list.smartRuleJson ? 'daily' : (list.autoRefreshFrequency || 'daily')}`
    : null;
  const facts = [`${n} title${n === 1 ? '' : 's'}`, refreshes].filter(Boolean).join(' · ');

  const pill = (
    <span className="flex items-center gap-1.5 flex-wrap">
      {!list.isOwner && <span className="v2-chip">Shared with you - read only</span>}
      {list.isOwner && list.shared && <span className="v2-chip">Shared</span>}
      {list.smartRuleJson && <span className="v2-chip">Smart</span>}
    </span>
  );

  const more: V2MenuItem[] = list.isOwner ? [
    { label: 'Rename', icon: <PencilSquareIcon className="w-4 h-4" />, onClick: h.onRename },
    { label: 'Cover art', icon: <PhotoIcon className="w-4 h-4" />, onClick: h.onCoverArt },
    {
      label: list.keptRatings.length > 0 ? `Content rating (${list.keptRatings.length})` : 'Content rating',
      icon: <ShieldExclamationIcon className="w-4 h-4" />, onClick: h.onContentRating,
    },
    { label: list.smartRuleJson ? 'Smart rule on' : 'Smart rule', icon: <FunnelIcon className="w-4 h-4" />, onClick: h.onSmartRule },
    ...(list.importSourceUrl ? [{ label: 'Refresh from source', icon: <ArrowPathIcon className="w-4 h-4" />, onClick: h.onRefresh }] : []),
    ...(list.lastRemovalAt ? [{ label: 'Restore last removal', icon: <ArrowPathIcon className="w-4 h-4" />, onClick: h.onRestoreRemoval }] : []),
    {
      label: list.shared ? 'Stop sharing with other accounts' : 'Show to other accounts (read only)',
      icon: list.shared ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />,
      onClick: h.onToggleShared,
    },
    { label: 'Delete catalog', icon: <TrashIcon className="w-4 h-4" />, onClick: h.onDelete, danger: true },
  ] : [];

  const closeThen = (fn: () => void) => () => { setShareOpen(false); fn(); };
  const empty = n === 0;
  const shareRow = (icon: ReactNode, title: string, line: string, onClick: () => void, disabled = false) => (
    <button
      key={title}
      type="button"
      className="v2-tool disabled:opacity-40 disabled:cursor-not-allowed"
      disabled={disabled}
      title={disabled ? 'Add titles first' : undefined}
      onClick={onClick}
    >
      <span className="v2-tool-icon">{icon}</span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block font-semibold text-[14.5px] text-default">{title}</span>
        <span className="block text-muted text-[12.5px] mt-0.5">{line}</span>
      </span>
    </button>
  );

  return (
    <>
      <V2DetailHead
        lead={<Cover list={list} coverStyle={coverStyle} />}
        title={list.name}
        pill={pill}
        facts={facts}
        actions={list.isOwner ? (
          <>
            <V2Button primary icon={<SparklesIcon className="w-4 h-4" />} onClick={h.onSuggest}>Suggest titles</V2Button>
            <V2Button icon={<ShareIcon className="w-4 h-4" />} onClick={() => setShareOpen(true)}>Share</V2Button>
          </>
        ) : undefined}
        more={more}
      />
      <Modal isOpen={shareOpen} onClose={() => setShareOpen(false)} title="Share this catalog" size="sm">
        <div className="space-y-2.5">
          {shareRow(<ClipboardDocumentIcon className="w-5 h-5" />, 'Share as code', 'A copy-paste code any SlickSync can import', closeThen(h.onShareCode), empty)}
          {shareRow(
            <GlobeAltIcon className="w-5 h-5" />,
            list.federationPublished ? 'Published (manage link)' : 'Publish to other instances',
            list.federationPublished ? 'Other SlickSync instances can subscribe. View or revoke the link.' : 'Let another household subscribe from their own SlickSync',
            closeThen(h.onPublish),
          )}
          {shareRow(<ArrowUpTrayIcon className="w-5 h-5" />, 'Export to MDBList', 'Make a separate MDBList list from these titles', closeThen(h.onExportMdblist), empty)}
          {shareRow(<ArrowUpTrayIcon className="w-5 h-5" />, 'Export to SIMKL', 'Add these titles to someone’s Plan to Watch', closeThen(h.onExportSimkl), empty)}
        </div>
      </Modal>
    </>
  );
}

/** Find a title, sort, and select - one row above the poster grid. */
export function CatalogV2Toolbar({
  isOwner, query, onQuery, sortControl, selectMode, onEnterSelect, onExitSelect,
  totalCount, selectedCount, onSelectAll, onDeselectAll,
}: {
  isOwner: boolean;
  query: string;
  onQuery: (q: string) => void;
  sortControl: ReactNode;
  selectMode: boolean;
  onEnterSelect: () => void;
  onExitSelect: () => void;
  totalCount: number;
  selectedCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 flex-wrap mt-1.5 mb-4">
      <label className="relative w-full sm:w-[280px]">
        <MagnifyingGlassIcon className="w-4 h-4 text-subtle absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Find a title"
          aria-label="Find a title"
          className="w-full pl-9 pr-8 py-2 rounded-xl bg-surface text-default text-sm border border-default focus:border-primary focus:outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-subtle hover:text-default"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        )}
      </label>
      <span className="flex-1 max-sm:hidden" />
      {selectMode && isOwner && (
        <span className="flex items-center gap-2">
          <SelectAllCheckbox totalCount={totalCount} selectedCount={selectedCount} onSelectAll={onSelectAll} onDeselectAll={onDeselectAll} />
          <span className="text-xs text-muted">{selectedCount} of {totalCount} selected</span>
        </span>
      )}
      {sortControl}
      {isOwner && (selectMode ? (
        <button type="button" className="v2-btn" onClick={onExitSelect}>
          <XCircleIcon className="w-4 h-4" />
          Cancel
        </button>
      ) : (
        <button type="button" className="v2-btn" onClick={onEnterSelect}>
          <CheckCircleIcon className="w-4 h-4" />
          Select
        </button>
      ))}
    </div>
  );
}

