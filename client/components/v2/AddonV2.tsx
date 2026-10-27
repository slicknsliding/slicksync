'use client';

// The v2 page for one addon (Themes → Page design → v2). The page keeps its
// data and handlers; these are the pieces it draws differently: who has the
// addon, what it gives, how it has been answering, and its address and proxy.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { DndContext, closestCenter, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowPathIcon, Bars3Icon, CheckIcon, DocumentDuplicateIcon, MagnifyingGlassIcon, PlusIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { avatarColorFill } from '@/components/ui/Avatar';
import { ToggleSwitch } from '@/components/ui';
import { DragOverlay } from '@/components/ui/DragSortable';
import { V2Box } from '@/components/v2/V2Detail';
import { V2Button } from '@/components/v2/V2Bits';

type Sensors = React.ComponentProps<typeof DndContext>['sensors'];

/** What the addon is mostly for, in one word, from the things it gives. */
export function addonKind(resources: string[]): string {
  const has = (r: string) => resources.includes(r);
  if (has('stream')) return 'Streams';
  if (has('subtitles')) return 'Subtitles';
  if (has('catalog') || has('addon_catalog')) return 'Catalogs';
  if (has('meta')) return 'Details';
  return 'Addon';
}

const chipClass = 'inline-flex items-center gap-1.5 rounded-full border border-default bg-surface px-3 py-1.5 text-[13.5px]';

// ---------------------------------------------------------------- Given to

export type V2AddonGroup = { id: string; name: string; users?: number; colorIndex?: number; color?: string };

export function GivenToV2({ groups, onAdd, onRemove, onSync }: {
  groups: V2AddonGroup[];
  onAdd: () => void;
  onRemove: (g: V2AddonGroup) => void;
  onSync: (g: V2AddonGroup) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {groups.map((g) => (
        <span key={g.id} className={`${chipClass} pr-1.5`}>
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color || avatarColorFill(g.colorIndex ?? 0) }} />
          <Link href={`/groups/${g.id}`} className="font-medium text-default hover:underline">{g.name}</Link>
          <span className="text-muted text-[12.5px]">· {g.users || 0} {g.users === 1 ? 'person' : 'people'}</span>
          <button type="button" className="p-1 rounded-full text-muted hover:text-default hover:bg-surface-hover" title={`Sync ${g.name}`} aria-label={`Sync ${g.name}`} onClick={() => onSync(g)}>
            <ArrowPathIcon className="w-3.5 h-3.5" />
          </button>
          <button type="button" className="p-1 rounded-full text-muted hover:text-error hover:bg-surface-hover" title={`Take it off ${g.name}`} aria-label={`Remove from ${g.name}`} onClick={() => onRemove(g)}>
            <XMarkIcon className="w-3.5 h-3.5" />
          </button>
        </span>
      ))}
      <button type="button" className={`${chipClass} border-dashed text-muted hover:text-default hover:bg-surface-hover`} onClick={onAdd}>
        <PlusIcon className="w-4 h-4" />
        Add to a group
      </button>
    </div>
  );
}

// ------------------------------------------------------------- What it gives

export function ResourcesV2({ names, selected, onToggle, onReset, saving }: {
  names: string[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  onReset: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {names.length === 0 && <span className="text-muted text-sm">Nothing listed yet.</span>}
      {names.map((name) => {
        const on = selected.has(name);
        return (
          <button
            key={name}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(name)}
            className={`${chipClass} ${on ? 'text-default' : 'text-subtle'} hover:bg-surface-hover`}
          >
            {on ? <CheckIcon className="w-3.5 h-3.5" style={{ color: 'var(--color-primary)' }} /> : <span className="w-3.5 h-3.5 rounded-full border border-default" />}
            {name}
          </button>
        );
      })}
      <span className="flex-1" />
      {saving && <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin text-muted" />}
      <V2Button onClick={onReset}>Reset</V2Button>
    </div>
  );
}

function CatalogRow({ catalog, id, isSelected, onToggle }: { catalog: { id?: string; name?: string; type?: string }; id: string; isSelected: boolean; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition: isDragging ? 'none' : transition, opacity: isDragging ? 0 : 1 }}
      className="flex items-center gap-2.5 py-2 border-t border-default first:border-t-0"
    >
      <button type="button" {...attributes} {...listeners} className="p-1 rounded cursor-grab active:cursor-grabbing text-subtle" style={{ touchAction: 'none' }} aria-label="Drag to reorder">
        <Bars3Icon className="w-5 h-5" />
      </button>
      <button type="button" className="flex-1 min-w-0 flex items-center gap-2 text-left" onClick={onToggle} aria-pressed={isSelected}>
        <span className={`truncate font-medium ${isSelected ? 'text-default' : 'text-subtle'}`}>{catalog.name || catalog.id}</span>
        <span className="v2-chip text-muted">{catalog.type}</span>
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-label={isSelected ? 'Leave this catalog out' : 'Include this catalog'}
        className="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0"
        style={isSelected ? { background: 'var(--color-primary)', borderColor: 'var(--color-primary)' } : { borderColor: 'var(--color-surface-border)' }}
      >
        {isSelected && <CheckIcon className="w-3 h-3 text-white" />}
      </button>
    </div>
  );
}

type Catalog = { id?: string; name?: string; type?: string };

export function CatalogsV2({
  regular, search, selected, keyOf, sensors, saving, activeId,
  onToggle, onToggleAll, onReset, onDragStart, onDragEnd,
}: {
  regular: Catalog[];
  search: Catalog[];
  selected: Set<string>;
  keyOf: (c: Catalog) => string;
  sensors: Sensors;
  saving: boolean;
  activeId: string | null;
  onToggle: (key: string) => void;
  onToggleAll: (which: 'regular' | 'search') => void;
  onReset: () => void;
  onDragStart: (e: DragStartEvent) => void;
  onDragEnd: (e: DragEndEvent) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (c: Catalog) => !q || `${c.name || ''} ${c.id || ''} ${c.type || ''}`.toLowerCase().includes(q);
  const shownRegular = regular.filter(match);
  const shownSearch = search.filter(match);
  const allRegular = regular.length > 0 && regular.every((c) => selected.has(keyOf(c)));
  const allSearch = search.length > 0 && search.every((c) => selected.has(keyOf(c)));

  const group = (label: string, all: boolean, which: 'regular' | 'search', shown: Catalog[]) => (
    <div className="min-w-0">
      <div className="flex items-center gap-2 py-1.5">
        <span className="text-[12.5px] font-semibold text-muted flex-1">{label}</span>
        <button type="button" className="text-[12.5px] font-medium text-primary hover:underline" onClick={() => onToggleAll(which)}>
          {all ? 'Leave all out' : 'Include all'}
        </button>
      </div>
      {shown.length === 0 && <p className="text-muted text-sm py-2">No catalogs match.</p>}
      <SortableContext items={shown.map(keyOf)} strategy={verticalListSortingStrategy}>
        {shown.map((c) => (
          <CatalogRow key={keyOf(c)} id={keyOf(c)} catalog={c} isSelected={selected.has(keyOf(c))} onToggle={() => onToggle(keyOf(c))} />
        ))}
      </SortableContext>
    </div>
  );

  const active = activeId ? [...regular, ...search].find((c) => keyOf(c) === activeId) : null;
  return (
    <V2Box className="mt-3">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <label className="flex items-center gap-2 flex-1 min-w-[200px] rounded-xl border border-default bg-surface-hover px-3 py-1.5">
          <MagnifyingGlassIcon className="w-4 h-4 text-muted shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a catalog"
            aria-label="Find a catalog"
            className="flex-1 min-w-0 bg-transparent text-sm text-default"
            style={{ border: 'none', outline: 'none', boxShadow: 'none' }}
          />
        </label>
        {saving && <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin text-muted" />}
        <V2Button onClick={onReset}>Reset</V2Button>
      </div>
      <div className="text-muted text-[12.5px] pb-1">Drag to reorder; untick to leave a catalog out.</div>
      {regular.length === 0 && search.length === 0 ? (
        <p className="text-muted text-sm py-2">No catalogs available</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3" style={{ userSelect: 'none' }}>
            {regular.length > 0 && group('Catalogs', allRegular, 'regular', shownRegular)}
            {search.length > 0 && group('Search catalogs', allSearch, 'search', shownSearch)}
          </div>
          <DragOverlay>
            {active ? (
              <div className="rounded-xl border border-default bg-surface px-3 py-2 shadow-lg flex items-center gap-2.5">
                <Bars3Icon className="w-5 h-5 text-subtle" />
                <span className="font-medium text-default truncate">{active.name || active.id}</span>
                <span className="v2-chip text-muted">{active.type}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </V2Box>
  );
}

// -------------------------------------------------------------------- Health

export type V2HealthCheck = { id: string; isOnline: boolean; error: string | null; checkedAt: string; responseTimeMs: number | null };

/** How the last run of checks reads, in words. */
export function healthSummary(history: V2HealthCheck[]): string {
  if (history.length === 0) return 'no checks yet';
  const newestFirst = [...history].sort((a, b) => +new Date(b.checkedAt) - +new Date(a.checkedAt));
  const state = newestFirst[0].isOnline;
  let run = 0;
  for (const h of newestFirst) { if (h.isOnline === state) run++; else break; }
  const n = `${run} check${run === 1 ? '' : 's'}`;
  return state ? `online for ${n} in a row` : `not answering for ${n} in a row`;
}

export function HealthStripV2({ history, loading, error, aiSummary, isChecking, onCheck }: {
  history: V2HealthCheck[];
  loading: boolean;
  error: string | null;
  aiSummary: string | null;
  isChecking: boolean;
  onCheck: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const oldestFirst = [...history].sort((a, b) => +new Date(a.checkedAt) - +new Date(b.checkedAt));
  const misses = history.filter((h) => !h.isOnline);
  const lastMiss = misses.length ? [...misses].sort((a, b) => +new Date(b.checkedAt) - +new Date(a.checkedAt))[0] : null;
  return (
    <div>
      {loading ? (
        <div className="flex gap-0.5 animate-pulse">{Array.from({ length: 30 }).map((_, i) => <span key={i} className="flex-1 h-[26px] rounded-[3px] bg-surface-hover" />)}</div>
      ) : error || oldestFirst.length === 0 ? (
        <p className="text-sm text-subtle">{error ? error : 'No health checks recorded yet. Choose Check now to run one.'}</p>
      ) : (
        <>
          <div className="flex gap-0.5" role="img" aria-label={`Last ${oldestFirst.length} checks, ${healthSummary(history)}`}>
            {oldestFirst.map((h) => (
              <span
                key={h.id}
                className="flex-1 h-[26px] rounded-[3px] min-w-[3px]"
                style={{ background: h.isOnline ? 'var(--color-success, #22c55e)' : 'var(--color-error, #ef4444)' }}
                title={`${new Date(h.checkedAt).toLocaleString()} · ${h.isOnline ? 'Online' : `Not answering${h.error ? `: ${h.error}` : ''}`}`}
              />
            ))}
          </div>
          <div className="text-muted text-[12.5px] mt-2">
            Last {oldestFirst.length} checks{lastMiss ? ` · last miss ${new Date(lastMiss.checkedAt).toLocaleString()}` : ' · no misses'}
          </div>
        </>
      )}
      {aiSummary && <p className="mt-3 text-sm text-default rounded-xl px-3 py-2.5 bg-surface-hover">{aiSummary}</p>}
      <div className="flex flex-wrap gap-2.5 mt-3.5">
        <V2Button onClick={onCheck} disabled={isChecking} icon={<ArrowPathIcon className={`w-4 h-4 ${isChecking ? 'animate-spin' : ''}`} />}>
          {isChecking ? 'Checking...' : 'Check now'}
        </V2Button>
        {oldestFirst.length > 0 && <V2Button onClick={() => setShowAll((v) => !v)}>{showAll ? 'Hide the list' : 'Show every check'}</V2Button>}
      </div>
      {showAll && (
        <div className="mt-3 max-h-[340px] overflow-y-auto rounded-xl border border-default divide-y divide-[var(--color-surface-border)]">
          {[...oldestFirst].reverse().map((h) => (
            <div key={h.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: h.isOnline ? 'var(--color-success, #22c55e)' : 'var(--color-error, #ef4444)' }} />
              <span className={h.isOnline ? 'text-default' : 'text-error'}>{h.isOnline ? 'Online' : 'Not answering'}</span>
              <span className="text-muted text-[12.5px] truncate flex-1">{new Date(h.checkedAt).toLocaleString()}{!h.isOnline && h.error ? ` · ${h.error}` : ''}</span>
              {h.responseTimeMs != null && <span className="text-muted text-[12.5px]">{h.responseTimeMs} ms</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type V2BackupLink = { id: string; name: string; isOnline?: boolean; version?: string };

export function BackupChainV2({ chain, activeId, message, busy, onAdd, onRemove }: {
  chain: V2BackupLink[];
  activeId?: string;
  message?: string;
  busy: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  return (
    <div>
      <div className="text-[12.5px] font-semibold text-muted mb-2">Backup</div>
      {chain.length === 0 ? (
        <p className="text-muted text-sm mb-3">No backup yet. Add one to take over when this addon is not answering.</p>
      ) : (
        <div className="flex flex-col gap-2 mb-3">
          {chain.map((b, i) => (
            <div key={b.id} className="flex items-center gap-2.5 rounded-xl border border-default bg-surface-hover px-3 py-2">
              <span className="text-muted text-[12.5px] shrink-0">Backup {i + 1}</span>
              <Link href={`/addons/${b.id}`} className="font-medium text-default hover:underline truncate">{b.name || 'Unnamed addon'}</Link>
              {b.version && <span className="v2-chip text-muted">v{b.version}</span>}
              <span className="text-muted text-[12.5px] ml-auto shrink-0">{activeId === b.id ? 'In use now' : b.isOnline ? 'Online' : 'Not answering'}</span>
            </div>
          ))}
          {message && <p className="text-muted text-[12.5px]">{message}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-2.5">
        <V2Button onClick={onAdd} disabled={busy} icon={<PlusIcon className="w-4 h-4" />}>{chain.length === 0 ? 'Add a backup addon' : 'Add another backup'}</V2Button>
        {chain.length > 0 && <V2Button onClick={onRemove} disabled={busy}>Remove the backups</V2Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------- Address and proxy

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

export function ManifestV2({ lines, json, open, onToggle }: { lines: DiffLine[] | null; json: string; open: boolean; onToggle: () => void }) {
  const hasDiff = !!lines && lines.some((l) => l.type !== 'same');
  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap">
        <b className="text-[14.5px]">Manifest</b>
        <span className="text-muted text-[12.5px] flex-1">{lines ? (hasDiff ? 'What you changed from the original' : 'Same as the original') : 'The addon’s own description of itself'}</span>
        <V2Button onClick={onToggle}>{open ? 'Hide' : lines ? 'Show changes' : 'Show manifest'}</V2Button>
      </div>
      {open && (
        <div className="mt-3">
          {lines ? (
            <>
              {!hasDiff && <p className="text-xs text-subtle italic mb-2">No differences — manifests are identical.</p>}
              <pre className="p-4 rounded-xl bg-surface border border-default text-xs font-mono overflow-auto max-h-[32rem] leading-5">
                {lines.map((line, i) => (
                  <span key={i} className={`block ${line.type === 'del' ? 'bg-red-500/10 text-red-400' : line.type === 'add' ? 'bg-green-500/10 text-green-400' : 'text-subtle'}`}>
                    {line.type === 'del' ? '- ' : line.type === 'add' ? '+ ' : '  '}
                    {line.text}
                  </span>
                ))}
              </pre>
            </>
          ) : (
            <pre className="p-4 rounded-xl bg-surface border border-default text-xs text-subtle font-mono overflow-auto max-h-[32rem] whitespace-pre-wrap break-all">{json}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ProxyV2({ enabled, onToggle, toggling, url, onCopy, uuid, onRegenerate, regenerating, vaultified, onVault, vaulting }: {
  enabled: boolean;
  onToggle: () => void;
  toggling: boolean;
  url: string | null;
  onCopy: () => void;
  uuid?: string | null;
  onRegenerate: () => void;
  regenerating: boolean;
  vaultified: boolean;
  onVault: () => void;
  vaulting: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px]">
          <b className="text-[14.5px]">Proxy</b>
          <div className="text-muted text-[12.5px]">Hide the original addon address behind one of ours.</div>
        </div>
        <span className="text-sm text-muted">{enabled ? 'On' : 'Off'}</span>
        <ToggleSwitch checked={enabled} onChange={onToggle} disabled={toggling} />
      </div>

      <div className="flex items-center gap-3 flex-wrap mt-3 rounded-xl bg-surface-hover px-3.5 py-3">
        <div className="flex-1 min-w-[220px]">
          <div className="text-sm font-medium text-default">Keys stay in the Vault</div>
          <div className="text-xs text-muted mt-0.5">
            {vaultified
              ? 'The stored address holds a placeholder, not the key. Changing the Vault entry needs no rewrite and no re-sync - the proxy uses the current secret on every request.'
              : 'Replace the key inside the addon address with a Vault reference. The real key then never appears in the stored address, synced manifests, or on any device.'}
          </div>
        </div>
        <V2Button onClick={onVault} disabled={vaulting}>{vaulting ? 'Working...' : vaultified ? 'Restore plain URL' : 'Vault-inject'}</V2Button>
      </div>

      {enabled && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="rounded-xl border border-default bg-surface px-3.5 py-3">
            <div className="text-sm font-medium text-default mb-2">Proxy address</div>
            {url ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 p-2 bg-surface-hover rounded-lg text-xs text-subtle break-all font-mono">{url}</code>
                <button type="button" className="v2-btn" style={{ padding: '7px 10px' }} onClick={onCopy} aria-label="Copy the proxy address" title="Copy">
                  <DocumentDuplicateIcon className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <p className="text-sm text-subtle">The proxy address appears once it is on.</p>
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap rounded-xl bg-surface-hover px-3.5 py-2.5">
            <span className="text-xs text-muted">UUID</span>
            <code className="text-xs text-subtle font-mono flex-1 min-w-0 break-all">{uuid || 'Not generated'}</code>
            <V2Button onClick={onRegenerate} disabled={regenerating} icon={<ArrowPathIcon className={`w-4 h-4 ${regenerating ? 'animate-spin' : ''}`} />}>Regenerate</V2Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A labelled block inside a section's box. */
export function AddonBlock({ children }: { children: ReactNode }) {
  return <div className="py-4 first:pt-0 last:pb-0 border-t border-default first:border-t-0">{children}</div>;
}
