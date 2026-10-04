'use client';

// Jellyfin Collections - SlickSync catalogs as real collections on the
// household's own Jellyfin servers (AIOStreams and AIOMetadata have
// AIOStreams Collections instead). Pick the server, tap catalogs to switch
// them on: each becomes a Jellyfin collection of the titles that server has,
// kept in step by server/utils/jellyfinServerCollections.js. A Jellyfin
// collection is server-wide, so there is no profile to pick here.

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeftIcon, ArrowPathIcon, CheckIcon, ServerStackIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { Header, Breadcrumbs } from '@/components/layout/Header';
import { PageSection } from '@/components/layout/PageContainer';
import { NebulaPageHeading } from '@/components/layout/NebulaTopbar';
import { useLayoutMode } from '@/lib/layout-mode';
import { Card, Button, Badge } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { usePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { posterUrl, cachedImageUrl } from '@/lib/posterUrl';
import { api, type JellyfinCollectionServer, type JellyfinCollectionsView } from '@/lib/api';

const LIST = '/catalogs/jellyfin-collections';

function ago(iso: string | null) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

type CatalogRow = JellyfinCollectionsView['catalogs'][number];

function CatalogTile({ c, busy, disabled, onToggle }: { c: CatalogRow; busy: boolean; disabled: boolean; onToggle: () => void }) {
  const { rpdbEnabled } = usePersonalFeatures();
  const src = c.coverTitleId ? posterUrl({ id: c.coverTitleId, poster: c.cover }, rpdbEnabled) : cachedImageUrl(c.cover, 342);
  const here = c.onServer;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy || disabled}
      aria-pressed={c.on}
      className={`group text-left rounded-2xl overflow-hidden border transition-colors disabled:cursor-not-allowed ${
        c.on ? 'border-primary ring-2 ring-primary/60' : 'border-default hover:border-primary/50'
      } ${disabled && !c.on ? 'opacity-60' : ''}`}
    >
      <div className="relative aspect-[2/3] bg-surface-hover">
        {src
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={src} alt="" className={`absolute inset-0 w-full h-full object-cover transition-opacity ${c.on ? '' : 'opacity-60 group-hover:opacity-90'}`} />
          : <div className="absolute inset-0 flex items-center justify-center"><Squares2X2Icon className="w-10 h-10 text-muted" /></div>}
        {c.on && (
          <span className="absolute top-2 right-2 w-7 h-7 rounded-full bg-primary flex items-center justify-center shadow">
            <CheckIcon className="w-4 h-4 text-white" />
          </span>
        )}
        {busy && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/50">
            <ArrowPathIcon className="w-7 h-7 text-white animate-spin" />
          </span>
        )}
      </div>
      <div className="p-2.5">
        <p className="text-sm font-medium text-default truncate">{c.name}</p>
        <p className="text-[11px] text-muted truncate">
          {here === null
            ? `${c.titles} title${c.titles === 1 ? '' : 's'}`
            : here === 0
              ? 'None on this server'
              : `${here} of ${c.titles} on this server`}
        </p>
      </div>
    </button>
  );
}

export default function JellyfinCollectionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const serverKey = searchParams.get('server') || '';
  const { layoutMode } = useLayoutMode();
  const [servers, setServers] = useState<JellyfinCollectionServer[] | null>(
    () => api.peekGet<{ servers: JellyfinCollectionServer[] }>('/jellyfin/server-collections/servers')?.servers ?? null,
  );

  useEffect(() => {
    api.getJellyfinCollectionServers()
      .then((r) => setServers(r.servers))
      .catch((e: any) => { toast.error(e?.message || 'Could not load the Jellyfin servers'); setServers((s) => s ?? []); });
  }, []);

  // Only one server: nothing to pick.
  useEffect(() => {
    if (!serverKey && servers?.length === 1) router.replace(`${LIST}?server=${encodeURIComponent(servers[0].key)}`);
  }, [servers, serverKey, router]);

  const selected = servers?.find((s) => s.key === serverKey) || null;
  const pick = (key: string) => router.push(key ? `${LIST}?server=${encodeURIComponent(key)}` : LIST);

  const backButton = (
    <Button variant="ghost" size="sm" leftIcon={<ArrowLeftIcon className="w-4 h-4" />} onClick={() => router.push('/catalogs')}>
      Back
    </Button>
  );
  const subtitle = 'Catalogs as collections on your own Jellyfin server';

  return (
    <>
      {layoutMode !== 'nebula' && (
        <Header
          title={<Breadcrumbs items={[{ label: 'Catalogs', href: '/catalogs' }, { label: 'Jellyfin Collections' }]} className="text-xl font-semibold" />}
          subtitle={subtitle}
          actions={backButton}
        />
      )}
      <div className={layoutMode === 'nebula' ? 'px-4 md:px-6 pb-8 pt-6' : 'p-8'}>
        <div className={layoutMode === 'nebula' ? 'mx-auto' : ''} style={layoutMode === 'nebula' ? { maxWidth: 'min(120rem, 92vw)' } : undefined}>
          {layoutMode === 'nebula' && <NebulaPageHeading title="Jellyfin Collections" subtitle={subtitle} leading={backButton} />}

          <PageSection>
            {!selected ? (
              <Card padding="lg" className="mb-6">
                <label className="block text-xs font-medium text-muted mb-3">Jellyfin server</label>
                {servers === null || (!serverKey && servers.length === 1) ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-20 rounded-xl bg-surface-hover animate-pulse" />)}
                  </div>
                ) : servers.length === 0 ? (
                  <p className="text-xs text-subtle">
                    Nobody here signs in to a Jellyfin server of their own yet. Add someone with Users &rarr; Add &rarr; Jellyfin | AIOStreams.{' '}
                    <Link href="/guides/add-jellyfin-account" className="text-primary hover:underline">How</Link>
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {servers.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => pick(s.key)}
                        className="flex items-center gap-3 p-3 rounded-xl border border-default hover:border-primary/50 bg-subtle hover:bg-surface-hover transition-colors text-left"
                      >
                        <span className="w-10 h-10 rounded-xl bg-surface-hover flex items-center justify-center shrink-0"><ServerStackIcon className="w-5 h-5 text-muted" /></span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-default truncate">{s.name}</p>
                          <p className="text-xs text-subtle truncate">{s.people.map((p) => p.username).join(', ')}</p>
                          <Badge variant="jellyfin" size="sm" className="mt-1">Jellyfin</Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </Card>
            ) : (
              <ServerCollections key={selected.key} server={selected} canSwitch={(servers?.length || 0) > 1} onSwitch={() => pick('')} />
            )}
          </PageSection>
        </div>
      </div>
    </>
  );
}

function ServerCollections({ server, canSwitch, onSwitch }: { server: JellyfinCollectionServer; canSwitch: boolean; onSwitch: () => void }) {
  const path = api.jellyfinCollectionsPath(server.key);
  const [view, setView] = useState<JellyfinCollectionsView | null>(() => api.peekGet<JellyfinCollectionsView>(path) ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.getJellyfinCollections(server.key));
    } catch (e: any) {
      toast.error(e?.message || 'Could not load the collections');
    }
  }, [server.key]);
  useEffect(() => { load(); }, [load]);

  const toggle = async (c: CatalogRow) => {
    setBusy(c.id);
    try {
      const next = await api.setJellyfinCollection(server.key, c.id, !c.on);
      setView(next);
      const now = next.catalogs.find((x) => x.id === c.id);
      if (next.lastError && next.lastError !== 'no-permission') toast.error(`Jellyfin said: ${next.lastError}`);
      else if (now?.on && !now.inJellyfin) toast.success(`None of ${c.name}'s titles are on this server yet - it shows up once one is`);
      else toast.success(now?.on ? `${c.name} is a collection on ${next.server.name}` : `${c.name} is off ${next.server.name}`);
    } catch (e: any) {
      toast.error(e?.message || 'Could not change it');
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      setView(await api.syncJellyfinCollections(server.key));
    } catch (e: any) {
      toast.error(e?.message || 'Could not sync');
    } finally {
      setSyncing(false);
    }
  };

  const noPermission = !!view && !view.actor;
  const onCount = view?.catalogs.filter((c) => c.on).length || 0;

  return (
    <>
      <Card padding="lg" className="mb-6">
        <div className="flex flex-wrap gap-x-6 gap-y-3 items-center justify-between">
          <button
            type="button"
            onClick={() => (canSwitch ? onSwitch() : undefined)}
            className="flex items-center gap-3 pr-3 rounded-xl hover:bg-surface-hover transition-colors text-left min-w-0"
            title={canSwitch ? 'Switch server' : undefined}
          >
            <span className="w-10 h-10 rounded-xl bg-surface-hover flex items-center justify-center shrink-0"><ServerStackIcon className="w-5 h-5 text-muted" /></span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-sm font-medium text-default truncate">{view?.server.name || server.name}</p>
                <Badge variant="jellyfin" size="sm" className="shrink-0">Jellyfin</Badge>
              </div>
              <p className="text-xs text-subtle truncate">{server.people.map((p) => p.username).join(', ')}</p>
              {canSwitch && <p className="text-xs text-primary">Switch server</p>}
            </div>
          </button>
          {view?.actor && (
            <div className="flex items-center gap-3">
              <p className="text-xs text-muted">
                {onCount > 0 && view.lastSyncAt ? `Synced ${ago(view.lastSyncAt)}` : 'Kept in step every 30 minutes'}
              </p>
              <Button variant="ghost" size="sm" leftIcon={<ArrowPathIcon className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />} onClick={syncNow} disabled={syncing || onCount === 0}>
                Sync now
              </Button>
            </div>
          )}
        </div>
      </Card>

      {view && (
        <Card padding="md" className="mb-4">
          {noPermission ? (
            <p className="text-sm text-default">
              To make collections, SlickSync needs a sign-in on this server that may manage them, and {view.people.map((p) => p.username).join(', ')} can&rsquo;t.
              In Jellyfin, open Dashboard &rarr; Users, pick one of them and allow them to manage collections &ndash; or add the server&rsquo;s administrator to SlickSync.
            </p>
          ) : (
            <p className="text-sm text-default">
              Tap a catalog to make it a collection on this server &ndash; it holds the catalog&rsquo;s titles the server has, under the catalog&rsquo;s name. Everyone on {view.server.name} who can see those titles sees it. Changes are made as {view.actor?.username}.
              {view.actor && !view.actor.admin && (
                <span className="block mt-1 text-muted">Catalog covers need an administrator&rsquo;s sign-in on this server &ndash; {view.actor.username} isn&rsquo;t one, so Jellyfin picks the pictures.</span>
              )}
              {view.lastError && view.lastError !== 'no-permission' && <span className="block mt-1 text-error">The last sync didn&rsquo;t finish: {view.lastError}</span>}
            </p>
          )}
        </Card>
      )}

      {!view ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="aspect-[2/3] rounded-2xl bg-surface-hover animate-pulse" />)}
        </div>
      ) : view.catalogs.length === 0 ? (
        <Card padding="lg"><p className="text-sm text-muted text-center">No catalogs yet. Make one on the Catalogs page.</p></Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {view.catalogs.map((c) => (
            <CatalogTile key={c.id} c={c} busy={busy === c.id} disabled={noPermission || (busy !== null && busy !== c.id)} onToggle={() => toggle(c)} />
          ))}
        </div>
      )}
    </>
  );
}
