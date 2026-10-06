'use client';

// A person's own pages get the same top bar as the admin pages (NebulaBar),
// with their own rows - Home, Library, Activity, Addons, Shares, Settings -
// instead of the side menu they used to have. Addons is left out for
// Jellyfin, AIOStreams and AIOMetadata people, who have no addon list here.

import {
  HomeIcon,
  FilmIcon,
  ClockIcon,
  ShareIcon,
  PuzzlePieceIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';
import { NebulaBar, type NebulaNavSection } from '@/components/layout/NebulaBar';
import { PanelSwitcher } from '@/components/layout/PanelSwitcher';
import { useUserAuth } from '@/lib/hooks/useUserAuth';
import { useUserMobileMenu } from '@/lib/hooks/useUserMobileMenu';

const ITEMS: NebulaNavSection['items'] = [
  { href: '/user', label: 'Home', icon: HomeIcon },
  { href: '/user/library', label: 'Library', icon: FilmIcon },
  { href: '/user/activity', label: 'Activity', icon: ClockIcon },
  { href: '/user/addons', label: 'Addons', icon: PuzzlePieceIcon },
  { href: '/user/shares', label: 'Shares', icon: ShareIcon },
  { href: '/user/settings', label: 'Settings', icon: Cog6ToothIcon },
];

export function PersonTopbar() {
  const { userInfo, logout, provider } = useUserAuth();
  const menu = useUserMobileMenu();
  const sections: NebulaNavSection[] = [
    { id: 'person', items: ITEMS.filter((item) => provider !== 'jellyfin' || item.href !== '/user/addons') },
  ];

  const handleLogout = () => {
    logout();
    window.location.href = '/login?mode=user';
  };

  return (
    <NebulaBar
      sections={sections}
      homeHref="/user"
      menu={menu}
      account={<PanelSwitcher mode="user" userInfo={userInfo} onLogout={handleLogout} variant="compact" align="left" />}
    />
  );
}
