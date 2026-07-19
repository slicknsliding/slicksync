'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ClipboardIcon, CheckIcon, ArrowRightIcon } from '@heroicons/react/24/outline';
import { SlickSyncLogo } from '@/components/ui/SlickSyncLogo';
import { api } from '@/lib/api';

// Public-mode (multi-tenant) self-registration - the flow the README already
// documented ("first visit shows a registration screen") but that had no
// actual page behind it: the backend's POST /auth/register endpoint existed
// and worked, there was just nothing in the frontend that could reach it.
export default function RegisterPage() {
  const router = useRouter();
  const INSTANCE_TYPE = (process.env.NEXT_PUBLIC_INSTANCE_TYPE || 'private') as 'public' | 'private';

  const [uuid, setUuid] = useState<string | null>(null);
  const [uuidError, setUuidError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadUuid = async () => {
    setUuidError(null);
    try {
      const result = await api.generateAccountUuid();
      setUuid(result.uuid);
    } catch {
      setUuidError('Failed to generate an account ID. Please refresh and try again.');
    }
  };

  useEffect(() => {
    if (INSTANCE_TYPE === 'public') {
      loadUuid();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [INSTANCE_TYPE]);

  const copyUuid = () => {
    if (!uuid) return;
    navigator.clipboard.writeText(uuid);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uuid) return;
    setFormError(null);

    if (password.length < 4) {
      setFormError('Password must be at least 4 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await api.register(uuid, password);
      if (data.token) {
        localStorage.setItem('slicksync-admin-token', data.token);
      }
      router.push('/');
    } catch (err: any) {
      if (err?.response?.status === 409) {
        // Vanishingly unlikely (server-generated UUID collision), but
        // recoverable - just get a fresh one and let them retry.
        setFormError('That account ID was just taken - generated a new one, please try again.');
        loadUuid();
      } else {
        setFormError(err?.message || 'Registration failed. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (INSTANCE_TYPE !== 'public') {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-6"
        style={{ background: 'var(--color-bg)' }}
      >
        <div className="w-full max-w-md text-center">
          <h1 className="text-xl font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
            Registration isn't available
          </h1>
          <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>
            This instance is running in private mode, which uses a single shared
            login rather than separate self-registered accounts.
          </p>
          <button
            onClick={() => router.push('/login?mode=admin')}
            className="text-sm hover:underline"
            style={{ color: 'var(--color-primary)' }}
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: 'var(--color-bg)' }}
    >
      {/* Background gradient - matches the login page */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full blur-[120px] opacity-30"
          style={{ background: 'var(--color-primaryMuted)' }}
        />
        <div
          className="absolute -bottom-40 -left-40 w-[400px] h-[400px] rounded-full blur-[100px] opacity-20"
          style={{ background: 'var(--color-secondaryMuted)' }}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md relative"
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center"
            style={{ background: 'var(--color-primary)' }}
          >
            <SlickSyncLogo className="w-10 h-10" />
          </motion.div>
          <h1 className="text-3xl font-bold font-display mb-2" style={{ color: 'var(--color-text)' }}>
            SlickSync
          </h1>
          <p style={{ color: 'var(--color-text-muted)' }}>
            Create your admin account
          </p>
        </div>

        <motion.div
          className="rounded-2xl overflow-hidden"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-border)',
          }}
        >
          <div className="h-1" style={{ background: 'var(--color-primary)' }} />

          <div className="p-6 space-y-4">
            {/* Account ID - server-generated, not user-chosen. This is the
                permanent login identifier with no recovery flow, so it's
                shown up front with a copy button and a clear warning rather
                than buried until after registration completes. */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>
                Your account ID
              </label>
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 px-4 py-3 rounded-xl text-sm font-mono truncate"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-surface-border)',
                    color: 'var(--color-text)',
                  }}
                >
                  {uuid || (uuidError ? '—' : 'Generating…')}
                </div>
                <button
                  type="button"
                  onClick={copyUuid}
                  disabled={!uuid}
                  className="shrink-0 p-3 rounded-xl transition-all"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-surface-border)',
                    opacity: uuid ? 1 : 0.5,
                  }}
                  aria-label="Copy account ID"
                >
                  {copied ? (
                    <CheckIcon className="w-4 h-4" style={{ color: 'var(--color-success)' }} />
                  ) : (
                    <ClipboardIcon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                  )}
                </button>
              </div>
              <p className="text-xs mt-2" style={{ color: 'var(--color-warning)' }}>
                Save this somewhere safe - it's your login ID, and there's no way to recover it if lost.
              </p>
              {uuidError && (
                <p className="text-xs mt-2" style={{ color: 'var(--color-error)' }}>
                  {uuidError}{' '}
                  <button type="button" onClick={loadUuid} className="underline">
                    Retry
                  </button>
                </p>
              )}
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="password" className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl text-sm transition-all"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-surface-border)',
                    color: 'var(--color-text)',
                  }}
                  placeholder="At least 4 characters"
                  autoComplete="new-password"
                />
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text)' }}>
                  Confirm password
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl text-sm transition-all"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-surface-border)',
                    color: 'var(--color-text)',
                  }}
                  placeholder="********"
                  autoComplete="new-password"
                />
              </div>

              {formError && (
                <motion.p
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-sm"
                  style={{ color: 'var(--color-error)' }}
                >
                  {formError}
                </motion.p>
              )}

              <button
                type="submit"
                disabled={isSubmitting || !uuid || !password || !confirmPassword}
                className="w-full py-3.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2"
                style={{
                  background: 'var(--color-primary)',
                  color: 'white',
                  opacity: isSubmitting || !uuid || !password || !confirmPassword ? 0.5 : 1,
                }}
              >
                {isSubmitting ? (
                  <>
                    <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Creating account...
                  </>
                ) : (
                  <>
                    <ArrowRightIcon className="w-5 h-5" />
                    Create account
                  </>
                )}
              </button>
            </form>
          </div>
        </motion.div>

        <p className="text-center mt-6 text-sm" style={{ color: 'var(--color-text-subtle)' }}>
          Already have an account?{' '}
          <button
            onClick={() => router.push('/login?mode=admin')}
            className="hover:underline"
            style={{ color: 'var(--color-primary)' }}
          >
            Sign in
          </button>
        </p>
      </motion.div>
    </div>
  );
}
