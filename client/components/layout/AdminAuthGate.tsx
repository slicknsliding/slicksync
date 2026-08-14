'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '@/lib/api';

interface AdminAuthGateProps {
  children: React.ReactNode;
}

// Blocks rendering the admin shell (Sidebar/Dashboard/etc.) until a session
// check resolves. Without this, an anonymous visitor to "/" got a flash of
// the full dashboard - Sidebar, stat cards, everything - before the page's
// own data fetches came back 401 and the global redirect handler in api.ts
// kicked in and sent them to /login. UserAuthGate already solved this same
// problem for the /user routes; the admin routes never got the equivalent.
//
// getSession() hits /auth/me, which resolves three ways: a real account
// (valid session), { account: null } with no error (auth disabled entirely,
// private mode), or a 401 (no/invalid session). api.ts's own handler already
// starts the redirect to /login on that 401 - but window.location.href
// doesn't unmount React synchronously, so there's a real window between
// that redirect firing and the browser actually navigating away. An earlier
// version of this gate only tracked whether the check had *finished*, not
// whether it had *succeeded* - so a 401 still flipped straight to rendering
// children in that window, reproducing the exact flash this gate exists to
// prevent. Tracking the outcome explicitly (not just completion) keeps the
// gate closed for the whole redirect, not just until the request settles.
export function AdminAuthGate({ children }: AdminAuthGateProps) {
  const [status, setStatus] = useState<'checking' | 'ok' | 'unauthenticated'>('checking');

  useEffect(() => {
    let cancelled = false;
    api.getSession()
      .then(() => {
        if (!cancelled) setStatus('ok');
      })
      .catch((err: any) => {
        if (cancelled) return;
        // Only a real 401 means "not authenticated" (redirect already in
        // flight via api.ts). Anything else - a network error, the server
        // being briefly unreachable - fails open rather than stranding the
        // user on a spinner forever over a transient issue unrelated to auth.
        setStatus(err?.response?.status === 401 ? 'unauthenticated' : 'ok');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status !== 'ok') {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--color-bg)' }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center gap-4"
        >
          <div className="relative w-12 h-12">
            <motion.div
              className="absolute inset-0 rounded-full"
              style={{
                border: '3px solid var(--color-surface-border)',
                borderTopColor: 'var(--color-primary)',
              }}
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            />
          </div>
          <p style={{ color: 'var(--color-text-muted)' }} className="text-sm">
            Verifying session...
          </p>
        </motion.div>
      </div>
    );
  }

  return <>{children}</>;
}
