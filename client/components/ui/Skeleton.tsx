'use client';

// What a list page shows while it loads: grey outlines laid out like that
// page's real cards (same grid, same card height), so nothing jumps when the
// real ones arrive. Flat on purpose - no shimmer, no pulse, no fade. Colors
// come from the theme tokens (see .sk-* in ideas-lists.css).
//
// The grid classes match what each page draws for real: v2 pages use the
// v2-grid, the Classic design its own per-page grid. A page passes which
// design it is in and the grid/list view it is showing.

export type SkeletonKind = 'people' | 'groups' | 'addons' | 'posters';

type Props = {
  kind: SkeletonKind;
  /** The v2 page design (Classic when false). */
  v2: boolean;
  /** Grid or list, the way the page is set to show its items. */
  view?: 'grid' | 'list';
  /** How many placeholders; a screenful by default. */
  count?: number;
  /** What a screen reader hears, e.g. "Loading users". */
  label: string;
};

// Where each kind's grid comes from, per design, written out in full so
// Tailwind sees every class (nothing is glued together).
const GRID: Record<SkeletonKind, { v2: string; classic: string }> = {
  people: { v2: 'v2-grid', classic: 'user-card-grid' },
  groups: { v2: 'v2-grid v2-grid-3', classic: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6' },
  addons: { v2: 'v2-grid', classic: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6' },
  posters: { v2: 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3', classic: 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-3' },
};

function Bar({ w, h = 12 }: { w: string; h?: number }) {
  return <span className="sk-bar" style={{ width: w, height: h }} />;
}

function Card({ kind, v2 }: { kind: SkeletonKind; v2: boolean }) {
  if (kind === 'posters') return <div className="sk-poster" />;
  if (kind === 'people') {
    return (
      <div className={v2 ? 'sk-card sk-people-v2' : 'sk-card sk-people'}>
        <div className="sk-head"><span className="sk-dot sk-dot-lg" /><div className="sk-stack"><Bar w="55%" h={14} /><Bar w="30%" h={10} /></div></div>
        <Bar w="38%" h={12} />
        <Bar w="75%" h={10} />
      </div>
    );
  }
  if (kind === 'groups') {
    return (
      <div className={v2 ? 'sk-card sk-groups-v2' : 'sk-card sk-groups'}>
        <div className="sk-head"><span className="sk-dot sk-dot-lg sk-round" /><div className="sk-stack"><Bar w="50%" h={14} /><Bar w="70%" h={10} /></div></div>
        <Bar w="35%" h={12} />
        <Bar w="60%" h={10} />
        {v2 && <Bar w="85%" h={10} />}
      </div>
    );
  }
  return (
    <div className={v2 ? 'sk-card sk-addons-v2' : 'sk-card sk-addons'}>
      <div className="sk-head"><span className="sk-dot sk-dot-lg sk-round" /><div className="sk-stack"><Bar w="55%" h={14} /><Bar w="35%" h={10} /></div></div>
      <Bar w="90%" h={10} />
      <Bar w="45%" h={10} />
    </div>
  );
}

function Row({ kind }: { kind: SkeletonKind }) {
  return (
    <div className={kind === 'posters' ? 'sk-row sk-row-tall' : 'sk-row'}>
      <span className="sk-dot" />
      <div className="sk-stack" style={{ flex: 1 }}><Bar w="35%" h={13} /><Bar w="55%" h={10} /></div>
      <Bar w="72px" h={28} />
    </div>
  );
}

export function CardsSkeleton({ kind, v2, view = 'grid', count = 6, label }: Props) {
  const items = Array.from({ length: count }, (_, i) => i);
  if (view === 'list') {
    return (
      <div role="status" aria-label={label} className={v2 ? 'v2-list' : 'sk-list'}>
        {items.map((i) => <Row key={i} kind={kind} />)}
      </div>
    );
  }
  return (
    <div role="status" aria-label={label} className={v2 ? GRID[kind].v2 : GRID[kind].classic}>
      {items.map((i) => <Card key={i} kind={kind} v2={v2} />)}
    </div>
  );
}
