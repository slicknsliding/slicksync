'use client';

// A person's own pages in the Original layout: the same sidebar the admin
// pages use, with their links and their account at its foot.

import { usePathname } from 'next/navigation';
import { HomeIcon, FilmIcon, ClockIcon, ShareIcon, PuzzlePieceIcon, Cog6ToothIcon } from '@heroicons/react/24/outline';
import { SidebarFrame } from '@/components/layout/Sidebar';
import { PanelSwitcher } from '@/components/layout/PanelSwitcher';
import { useUserAuth } from '@/lib/hooks/useUserAuth';

const ITEMS = [
  { name: 'Home', href: '/user', icon: HomeIcon },
  { name: 'Library', href: '/user/library', icon: FilmIcon },
  { name: 'Activity', href: '/user/activity', icon: ClockIcon },
  { name: 'Addons', href: '/user/addons', icon: PuzzlePieceIcon },
  { name: 'Shares', href: '/user/shares', icon: ShareIcon },
  { name: 'Settings', href: '/user/settings', icon: Cog6ToothIcon },
];

export function PersonSidebar() {
  const pathname = usePathname() || '/user';
  const { userInfo, logout, provider } = useUserAuth();
  // A Jellyfin sign-in has no addon list of its own (same as the top bar).
  const items = ITEMS.filter((i) => provider !== 'jellyfin' || i.href !== '/user/addons');
  const isItemActive = (href: string) => (href === '/user' ? pathname === '/user' : pathname === href || pathname.startsWith(href + '/'));
  const handleLogout = () => {
    logout();
    window.location.href = '/login?mode=user';
  };
  return (
    <div className="hidden md:block">
      <SidebarFrame
        sections={[{ id: 'mine', label: 'My space', items }]}
        homeHref="/user"
        isItemActive={isItemActive}
        account={<PanelSwitcher mode="user" userInfo={userInfo} onLogout={handleLogout} />}
      />
    </div>
  );
}
