'use client';

// Without this, a component throwing during render left the whole page
// blank with no way back except a reload - and on an installed app, no
// address bar to reload from. This keeps the shell and offers the two
// things that actually recover it.
import { useEffect } from 'react';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Visible in the browser console for anyone diagnosing a report.
    console.error('[SlickSync] page error:', error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div
        className="w-full max-w-md rounded-2xl p-6 text-center"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
      >
        <h2 className="text-lg font-semibold font-display" style={{ color: 'var(--color-text)' }}>
          This page hit an error
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          The rest of SlickSync is still running. Trying again usually clears it.
        </p>
        {error?.message && (
          <p className="mt-3 text-xs font-mono break-words" style={{ color: 'var(--color-text-subtle, var(--color-text-muted))' }}>
            {error.message}
          </p>
        )}
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ background: 'var(--color-primary)' }}
          >
            Try again
          </button>
          <a
            href="/"
            className="px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text)' }}
          >
            Go to the dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
