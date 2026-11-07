'use client';

// A wrong or old address. Without this file Next.js showed its own bare
// "404" page: system type, the device's light/dark colours and no way back
// into the app - and an installed app has no address bar to recover from.
// Same card as error.tsx, with a way home that fits who is signed in here.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import { useIsTV } from '@/lib/hooks/useIsTV';

export default function NotFound() {
  const pathname = usePathname();
  const isTV = useIsTV();
  // Someone signed in to their own page (and not as an admin on this
  // device) goes back to it; everyone else goes to the dashboard, which
  // sends a signed-out visitor to sign in.
  const [person, setPerson] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads this device's storage once after hydration
      setPerson(!api.wasSignedIn() && !!localStorage.getItem('slicksync-user-auth'));
    } catch { /* storage blocked - keep the dashboard */ }
  }, []);

  // TV: the remote starts on the first button, and left/right moves between the two.
  const homeRef = useRef<HTMLAnchorElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState<'home' | 'back' | null>(null);
  useEffect(() => {
    if (isTV) homeRef.current?.focus({ preventScroll: true });
  }, [isTV]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!isTV) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); backRef.current?.focus(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); homeRef.current?.focus(); }
  };
  const ring = (which: 'home' | 'back') => (isTV && focused === which ? '0 0 0 4px var(--color-primary)' : undefined);

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = person ? '/user' : '/';
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-6">
      <div
        className="w-full max-w-md rounded-2xl p-6 text-center"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-surface-border)' }}
      >
        <div className="flex justify-center mb-3.5">
          <span
            aria-hidden
            className="w-12 h-12 rounded-[13px] inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))',
              boxShadow: '0 8px 28px -6px var(--color-primary)',
            }}
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round">
              <rect x="2.5" y="7" width="11" height="6.5" rx="3.25" transform="rotate(-30 8 10.25)" />
              <rect x="10.5" y="10.5" width="11" height="6.5" rx="3.25" transform="rotate(-30 16 13.75)" />
            </svg>
          </span>
        </div>
        <h1 className="text-lg font-semibold font-display" style={{ color: 'var(--color-text)' }}>
          Nothing here
        </h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          That link doesn’t go to a page in SlickSync. It may be old, or mistyped.
        </p>
        {pathname && (
          <p className="mt-2.5 text-xs font-mono break-all" style={{ color: 'var(--color-text-subtle, var(--color-text-muted))' }}>
            {pathname}
          </p>
        )}
        <div className="mt-5 flex items-center justify-center gap-2 flex-wrap" onKeyDown={onKeyDown}>
          <a
            ref={homeRef}
            href={person ? '/user' : '/'}
            onFocus={() => setFocused('home')}
            onBlur={() => setFocused(null)}
            className={`px-4 py-2 rounded-lg text-sm font-medium${isTV ? ' outline-none' : ''}`}
            style={{ background: 'var(--color-primary-solid)', color: 'var(--color-on-primary-solid, #fff)', boxShadow: ring('home') }}
          >
            {person ? 'Go to your page' : 'Go to the dashboard'}
          </a>
          <button
            ref={backRef}
            type="button"
            onClick={goBack}
            onFocus={() => setFocused('back')}
            onBlur={() => setFocused(null)}
            className={`px-4 py-2 rounded-lg text-sm font-medium${isTV ? ' outline-none' : ''}`}
            style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text)', boxShadow: ring('back') }}
          >
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}
