'use client';

import { ReactNode } from 'react';
import { PubFrame, PubLogo } from '@/components/v2/PublicV2';
import { useTVStops } from '@/components/tv/useTVModal';
import { TVFocusable } from '@/components/tv/TVFocusable';

interface InviteLayoutProps {
  children: ReactNode;
  showNewRequestButton?: boolean;
  onNewRequest?: () => void;
  /** The line under the name (what this page is for). */
  subtitle?: ReactNode;
}

/**
 * Public invite page layout with SlickSync branding: the mark and name, one
 * line saying what the page is for, and the page's own content in a narrow
 * centred column.
 */
export function InviteLayout({
  children,
  showNewRequestButton = false,
  onNewRequest,
  subtitle = 'Join a SlickSync household',
}: InviteLayoutProps) {
  // TV: New request is a remote stop; OK does what a click does.
  const isTV = useTVStops();
  const newRequest = onNewRequest && (
    <button type="button" className="v2-btn" onClick={onNewRequest} tabIndex={isTV ? -1 : undefined}>
      New request
    </button>
  );
  return (
    <PubFrame>
      <PubLogo sub={subtitle} />
      {children}
      {showNewRequestButton && onNewRequest && (
        <div className="mt-4 text-center">
          {isTV ? <TVFocusable className="inline-block" onEnterPress={onNewRequest}>{newRequest}</TVFocusable> : newRequest}
        </div>
      )}
    </PubFrame>
  );
}
