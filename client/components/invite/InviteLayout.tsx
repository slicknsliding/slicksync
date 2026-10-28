'use client';

import { ReactNode } from 'react';
import { PubFrame, PubLogo } from '@/components/v2/PublicV2';

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
  return (
    <PubFrame>
      <PubLogo sub={subtitle} />
      {children}
      {showNewRequestButton && onNewRequest && (
        <div className="mt-4 text-center">
          <button type="button" className="v2-btn" onClick={onNewRequest}>
            New request
          </button>
        </div>
      )}
    </PubFrame>
  );
}
