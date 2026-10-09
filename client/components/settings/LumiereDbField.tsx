'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircleIcon, ExclamationTriangleIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { api, LumiereStatus } from '@/lib/api';

/**
 * The account's own LumiereDB - IMDb's data, self-hosted - with a badge
 * saying whether it's up. A first start downloads IMDb's data and builds an
 * index for about ten minutes, so while it's building the badge checks
 * again by itself until it's ready.
 */
export function LumiereDbField({ value, onChange, onSave }: {
  value: string;
  onChange: (v: string) => void;
  onSave: (v: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<LumiereStatus | null>(null);

  const check = useCallback(async (fresh: boolean) => {
    try {
      setStatus(await api.getLumiereStatus(fresh));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getLumiereStatus(false).then((r) => { if (!cancelled) setStatus(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (status?.state !== 'building') return;
    const t = setTimeout(() => check(true), 30000);
    return () => clearTimeout(t);
  }, [status, check]);

  const badge = !value.trim() || !status || status.state === 'off' ? null
    : status.state === 'ready' ? (
      <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--color-success)' }}>
        <CheckCircleIcon className="w-3.5 h-3.5" />
        Ready
      </span>
    ) : status.state === 'building' ? (
      <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--color-warning)' }}>
        <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />
        Building its index
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--color-error)' }}>
        <ExclamationTriangleIcon className="w-3.5 h-3.5" />
        {status.state === 'login' ? 'Needs a sign-in' : status.state === 'wrong' ? 'Not LumiereDB' : 'Can’t reach it'}
      </span>
    );

  return (
    <div className="pt-1">
      <div className="flex items-center justify-between mb-1.5">
        <label className="block text-sm font-medium text-default">LumiereDB address <span className="text-subtle font-normal">(optional)</span></label>
        {badge}
      </div>
      <p className="text-xs text-muted mb-2">
        Your own copy of IMDb&apos;s data, run next to SlickSync. Discover search forgives typos and finds
        titles in other languages, Discover gets Trending and IMDb&apos;s Popular, Smart Catalogs get IMDb&apos;s
        ratings and vote counts, people search works without a TMDb key, and history imports match more titles.
        Run the <code className="text-[11px]">ghcr.io/0xconstant1/lumiere-db</code> image and put its address here, or
        leave it blank to keep all of this off. IMDb&apos;s data is for personal, non-commercial use.
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={async () => {
          // Saved as just the server's address, as the server does too - a
          // pasted readiness check or search loses its path.
          const cleaned = value.trim().replace(/\/(readyz|search(\/people)?|lists\/[a-z]+|discover(\/options)?)\/?(\?.*)?$/i, '').replace(/\/+$/, '');
          if (cleaned !== value) onChange(cleaned);
          await onSave(cleaned);
          check(true);
        }}
        placeholder="http://lumiere-db:8000"
        autoComplete="off"
        spellCheck={false}
        className="input-base w-full px-3 py-2 text-sm"
      />
      {value.trim() && status && status.state !== 'ready' && status.state !== 'off' && (
        <p className="text-xs mt-1.5 leading-snug" style={{ color: status.state === 'building' ? 'var(--color-text-muted)' : 'var(--color-warning)' }}>
          {status.message}
        </p>
      )}
    </div>
  );
}
