'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { MagnifyingGlassIcon, StarIcon, ArrowTopRightOnSquareIcon, PlusIcon } from '@heroicons/react/24/outline';

// Browse the public Stremio addon directory and add one without ever
// hunting down a manifest URL by hand - previously the only way in was
// pasting a URL you had to find somewhere else first.
//
// Everything here is read-only browsing of someone else's public listing
// (see server/routes/addonDirectory.js). Adding goes through the app's
// normal createAddon path, which re-fetches the manifest from the addon's
// own URL, so nothing the directory says about an addon is trusted as fact.
//
// Addons that require configuration on their own site (configureUrl set -
// Torrentio-style provider/debrid pickers) cannot be meaningfully installed
// from a bare manifest URL: you would get the addon with no settings. Those
// get a "Configure first" link out to the addon's own page instead of an Add
// button, which is the honest option rather than installing something
// half-set-up.

interface AddonDirectoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful add so the caller can refresh its list. */
  onAdded: () => void;
}

// Categories the upstream directory actually uses, in rough order of how
// often someone is looking for them. Kept short deliberately - the full list
// runs to dozens and turns the filter row into a wall.
const QUICK_CATEGORIES = ['movies', 'tv shows', 'anime', 'torrents', 'debrid support', 'live tv', 'subtitles'];

export function AddonDirectoryModal({ isOpen, onClose, onAdded }: AddonDirectoryModalProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingUrl, setAddingUrl] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.browseAddonDirectory>> | null>(null);

  // Debounced so typing doesn't fire a request per keystroke - the server
  // caches, but the upstream directory shouldn't be hammered either.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  // Tracks the newest request so a slow earlier response can never overwrite
  // a newer one (classic search race - type fast, get stale results).
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.browseAddonDirectory({
        page,
        search: debouncedSearch || undefined,
        category: category || undefined,
      });
      if (seq !== requestRef.current) return;
      setResult(res);
    } catch (e) {
      if (seq !== requestRef.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load the addon directory');
    } finally {
      if (seq === requestRef.current) setLoading(false);
    }
  }, [page, debouncedSearch, category]);

  useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

  // Reset back to a clean browse when reopened, rather than resuming
  // whatever search was left over from last time.
  useEffect(() => {
    if (!isOpen) {
      setSearch(''); setDebouncedSearch(''); setCategory(''); setPage(1); setResult(null); setError(null);
    }
  }, [isOpen]);

  const handleAdd = async (manifestUrl: string, name: string) => {
    setAddingUrl(manifestUrl);
    try {
      await api.createAddon({ manifestUrl, name });
      toast.success(`Added ${name}`);
      onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to add ${name}`);
    } finally {
      setAddingUrl(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Browse addon directory" size="full">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Public addons from stremio-addons.net. Adding one here brings it into SlickSync - you can then assign it to users or groups like any other addon.
        </p>

        <div className="relative">
          <MagnifyingGlassIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search addons..."
            autoComplete="off"
            spellCheck={false}
            className="input-base w-full pl-9 pr-3 py-2 text-sm"
          />
        </div>

        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => { setCategory(''); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${!category ? 'bg-primary text-white' : 'bg-surface-hover text-muted nav-item-hover-pill'}`}
          >
            All
          </button>
          {QUICK_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setCategory(category === c ? '' : c); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${category === c ? 'bg-primary text-white' : 'bg-surface-hover text-muted nav-item-hover-pill'}`}
            >
              {c}
            </button>
          ))}
        </div>

        {error && (
          <div className="p-3 rounded-lg text-sm" style={{ background: 'color-mix(in srgb, var(--color-error) 12%, transparent)', color: 'var(--color-text)' }}>
            {error}
            <Button variant="ghost" size="sm" className="ml-2" onClick={load}>Retry</Button>
          </div>
        )}

        <div className="max-h-[52vh] overflow-y-auto space-y-2 pr-1">
          {loading && !result && <p className="text-sm text-muted py-6 text-center">Loading addons...</p>}
          {!loading && result?.addons.length === 0 && (
            <p className="text-sm text-muted py-6 text-center">No addons match that search.</p>
          )}
          {result?.addons.map((a) => (
            <div key={a.manifestUrl} className="flex items-start gap-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-hover)' }}>
              {a.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.logo} alt="" width={40} height={40} className="w-10 h-10 rounded-lg object-contain shrink-0 bg-black/20" />
              ) : (
                <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center text-xs text-subtle" style={{ background: 'var(--color-bg-subtle)' }}>?</div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-default">{a.name}</span>
                  {a.stars > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs text-muted">
                      <StarIcon className="w-3.5 h-3.5" />{a.stars}
                    </span>
                  )}
                  {a.resources.slice(0, 4).map((r) => (
                    <Badge key={r} variant="default" size="sm">{r}</Badge>
                  ))}
                </div>
                {a.description && <p className="text-xs text-muted mt-1 line-clamp-2">{a.description}</p>}
              </div>
              <div className="shrink-0">
                {a.configureUrl ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<ArrowTopRightOnSquareIcon className="w-4 h-4" />}
                    onClick={() => window.open(a.configureUrl!, '_blank', 'noopener,noreferrer')}
                    title="This addon needs setting up on its own site first - install the URL it gives you afterwards"
                  >
                    Configure first
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<PlusIcon className="w-4 h-4" />}
                    isLoading={addingUrl === a.manifestUrl}
                    onClick={() => handleAdd(a.manifestUrl, a.name)}
                  >
                    Add
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {result && result.pagination.totalPages > 1 && (
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-muted">
              Page {result.pagination.page} of {result.pagination.totalPages} · {result.pagination.total} addons
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={!result.pagination.hasPreviousPage || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
              <Button variant="ghost" size="sm" disabled={!result.pagination.hasNextPage || loading} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
