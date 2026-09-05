'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  UserIcon,
  ShieldCheckIcon,
  ArrowRightOnRectangleIcon,
  ChevronDownIcon,
  ArrowsRightLeftIcon,
  Cog6ToothIcon,
  NewspaperIcon,
  QueueListIcon,
  SwatchIcon,
} from '@heroicons/react/24/outline';
import { Avatar } from '@/components/ui';
import { AccountModal } from './AccountModal';
import { useLayoutMode } from '@/lib/layout-mode';

interface PanelSwitcherProps {
  /** Current panel mode */
  mode: 'admin' | 'user';
  /** User info for display (optional) */
  userInfo?: {
    username?: string;
    email?: string | null;
    colorIndex?: number;
    uuid?: string | null;
    linkedProvider?: 'stremio' | 'nuvio' | null;
    avatarUrl?: string | null;
  } | null;
  /** Called when logout is clicked */
  onLogout?: () => void;
  /** Whether the component is collapsed (for sidebar) */
  collapsed?: boolean;
  /** 'compact' renders a small icon-only trigger (topbar use) instead of the
   *  full-width name/email row the sidebar uses. */
  variant?: 'full' | 'compact';
  /** Sidebar trigger sits at the bottom of the screen, so its dropdown opens
   *  upward ('up', the default). A topbar trigger sits at the top, so it
   *  needs the dropdown to open downward instead - otherwise it renders
   *  off the top of the viewport. */
  dropdownPosition?: 'up' | 'down';
  /** Which edge of the compact trigger the dropdown's own edge anchors to.
   *  'right' (default) suits a trigger near the right edge of the screen -
   *  the menu opens leftward, staying on-screen. A trigger near the left
   *  edge (e.g. Nebula's bottom-left account button) needs 'left' instead,
   *  or the menu opens leftward off the edge of the viewport. Only affects
   *  variant="compact" - the full-width sidebar trigger always spans
   *  left-0 right-0 regardless. */
  align?: 'left' | 'right';
}

/**
 * Panel switcher component for switching between Admin and User panels
 * Appears in the sidebar of both panels
 */
export function PanelSwitcher({ mode, userInfo, onLogout, collapsed = false, variant = 'full', dropdownPosition = 'up', align = 'right' }: PanelSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  const handleSwitchPanel = async () => {
    if (mode === 'admin') {
      setIsOpen(false);
      // Switching from Admin to User
      // Check if user is logged in (has auth in localStorage)
      const userAuth = localStorage.getItem('slicksync-user-auth');
      if (userAuth) {
        try {
          const data = JSON.parse(userAuth);
          // Nuvio sessions have no client-held authKey (see useUserAuth.tsx) -
          // userId + provider:'nuvio' is a valid session on its own.
          if (data.userId && (data.authKey || data.provider === 'nuvio')) {
            window.location.href = '/user';
            return;
          }
        } catch { }
      }
      // Not logged in as user, go to login
      window.location.href = '/login?mode=user';
    } else {
      // Switching from User to Admin
      // Check if admin is logged in (localStorage)
      const adminToken = localStorage.getItem('slicksync-admin-token');
      if (adminToken) {
        setIsOpen(false);
        window.location.href = '/';
        return;
      }

      // If no token, verify session via API (cookie check) to avoid login page flash
      try {
        const response = await fetch('/api/ext/account');
        if (response.ok) {
          setIsOpen(false);
          window.location.href = '/';
          return;
        }
      } catch { }

      // Not logged in as admin, go to login
      setIsOpen(false);
      window.location.href = '/login?mode=admin';
    }
  };

  const handleLogout = () => {
    setIsOpen(false);
    onLogout?.();
  };

  const isAdmin = mode === 'admin';
  const isPublicInstance = (process.env.NEXT_PUBLIC_INSTANCE_TYPE || 'private') === 'public';
  // Original layout's own Sidebar already has a "System" section with Tasks/
  // Settings/Changelog directly in the nav - only Nebula moved them
  // into this dropdown, specifically because its topbar has no room to
  // spare for a fourth nav row. Showing them here too on Original was pure
  // duplication of something already one click away in the sidebar.
  const { layoutMode } = useLayoutMode();
  const showSystemLinks = layoutMode === 'nebula';
  const targetPanel = isAdmin ? 'User' : 'Admin';
  const TargetIcon = isAdmin ? UserIcon : ShieldCheckIcon;
  const isCompact = variant === 'compact';

  return (
    <div className="relative" ref={menuRef}>
      {/* Trigger Button */}
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => setIsOpen(!isOpen)}
        className={isCompact
          ? 'flex items-center justify-center w-9 h-9 rounded-lg transition-all duration-200'
          : 'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200'}
        style={{
          background: isOpen ? 'var(--color-surface-elevated)' : 'transparent',
          color: 'var(--color-text)',
        }}
        onMouseEnter={(e) => {
          if (!isOpen) {
            e.currentTarget.style.background = 'var(--color-surface-hover)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isOpen) {
            e.currentTarget.style.background = 'transparent';
          }
        }}
      >
        {/* Current Mode Icon */}
        <div
          className="flex-shrink-0"
        >
          {isAdmin ? (
            userInfo ? (
              <Avatar
                name={userInfo.username || 'A'}
                src={userInfo.avatarUrl || undefined}
                email={userInfo.email || undefined}
                size="sm"
                className="w-8 h-8"
                avatarClassName="rounded-lg"
                fallbackIcon={<ShieldCheckIcon className="w-4 h-4" style={{ color: 'white' }} />}
              />
            ) : (
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--color-primary-muted)' }}
              >
                <ShieldCheckIcon className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
              </div>
            )
          ) : (
            userInfo ? (
              <Avatar
                name={userInfo.username || 'U'}
                email={userInfo.email || undefined}
                colorIndex={userInfo.colorIndex || 0}
                size="sm"
                className="w-8 h-8"
                avatarClassName="rounded-lg"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--color-success-muted)' }}
              >
                <UserIcon className="w-4 h-4" style={{ color: 'var(--color-success)' }} />
              </div>
            )
          )}
        </div>

        {!collapsed && !isCompact && (
          <>
            <div className="flex-1 text-left min-w-0">
              <p className="text-sm font-medium truncate">
                {isAdmin ? (userInfo?.username || 'Admin Panel') : (userInfo?.username || 'User Panel')}
              </p>
              <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                {isAdmin ? (userInfo?.email || 'Administrator') : (userInfo?.email || 'Signed in')}
              </p>
            </div>

            <ChevronDownIcon
              className={`w-4 h-4 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
              style={{ color: 'var(--color-text-muted)' }}
            />
          </>
        )}
      </motion.button>

      {/* Dropdown Menu */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: dropdownPosition === 'down' ? 10 : -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: dropdownPosition === 'down' ? 10 : -10, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className={
              `absolute rounded-xl overflow-hidden shadow-xl z-50 ${dropdownPosition === 'down' ? 'top-full mt-2' : 'bottom-full mb-2'} ${
                isCompact ? `${align === 'left' ? 'left-0' : 'right-0'} w-72` : 'left-0 right-0'
              }`
            }
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-surface-border)',
            }}
          >
            {/* Switch Panel Button */}
            <button
              onClick={handleSwitchPanel}
              className="w-full flex items-center gap-3 px-4 py-3 transition-all duration-200"
              style={{ color: 'var(--color-text)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--color-surface-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{
                  background: isAdmin ? 'var(--color-success-muted)' : 'var(--color-primary-muted)',
                }}
              >
                <TargetIcon
                  className="w-4 h-4"
                  style={{ color: isAdmin ? 'var(--color-success)' : 'var(--color-primary)' }}
                />
              </div>
              <div className="flex-1 text-left">
                <p className="text-sm font-medium">Switch to {targetPanel} Panel</p>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {isAdmin ? 'Access your library and settings' : 'Manage users and system'}
                </p>
              </div>
              <ArrowsRightLeftIcon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
            </button>

            {/* TorBox referral - always shown for both layouts (previously a
                floating badge fixed to a screen corner, which needed its own
                positioning/sizing pass on every layout and viewport size and
                still read inconsistently across deployments - one stable
                spot here instead). Tasks/Settings/Changelog below are (Themes now
                lives inside Settings as its own section)
                Nebula's "System" group, dropped from its topbar entirely
                since there's no room to spare there - Original's own
                Sidebar already has these same 4 directly in the nav, so
                showing them here too on Original was pure duplication. */}
            {isAdmin && (
              <>
                <div className="h-px" style={{ background: 'var(--color-surface-border)' }} />
                <a
                  href="https://torbox.app/subscription?referral=790ccd5b-646d-43d7-9072-aef7a6eb1de8"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setIsOpen(false)}
                  className="nav-item-hover-pill w-full flex items-center gap-3 px-4 py-3 rounded-lg"
                  style={{ color: 'var(--color-text)' }}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center p-1.5"
                    style={{ background: 'var(--color-surface-hover)' }}
                  >
                    <img src="https://torbox.app/assets/logo-bb7a9579.svg" alt="TorBox" className="w-full h-full" />
                  </div>
                  <span className="nav-item-label text-sm font-medium">Torbox Referral</span>
                </a>
                {showSystemLinks && (
                  <>
                    <button
                      onClick={() => { setIsOpen(false); router.push('/tasks'); }}
                      className="nav-item-hover-pill w-full flex items-center gap-3 px-4 py-3 rounded-lg"
                      style={{ color: 'var(--color-text)' }}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ background: 'var(--color-surface-hover)' }}
                      >
                        <QueueListIcon className="nav-item-icon w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                      </div>
                      <span className="nav-item-label text-sm font-medium">Tasks</span>
                    </button>
                    <button
                      onClick={() => { setIsOpen(false); router.push('/settings'); }}
                      className="nav-item-hover-pill w-full flex items-center gap-3 px-4 py-3 rounded-lg"
                      style={{ color: 'var(--color-text)' }}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ background: 'var(--color-surface-hover)' }}
                      >
                        <Cog6ToothIcon className="nav-item-icon w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                      </div>
                      <span className="nav-item-label text-sm font-medium">Settings</span>
                    </button>
                    <button
                      onClick={() => { setIsOpen(false); router.push('/changelog'); }}
                      className="nav-item-hover-pill w-full flex items-center gap-3 px-4 py-3 rounded-lg"
                      style={{ color: 'var(--color-text)' }}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ background: 'var(--color-surface-hover)' }}
                      >
                        <NewspaperIcon className="nav-item-icon w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                      </div>
                      <span className="nav-item-label text-sm font-medium">Changelog</span>
                    </button>
                  </>
                )}
              </>
            )}

            {/* Account Button (Admin Mode / Public Instance only) */}
            {isAdmin && isPublicInstance && (
              <>
                <div className="h-px" style={{ background: 'var(--color-surface-border)' }} />
                <button
                  onClick={() => { setIsOpen(false); setAccountModalOpen(true); }}
                  className="w-full flex items-center gap-3 px-4 py-3 transition-all duration-200"
                  style={{ color: 'var(--color-text)' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-surface-hover)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{ background: 'var(--color-surface-hover)' }}
                  >
                    <Cog6ToothIcon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-sm font-medium">Account</p>
                    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Manage login methods</p>
                  </div>
                </button>
              </>
            )}

            {/* Divider */}
            <div className="h-px" style={{ background: 'var(--color-surface-border)' }} />

            {/* Logout Button */}
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-3 transition-all duration-200"
              style={{ color: 'var(--color-error)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--color-error-muted)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--color-error-muted)' }}
              >
                <ArrowRightOnRectangleIcon className="w-4 h-4" style={{ color: 'var(--color-error)' }} />
              </div>
              <span className="text-sm font-medium">Logout</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Account Modal */}
      {isAdmin && isPublicInstance && (
        <AccountModal
          isOpen={accountModalOpen}
          onClose={() => setAccountModalOpen(false)}
          accountInfo={{
            uuid: userInfo?.uuid,
            email: userInfo?.email,
            linkedProvider: userInfo?.linkedProvider,
          }}
          onAccountUpdated={() => {
            // Refresh page to update account info
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}
