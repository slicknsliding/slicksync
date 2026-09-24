'use client';

import { motion } from 'framer-motion';
import {
  ArrowTopRightOnSquareIcon,
  ClipboardIcon,
  CheckIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
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
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-5"
    >
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{description}</p>

      {!code ? (
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="mt-4 w-full rounded-xl bg-primary/20 px-4 py-2.5 text-sm font-medium text-primary hover:bg-primary/30 disabled:opacity-50"
        >
          {isStarting ? 'Starting…' : 'Get a sign-in code'}
        </button>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3">
            <span className="font-mono text-xl tracking-[0.2em]">{code}</span>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded-lg p-2 hover:bg-white/5"
              aria-label="Copy the code"
            >
              {copied ? <CheckIcon className="w-5 h-5 text-primary" /> : <ClipboardIcon className="w-5 h-5" />}
            </button>
          </div>

          {webUrl && (
            <a
              href={webUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              Open Nuvio to enter it
              <ArrowTopRightOnSquareIcon className="w-4 h-4" />
            </a>
          )}

          <p className="text-xs text-subtle">
            {expired
              ? 'That code has expired.'
              : isWaiting
                ? `Waiting for you to approve it in Nuvio${secondsLeft !== null ? ` · ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} left` : ''}`
                : 'Approved.'}
          </p>

          {expired && (
            <button
              type="button"
              onClick={start}
              disabled={busy}
              className="inline-flex items-center gap-1.5 self-start text-sm text-primary hover:underline disabled:opacity-50"
            >
              <ArrowPathIcon className="w-4 h-4" />
              Get a new code
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}
