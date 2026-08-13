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
// private mode), or a 401 (no/invalid session - api.ts's own handler
// redirects to /login on that response, same as it already does for every
// other protected endpoint). Either of the first two means it's safe to
// render; only the 401 case needs this gate to actually intervene, and it
// does so by simply never having rendered the shell in the first place.
export function AdminAuthGate({ children }: AdminAuthGateProps) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getSession()
      // A 401 already triggers api.ts's own redirect to /login - nothing
      // further to do here. A network error fails open (render normally)
      // rather than stranding the user on a spinner if the check itself
      // can't complete.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
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
