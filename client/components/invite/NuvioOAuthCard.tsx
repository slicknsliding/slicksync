'use client';

import { motion } from 'framer-motion';
import { ArrowTopRightOnSquareIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { PubButton, PubCode, PubHeading, PubLink, PubQr, PubWaiting } from '@/components/v2/PublicV2';
import { useState, useEffect, useCallback, useRef } from 'react';
import { inviteApi } from '@/lib/invite-api';
import { copyToClipboard } from '@/lib/clipboard';

interface NuvioOAuthCardProps {
  /** The invitation this sign-in belongs to - the flow is gated on it. */
  inviteCode: string;
  /** Called with the device code once Nuvio has approved the sign-in. */
  onApproved: (nuvioCode: string) => Promise<void>;
  onError?: (message: string) => void;
  disabled?: boolean;
  isCompleting?: boolean;
  title?: string;
  description?: string;
}

/**
 * Nuvio device sign-in for someone joining by invite.
 *
 * Unlike the Stremio card next to it, which talks to Stremio's link service
 * from the browser, this drives SlickSync's own endpoints: the exchange that
 * turns an approved code into a refresh token happens on the server, so the
 * credential never passes through the page.
 */
export function NuvioOAuthCard({
  inviteCode,
  onApproved,
  onError,
  disabled = false,
  isCompleting = false,
  title = 'Sign in with Nuvio',
  description = 'Open Nuvio on any device and enter this code to complete your request.',
}: NuvioOAuthCardProps) {
  const [code, setCode] = useState<string | null>(null);
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Held in a ref rather than state: the poll loop reads them and they must
  // never trigger a re-render, and they must never reach anything rendered.
  const session = useRef<{ code: string; deviceNonce: string; anonToken: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => {
    cancelled.current = true;
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  // Countdown, purely so the code on screen visibly goes stale rather than
  // silently failing when it does.
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const poll = useCallback(async (intervalSeconds: number) => {
    if (cancelled.current || !session.current) return;
    try {
      const res = await inviteApi.pollNuvioLogin(inviteCode, session.current);
      if (cancelled.current) return;
      if (res?.status === 'authorized') {
        setIsWaiting(false);
        await onApproved(session.current.code);
        return;
      }
      pollTimer.current = setTimeout(() => poll(intervalSeconds), intervalSeconds * 1000);
    } catch (err) {
      if (cancelled.current) return;
      setIsWaiting(false);
      onError?.(err instanceof Error ? err.message : 'Could not check the Nuvio sign-in');
    }
  }, [inviteCode, onApproved, onError]);

  const start = useCallback(async () => {
    setIsStarting(true);
    try {
      const s = await inviteApi.startNuvioLogin(inviteCode);
      session.current = { code: s.code, deviceNonce: s.deviceNonce, anonToken: s.anonToken };
      setCode(s.code);
      setWebUrl(s.webUrl || null);
      setExpiresAt(s.expiresAt ? new Date(s.expiresAt).getTime() : null);
      setIsWaiting(true);
      poll(s.pollIntervalSeconds || 5);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Could not start the Nuvio sign-in');
    } finally {
      setIsStarting(false);
    }
  }, [inviteCode, onError, poll]);

  const copy = async () => {
    if (!code) return;
    if (await copyToClipboard(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const expired = secondsLeft !== null && secondsLeft <= 0;
  const busy = disabled || isCompleting || isStarting;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4 text-center"
    >
      <PubHeading title={title} line={description} />

      {!code ? (
        <PubButton primary onClick={start} disabled={busy}>
          {isStarting ? 'Starting…' : 'Get a sign-in code'}
        </PubButton>
      ) : (
        <>
          {webUrl && !expired && <PubQr data={webUrl} alt="Scan with your phone to open Nuvio" />}
          <PubCode code={code} copied={copied} onCopy={copy} />

          {expired
            ? <p className="text-sm" style={{ color: 'var(--color-text-subtle)' }}>That code has expired.</p>
            : isWaiting
              ? <PubWaiting>{`Waiting for you to approve it in Nuvio${secondsLeft !== null ? ` · ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} left` : ''}`}</PubWaiting>
              : <p className="text-sm" style={{ color: 'var(--color-text-subtle)' }}>Approved.</p>}

          <div className="grid gap-2">
            {webUrl && (
              <a
                href={webUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full py-3 px-4 rounded-xl font-medium flex items-center justify-center gap-2"
                style={{ background: 'var(--color-primary-solid)', color: 'var(--color-on-primary-solid, #fff)' }}
              >
                <ArrowTopRightOnSquareIcon className="w-5 h-5" />
                Open Nuvio to enter it
              </a>
            )}
            {expired && (
              <PubLink onClick={start} disabled={busy} icon={<ArrowPathIcon className="w-4 h-4" />} className="py-2">
                Get a new code
              </PubLink>
            )}
          </div>
        </>
      )}
    </motion.div>
  );
}
