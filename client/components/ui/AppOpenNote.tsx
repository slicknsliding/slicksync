'use client';

// The "Didn't open?" note under a row of open buttons (lib/useAppOpenCheck).
// basis-full drops it onto its own line in a flex-wrap row.

import { InformationCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';

export function AppOpenNote({ onClose, isTV = false }: { onClose: () => void; isTV?: boolean }) {
  return (
    <div
      role="status"
      className="basis-full w-full min-w-0 flex items-start gap-2 text-muted"
      style={{
        marginTop: 4,
        padding: '10px 12px',
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.4,
        background: 'rgba(159, 146, 255, 0.08)',
        border: '1px solid rgba(159, 146, 255, 0.2)',
      }}
    >
      <InformationCircleIcon className="shrink-0" style={{ width: 18, height: 18, color: 'rgb(212, 208, 255)' }} />
      <p className="flex-1 min-w-0">
        <span className="text-default" style={{ fontWeight: 500 }}>Didn&apos;t open?</span>{' '}
        Open in AIOStreams needs the AIOStreams app (2.37 or newer) on this device. Browsers ignore the link when the app isn&apos;t there.
      </p>
      {!isTV && (
        <button type="button" aria-label="Close" onClick={onClose} className="shrink-0 text-muted hover:text-default">
          <XMarkIcon style={{ width: 18, height: 18 }} />
        </button>
      )}
    </div>
  );
}
