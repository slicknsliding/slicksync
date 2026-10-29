'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { PubCard, PubButton, PubHeading } from '@/components/v2/PublicV2';
import { InviteLayout } from '@/components/invite/InviteLayout';
import { StremioOAuthCard } from '@/components/invite/StremioOAuthCard';
import { StatusCard } from '@/components/invite/StatusCard';
import { inviteApi, InviteApiError } from '@/lib/invite-api';

type DeleteState = 'confirm' | 'oauth' | 'success' | 'error' | 'not-found';

/**
 * User self-deletion page
 * 
 * Allows users to delete their own account by authenticating with Stremio.
 */
export default function DeleteAccountPage() {
  const router = useRouter();
  const [state, setState] = useState<DeleteState>('confirm');
  const [isDeleting, setIsDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Set when SlickSync's side is gone but the addons are still on their Stremio account.
  const [addonsLeft, setAddonsLeft] = useState(false);

  // Handle OAuth completion - delete the user
  const handleAuthKey = async (authKey: string) => {
    setIsDeleting(true);
    setErrorMessage(null);

    try {
      const result = await inviteApi.deleteUser(authKey);
      setAddonsLeft(result?.addonsCleared === false);
      setState('success');
    } catch (error) {
      if (error instanceof InviteApiError) {
        if (error.status === 404) {
          setState('not-found');
          return;
        }
        setErrorMessage(error.message || 'Failed to delete account');
      } else {
        setErrorMessage('An unexpected error occurred');
      }
      setState('error');
    } finally {
      setIsDeleting(false);
    }
  };

  // Handle error from OAuth card
  const handleOAuthError = (message: string) => {
    console.error('OAuth error:', message);
  };

  // Start the deletion flow
  const handleStartDelete = () => {
    setState('oauth');
  };

  // Go back to confirmation
  const handleCancel = () => {
    setState('confirm');
    setErrorMessage(null);
  };

  // Render based on state
  const renderContent = () => {
    switch (state) {
      case 'confirm':
        return (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <PubCard>
              <PubHeading
                title="Leave this household"
                line="Your SlickSync account and what it knows about your watching are removed. This can’t be undone, and you’ll need to ask for access again if you want to rejoin."
              />
              <div className="grid gap-2">
                <PubButton danger onClick={handleStartDelete}>
                  Sign in to confirm
                </PubButton>
                <PubButton onClick={() => router.push('/user')}>
                  Keep my account
                </PubButton>
              </div>
              <p className="mt-4 text-xs text-center" style={{ color: 'var(--color-text-subtle)' }}>
                You&rsquo;ll sign in with Stremio to confirm.
              </p>
            </PubCard>
          </motion.div>
        );

      case 'oauth':
        return (
          <PubCard>
            <StremioOAuthCard
              onAuthKey={handleAuthKey}
              onError={handleOAuthError}
              isCompleting={isDeleting}
              title="Confirm Deletion"
              description="Sign in with Stremio to confirm account deletion."
            />
            <div className="mt-4">
              <PubButton onClick={handleCancel}>Cancel</PubButton>
            </div>
          </PubCard>
        );

      case 'success':
        return (
          <StatusCard type="completed" title="Account Deleted">
            <p>Your account has been successfully deleted.</p>
            {addonsLeft && (
              <p className="mt-2">
                We couldn&apos;t remove the SlickSync addons from your Stremio account, so they are still there.
                To take them off yourself, open Stremio&apos;s Addons page and uninstall the ones SlickSync added.
              </p>
            )}
            <p className="mt-2 opacity-75">
              Thank you for using SlickSync. You can request access again if you change your mind.
            </p>
          </StatusCard>
        );

      case 'not-found':
        return (
          <StatusCard type="not-found" title="Account Not Found">
            <p>No account was found for this Stremio user.</p>
            <p className="mt-2 opacity-75">
              The account may have already been deleted.
            </p>
          </StatusCard>
        );

      case 'error':
        return (
          <StatusCard 
            type="error" 
            title="Deletion Failed"
            footer={
              <PubButton onClick={handleCancel}>Try Again</PubButton>
            }
          >
            <p>{errorMessage || 'An error occurred while deleting your account.'}</p>
            <p className="mt-2 opacity-75">
              Please try again or contact the administrator.
            </p>
          </StatusCard>
        );

      default:
        return null;
    }
  };

  return (
    <InviteLayout subtitle="Removing your account">
      {renderContent()}
    </InviteLayout>
  );
}
