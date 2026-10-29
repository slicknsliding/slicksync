'use client';

// Themes → Layout: the small personal settings - how tight the pages are,
// where Now Playing shows who is watching, which page SlickSync opens on,
// and whether pages keep their filter. All
// saved to the account; each has a plain default.

import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useCwTime, useDensity, useFoldArrows, useKeepFilters, useNameFolds, useNowPlayingProgress, useNowPlayingWho, useStartPage } from '@/lib/arrange';
import { ADMIN_MENU } from '@/lib/adminMenu';
import { V2SetRow, V2Seg, V2Switch, V2_SELECT_CLASS } from '@/components/v2/SettingsV2';

const START_PAGES = [...ADMIN_MENU.map((i) => ({ href: i.href, label: i.label })), { href: '/tasks', label: 'Tasks' }];

export function PersonalTouches({ v2 = false }: { v2?: boolean } = {}) {
  const { density, setDensity } = useDensity();
  const { startPage, setStartPage } = useStartPage();
  const { keep, setKeep } = useKeepFilters();
  const { where, setWhere } = useNowPlayingWho();
  const { where: cwWhere, setWhere: setCwWhere } = useCwTime();
  const { where: npProgress, setWhere: setNpProgress } = useNowPlayingProgress();
  const { shown: arrows, setShown: setArrows } = useFoldArrows();
  const { on: nameTap, setOn: setNameTap } = useNameFolds();
  // The v2 Settings draws these as rows.
  if (v2) {
    return (
      <>
        <V2SetRow
          title="Density"
          line="Compact fits more cards and rows on screen"
          control={<V2Seg<'comfortable' | 'compact'> label="Density" value={density as 'comfortable' | 'compact'} options={[{ id: 'comfortable' as const, label: 'Comfortable' }, { id: 'compact' as const, label: 'Compact' }]} onChange={setDensity} />}
        />
        <V2SetRow
          title="Now Playing"
          line="Who’s watching: under the picture, or on it"
          control={<V2Seg<'under' | 'on'> label="Now Playing" value={where} options={[{ id: 'under' as const, label: 'Under' }, { id: 'on' as const, label: 'On the picture' }]} onChange={setWhere} />}
        />
        <V2SetRow
          title="Now Playing progress"
          line="How far in and when it ends: on the picture, or under it"
          control={<V2Seg<'on' | 'under'> label="Now Playing progress" value={npProgress} options={[{ id: 'on' as const, label: 'On the picture' }, { id: 'under' as const, label: 'Under' }]} onChange={setNpProgress} />}
        />
        <V2SetRow
          title="Fold arrows"
          line="The arrow beside each section’s name. Hidden by default; they always show while arranging"
          control={<V2Seg<'show' | 'hide'> label="Fold arrows" value={arrows} options={[{ id: 'show' as const, label: 'Show' }, { id: 'hide' as const, label: 'Hide' }]} onChange={setArrows} />}
        />
        <V2SetRow
          title="Tap a name to fold"
          line="Tapping a section’s name, its count or “folded” folds and unfolds it"
          control={<V2Seg<'on' | 'off'> label="Tap a name to fold" value={nameTap ? 'on' : 'off'} options={[{ id: 'on' as const, label: 'On' }, { id: 'off' as const, label: 'Off' }]} onChange={(v) => setNameTap(v === 'on')} />}
        />
        <V2SetRow
          title="Continue Watching"
          line="Time left: on the picture, or under it with the episode name"
          control={<V2Seg<'on' | 'under'> label="Continue Watching time left" value={cwWhere} options={[{ id: 'on' as const, label: 'On the picture' }, { id: 'under' as const, label: 'Under' }]} onChange={setCwWhere} />}
        />
        <V2SetRow
          title="Start page"
          line="Where SlickSync opens when you come back"
          control={(
            <select value={startPage} onChange={(e) => setStartPage(e.target.value)} className={V2_SELECT_CLASS} aria-label="Start page">
              {START_PAGES.map((p) => <option key={p.href} value={p.href}>{p.label}</option>)}
            </select>
          )}
        />
        <V2SetRow
          title="Keep each page’s filter"
          line="Users, Addons and the Vault open on the filter you last picked"
          control={<V2Switch on={keep} onChange={setKeep} label="Keep each page’s filter" />}
        />
      </>
    );
  }
  return (
    <div className="mt-5 rounded-xl p-4 space-y-4" style={{ border: '1px solid var(--color-surface-border)' }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Density</p>
          <p className="text-xs text-muted">Compact fits more cards and rows on screen</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Density">
          {(['comfortable', 'compact'] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={density === d} className={density === d ? 'on' : ''} onClick={() => setDensity(d)}>
              {d === 'comfortable' ? 'Comfortable' : 'Compact'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Now Playing</p>
          <p className="text-xs text-muted">Who’s watching: under the picture, or on it</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Now Playing">
          {(['under', 'on'] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={where === w} className={where === w ? 'on' : ''} onClick={() => setWhere(w)}>
              {w === 'under' ? 'Under' : 'On the picture'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Now Playing progress</p>
          <p className="text-xs text-muted">How far in and when it ends: on the picture, or under it</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Now Playing progress">
          {(['on', 'under'] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={npProgress === w} className={npProgress === w ? 'on' : ''} onClick={() => setNpProgress(w)}>
              {w === 'under' ? 'Under' : 'On the picture'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Fold arrows</p>
          <p className="text-xs text-muted">The arrow beside each section’s name. Hidden by default; they always show while arranging</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Fold arrows">
          {(['show', 'hide'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={arrows === v} className={arrows === v ? 'on' : ''} onClick={() => setArrows(v)}>
              {v === 'show' ? 'Show' : 'Hide'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Tap a name to fold</p>
          <p className="text-xs text-muted">Tapping a section’s name, its count or “folded” folds and unfolds it</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Tap a name to fold">
          {([true, false] as const).map((v) => (
            <button key={String(v)} type="button" role="radio" aria-checked={nameTap === v} className={nameTap === v ? 'on' : ''} onClick={() => setNameTap(v)}>
              {v ? 'On' : 'Off'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Continue Watching</p>
          <p className="text-xs text-muted">Time left: on the picture, or under it with the episode name</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Continue Watching time left">
          {(['on', 'under'] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={cwWhere === w} className={cwWhere === w ? 'on' : ''} onClick={() => setCwWhere(w)}>
              {w === 'under' ? 'Under' : 'On the picture'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Start page</p>
          <p className="text-xs text-muted">Where SlickSync opens when you come back</p>
        </div>
        <select
          value={startPage}
          onChange={(e) => setStartPage(e.target.value)}
          className="input-base px-3 py-2 text-sm rounded-lg"
          style={{ width: '11rem', background: 'var(--color-surface-hover)', color: 'var(--color-text)', border: '1px solid var(--color-surface-border)' }}
          aria-label="Start page"
        >
          {START_PAGES.map((p) => <option key={p.href} value={p.href}>{p.label}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-default">Keep each page&apos;s filter</p>
          <p className="text-xs text-muted">Users, Addons and the Vault open on the filter you last picked</p>
        </div>
        <ToggleSwitch checked={keep} onChange={() => setKeep(!keep)} />
      </div>
    </div>
  );
}
