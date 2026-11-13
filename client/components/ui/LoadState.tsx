'use client';

// The one screen a page shows when it couldn't load (LoadError), and the one
// it shows when there's nothing to list yet (EmptyState). Same layout for
// both: an icon tile, a plain title, one line, and an optional button.
// LoadError keeps the technical text folded away under Details, so a
// provider's own message or an address never sits on the page by default.

import type { ReactNode } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { useIsTV } from '@/lib/hooks/useIsTV';

function StateFrame({ icon, tone, title, line, action, children }: {
  icon: ReactNode;
  tone: 'error' | 'neutral';
  title: string;
  line?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="text-center py-14 px-4">
      <div className={`w-14 h-14 mx-auto rounded-2xl flex items-center justify-center ${tone === 'error' ? 'bg-error-muted text-error' : 'bg-surface-hover text-subtle'}`}>
        {icon}
      </div>
      <h3 className="text-lg font-semibold mt-4 mb-1.5 text-default">{title}</h3>
      {line && <p className="text-sm text-muted mx-auto max-w-sm leading-relaxed">{line}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
      {children}
    </div>
  );
}

/** "Couldn't load your …" with Try again, and the raw error folded under Details. */
export function LoadError({ what, error, onRetry, line }: {
  /** Finishes the title: "Couldn't load {what}", e.g. "your addons". */
  what: string;
  /** The underlying error; only its text is shown, and only under Details. */
  error?: unknown;
  /** Defaults to reloading the page. */
  onRetry?: () => void;
  /** Replaces the default "what to try" sentence. */
  line?: ReactNode;
}) {
  const isTV = useIsTV();
  const retry = onRetry ?? (() => window.location.reload());
  const details = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const button = <Button variant="primary" onClick={retry}>Try again</Button>;
  return (
    <StateFrame
      tone="error"
      icon={<ExclamationTriangleIcon className="w-7 h-7" />}
      title={`Couldn’t load ${what}`}
      line={line ?? 'SlickSync couldn’t reach what it needed. Check your connection, then try again.'}
      action={isTV ? <TVFocusable className="inline-block" onEnterPress={retry}>{button}</TVFocusable> : button}
    >
      {details && !isTV && (
        <details className="load-details mt-4 mx-auto max-w-md text-left">
          <summary className="cursor-pointer text-center text-xs text-muted select-none">Details</summary>
          <code className="block mt-2 px-3 py-2 rounded-lg bg-surface-hover border border-default text-xs text-muted font-mono break-all whitespace-pre-wrap">{details}</code>
        </details>
      )}
    </StateFrame>
  );
}

/** Nothing to list yet: neutral colours, the page's own wording. */
export function EmptyState({ icon, title, line, action }: {
  icon: ReactNode;
  title: string;
  line?: ReactNode;
  action?: ReactNode;
}) {
  return <StateFrame tone="neutral" icon={icon} title={title} line={line} action={action} />;
}
