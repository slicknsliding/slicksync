'use client';

import { useState, type ComponentType } from 'react';
import {
  ChevronDownIcon, UserIcon, ServerStackIcon, UserCircleIcon, FilmIcon, CheckCircleIcon, CalendarDaysIcon,
  LinkIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/Toast';

/** Everything the Activity feed can be narrowed by. '' means "any". */
export interface ActivityFilters {
  person: string;
  source: string;
  profile: string;
  kind: string;
  status: string;
  when: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: ActivityFilters = { person: '', source: '', profile: '', kind: '', status: '', when: '', from: '', to: '' };

const KEYS = Object.keys(EMPTY_FILTERS) as (keyof ActivityFilters)[];

/** Labels a viewing can carry that say where it came from rather than which Nuvio profile. */
export const SOURCE_LABELS: Record<string, string> = { AIOStreams: 'aiostreams', Imported: 'imported', Scrobbled: 'scrobbled' };

export const SOURCE_NAMES: Record<string, string> = {
  stremio: 'Stremio', nuvio: 'Nuvio', aiostreams: 'AIOStreams', imported: 'Imported', scrobbled: 'Scrobbled',
};

/** Where one viewing came from: a special label first, otherwise the person's provider. */
export function sourceOf(profileLabel: string | undefined, provider: string | undefined) {
  if (profileLabel && SOURCE_LABELS[profileLabel]) return SOURCE_LABELS[profileLabel];
  return provider === 'nuvio' ? 'nuvio' : 'stremio';
}

export function hasAnyFilter(f: ActivityFilters) {
  return KEYS.some((k) => !!f[k]);
}

/** Filters named in the address, so a filtered feed can be shared as a link. */
export function filtersFromParams(params: URLSearchParams): ActivityFilters | null {
  const out = { ...EMPTY_FILTERS };
  let any = false;
  for (const k of KEYS) {
    const v = params.get(k);
    if (v) { out[k] = v; any = true; }
  }
  // The dashboard's stat cards link here with ?period=today|week.
  const period = params.get('period');
  if (!out.when && (period === 'today' || period === 'week')) { out.when = period; any = true; }
  return any ? out : null;
}

export function filtersToParams(f: ActivityFilters, current: URLSearchParams) {
  const next = new URLSearchParams(current.toString());
  next.delete('period');
  for (const k of KEYS) {
    if (f[k] && (k !== 'from' && k !== 'to' || f.when === 'custom')) next.set(k, f[k]);
    else next.delete(k);
  }
  return next;
}

interface Option { value: string; label: string }

function Pill({ icon: Icon, label, value, options, onChange }: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  const active = !!value;
  const shown = options.find((o) => o.value === value)?.label || options[0]?.label || label;
  // The real dropdown is stretched invisibly over the whole pill, so a tap
  // anywhere on it - icon, text or arrow - opens the list.
  return (
    <div
      className={`relative inline-flex items-center gap-1.5 rounded-full border pl-3 pr-8 py-1.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-primary/60 ${
        active ? 'border-primary/60 bg-primary/15 text-default' : 'border-default bg-surface text-muted hover:text-default hover:bg-surface-hover'
      }`}
    >
      <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-primary' : ''}`} />
      <span className="truncate max-w-[11rem]">{shown}</span>
      <ChevronDownIcon className="w-3.5 h-3.5 absolute right-3 pointer-events-none" />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer appearance-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)' }}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * The Activity feed's filters: who, where it came from, which profile, what
 * kind, finished or not, and when. Each only offers what the feed actually
 * holds, and the page keeps them in the address so a view can be shared.
 */
export function ActivityFilterBar({ value, onChange, people, sources, profiles }: {
  value: ActivityFilters;
  onChange: (next: ActivityFilters) => void;
  people: Option[];
  sources: string[];
  profiles: string[];
}) {
  const [copying, setCopying] = useState(false);
  const set = (patch: Partial<ActivityFilters>) => onChange({ ...value, ...patch });
  const today = new Date().toISOString().slice(0, 10);

  const copyLink = async () => {
    setCopying(true);
    const ok = await copyToClipboard(window.location.href);
    setCopying(false);
    if (ok) toast.success('Link to this view copied');
    else toast.error('Copy failed - copy the address from the browser instead');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {people.length > 1 && (
          <Pill icon={UserIcon} label="Person" value={value.person} onChange={(person) => set({ person })}
            options={[{ value: '', label: 'Everyone' }, ...people]} />
        )}
        {sources.length > 1 && (
          <Pill icon={ServerStackIcon} label="Watched on" value={value.source} onChange={(source) => set({ source })}
            options={[{ value: '', label: 'Any app' }, ...sources.map((s) => ({ value: s, label: SOURCE_NAMES[s] || s }))]} />
        )}
        {profiles.length > 0 && (
          <Pill icon={UserCircleIcon} label="Profile" value={value.profile} onChange={(profile) => set({ profile })}
            options={[{ value: '', label: 'Any profile' }, ...profiles.map((p) => ({ value: p, label: p }))]} />
        )}
        <Pill icon={FilmIcon} label="Kind" value={value.kind} onChange={(kind) => set({ kind })}
          options={[{ value: '', label: 'Movies & shows' }, { value: 'movie', label: 'Movies' }, { value: 'series', label: 'Shows' }]} />
        <Pill icon={CheckCircleIcon} label="Finished" value={value.status} onChange={(status) => set({ status })}
          options={[{ value: '', label: 'Finished or not' }, { value: 'finished', label: 'Finished' }, { value: 'partial', label: 'Stopped part-way' }]} />
        <Pill icon={CalendarDaysIcon} label="When" value={value.when}
          onChange={(when) => set(when === 'custom' ? { when, from: value.from || today, to: value.to || today } : { when, from: '', to: '' })}
          options={[
            { value: '', label: 'Any time' },
            { value: 'today', label: 'Today' },
            { value: 'week', label: 'Last 7 days' },
            { value: 'month', label: 'Last 30 days' },
            { value: 'year', label: 'This year' },
            { value: 'custom', label: 'Pick dates…' },
          ]} />

        {value.when === 'custom' && (
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/60 bg-primary/15 px-3 py-1 text-sm">
            <input type="date" aria-label="From" value={value.from} max={value.to || undefined}
              onChange={(e) => set({ from: e.target.value })}
              className="bg-transparent text-default focus:outline-none" />
            <span className="text-muted">to</span>
            <input type="date" aria-label="To" value={value.to} min={value.from || undefined}
              onChange={(e) => set({ to: e.target.value })}
              className="bg-transparent text-default focus:outline-none" />
          </div>
        )}

        {hasAnyFilter(value) && (
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => onChange(EMPTY_FILTERS)}
              className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-muted hover:text-default hover:bg-surface-hover transition-colors">
              <XMarkIcon className="w-4 h-4" /> Clear
            </button>
            <button type="button" onClick={copyLink} disabled={copying} title="Copy a link to this view"
              className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-muted hover:text-default hover:bg-surface-hover transition-colors">
              <LinkIcon className="w-4 h-4" /> Copy link
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
