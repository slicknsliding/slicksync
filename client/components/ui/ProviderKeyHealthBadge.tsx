'use client';

import { CheckCircleIcon, ExclamationTriangleIcon, ClockIcon } from '@heroicons/react/24/outline';
import type { SyncSettings } from '@/lib/api';

interface ProviderKeyHealthBadgeProps {
  /** Result for this one provider - settings.keyHealth?.[provider]. */
  result?: SyncSettings['keyHealth'] extends Record<string, infer V> | undefined ? V : never;
}

// Small inline status pill shown next to each of the four metadata-provider
// key inputs (Settings -> SlickTrax/Discover). Reads whatever the last check
// found - see server/utils/metadataKeyHealth.js - rather than checking
// anything itself; the "Check keys now" button next to the fields is what
// actually triggers a check. Renders nothing until a key has been checked at
// least once, so a fresh install with unchecked keys shows no false signal
// either way.
export function ProviderKeyHealthBadge({ result }: ProviderKeyHealthBadgeProps) {
  if (!result) return null;

  const checkedAgo = formatRelativeTime(result.checkedAt);

  if (result.ok) {
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1 text-xs font-medium"
          style={{ color: 'var(--color-success)' }}
          title={`Last checked ${checkedAgo}`}
        >
          <CheckCircleIcon className="w-3.5 h-3.5" />
          Working
        </span>
        {/* Quota pressure - MDBList only, the one provider whose real usage
            is actually checkable (see metadataKeyHealth.js's own comment for
            why TMDb/OMDb/RPDB don't get one). Color escalates as a genuinely
            shared instance key (everyone falling back to it) approaches its
            cap, which is the whole point - catching pressure before it
            becomes an outage. */}
        {result.usage && (
          <span
            className="text-xs"
            style={{
              color: result.usage.percentUsed >= 90
                ? 'var(--color-error)'
                : result.usage.percentUsed >= 70
                  ? 'var(--color-warning)'
                  : 'var(--color-text-muted)',
            }}
            title={`${result.usage.used.toLocaleString()} of ${result.usage.limit.toLocaleString()} requests used${result.usage.plan ? ` (${result.usage.plan} plan)` : ''}`}
          >
            {result.usage.used.toLocaleString()}/{result.usage.limit.toLocaleString()} ({result.usage.percentUsed}%)
          </span>
        )}
      </span>
    );
  }

  // The WHY is visible text, not just a hover tooltip - a failing key whose
  // reason hides behind a title attribute reads as "broken, no explanation"
  // on touch screens and to anyone who doesn't think to hover (confirmed
  // live: an OMDb key at its daily limit showed a bare "Not working").
  return (
    <span className="inline-flex flex-col items-end gap-0.5 max-w-[16rem] text-right">
      <span
        className="inline-flex items-center gap-1 text-xs font-medium"
        style={{ color: result.rateLimited ? 'var(--color-warning)' : 'var(--color-error)' }}
        title={`Last checked ${checkedAgo}`}
      >
        <ExclamationTriangleIcon className="w-3.5 h-3.5" />
        {result.rateLimited ? 'Limit reached' : 'Not working'}
      </span>
      {result.message && result.message !== 'OK' && (
        <span className="text-[11px] leading-snug text-muted">{result.message}</span>
      )}
    </span>
  );
}

/** Same "unchecked" placeholder shown in place of a badge when there's
 * genuinely no result yet, so the field doesn't look silently broken vs
 * silently never-tested. */
export function ProviderKeyHealthUnchecked() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-subtle">
      <ClockIcon className="w-3.5 h-3.5" />
      Not checked yet
    </span>
  );
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}
