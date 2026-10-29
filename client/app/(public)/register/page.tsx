'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ClipboardIcon, CheckIcon } from '@heroicons/react/24/outline';
import { PubFrame, PubLogo, PubCard, PubButton, PubHeading, PubField, PubError, pubInputStyle } from '@/components/v2/PublicV2';
import { PasswordToggleButton } from '@/components/ui/Input';
import { api } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';

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
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);
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
    copyToClipboard(uuid);
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
      <PubFrame>
        <PubLogo sub="This instance is private" />
        <PubCard>
          <PubHeading
            title="Registration isn’t available"
            line="This instance is running in private mode, which uses a single shared login rather than separate self-registered accounts."
          />
          <PubButton primary onClick={() => router.push('/login?mode=admin')}>
            Go to sign in
          </PubButton>
        </PubCard>
      </PubFrame>
    );
  }

  return (
    <PubFrame>
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
        <PubLogo sub="Create the account that runs this SlickSync" />

        <PubCard>
          <div className="space-y-4">
            {/* Account ID - server-generated, not user-chosen. This is the
                permanent login identifier with no recovery flow, so it's
                shown up front with a copy button and a clear warning rather
                than buried until after registration completes. */}
            <div
              className="rounded-2xl p-3.5"
              style={{
                border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 45%, transparent)',
                background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 8%, transparent)',
              }}
            >
              <p className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>Your account ID</p>
              <div className="flex items-center gap-2 mt-2">
                <div
                  className="flex-1 min-w-0 px-3 py-2.5 rounded-xl text-sm font-mono truncate"
                  style={pubInputStyle}
                >
                  {uuid || (uuidError ? '—' : 'Generating…')}
                </div>
                <button
                  type="button"
                  onClick={copyUuid}
                  disabled={!uuid}
                  className="shrink-0 p-3 rounded-xl transition-all"
                  style={{
                    ...pubInputStyle,
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
              <p className="text-[12.5px] mt-2" style={{ color: 'var(--color-text-muted)' }}>
                Save it somewhere safe: it&rsquo;s how you sign in, and it can&rsquo;t be recovered.
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
              <PubField label="Password" htmlFor="password">
                <div className="relative">
                  <input
                    id="password"
                    type={passwordVisible ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-4 pr-12 py-3 rounded-xl text-sm transition-all"
                    style={pubInputStyle}
                    placeholder="At least 4 characters"
                    autoComplete="new-password"
                  />
                  <PasswordToggleButton visible={passwordVisible} onToggle={() => setPasswordVisible((v) => !v)} />
                </div>
              </PubField>

              <PubField label="Password again" htmlFor="confirmPassword">
                <div className="relative">
                  <input
                    id="confirmPassword"
                    type={confirmPasswordVisible ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full pl-4 pr-12 py-3 rounded-xl text-sm transition-all"
                    style={pubInputStyle}
                    placeholder="********"
                    autoComplete="new-password"
                  />
                  <PasswordToggleButton visible={confirmPasswordVisible} onToggle={() => setConfirmPasswordVisible((v) => !v)} />
                </div>
              </PubField>

              {formError && <PubError>{formError}</PubError>}

              <PubButton
                primary
                type="submit"
                disabled={isSubmitting || !uuid || !password || !confirmPassword}
                icon={isSubmitting ? <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" /> : undefined}
              >
                {isSubmitting ? 'Creating account...' : 'Create account'}
              </PubButton>
            </form>

            <p className="text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => router.push('/login?mode=admin')}
                className="hover:underline font-semibold"
                style={{ color: 'var(--color-primary)' }}
              >
                Sign in
              </button>
            </p>
          </div>
        </PubCard>
      </motion.div>
    </PubFrame>
  );
}
