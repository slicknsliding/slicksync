'use client';

import { useState } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import type { SmartCatalogRule, SmartCatalogSort } from '@/lib/api';

type Draft = Partial<SmartCatalogRule>;

const splitList = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean);
const numOrNull = (text: string) => (text.trim() ? Number(text) : null);

const SORTS: Array<{ value: SmartCatalogSort | ''; label: string }> = [
  { value: '', label: 'Best rated' },
  { value: 'popular', label: 'Most popular' },
  { value: 'trending', label: 'Trending' },
  { value: 'votes', label: 'Most voted' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
];

const VOTE_FLOORS = [
  { value: '', label: 'Any' },
  { value: '1000', label: '1,000+ votes' },
  { value: '10000', label: '10,000+ votes' },
  { value: '100000', label: '100,000+ votes' },
];

const field = 'input-base w-full px-3 py-2 text-sm';
const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-xs font-medium text-muted mb-1">{children}</label>
);

/**
 * The Smart rule editor's fields. People and the basics show straight away;
 * the rest sit under "More rules", opened by itself when a saved rule
 * already uses one of them.
 */
export function SmartRuleForm({ draft, setDraft, lumiereReady }: {
  draft: Draft;
  setDraft: (update: (d: Draft) => Draft) => void;
  lumiereReady: boolean;
}) {
  const usesMore = !!(draft.excludeGenres?.length || draft.sort || draft.minVotes || draft.minRuntimeMinutes
    || draft.maxRuntimeMinutes || draft.seriesStatus || draft.lastAiredFrom);
  const [more, setMore] = useState(usesMore);
  const series = draft.type === 'series';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Type</Label>
          <select
            value={draft.type || ''}
            onChange={(e) => setDraft((d) => ({ ...d, type: (e.target.value || null) as 'movie' | 'series' | null }))}
            className={field}
          >
            <option value="">Movies and series</option>
            <option value="movie">Movies only</option>
            <option value="series">Series only</option>
          </select>
        </div>
        <div>
          <Label>Genres <span className="text-subtle">(comma separated)</span></Label>
          <input type="text" defaultValue={(draft.genres || []).join(', ')} onBlur={(e) => setDraft((d) => ({ ...d, genres: splitList(e.target.value) }))} placeholder="Horror, Thriller" className={field} />
        </div>
        <div>
          <Label>From year</Label>
          <input type="number" defaultValue={draft.yearFrom ?? ''} onBlur={(e) => setDraft((d) => ({ ...d, yearFrom: numOrNull(e.target.value) }))} className={field} />
        </div>
        <div>
          <Label>To year</Label>
          <input type="number" defaultValue={draft.yearTo ?? ''} onBlur={(e) => setDraft((d) => ({ ...d, yearTo: numOrNull(e.target.value) }))} className={field} />
        </div>
        <div>
          <Label>Minimum rating{lumiereReady ? <span className="text-subtle"> (IMDb)</span> : null}</Label>
          <input type="number" step="0.5" min="0" max="10" defaultValue={draft.minRating ?? ''} onBlur={(e) => setDraft((d) => ({ ...d, minRating: numOrNull(e.target.value) }))} className={field} />
        </div>
        <div>
          <Label>How many titles</Label>
          <input type="number" min="5" max="100" defaultValue={draft.limit ?? 40} onBlur={(e) => setDraft((d) => ({ ...d, limit: Number(e.target.value) || 40 }))} className={field} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 sm:col-span-1">
          <Label>Actors <span className="text-subtle">(full names)</span></Label>
          <input type="text" defaultValue={(draft.cast || []).join(', ')} onBlur={(e) => setDraft((d) => ({ ...d, cast: splitList(e.target.value) }))} placeholder="Al Pacino, Robert De Niro" className={field} />
          {(draft.cast?.length || 0) > 1 && (
            <div className="flex gap-1.5 mt-1.5" role="group" aria-label="Which actors must be in it">
              {(['all', 'any'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, castMatch: m }))}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    (draft.castMatch || 'all') === m ? 'bg-primary text-white' : 'bg-surface-hover text-muted nav-item-hover-pill'
                  }`}
                >
                  {m === 'all' ? 'All of them in it' : 'Any of them'}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="col-span-2 sm:col-span-1">
          <Label>Directors <span className="text-subtle">(full names)</span></Label>
          <input type="text" defaultValue={(draft.directors || []).join(', ')} onBlur={(e) => setDraft((d) => ({ ...d, directors: splitList(e.target.value) }))} placeholder="Christopher Nolan" className={field} />
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setMore((v) => !v)}
          aria-expanded={more}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-default transition-colors"
        >
          <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${more ? 'rotate-180' : ''}`} />
          More rules
        </button>
        {more && (
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <Label>Not these genres</Label>
              <input type="text" defaultValue={(draft.excludeGenres || []).join(', ')} onBlur={(e) => setDraft((d) => ({ ...d, excludeGenres: splitList(e.target.value) }))} placeholder="Romance" className={field} />
            </div>
            <div>
              <Label>Order</Label>
              <select value={draft.sort || ''} onChange={(e) => setDraft((d) => ({ ...d, sort: (e.target.value || null) as SmartCatalogSort | null }))} className={field}>
                {SORTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}{o.value === 'trending' && !lumiereReady ? ' (needs LumiereDB)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Leave out little-known titles</Label>
              <select value={draft.minVotes ? String(draft.minVotes) : ''} onChange={(e) => setDraft((d) => ({ ...d, minVotes: e.target.value ? Number(e.target.value) : null }))} className={field}>
                {VOTE_FLOORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <Label>Runtime <span className="text-subtle">(minutes)</span></Label>
              <div className="flex items-center gap-1.5">
                <input type="number" min="1" aria-label="Shortest runtime" defaultValue={draft.minRuntimeMinutes ?? ''} onBlur={(e) => setDraft((d) => ({ ...d, minRuntimeMinutes: numOrNull(e.target.value) }))} placeholder="from" className={field} />
                <input type="number" min="1" aria-label="Longest runtime" defaultValue={draft.maxRuntimeMinutes ?? ''} onBlur={(e) => setDraft((d) => ({ ...d, maxRuntimeMinutes: numOrNull(e.target.value) }))} placeholder="to" className={field} />
              </div>
            </div>
            {series && (
              <>
                <div>
                  <Label>Series that are</Label>
                  <select value={draft.seriesStatus || ''} onChange={(e) => setDraft((d) => ({ ...d, seriesStatus: (e.target.value || null) as 'airing' | 'ended' | null }))} className={field}>
                    <option value="">Airing or ended</option>
                    <option value="airing">Still airing</option>
                    <option value="ended">Ended</option>
                  </select>
                </div>
                <div>
                  <Label>Last aired in or after</Label>
                  <input type="number" defaultValue={draft.lastAiredFrom ?? ''} onBlur={(e) => setDraft((d) => ({ ...d, lastAiredFrom: numOrNull(e.target.value) }))} placeholder="2020" className={field} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
