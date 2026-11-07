'use client';

import { ReactNode } from 'react';
import { PubOutcome, PubButton, type PubTone } from '@/components/v2/PublicV2';
import { useTVStops } from '@/components/tv/useTVModal';
import { TVFocusable } from '@/components/tv/TVFocusable';
import { TVLink } from '@/components/tv/TVLink';

type StatusType =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'completed'
  | 'error'
  | 'disabled'
  | 'expired'
  | 'email-mismatch'
  | 'not-found';

interface StatusCardProps {
  type: StatusType;
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
}

// One coloured dot per way an invite (or a removal) can end.
const TONE: Record<StatusType, PubTone> = {
  pending: 'warn',
  accepted: 'ok',
  rejected: 'bad',
  completed: 'ok',
  error: 'bad',
  disabled: 'off',
  expired: 'warn',
  'email-mismatch': 'warn',
  'not-found': 'off',
};

/**
 * Status card for displaying various states in the invite flow: a coloured
 * dot, the title, a line in plain words and, where it helps, one button.
 */
export function StatusCard({ type, title, children, footer }: StatusCardProps) {
  return (
    <PubOutcome tone={TONE[type]} title={title} action={footer} pulse={type === 'pending'}>
      {children}
    </PubOutcome>
  );
}

/** A card's one button; on a TV a remote stop, OK doing what a click does. */
function RetryButton({ onRetry, children }: { onRetry: () => void; children: ReactNode }) {
  const isTV = useTVStops();
  const button = <PubButton onClick={onRetry} tabIndex={isTV ? -1 : undefined}>{children}</PubButton>;
  return isTV ? <TVFocusable className="block" onEnterPress={onRetry}>{button}</TVFocusable> : button;
}

/**
 * Preset status cards for common states
 */
export const StatusCards = {
  Pending: () => (
    <StatusCard type="pending" title="Waiting for a yes">
      <p>We&rsquo;ll let you in as soon as they approve. You can close this page.</p>
    </StatusCard>
  ),

  Rejected: () => (
    <StatusCard type="rejected" title="Not this time">
      <p>The person who runs it said no. Ask them if you think it&rsquo;s a mistake.</p>
    </StatusCard>
  ),

  Completed: () => (
    <StatusCard
      type="completed"
      title="You’re in"
      footer={
        <TVLink href="/login" className="block">
          <PubButton primary>Open SlickSync</PubButton>
        </TVLink>
      }
    >
      <p>Your addons are on their way to your app.</p>
    </StatusCard>
  ),

  Disabled: () => (
    <StatusCard type="disabled" title="This link has ended">
      <p>Ask for a new one.</p>
    </StatusCard>
  ),

  NotFound: () => (
    <StatusCard type="not-found" title="This link isn’t right">
      <p>It doesn&rsquo;t exist, or was switched off.</p>
    </StatusCard>
  ),

  EmailMismatch: ({ onRetry }: { onRetry?: () => void } = {}) => (
    <StatusCard
      type="email-mismatch"
      title="That’s a different account"
      footer={onRetry ? <RetryButton onRetry={onRetry}>Try again</RetryButton> : undefined}
    >
      <p>Sign in with the account you started with.</p>
    </StatusCard>
  ),

  OAuthExpired: ({ onRetry }: { onRetry?: () => void } = {}) => (
    <StatusCard
      type="expired"
      title="The sign-in link ran out"
      footer={onRetry ? <RetryButton onRetry={onRetry}>New link</RetryButton> : undefined}
    >
      <p>Get a fresh one and try again.</p>
    </StatusCard>
  ),
};
