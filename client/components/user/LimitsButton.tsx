'use client';

// "Limits": someone's daily limit, bedtime and age limit in one popup - three
// cards with a switch each. On a person's page beside Caught up to, on each
// card on the Users page (just before Synced), and under each Nuvio profile
// and household user there, where a merged profile has limits of its own
// (server/utils/screenSubjects.js).
//
// On the Users page the pill's colour comes from the page's one overview of
// who has limits (api.getLimitsOverview), so a page of cards asks the server
// once, not once per card; on a person's page it reads its own. Opening it
// reads the rest.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline';
import { ActionPill, type ActionPillTone } from '@/components/user/ActionPill';
import { ScreenTimePanel } from '@/components/user/ScreenTimePanel';
import { AgeLimitCard, ageLimitLabel } from '@/components/user/AgeLimitCard';
import { api, type AgeLimitView, type LimitsSummary, type ScreenTimeView } from '@/lib/api';
import { placePopup, popupStyle, useFitPopup, type PopupPlacement } from '@/lib/anchoredPopup';

export function LimitsButton({ id, name, summary, size = 'sm', onPickGroup, onReconnect }: {
  /** A person's id, or a merged profile's (its limitId). */
  id: string;
  name: string;
  /** From the page's overview; left out, the pill reads its own state. */
  summary?: LimitsSummary | null;
  /** 'sm' beside the small badges on a card or tile, 'md' among a person page's pills. */
  size?: 'sm' | 'md';
  onPickGroup?: () => void;
  onReconnect?: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<PopupPlacement | null>(null);
  // What the popup - or, without an overview, the pill itself - last read.
  const [screen, setScreen] = useState<ScreenTimeView | null>(null);
  const [age, setAge] = useState<AgeLimitView | null>(null);

  useEffect(() => {
    if (summary !== undefined) return;
    api.getScreenTime(id).then(setScreen).catch(() => {});
    api.getAgeLimit(id).then(setAge).catch(() => {});
  }, [id, summary === undefined]);

  const open = !!anchor;
  const close = () => setAnchor(null);
  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return null;
    return placePopup(r, 360, panel.current?.scrollHeight);
  };
  const toggleOpen = () => {
    if (open) { close(); return; }
    const at = place();
    if (at) setAnchor(at);
  };
  useFitPopup(panel, open, () => { const at = place(); if (at) setAnchor(at); });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onMove = () => { const at = place(); if (at) setAnchor(at); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const paused = screen ? screen.paused : summary?.paused || null;
  const limitMinutes = screen?.limit?.minutes || 0;
  const reached = !!limitMinutes && !!screen?.appliesToday && (screen?.todayMinutes ?? 0) >= limitMinutes;
  const on = screen || age ? !!screen?.limit || age?.current != null : !!summary?.on;
  const tone: ActionPillTone = paused || reached ? 'warn' : on ? 'on' : 'neutral';
  const title = paused ? `Paused until ${paused.untilLabel}` : reached ? 'Past today’s limit' : on ? 'Limits are on' : 'No limits';
  const ageLabel = ageLimitLabel(age);

  return (
    // A card or tile underneath may react to clicks, right-clicks and keys of
    // its own; nothing done here - in the pill or its popup, whose backdrop
    // covers the whole page - reaches it. (React passes a portal's events up
    // through the component that rendered it, so a right-click anywhere
    // while the popup was open used to open the card's own menu.)
    <span
      className="inline-flex max-w-full min-w-0"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ActionPill ref={button} icon={AdjustmentsHorizontalIcon} size={size} open={open} onClick={toggleOpen} tone={tone} title={title}>
        Limits
      </ActionPill>
      {open && anchor && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
          <div
            ref={panel}
            role="dialog"
            aria-label={`Limits for ${name}`}
            className="fixed z-[9999] rounded-2xl border border-default shadow-2xl p-4"
            style={{ ...popupStyle(anchor), background: 'var(--color-surface)' }}
          >
            <ScreenTimePanel
              userId={id}
              name={name}
              onPickGroup={onPickGroup}
              onReconnect={onReconnect}
              onClose={close}
              onChange={setScreen}
              alsoOn={ageLabel ? `nothing rated above ${ageLabel}` : null}
              after={<AgeLimitCard userId={id} name={name} onChange={setAge} onClose={close} />}
            />
          </div>
        </>,
        document.body,
      )}
    </span>
  );
}
