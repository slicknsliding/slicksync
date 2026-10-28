'use client';

import { motion } from 'framer-motion';
import { ArrowTopRightOnSquareIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { PubButton, PubCode, PubError, PubHeading, PubLink, PubOr, PubQr, PubWaiting } from '@/components/v2/PublicV2';
import { useState, useEffect, useCallback, useRef } from 'react';
import { stremioOAuth } from '@/lib/invite-api';
import { copyToClipboard } from '@/lib/clipboard';

interface StremioOAuthCardProps {
  /** OAuth link provided by admin (if already generated) */
  initialLink?: string | null;
  /** OAuth code provided by admin */
  initialCode?: string | null;
  /** Expiration timestamp */
  initialExpiresAt?: string | null;
  /** Called when OAuth completes with auth key */
  onAuthKey: (authKey: string) => Promise<void>;
  /** Called on error */
  onError?: (message: string) => void;
  /** Whether the card is disabled */
  disabled?: boolean;
  /** Whether we're in completing state (called from parent) */
  isCompleting?: boolean;
  /** Title for the card */
  title?: string;
  /** Description for the card */
  description?: string;
}

/**
 * Stremio OAuth card for authenticating with Stremio
 * 
 * Supports two modes:
 * 1. Admin-generated link: Uses initialLink/initialCode props
 * 2. Self-generated link: Creates link via Stremio API
 */
export function StremioOAuthCard({
  initialLink,
  initialCode,
  initialExpiresAt,
  onAuthKey,
  onError,
  disabled = false,
  isCompleting = false,
  title = 'Complete with Stremio',
  description = 'Sign in with your Stremio account to complete the setup.',
}: StremioOAuthCardProps) {
  // OAuth state
  const [oauthLink, setOAuthLink] = useState<string | null>(initialLink || null);
  const [oauthCode, setOAuthCode] = useState<string>(initialCode || '');
  const [oauthExpiresAt, setOAuthExpiresAt] = useState<number | null>(
    initialExpiresAt ? new Date(initialExpiresAt).getTime() : null
  );
  
  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPolling, setIsPolling] = useState(!!initialCode);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  
  // Refs for cleanup
  const pollIntervalRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  
  // Check if OAuth is expired
  const isExpired = oauthExpiresAt ? oauthExpiresAt < Date.now() : false;
  
  // Has admin-provided link (can't refresh)
  const hasAdminLink = !!initialCode;

  // Update state when initial props change
  useEffect(() => {
    if (initialLink) {
      setOAuthLink(initialLink);
      setIsPolling(true);
    }
    if (initialCode) {
      setOAuthCode(initialCode);
      setIsPolling(true);
    }
    if (initialExpiresAt) {
      setOAuthExpiresAt(new Date(initialExpiresAt).getTime());
    }
  }, [initialLink, initialCode, initialExpiresAt]);

  // Timer for countdown
  useEffect(() => {
    if (!oauthExpiresAt || isExpired) {
      setTimeLeft(null);
      return;
    }

    const updateTimer = () => {
      const diff = Math.max(0, oauthExpiresAt - Date.now());
      if (diff === 0) {
        setTimeLeft('Expired');
        setIsPolling(false);
        return;
      }
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${minutes}:${seconds.toString().padStart(2, '0')}`);
    };

    updateTimer();
    timerIntervalRef.current = window.setInterval(updateTimer, 1000);

    return () => {
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
      }
    };
  }, [oauthExpiresAt, isExpired]);

  // Poll for OAuth completion
  useEffect(() => {
    if (!isPolling || !oauthCode || isExpired || disabled || isCompleting) {
      return;
    }

    const poll = async () => {
      try {
        const result = await stremioOAuth.poll(oauthCode);
        
        if (result.success && result.authKey) {
          setIsPolling(false);
          if (pollIntervalRef.current) {
            window.clearInterval(pollIntervalRef.current);
          }
          await onAuthKey(result.authKey);
        } else if (result.error) {
          setError(result.error);
          onError?.(result.error);
        }
      } catch (err) {
        // Silently handle polling errors
      }
    };

    // Initial poll
    poll();
    
    // Set up interval
    pollIntervalRef.current = window.setInterval(poll, 3000);

    return () => {
      if (pollIntervalRef.current) {
        window.clearInterval(pollIntervalRef.current);
      }
    };
  }, [isPolling, oauthCode, isExpired, disabled, isCompleting, onAuthKey, onError]);

  // Generate new OAuth link
  const generateLink = useCallback(async () => {
    if (isGenerating || disabled || hasAdminLink) return;
    
    setIsGenerating(true);
    setError(null);
    
    try {
      const result = await stremioOAuth.create();
      setOAuthLink(result.link);
      setOAuthCode(result.code);
      setOAuthExpiresAt(result.expiresAt);
      setIsPolling(true);
    } catch (err: any) {
      const message = err?.message || 'Failed to generate OAuth link';
      setError(message);
      onError?.(message);
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, disabled, hasAdminLink, onError]);

  // Auto-generate if no initial link
  useEffect(() => {
    if (!initialLink && !initialCode && !oauthLink) {
      generateLink();
    }
  }, [initialLink, initialCode, oauthLink, generateLink]);

  // Copy code to clipboard
  const copyCode = useCallback(() => {
    if (!oauthCode) return;
    copyToClipboard(oauthCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [oauthCode]);

  // Open OAuth link
  const openLink = useCallback(() => {
    if (!oauthLink || disabled) return;
    window.open(oauthLink, '_blank', 'noopener,noreferrer');
  }, [oauthLink, disabled]);

  // Time left color based on urgency
  const getTimeColor = () => {
    if (!oauthExpiresAt) return 'var(--color-text-subtle)';
    const diff = oauthExpiresAt - Date.now();
    if (diff < 60000) return 'var(--color-error)'; // < 1 min
    if (diff < 120000) return 'var(--color-warning)'; // < 2 min
    return 'var(--color-text-subtle)';
  };

  return (
    <motion.div
      className="space-y-4 text-center"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <PubHeading title={title} line={description} />

      {oauthLink && !isExpired && !isCompleting && (
        <PubQr data={oauthLink} alt="Scan with your phone to open Stremio" />
      )}

      {/* Main button - Open Stremio */}
      <PubButton
        primary
        onClick={openLink}
        disabled={!oauthLink || disabled || isExpired || isCompleting}
        icon={isCompleting || isGenerating
          ? <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
          : <ArrowTopRightOnSquareIcon className="w-5 h-5" />}
      >
        {isCompleting ? 'Creating Account...' : isGenerating ? 'Generating Link...' : 'Open Stremio'}
      </PubButton>

      <PubOr />

      {/* Manual code entry */}
      <div className="space-y-2.5">
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Copy the code and paste it at{' '}
          <a
            href="https://link.stremio.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
            style={{ color: 'var(--color-primary)' }}
          >
            link.stremio.com
          </a>
        </p>
        <PubCode code={oauthCode} copied={copied} onCopy={copyCode} />
      </div>

      {/* Timer and refresh */}
      <div className="flex items-center justify-center gap-4">
        {timeLeft && (
          <span className="text-sm font-mono" style={{ color: getTimeColor() }}>
            {timeLeft}
          </span>
        )}
        {!hasAdminLink && (
          <PubLink onClick={generateLink} disabled={isGenerating || disabled} icon={<ArrowPathIcon className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />}>
            Refresh
          </PubLink>
        )}
      </div>

      {error && <PubError>{error}</PubError>}

      {isPolling && !isExpired && !error && (
        <PubWaiting tone="var(--color-success)">Waiting for you to approve it…</PubWaiting>
      )}
    </motion.div>
  );
}
