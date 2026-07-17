'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { SlickSyncLogo } from '@/components/ui/SlickSyncLogo';
import {
  HomeIcon,
  FilmIcon,
  ClockIcon,
  ShareIcon,
  PuzzlePieceIcon,
  Cog6ToothIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useUserAuth } from '@/lib/hooks/useUserAuth';
import { PanelSwitcher } from '@/components/layout/PanelSwitcher';

interface UserSidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

// User panel navigation
const navigationItems = [
  { name: 'Home', href: '/user', icon: HomeIcon },
  { name: 'Library', href: '/user/library', icon: FilmIcon },
  { name: 'Activity', href: '/user/activity', icon: ClockIcon },
  { name: 'Addons', href: '/user/addons', icon: PuzzlePieceIcon },
  { name: 'Shares', href: '/user/shares', icon: ShareIcon },
  { name: 'Settings', href: '/user/settings', icon: Cog6ToothIcon },
];

interface NavItemProps {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: boolean;
  index: number;
  onNavigate?: () => void;
}

function NavItem({ name, href, icon: Icon, isActive, index, onNavigate }: NavItemProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.03 }}
    >
      <Link
        href={href}
        onClick={onNavigate}
        className="relative flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group"
        style={{
          background: isActive ? 'var(--color-primary-muted)' : 'transparent',
          color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            e.currentTarget.style.background = 'var(--color-surface-hover)';
            e.currentTarget.style.color = 'var(--color-text)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--color-text-muted)';
          }
        }}
      >
        {/* Active indicator */}
        {isActive && (
          <motion.div
            layoutId="userActiveNavIndicator"
            className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r-full"
            style={{ background: 'var(--color-primary)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          />
        )}

        <Icon
          className={`w-[18px] h-[18px] transition-colors ${isActive ? 'text-primary' : ''}`}
        />
        <span className="text-sm font-medium">{name}</span>
      </Link>
    </motion.div>
  );
}

export function UserSidebar({ isOpen = false, onClose }: UserSidebarProps) {
  const pathname = usePathname();
  const { userInfo, logout } = useUserAuth();

  const isItemActive = (href: string) => {
    if (href === '/user') {
      return pathname === '/user';
    }
    return pathname === href || pathname.startsWith(href + '/');
  };

  const handleLogout = () => {
    logout();
    // Redirect to login page
    window.location.href = '/login?mode=user';
  };

  const handleNavigate = () => {
    if (onClose) {
      onClose();
    }
  };

  return (
    <>
      {/* Mobile Backdrop */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/50 z-40 md:hidden"
            onClick={onClose}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        initial={{ x: -280 }}
        animate={{ x: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className={`
          fixed left-0 top-0 bottom-0 w-60 flex flex-col z-50
          md:z-40 md:translate-x-0 md:flex
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        style={{
          background: 'var(--color-surface)',
          borderRight: '1px solid var(--color-surface-border)',
        }}
      >
        {/* Mobile Close Button */}
        <div className="flex items-center justify-between p-4 md:hidden">
          <span className="text-sm font-medium text-muted">Menu</span>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
          >
            <XMarkIcon className="w-5 h-5 text-muted" />
          </button>
        </div>

        {/* Logo */}
        <div
          className="p-5 hidden md:block"
          style={{ borderBottom: '1px solid var(--color-surface-border)' }}
        >
          <Link href="/user" className="flex items-center gap-3">
            <motion.div
              whileHover={{ scale: 1.05 }}
              transition={{ duration: 0.2 }}
              className="w-9 h-9 rounded-lg flex items-center justify-center overflow-hidden"
              style={{ background: 'var(--color-primary)' }}
            >
              <SlickSyncLogo className="w-7 h-7" />
            </motion.div>
            <div>
              <h1 className="text-lg font-bold font-display" style={{ color: 'var(--color-text)' }}>
                SlickSync
              </h1>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto custom-scrollbar">
          {navigationItems.map((item, index) => (
            <NavItem
              key={item.href}
              name={item.name}
              href={item.href}
              icon={item.icon}
              isActive={isItemActive(item.href)}
              index={index}
              onNavigate={handleNavigate}
            />
          ))}
        </nav>

        {/* Panel Switcher */}
        <div
          className="p-3"
          style={{ borderTop: '1px solid var(--color-surface-border)' }}
        >
          <PanelSwitcher
            mode="user"
            userInfo={userInfo}
            onLogout={handleLogout}
          />
        </div>
      </motion.aside>
    </>
  );
}
