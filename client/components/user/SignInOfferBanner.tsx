'use client';

// "Chris just added Nuvio - bring the titles they've watched on Stremio over
// to it?" (server/utils/watchCopy/offer.js). On the person page while their
// newest sign-in is new and nearly empty. "Show me what copies" opens Sync
// watch history with both boxes filled in; "Not now" hides it for that
// sign-in for good.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type WatchCopyOffer } from '@/lib/api';

const LOOK: Record<string, string> = {
  stremio: 'linear-gradient(135deg,#8a5cf6,#5b3fd6)',
  nuvio: 'linear-gradient(135deg,#38599e,#ff9800)',
  jellyfin: 'linear-gradient(135deg,#aa5cc3,#00a4dc)',
  aiostreams: 'linear-gradient(135deg,#9f92ff,#5b4fd6)',
  aiometadata: 'linear-gradient(135deg,#14b8a6,#0e7490)',
};

export function SignInOfferBanner({ userId }: { userId: string }) {
  const [offer, setOffer] = useState<WatchCopyOffer | null>(null);
  useEffect(() => {
    api.getWatchCopyOffer(userId).then((r) => setOffer(r.offer)).catch(() => setOffer(null));
  }, [userId]);
  if (!offer) return null;

  const notNow = () => {
    setOffer(null);
    api.dismissWatchCopyOffer(userId, offer.to.provider).catch(() => {});
  };
  const href = `/users/${encodeURIComponent(userId)}/copy-history?from=${encodeURIComponent(offer.from.side)}&to=${encodeURIComponent(offer.to.side)}`;

  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-3 px-3.5 py-3 rounded-2xl border" style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 45%, var(--color-surface-border))', background: 'color-mix(in srgb, var(--color-primary) 8%, var(--color-surface))' }}>
      <span className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white font-bold text-sm shrink-0" style={{ background: LOOK[offer.to.kind] || LOOK.jellyfin }} aria-hidden="true">
        {offer.to.label.slice(0, 1)}
      </span>
      <div className="flex-1 min-w-0 basis-[12rem]">
        <div className="font-semibold text-default text-sm">{offer.name} just added {offer.to.label}</div>
        <div className="text-xs text-muted">Bring the {offer.from.count.toLocaleString()} title{offer.from.count === 1 ? '' : 's'} they&apos;ve watched on {offer.from.label} over to it?</div>
      </div>
      <div className="flex gap-2 ml-auto">
        <button type="button" onClick={notNow} className="px-3 py-1.5 rounded-lg text-sm border border-default text-default whitespace-nowrap">Not now</button>
        <Link href={href} className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white whitespace-nowrap" style={{ background: 'var(--color-primary-solid)' }}>Show me what copies</Link>
      </div>
    </div>
  );
}
