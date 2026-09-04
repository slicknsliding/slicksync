'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { MagnifyingGlassIcon, StarIcon, ArrowTopRightOnSquareIcon, PlusIcon } from '@heroicons/react/24/outline';
import { copyToClipboard } from '@/lib/clipboard';

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

  // Reachability of the addons currently on screen, probed FROM THE BROWSER.
  // Deliberately not server-side: the server is on a VPS, and a large class
  // of popular addons (anything Cloudflare-fronted) refuses datacenter IPs
  // while answering a home connection perfectly - so a server-side probe
  // would wrongly condemn working addons as dead. It also costs the server
  // nothing, since each check runs on the viewer's own connection.
  //
  // Only genuinely unreachable addons are flagged: a failure here means the
  // browser could not reach it either, which is the same position the user
  // would be in.
  const [reachability, setReachability] = useState<Record<string, 'ok' | 'dead'>>({});
  const [checkingReach, setCheckingReach] = useState(false);
  const [hideDead, setHideDead] = useState(false);

  const checkReachability = useCallback(async (urls: string[]) => {
    const unknown = urls.filter((u) => !(u in reachability));
    if (unknown.length === 0) return;
    setCheckingReach(true);
    // Small concurrency cap - a page of 24 all at once is a burst nobody
    // benefits from, and some hosts throttle it.
    const CONCURRENCY = 5;
    const found: Record<string, 'ok' | 'dead'> = {};
    let i = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < unknown.length) {
        const url = unknown[i++];
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8000);
          const res = await fetch(url, { signal: ctrl.signal });
          clearTimeout(t);
          // A 403 is NOT dead - it is the addon refusing this particular
          // caller. Only a hard failure or a non-manifest response counts.
          found[url] = res.ok || res.status === 403 || res.status === 401 ? 'ok' : 'dead';
        } catch {
          found[url] = 'dead';
        }
      }
    }));
    setReachability((prev) => ({ ...prev, ...found }));
    setCheckingReach(false);
  }, [reachability]);

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
      try {
        await api.createAddon({ manifestUrl, name });
      } catch (serverErr) {
        // The server could not fetch the manifest - very often because the
        // addon's host blocks datacenter/VPS IPs. Confirmed live: torrentio
        // and thepiratebay-plus both return 403 to two different VPS hosts
        // while returning 200 to a browser on a home connection.
        //
        // So retry from HERE. The browser is on the user's own connection,
        // which those addons don't block, and Stremio addons must serve
        // permissive CORS headers for Stremio's own web app to work - so
        // this read is allowed. The manifest is then handed to the server,
        // which already accepts a pre-fetched one and skips its own fetch.
        // Costs the server no bandwidth at all: the download happens here.
        let manifestData: unknown = null;
        try {
          const res = await fetch(manifestUrl);
          if (res.ok) manifestData = await res.json();
        } catch { /* browser can't reach it either - genuinely unreachable */ }

        if (!manifestData) throw serverErr; // report the server's own reason
        await api.createAddon({ manifestUrl, name, manifestData });
      }
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

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={hideDead}
              onChange={async (e) => {
                setHideDead(e.target.checked);
                if (e.target.checked && result) {
                  await checkReachability(result.addons.map((a) => a.manifestUrl));
                }
              }}
            />
            Hide addons that don&apos;t respond
          </label>
          {checkingReach && <span className="text-xs text-subtle">Checking addons…</span>}
        </div>

        {error && (
          <div className="p-3 rounded-lg text-sm" style={{ background: 'color-mix(in srgb, var(--color-error) 12%, transparent)', color: 'var(--color-text)' }}>
            {error}
            <Button variant="ghost" size="sm" className="ml-2" onClick={load}>Retry</Button>
          </div>
        )}

        <div className="max-h-[52vh] overflow-y-auto space-y-2 pr-1">
          {/* SlickTrax leads the list itself - first row, above Torrentio -
              rather than a separate banner floating over the browse UI
              (user feedback: it belongs IN the list). Page 1 only, and it
              respects the search box like any other entry. */}
          {page === 1 && (!search.trim() || 'slicktrax continue watching watchlist catalogs'.includes(search.trim().toLowerCase())) && (
            <SlickTraxRow />
          )}
          {loading && !result && <p className="text-sm text-muted py-6 text-center">Loading addons...</p>}
          {!loading && result?.addons.length === 0 && (
            <p className="text-sm text-muted py-6 text-center">No addons match that search.</p>
          )}
          {result?.addons
            .filter((a) => !hideDead || reachability[a.manifestUrl] !== 'dead')
            .map((a) => (
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
                  {reachability[a.manifestUrl] === 'dead' && (
                    <Badge variant="error" size="sm">Not responding</Badge>
                  )}
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

// SlickTrax's front door in the place people actually look for addons -
// styled as the FIRST ROW of the directory list (above Torrentio), same
// shape as every other entry. The addon itself is PER-USER (a tokened
// manifest served by this very SlickSync), so instead of an Add button
// it's a picker: choose the person, and either enable-and-sync (the addon
// installs itself onto their account) or copy their manifest URL for a
// manual install anywhere. The per-user toggle on the user's own page
// remains the config home; this is discovery.
function SlickTraxRow() {
  const [users, setUsers] = useState<Array<{ id: string; username: string; traxAddonEnabled?: boolean }>>([]);
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  // Collapsed by default: one button, same as every other row (user
  // feedback - no picker sitting open in the list). "Configure" expands
  // the who-is-it-for step inline, because a per-user tokened addon can't
  // be a bare Add: there is no single manifest to add.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.getUsers().then((us) => {
      setUsers(us.map((u) => ({ id: u.id, username: u.username || 'Unnamed', traxAddonEnabled: u.traxAddonEnabled })));
    }).catch(() => {});
  }, []);

  const selected = users.find((u) => u.id === userId) || null;

  const enableAndSync = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.setTraxAddon(selected.id, true);
      await api.syncUser(selected.id);
      setUsers((prev) => prev.map((u) => (u.id === selected.id ? { ...u, traxAddonEnabled: true } : u)));
      toast.success(`SlickTrax enabled and synced onto ${selected.username}'s account - the rows appear on their devices`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not enable SlickTrax');
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await api.setTraxAddon(selected.id, true); // idempotent - stable token, returns the URL
      const ok = await copyToClipboard(r.manifestUrl);
      if (ok) toast.success('Manifest URL copied - paste it into any Stremio-compatible app');
      else toast.error(`Copy failed - the URL is: ${r.manifestUrl}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not fetch the URL');
    } finally {
      setBusy(false);
    }
  };

  return (
    // Same row anatomy as the directory entries below (icon / name+badges+
    // description / action on the right); the faint primary border is the
    // only tell that this one is the house addon, not a directory listing.
    <div className="flex items-start gap-3 p-3 rounded-xl border" style={{ background: 'var(--color-surface-hover)', borderColor: 'color-mix(in srgb, var(--color-primary) 35%, transparent)' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/android-chrome-192x192.png" alt="" width={40} height={40} className="w-10 h-10 rounded-lg object-contain shrink-0 bg-black/20" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-default">SlickTrax</span>
          <Badge variant="default" size="sm">catalog</Badge>
          <span className="text-xs" style={{ color: 'var(--color-primary)' }}>this server&apos;s own addon</span>
        </div>
        <p className="text-xs text-muted mt-1">
          Continue Watching, Watchlist and your Catalogs as rows inside Stremio and Nuvio - served live by this SlickSync, personal to each user. Pick who, and it installs itself on their next sync.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!open ? (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<ArrowTopRightOnSquareIcon className="w-4 h-4" />}
            onClick={() => setOpen(true)}
            title="SlickTrax is personal to each user - pick who it's for, then it installs itself"
          >
            Configure
          </Button>
        ) : (
          <>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="input-base px-3 py-2 text-sm appearance-none pr-8"
            >
              <option value="">Pick a user...</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.username}{u.traxAddonEnabled ? ' (enabled)' : ''}</option>
              ))}
            </select>
            {selected && !selected.traxAddonEnabled && (
              <Button variant="primary" size="sm" isLoading={busy} onClick={enableAndSync}>Add</Button>
            )}
            {selected && selected.traxAddonEnabled && (
              <Button variant="secondary" size="sm" isLoading={busy} onClick={copyUrl}>Copy manifest URL</Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

