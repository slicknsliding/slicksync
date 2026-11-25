'use client';

import { useState, type ReactNode } from 'react';
import { ChevronRightIcon, SparklesIcon, Bars3Icon, PlayIcon, RectangleStackIcon } from '@heroicons/react/24/outline';
import { EFFECTS } from '@/lib/effects';
import { arrangeMenu } from '@/lib/adminMenu';
import { useDensity, useEffectChoices, useMenuArrangement, useMotionChoice, useNowPlayingProgress, useNowPlayingWho } from '@/lib/arrange';

// Settings → Themes → Layout: its long run of rows sits in named groups that
// are folded when the page opens. The whole strip is the button. Which ones
// are open is remembered on this device. A folded group's rows stay on the
// page (hidden), so the Settings search still finds them; jumping to one
// opens its group (see the settings page).
const KEY = 'slicksync-settings-folds';

function readOpen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

export function SettingsGroup({ id, icon, title, summary, count, v2 = false, children }: {
  id: string;
  icon: ReactNode;
  title: string;
  /** What it is set to right now, in a few words. */
  summary: string;
  count: number;
  v2?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && readOpen().includes(id));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      const rest = readOpen().filter((x) => x !== id);
      localStorage.setItem(KEY, JSON.stringify(next ? [...rest, id] : rest));
    } catch { /* storage blocked */ }
  };
  return (
    <div className={`set-fold${open ? ' open' : ''}`} data-fold={id}>
      <button type="button" className="set-fold-head" aria-expanded={open} onClick={toggle}>
        <span className="set-fold-ic">{icon}</span>
        <span className="set-fold-name">
          <b className="font-display">{title}</b>
          <span>{summary}</span>
        </span>
        <span className="set-fold-count">{count} settings</span>
        <ChevronRightIcon className="set-fold-chev w-4 h-4" />
      </button>
      <div className={`set-fold-body${v2 ? ' divide-y' : ''}`} data-fold-body="" hidden={!open} style={{ borderColor: 'var(--color-surface-border)' }}>
        {children}
      </div>
    </div>
  );
}

/** A small colored label that splits a long group. */
export function SettingsLabel({ children }: { children: ReactNode }) {
  return <p className="set-label">{children}</p>;
}

type GroupProps = { v2?: boolean; children: ReactNode };

export function EffectsGroup({ v2, children }: GroupProps) {
  const { motion } = useMotionChoice();
  const { choices } = useEffectChoices();
  const on = choices.filter((c) => c.value).length;
  const how = motion === 'reduced' ? 'Motion reduced' : motion === 'full' ? 'Full motion' : 'Motion follows the device';
  return (
    <SettingsGroup id="effects" v2={v2} icon={<SparklesIcon className="w-5 h-5" />} title="Effects and motion" summary={`${how} · ${on} of ${EFFECTS.length} effects on`} count={EFFECTS.length + 1}>
      {children}
    </SettingsGroup>
  );
}

export function MenuGroup({ v2, count, children }: GroupProps & { count: number }) {
  const { menu } = useMenuArrangement();
  const { shown, more } = arrangeMenu(menu);
  return (
    <SettingsGroup id="menu" v2={v2} icon={<Bars3Icon className="w-5 h-5" />} title="Menu" summary={`${shown.length} page${shown.length === 1 ? '' : 's'} in the bar${more.length ? ` · ${more.length} in More` : ''}`} count={count}>
      {children}
    </SettingsGroup>
  );
}

export function WatchGroup({ v2, children }: GroupProps) {
  const { where } = useNowPlayingWho();
  const { where: progress } = useNowPlayingProgress();
  return (
    <SettingsGroup id="watch" v2={v2} icon={<PlayIcon className="w-5 h-5" />} title="Now Playing and Continue Watching" summary={`Names ${where === 'under' ? 'under the picture' : 'on the picture'} · progress ${progress === 'under' ? 'under it' : 'on it'}`} count={8}>
      {children}
    </SettingsGroup>
  );
}

export function PagesGroup({ v2, grid, children }: GroupProps & { grid: boolean }) {
  const { density } = useDensity();
  return (
    <SettingsGroup id="pages" v2={v2} icon={<RectangleStackIcon className="w-5 h-5" />} title="Pages and cards" summary={`${density === 'compact' ? 'Compact' : 'Comfortable'} · ${grid ? 'grid' : 'list'}`} count={6}>
      {children}
    </SettingsGroup>
  );
}
