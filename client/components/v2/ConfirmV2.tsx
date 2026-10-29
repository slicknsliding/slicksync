'use client';

// The v2 look of every "are you sure" window (ConfirmModal in ui/Modal.tsx
// draws this when Page design is v2): an icon for what kind of question it
// is, the title, what happens, an optional note on how to undo it, and
// buttons that name the thing. On a phone the buttons stack with the safe one
// at the bottom, nearest the thumb.

import type { ReactNode } from 'react';
import { ExclamationTriangleIcon, QuestionMarkCircleIcon, TrashIcon, ClockIcon } from '@heroicons/react/24/outline';

type Variant = 'danger' | 'warning' | 'default';

const GENERIC_CONFIRM = /^(confirm|delete|remove|yes|ok|continue)$/i;
const GENERIC_CANCEL = /^cancel$/i;

/** "Delete Sarah?" -> "Delete Sarah". Long titles are not worth a button. */
function nameFromTitle(title: string): string | null {
  const t = title.replace(/[?!.…]+$/, '').trim();
  return t && t.length <= 30 ? t : null;
}

/**
 * Buttons that name the thing. Only a generic label the caller passed
 * ("Confirm", "Delete", "Remove") is replaced, using the title's own words;
 * anything specific is left exactly as the caller wrote it.
 */
export function v2ConfirmLabels(title: string, confirmText: string, cancelText: string, variant: Variant) {
  let confirm = confirmText;
  let cancel = cancelText;
  const named = nameFromTitle(title);
  if (named && GENERIC_CONFIRM.test(confirmText.trim()) && /^(delete|remove|reset|clear|undo|export)\b/i.test(named)) confirm = named;
  if (named && variant === 'danger' && GENERIC_CANCEL.test(cancelText.trim())) {
    const m = named.match(/^(?:delete|remove)\s+(.+)$/i);
    if (m) cancel = `Keep ${m[1]}`;
  }
  return { confirm, cancel };
}

export function ConfirmV2Body({ title, description, note, icon, variant, confirmText, cancelText, isLoading, onClose, onConfirm }: {
  title: string;
  description: string;
  note?: string;
  icon?: ReactNode;
  variant: Variant;
  confirmText: string;
  cancelText: string;
  isLoading?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const tone = variant === 'danger' ? 'var(--color-error, #ef4444)' : variant === 'warning' ? 'var(--color-warning, #f59e0b)' : 'var(--color-primary)';
  const labels = v2ConfirmLabels(title, confirmText, cancelText, variant);
  const Icon = variant === 'danger' ? TrashIcon : variant === 'warning' ? ExclamationTriangleIcon : QuestionMarkCircleIcon;
  return (
    <div className="v2-confirm">
      <div className="flex items-start gap-3.5">
        <span
          className="shrink-0 flex items-center justify-center rounded-xl"
          style={{ width: 42, height: 42, color: tone, background: `color-mix(in srgb, ${tone} 16%, transparent)` }}
          aria-hidden="true"
        >
          {icon ?? <Icon className="w-5 h-5" />}
        </span>
        <div className="min-w-0 flex-1 pr-6">
          <div className="text-[19px] font-bold leading-snug" style={{ color: 'var(--color-text)' }}>{title}</div>
          <p className="text-sm leading-relaxed mt-2" style={{ color: 'var(--color-text)' }}>{description}</p>
          {note && (
            <div className="flex items-start gap-2 text-[13px] mt-3 px-3 py-2.5 rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
              <ClockIcon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
              <span>{note}</span>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-5">
        <button type="button" className="v2-btn justify-center" style={{ padding: '10px 16px' }} onClick={onClose} disabled={isLoading}>
          {labels.cancel}
        </button>
        <button
          type="button"
          className="v2-btn justify-center"
          style={{ padding: '10px 16px', background: tone, color: '#fff', borderColor: 'transparent' }}
          onClick={onConfirm}
          disabled={isLoading}
        >
          {isLoading ? 'Processing...' : labels.confirm}
        </button>
      </div>
    </div>
  );
}
