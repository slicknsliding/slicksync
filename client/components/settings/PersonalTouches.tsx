'use client';

// Themes → Layout: the small personal settings - how tight the pages are,
// where Now Playing shows who is watching, which page SlickSync opens on,
// and whether pages keep their filter. All
// saved to the account; each has a plain default.

import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useCardBackground, useCwFirst, useOutNow, useCwProgress, useCwTime, useCwWho, useDensity, useMotionChoice, useFoldArrows, useKeepFilters, useNameFolds, useNowPlayingProgress, useNowPlayingWho, useStartPage } from '@/lib/arrange';
import { ADMIN_MENU } from '@/lib/adminMenu';
import { V2SetRow, V2Seg, V2Switch, V2_SELECT_CLASS } from '@/components/v2/SettingsV2';

const START_PAGES = [...ADMIN_MENU.map((i) => ({ href: i.href, label: i.label })), { href: '/tasks', label: 'Tasks' }];

const MOTION_OPTIONS = [
  { id: 'device' as const, label: 'Device' },
  { id: 'reduced' as const, label: 'Reduced' },
  { id: 'full' as const, label: 'Full' },
];
const MOTION_LINE = 'Device follows your phone or computer’s reduce-motion setting. Reduced stops sliding, zooming and shimmering.';

/** Themes → Layout → Motion, saved to the account. */
export function MotionRow({ v2 = false }: { v2?: boolean }) {
  const { motion, setMotion } = useMotionChoice();
  if (v2) {
    return (
      <V2SetRow
        title="Motion"
        line={MOTION_LINE}
        control={<V2Seg<'device' | 'reduced' | 'full'> label="Motion" value={motion} options={MOTION_OPTIONS} onChange={setMotion} />}
      />
    );
  }
  return (
    <div className="mt-5 rounded-xl p-4" style={{ border: '1px solid var(--color-surface-border)' }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Motion</p>
          <p className="text-xs text-muted">{MOTION_LINE}</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Motion">
          {MOTION_OPTIONS.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={motion === o.id} className={motion === o.id ? 'on' : ''} onClick={() => setMotion(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PersonalTouches({ v2 = false }: { v2?: boolean } = {}) {
  const { density, setDensity } = useDensity();
  const { startPage, setStartPage } = useStartPage();
  const { keep, setKeep } = useKeepFilters();
  const { where, setWhere } = useNowPlayingWho();
  const { where: cwWhere, setWhere: setCwWhere } = useCwTime();
  const { where: cwWho, setWhere: setCwWho } = useCwWho();
  const { where: cwProgress, setWhere: setCwProgress } = useCwProgress();
  const { first: cwFirst, setFirst: setCwFirst } = useCwFirst();
  const { place: outNow, setPlace: setOutNow } = useOutNow();
  const { bg: cardBg, setBg: setCardBg } = useCardBackground();
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
          title="Continue Watching"
          line="Who’s watching: under the card, or on its picture"
          control={<V2Seg<'under' | 'on'> label="Continue Watching" value={cwWho} options={[{ id: 'under' as const, label: 'Under' }, { id: 'on' as const, label: 'On the picture' }]} onChange={setCwWho} />}
        />
        <V2SetRow
          title="Continue Watching progress"
          line="How far in and where they stopped: on the picture, or under it"
          control={<V2Seg<'on' | 'under'> label="Continue Watching progress" value={cwProgress} options={[{ id: 'on' as const, label: 'On the picture' }, { id: 'under' as const, label: 'Under' }]} onChange={setCwProgress} />}
        />
        <V2SetRow
          title="Continue Watching time left"
          line="Time left: on the picture, or under it with the episode name"
          control={<V2Seg<'on' | 'under'> label="Continue Watching time left" value={cwWhere} options={[{ id: 'on' as const, label: 'On the picture' }, { id: 'under' as const, label: 'Under' }]} onChange={setCwWhere} />}
        />
        <V2SetRow
          title="Continue Watching first card"
          line="The latest title: one wide banner, or the same size as the rest"
          control={<V2Seg<'wide' | 'same'> label="Continue Watching first card" value={cwFirst} options={[{ id: 'wide' as const, label: 'Wide' }, { id: 'same' as const, label: 'Same size' }]} onChange={setCwFirst} />}
        />
        <V2SetRow
          title="Out now"
          line="An episode that is out: a tag in the card’s corner, or a label above the poster"
          control={<V2Seg<'corner' | 'above'> label="Out now" value={outNow} options={[{ id: 'corner' as const, label: 'Corner' }, { id: 'above' as const, label: 'Above the poster' }]} onChange={setOutNow} />}
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
          title="Card backgrounds"
          line="Continue Watching and Coming up: the show’s picture behind the words, or a plain background that’s easier to read"
          control={<V2Seg<'picture' | 'plain'> label="Card backgrounds" value={cardBg} options={[{ id: 'picture' as const, label: 'Picture' }, { id: 'plain' as const, label: 'Plain' }]} onChange={setCardBg} />}
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
          <p className="font-medium text-sm text-default">Card backgrounds</p>
          <p className="text-xs text-muted">Continue Watching and Coming up: the show’s picture behind the words, or a plain background that’s easier to read</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Card backgrounds">
          {(['picture', 'plain'] as const).map((b) => (
            <button key={b} type="button" role="radio" aria-checked={cardBg === b} className={cardBg === b ? 'on' : ''} onClick={() => setCardBg(b)}>
              {b === 'picture' ? 'Picture' : 'Plain'}
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
          <p className="font-medium text-sm text-default">Continue Watching</p>
          <p className="text-xs text-muted">Who’s watching: under the card, or on its picture</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Continue Watching">
          {(['under', 'on'] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={cwWho === w} className={cwWho === w ? 'on' : ''} onClick={() => setCwWho(w)}>
              {w === 'under' ? 'Under' : 'On the picture'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Continue Watching progress</p>
          <p className="text-xs text-muted">How far in and where they stopped: on the picture, or under it</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Continue Watching progress">
          {(['on', 'under'] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={cwProgress === w} className={cwProgress === w ? 'on' : ''} onClick={() => setCwProgress(w)}>
              {w === 'on' ? 'On the picture' : 'Under'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Continue Watching time left</p>
          <p className="text-xs text-muted">Time left: on the picture, or under it with the episode name</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Continue Watching time left">
          {(['on', 'under'] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={cwWhere === w} className={cwWhere === w ? 'on' : ''} onClick={() => setCwWhere(w)}>
              {w === 'on' ? 'On the picture' : 'Under'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Continue Watching first card</p>
          <p className="text-xs text-muted">The latest title: one wide banner, or the same size as the rest</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Continue Watching first card">
          {(['wide', 'same'] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={cwFirst === w} className={cwFirst === w ? 'on' : ''} onClick={() => setCwFirst(w)}>
              {w === 'wide' ? 'Wide' : 'Same size'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex-1 min-w-[12rem]">
          <p className="font-medium text-sm text-default">Out now</p>
          <p className="text-xs text-muted">An episode that is out: a tag in the card’s corner, or a label above the poster</p>
        </div>
        <div className="menu-seg" role="radiogroup" aria-label="Out now">
          {(['corner', 'above'] as const).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={outNow === w} className={outNow === w ? 'on' : ''} onClick={() => setOutNow(w)}>
              {w === 'corner' ? 'Corner' : 'Above the poster'}
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
