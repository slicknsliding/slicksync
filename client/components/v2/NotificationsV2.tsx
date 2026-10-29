'use client';

// The v2 look of the notifications bell panel (NotificationsDropdown draws
// this when Page design is v2): Today and Earlier, an icon for the kind of
// thing in a tinted circle, a dot for unread, the button that deals with it
// where there is one, and links to the notification settings and Activity in
// the foot. What is listed, what a tap opens, Mark all read, Clear and
// dismissing one are the dropdown's own.

import type { MouseEvent, ReactNode } from 'react';
import { BellIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { SwipeToDismiss } from '@/components/ui/SwipeToDismiss';

export type BellItem = {
  id: string;
  type: string;
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
  poster?: string;
  data?: { id?: string } | null;
};

// One tint per kind, so a glance says what sort of thing it is.
const TINT: Record<string, string> = {
  activity: '#60a5fa',
  invite: '#a78bfa',
  task: '#22c55e',
  user: '#60a5fa',
  request: '#a78bfa',
  episode: '#22c55e',
  addon: '#f59e0b',
  sync: '#60a5fa',
  vault: '#f59e0b',
  mismatch: '#f59e0b',
  update: '#22c55e',
  announcement: '#a78bfa',
  device: '#60a5fa',
};

export function NotificationsPanelV2({
  items, icon, when, canOpen, swipe, onOpen, onDismiss, onAccept, onReject, onMarkAll, onClear, onSettings, onActivity,
}: {
  items: BellItem[];
  icon: (type: string) => ReactNode;
  when: (d: Date) => string;
  canOpen: (n: BellItem) => boolean;
  swipe: boolean;
  onOpen: (n: BellItem) => void;
  onDismiss: (id: string) => void;
  onAccept: (e: MouseEvent, reqId: string) => void;
  onReject: (e: MouseEvent, reqId: string) => void;
  onMarkAll: () => void;
  onClear: () => void;
  onSettings: () => void;
  onActivity: () => void;
}) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = items.filter((n) => n.timestamp.getTime() >= startOfToday.getTime());
  const earlier = items.filter((n) => n.timestamp.getTime() < startOfToday.getTime());

  const label = (t: string) => (
    <p className="text-[11.5px] font-semibold uppercase tracking-wider text-muted px-4 pt-2.5 pb-1.5">{t}</p>
  );

  const row = (n: BellItem) => {
    const tint = TINT[n.type] || '#60a5fa';
    const isRequest = n.type === 'request' && n.data;
    return (
      <SwipeToDismiss key={n.id} enabled={swipe && n.type !== 'request'} onDismiss={() => onDismiss(n.id)}>
        <div
          onClick={() => onOpen(n)}
          className={`flex items-start gap-3 px-4 py-3 border-t transition-colors duration-500 ${canOpen(n) ? 'cursor-pointer' : ''} ${n.read ? 'notif-read' : 'notif-lit'}`}
          style={{ borderColor: 'var(--color-surface-border)' }}
        >
          {n.poster ? (
            <div className="w-9 h-[52px] rounded-lg overflow-hidden shrink-0 border border-default">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={n.poster}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { (e.currentTarget.parentElement as HTMLElement | null)?.remove(); }}
              />
            </div>
          ) : (
            <span
              className="shrink-0 flex items-center justify-center rounded-full"
              style={{ width: 34, height: 34, color: tint, background: `color-mix(in srgb, ${tint} 16%, transparent)` }}
              aria-hidden="true"
            >
              {icon(n.type)}
            </span>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2">
              <p className="text-sm font-semibold flex-1 min-w-0 line-clamp-3 break-words">{n.title}</p>
              {!n.read && <span className="w-2 h-2 rounded-full shrink-0 mt-1.5" style={{ background: 'var(--color-primary)' }} aria-label="Unread" />}
            </div>
            <p className="text-[12.5px] text-muted mt-0.5 line-clamp-2 break-words">{n.message} · {when(n.timestamp)}</p>
            {isRequest && (
              <div className="flex gap-1.5 mt-2.5">
                <button type="button" className="v2-btn v2-btn-main" onClick={(e) => onAccept(e, n.data!.id as string)}>Accept</button>
                <button type="button" className="v2-btn" onClick={(e) => onReject(e, n.data!.id as string)}>Reject</button>
              </div>
            )}
          </div>
          {n.type !== 'request' && !swipe && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDismiss(n.id); }}
              className="p-1 rounded-md shrink-0 text-subtle hover:text-default hover:bg-surface transition-colors"
              aria-label="Dismiss notification"
              title="Dismiss"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      </SwipeToDismiss>
    );
  };

  return (
    <div className="popup-panel max-h-[min(560px,80dvh)] flex flex-col overflow-hidden rounded-[22px] max-sm:rounded-b-none!">
      <div className="flex items-center gap-3 px-4 py-3.5 shrink-0">
        <h3 className="text-base font-bold flex-1">Notifications</h3>
        {items.length > 0 && (
          <>
            <button type="button" className="text-[13px]" style={{ color: 'var(--color-primary)' }} onClick={onMarkAll}>Mark all read</button>
            <button type="button" className="text-[13px] text-muted hover:text-default" onClick={onClear}>Clear</button>
          </>
        )}
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {items.length === 0 ? (
          <div className="p-8 text-center">
            <BellIcon className="w-8 h-8 mx-auto mb-2 text-subtle" />
            <p className="text-sm text-muted">No new notifications</p>
          </div>
        ) : (
          <>
            {today.length > 0 && <>{label('Today')}{today.map(row)}</>}
            {earlier.length > 0 && <>{label('Earlier')}{earlier.map(row)}</>}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 text-[12.5px] text-muted px-4 py-3 border-t shrink-0" style={{ borderColor: 'var(--color-surface-border)' }}>
        <button type="button" className="hover:text-default" onClick={onSettings}>Notification settings</button>
        <button type="button" className="hover:text-default" onClick={onActivity}>See everything in Activity →</button>
      </div>
    </div>
  );
}
