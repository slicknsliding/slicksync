'use client';

// The Vault in the v2 page design: whatever needs you (not working, ending
// soon) sits on top; the rest is listed below. Each entry shows one status in
// words and the one button that fits it (Fix, Renew or Test), with Copy
// beside it. Sections move, fold and hide, and single entries hide, through
// Arrange. A note is not a key: its tile has no status and no Test, only its
// hidden text with Copy and Reveal.

import {
  ArrowPathIcon, ArrowPathRoundedSquareIcon, BellSnoozeIcon, ClockIcon, DocumentDuplicateIcon, DocumentTextIcon, EyeIcon, EyeSlashIcon, KeyIcon,
  PencilSquareIcon, PlayIcon, PuzzlePieceIcon, Square2StackIcon, TrashIcon,
} from '@heroicons/react/24/outline';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ArrangeSection } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import type { VaultEntry } from '@/lib/api';
import { V2Button, V2Card, V2CardMenuItem, V2Grid, V2Grip, V2Item, V2List, V2Status } from './V2Bits';
import { UsedByChip } from '@/components/vault/VaultBits';
import { canMarkRenewed, daysUntil, isNote, isSnoozed, judgeEntry, type Judged } from '@/lib/vaultStatus';

// The Dashboard reads an entry the same way.
export { judgeEntry };

export const VAULT_SECTIONS = [
  { key: 's:needs', label: 'Needs you' },
  { key: 's:rest', label: 'Working' },
] as const;

export function VaultV2({ entries, labels, arrange, entryArrange, view, testing, now, revealed, revealStamp, usedBy, onOpen, onCopy, onTest, onReveal, onSnooze, onRotate, onMoveToAddons, onDelete, onHistory, onDuplicate, onRenewed }: {
  entries: VaultEntry[];
  labels: Record<string, string>;
  arrange: PageArrange;
  entryArrange: PageArrange;
  view: 'grid' | 'list';
  testing: string | null;
  now: number;
  onOpen: (e: VaultEntry) => void;
  onCopy: (e: VaultEntry) => void;
  onTest: (e: VaultEntry) => void;
  /** Secrets shown on screen right now, by entry id. */
  revealed: Record<string, string>;
  /** When each revealed secret was shown; restarts its 30-second line. */
  revealStamp?: Record<string, number>;
  onReveal: (e: VaultEntry) => void;
  onSnooze: (e: VaultEntry) => void;
  /** Opens the provider's dashboard and the edit form together. */
  onRotate: (e: VaultEntry) => void;
  /** Asks first (the page's own confirm). */
  onMoveToAddons: (e: VaultEntry) => void;
  /** Two presses in the menu, then Undo. */
  onDelete: (e: VaultEntry) => void;
  /** The key's History, beside this card's menu button. */
  onHistory: (e: VaultEntry) => void;
  /** How many addons carry each key, by entry id. */
  usedBy?: Record<string, number>;
  /** Opens the add form filled in like this one, without the secret. */
  onDuplicate: (e: VaultEntry) => void;
  /** "I renewed it": moves the end date on one billing period. */
  onRenewed: (e: VaultEntry) => void;
}) {
  const hidden = new Set(entryArrange.hidden);
  const judged = entries.map((e) => ({ e, j: judgeEntry(e, now) }));

  const buttons = (e: VaultEntry, j: Judged) => {
    if (arrange.arranging) {
      return (
        <span className="flex items-center gap-1.5">
          <V2Grip label={`Drag ${e.name}`} />
          <button type="button" className="arrange-icon" aria-label={`Hide ${e.name}`} title="Hide on this page"
            onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); entryArrange.hide(e.id); }}>
            <EyeIcon className="w-4 h-4" />
          </button>
        </span>
      );
    }
    // A note has nothing to test: its second button shows or hides it.
    if (isNote(e)) {
      return (
        <span className="flex gap-2">
          <V2Button onClick={() => onCopy(e)} icon={<DocumentDuplicateIcon className="w-4 h-4" />}>Copy</V2Button>
          <V2Button onClick={() => onReveal(e)} icon={revealed[e.id] ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}>{revealed[e.id] ? 'Hide' : 'Reveal'}</V2Button>
        </span>
      );
    }
    const main = j.need === 'fix'
      ? <V2Button primary onClick={() => onOpen(e)}>Fix</V2Button>
      : j.need === 'renew'
        // A date someone typed moves on one period at a press; anything else is renewed in its form.
        ? (canMarkRenewed(e, now)
          ? <V2Button primary onClick={() => onRenewed(e)}>I renewed it</V2Button>
          : <V2Button onClick={() => onOpen(e)}>Renew</V2Button>)
        : (
          <V2Button onClick={() => onTest(e)} disabled={testing === e.id || e.testType === 'manual'} icon={<ArrowPathIcon className={`w-4 h-4${testing === e.id ? ' animate-spin' : ''}`} />}>
            Test
          </V2Button>
        );
    return (
      <span className="flex gap-2">
        <V2Button onClick={() => onCopy(e)} icon={<DocumentDuplicateIcon className="w-4 h-4" />}>Copy</V2Button>
        {main}
      </span>
    );
  };
  const menu = (e: VaultEntry): V2CardMenuItem[] => {
    const days = daysUntil(e.expiresAt, now);
    const snoozed = isSnoozed(e, now);
    const alertWorthy = days !== null && !e.autoRenew && (days < 0 || days <= (e.notifyDaysBefore ?? 7));
    const remove: V2CardMenuItem = { label: 'Delete', icon: <TrashIcon className="w-4 h-4" />, danger: true, sub: { title: isNote(e) ? 'Delete this note?' : 'Delete this key?', items: [{ label: 'Delete?', icon: <TrashIcon className="w-4 h-4" />, danger: true, onClick: () => onDelete(e) }] } };
    const duplicate: V2CardMenuItem = { label: 'Duplicate', icon: <Square2StackIcon className="w-4 h-4" />, onClick: () => onDuplicate(e) };
    if (isNote(e)) {
      return [
        { label: 'Edit', icon: <PencilSquareIcon className="w-4 h-4" />, onClick: () => onOpen(e) },
        duplicate,
        { label: revealed[e.id] ? 'Hide' : 'Reveal', icon: revealed[e.id] ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />, onClick: () => onReveal(e) },
        { label: 'History', icon: <ClockIcon className="w-4 h-4" />, onClick: () => onHistory(e) },
        remove,
      ];
    }
    return [
      { label: 'Run check now', icon: <PlayIcon className="w-4 h-4" />, disabled: e.testType === 'manual', onClick: () => onTest(e) },
      { label: 'Edit', icon: <PencilSquareIcon className="w-4 h-4" />, onClick: () => onOpen(e) },
      duplicate,
      { label: revealed[e.id] ? 'Hide value' : 'Reveal', icon: revealed[e.id] ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />, onClick: () => onReveal(e) },
      { label: 'History', icon: <ClockIcon className="w-4 h-4" />, onClick: () => onHistory(e) },
      { label: 'Snooze 7 days', icon: <BellSnoozeIcon className="w-4 h-4" />, disabled: !alertWorthy || snoozed, onClick: () => onSnooze(e) },
      { label: 'Rotate now', icon: <ArrowPathRoundedSquareIcon className="w-4 h-4" />, disabled: !e.dashboardUrl, onClick: () => onRotate(e) },
      { label: 'Move to Addons', icon: <PuzzlePieceIcon className="w-4 h-4" />, onClick: () => onMoveToAddons(e) },
      // The menu closes on any pick, so the second press lives in a second
      // list: "Delete?" acts at once and the Undo toast follows.
      remove,
    ];
  };
  const secretLine = (e: VaultEntry) => revealed[e.id]
    ? (
      <>
        <div className={isNote(e) ? 'text-[13.5px] text-default mt-1 whitespace-pre-wrap break-words select-all' : 'font-mono text-[13px] text-default mt-1 break-all select-all'}>{revealed[e.id]}</div>
        <div key={revealStamp?.[e.id] ?? 0} className="vault-reveal-line" aria-hidden="true" />
      </>
    )
    : null;
  const icon = (size: number, note = false) => (
    <span className="rounded-[14px] flex items-center justify-center shrink-0 text-muted" style={{ width: size, height: size, background: 'var(--color-surface-elevated, var(--color-surface-hover))' }}>
      {note ? <DocumentTextIcon className="w-1/2 h-1/2" /> : <KeyIcon className="w-1/2 h-1/2" />}
    </span>
  );
  const used = (e: VaultEntry) => ((usedBy?.[e.id] || 0) > 0 ? <div className="mt-2"><UsedByChip entryId={e.id} name={e.name} count={usedBy![e.id]} /></div> : null);
  const kind = (e: VaultEntry) => [labels[e.category] || e.category, e.provider].filter(Boolean).join(' · ');
  const tile = ({ e, j }: { e: VaultEntry; j: Judged }) => (
    <V2Item key={e.id} view="card" href="/vault" sortId={e.id} items={menu(e)} menuLabel={`${e.name} options`} arranging={arrange.arranging} onOpen={() => onOpen(e)}>
      <V2Card footer="Tap to edit" action={buttons(e, j)}>
        <div className="flex items-center gap-3.5 min-w-0">
          {icon(48, isNote(e))}
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-semibold text-default break-words min-w-0">{e.name}</div>
            <div className="text-muted text-[12.5px] truncate">{kind(e)}</div>
          </div>
        </div>
        {isNote(e) ? (
          <div data-vault-note="">
            {revealed[e.id] ? secretLine(e) : <div className="text-muted text-[13px]">Hidden</div>}
          </div>
        ) : (
        <div>
          <V2Status tone={j.tone}>{j.words}</V2Status>
          <div className="text-muted text-[13px] mt-1 truncate">{j.line}</div>
          {secretLine(e)}
          {used(e)}
        </div>
        )}
      </V2Card>
    </V2Item>
  );
  const row = ({ e, j }: { e: VaultEntry; j: Judged }) => (
    <V2Item key={e.id} view="row" href="/vault" sortId={e.id} items={menu(e)} menuLabel={`${e.name} options`} arranging={arrange.arranging} onOpen={() => onOpen(e)}>
      {icon(38, isNote(e))}
      <div className="flex-1 min-w-0">
        <b className="text-default block truncate">{e.name}</b>
        <div className="text-muted text-[12.5px] truncate">{kind(e)}</div>
        {secretLine(e)}
      </div>
      <div className="v2-col w-[150px]">{isNote(e) ? <span className="text-muted text-[13px]">Note</span> : <V2Status tone={j.tone}>{j.words}</V2Status>}</div>
      <div className="v2-col w-[200px] text-muted text-[13px] truncate">{isNote(e) ? (revealed[e.id] ? 'Showing' : 'Hidden') : j.line}</div>
      {buttons(e, j)}
    </V2Item>
  );

  return (
    <div>
      {arrange.shown.map((key) => {
        const all = judged.filter(({ j }) => (key === 's:needs' ? j.need !== null : j.need === null));
        if (all.length === 0) return null;
        const shown = all.filter(({ e }) => !hidden.has(e.id));
        const needs = key === 's:needs';
        const notesOnly = !needs && all.every(({ e }) => isNote(e));
        const name = needs ? 'Needs you' : notesOnly ? 'Notes' : 'Working';
        return (
          <ArrangeSection key={key} arrange={arrange} id={key} noun="section" cards
            label={name}
            title={<span className="flex items-center gap-2.5"><span className="w-3 h-3 rounded shrink-0" style={{ background: needs ? 'var(--color-error, #ef4444)' : notesOnly ? 'var(--color-text-muted)' : 'var(--color-success, #22c55e)' }} />{name}</span>}
            meta={`${all.length}`}>
            {shown.length === 0
              ? <p className="text-sm text-muted py-2">Every entry here is hidden on this page.</p>
              : (
                <SortableContext items={shown.map(({ e }) => e.id)} strategy={view === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}>
                  {view === 'grid' ? <V2Grid stretch={{ arrange: arrange, id: key }}>{shown.map(tile)}</V2Grid> : <V2List>{shown.map(row)}</V2List>}
                </SortableContext>
              )}
          </ArrangeSection>
        );
      })}
    </div>
  );
}
