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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : '';
}

function DetailsFold({ text, className = '' }: { text: string; className?: string }) {
  return (
    <details className={`load-details ${className}`}>
      <summary className="cursor-pointer text-xs text-muted select-none">Details</summary>
      <code className="block mt-1.5 px-2.5 py-1.5 rounded-lg bg-surface-hover border border-default text-xs text-muted font-mono break-all whitespace-pre-wrap">{text}</code>
    </details>
  );
}

/** A page that still shows what it has, but part of it failed: a banner on top. */
export function LoadBanner({ title, line, error, onRetry, className = '' }: {
  title: string;
  line?: ReactNode;
  error?: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const isTV = useIsTV();
  const details = errorText(error);
  const button = <Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>;
  return (
    <div className={`p-4 rounded-xl bg-error-muted border border-error text-sm flex flex-wrap sm:flex-nowrap items-start gap-3 ${className}`}>
      <ExclamationTriangleIcon className="w-5 h-5 shrink-0 text-error mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-error">{title}</p>
        {line && <p className="text-muted mt-0.5">{line}</p>}
        {details && !isTV && <DetailsFold text={details} className="mt-2" />}
      </div>
      <div className="shrink-0 ml-8 sm:ml-0">
        {isTV ? <TVFocusable onEnterPress={onRetry}>{button}</TVFocusable> : button}
      </div>
    </div>
  );
}

/** A small panel or popup that couldn't load: one line, Try again, folded Details. */
export function LoadErrorInline({ error, onRetry, what = 'this' }: {
  error?: unknown;
  onRetry?: () => void;
  /** "Couldn't load {what}." */
  what?: string;
}) {
  const isTV = useIsTV();
  const details = errorText(error);
  return (
    <div className="flex items-start gap-2 text-sm text-default">
      <ExclamationTriangleIcon className="w-4 h-4 shrink-0 text-error mt-0.5" />
      <div className="min-w-0">
        <span>Couldn’t load {what}.</span>
        {onRetry && (
          isTV
            ? <TVFocusable inline onEnterPress={onRetry}><button type="button" className="ml-1.5 text-primary font-medium" onClick={onRetry}>Try again</button></TVFocusable>
            : <button type="button" className="ml-1.5 text-primary font-medium hover:underline" onClick={onRetry}>Try again</button>
        )}
        {details && !isTV && <DetailsFold text={details} className="mt-1.5" />}
      </div>
    </div>
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
