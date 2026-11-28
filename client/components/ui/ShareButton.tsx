'use client';

import type { ReactNode } from 'react';
import { ShareIcon } from '@heroicons/react/24/outline';
import { useCoarsePointer } from '@/lib/hooks/useCoarsePointer';
import { useIsTV } from '@/lib/hooks/useIsTV';

export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
}

/** True on a phone or tablet whose browser can open the system share sheet.
 *  False on the server and on a computer, which keep Copy only. */
export function useCanNativeShare(): boolean {
  const coarse = useCoarsePointer();
  const isTV = useIsTV();
  return coarse && !isTV && typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** Opens the phone's own share sheet. Closing the sheet is not an error. */
export async function shareNatively(payload: SharePayload): Promise<void> {
  try {
    await navigator.share(payload);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return;
    throw e;
  }
}

/** The Share button that sits next to a Copy button. Renders nothing where
 *  there is no share sheet. `look` picks the v2 button or the classic one. */
export function ShareButton({ payload, look = 'classic', onError, children = 'Share' }: {
  payload: SharePayload;
  look?: 'v2' | 'classic';
  onError?: () => void;
  children?: ReactNode;
}) {
  const can = useCanNativeShare();
  if (!can) return null;
  const go = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    shareNatively(payload).catch(() => onError?.());
  };
  if (look === 'v2') {
    return (
      <button type="button" className="v2-btn" onClick={go}>
        <ShareIcon className="w-4 h-4" />
        {children}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={go}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-surface-hover text-default hover:bg-primary-muted transition-colors"
    >
      <ShareIcon className="w-4 h-4" />
      {children}
    </button>
  );
}
