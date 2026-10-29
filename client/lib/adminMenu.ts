// The admin pages' menu: one list, in Top Navi's default order, that both the
// top bar (NebulaTopbar) and the Original sidebar arrange from. The account's
// own arrangement (Themes → Layout → Arrange the menu) reorders it and moves
// hidden pages into More; with no arrangement, each bar keeps its own default.

import type { ComponentType } from 'react';
import {
  HomeIcon, MagnifyingGlassIcon, ClockIcon, ChartBarIcon, UsersIcon, UserGroupIcon,
  PuzzlePieceIcon, ShieldCheckIcon, EnvelopeIcon, RectangleStackIcon,
} from '@heroicons/react/24/outline';
import { arrangeKeys, type MenuArrangement } from '@/lib/arrange-core';

export type MenuItem = { href: string; label: string; icon: ComponentType<{ className?: string }> };

export const ADMIN_MENU: MenuItem[] = [
  { href: '/', label: 'Dashboard', icon: HomeIcon },
  { href: '/activity', label: 'Activity', icon: ClockIcon },
  { href: '/metrics', label: 'Metrics', icon: ChartBarIcon },
  { href: '/users', label: 'Users', icon: UsersIcon },
  { href: '/groups', label: 'Groups', icon: UserGroupIcon },
  { href: '/discover', label: 'Discover', icon: MagnifyingGlassIcon },
  { href: '/catalogs', label: 'Catalogs', icon: RectangleStackIcon },
  { href: '/addons', label: 'Addons', icon: PuzzlePieceIcon },
  { href: '/vault', label: 'Vault', icon: ShieldCheckIcon },
  { href: '/invitations', label: 'Invitations', icon: EnvelopeIcon },
];

/** Whether the menu has been arranged at all (order or hidden pages). */
export function menuIsArranged(menu: MenuArrangement) {
  return !!(menu.order?.length || menu.hidden?.length);
}

/** The menu in the arranged order, split into the bar and More. */
export function arrangeMenu(menu: MenuArrangement, items: MenuItem[] = ADMIN_MENU) {
  const byHref = new Map(items.map((i) => [i.href, i]));
  const { shown, hidden } = arrangeKeys(items.map((i) => i.href), { order: menu.order, hidden: menu.hidden });
  return {
    shown: shown.map((h) => byHref.get(h)!),
    more: menu.more === false ? [] : hidden.map((h) => byHref.get(h)!),
  };
}
