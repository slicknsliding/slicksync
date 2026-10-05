'use client';

import { useEffect, useState, useCallback } from 'react';
import { ArrowsRightLeftIcon } from '@heroicons/react/24/outline';
import { api, type WatchStateView } from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { copyToClipboard } from '@/lib/clipboard';

/**
 * The AIOStreams half of watch tracking. People watching through AIOStreams'
 * Jellyfin apps (Odin, Infuse, Swiftfin, its desktop app) never touch a
 * Stremio or Nuvio library, so nothing they watch there reached SlickSync.
 * This turns on the exchange for one person and adds the link to their
 * AIOStreams configuration when SlickSync has its password (otherwise hands
 * the link over to add by hand); it also lists the AIOStreams profiles that
 * have shown up, so each can be linked to the right person instead of guessed,
 * and what the 30-minute check found wrong (server/utils/aioSlickTrax.js).
 */

const ISSUE_TEXT: Record<string, string> = {
  missing: 'SlickTrax isn’t in their AIOStreams configuration any more, or is switched off - what they watch there isn’t arriving.',
  trackers: 'A household user’s tracker list in AIOStreams leaves SlickTrax out - add it back there.',
  libraries: 'SlickSync’s collections didn’t make AIOStreams’ library limit - turn on “Keep SlickSync’s collections first” below, or move “SlickSync catalogs” higher in their catalog order yourself.',
  quiet: 'Nothing has arrived from AIOStreams for a week.',
};
export function WatchStateRow({ userId }: { userId: string }) {
  const [view, setView] = useState<WatchStateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [movingFirst, setMovingFirst] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.getWatchState(userId));
    } catch {
      // A failed read leaves the row in its "off" shape rather than vanishing.
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    if (!view) return;
    setBusy(true);
    try {
      const next = await api.setWatchState(userId, !view.enabled);
      setView(next);
      if (next.install === 'failed') toast.error(next.installError || 'Couldn’t add it to AIOStreams');
      else toast.success(!next.enabled ? 'AIOStreams watch history off' : next.install === 'added' ? 'On, and added to their AIOStreams' : 'AIOStreams watch history on');
    } catch (err: any) {
      toast.error(err?.message || 'Could not change that');
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      const next = await api.installWatchStateIntoAio(userId);
      setView(next);
      if (next.install === 'failed') toast.error(next.installError || 'Couldn’t add it to AIOStreams');
      else toast.success(next.install === 'added' ? 'Added to their AIOStreams' : 'It’s already in their AIOStreams');
    } catch (err: any) {
      toast.error(err?.message || 'Couldn’t add it to AIOStreams');
    } finally {
      setInstalling(false);
    }
  };

  // Their AIOStreams, their order: only moved when this is on.
  const setFirst = async (on: boolean) => {
    setMovingFirst(true);
    try {
      const next = await api.setWatchStateCollectionsFirst(userId, on);
      setView(next);
      if (next.firstError) toast.error(`Kept the choice, but couldn’t move it yet: ${next.firstError}`);
      else toast.success(on ? 'SlickSync’s collections are first in their AIOStreams' : 'Their AIOStreams catalog order is left as they set it');
    } catch (err: any) {
      toast.error(err?.message || 'Could not change that');
    } finally {
      setMovingFirst(false);
    }
  };

  const link = async (viewer: string, target: string) => {
    try {
      setView(await api.linkWatchStateViewer(userId, viewer, target || null));
      toast.success(target === 'skip' ? 'Profile no longer tracked' : target ? 'Profile linked' : 'Profile unlinked');
    } catch (err: any) {
      toast.error(err?.message || 'Could not link that profile');
    }
  };

  const enabled = !!view?.enabled;

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center ${enabled ? 'bg-success-muted' : 'bg-primary-muted'}`}>
            <ArrowsRightLeftIcon className={`w-5 h-5 ${enabled ? 'text-success' : 'text-primary'}`} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-default">AIOStreams watch history</h4>
              {enabled && <Badge variant="success" size="sm">On</Badge>}
            </div>
            <p className="text-sm text-muted">
              {enabled
                ? 'What they watch on AIOStreams in a Jellyfin app is recorded here, and what they watched anywhere else shows up there.'
                : 'For anyone watching AIOStreams in a Jellyfin app - Infuse, Swiftfin, Odin or AIOStreams\' desktop app.'}
            </p>
            {enabled && view?.canInstall && (
              <div className="mt-2 flex flex-col gap-1.5">
                <p className="text-xs text-muted">
                  {view.install === 'failed'
                    ? <span className="text-warning">{view.installError}</span>
                    : 'SlickSync adds it to their AIOStreams configuration itself.'}
                </p>
                {(view.install === 'failed' || (view.issues || []).includes('missing')) && (
                  <Button variant="secondary" size="sm" isLoading={installing} onClick={install} className="self-start">
                    Add it to AIOStreams again
                  </Button>
                )}
                <label className="mt-1 flex items-start gap-2 text-xs text-default cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={!!view.collectionsFirst}
                    disabled={movingFirst}
                    onChange={(e) => setFirst(e.target.checked)}
                  />
                  <span>
                    Keep SlickSync’s collections first
                    <span className="block text-muted">Moves “SlickSync catalogs” to the top of their AIOStreams catalogs so it’s never past the library limit. Nothing else in their order changes. Off: SlickSync never reorders their catalogs.</span>
                  </span>
                </label>
              </div>
            )}
            {enabled && (view?.issues?.length ?? 0) > 0 && (
              <ul className="mt-2 space-y-1">
                {view!.issues!.map((k) => (
                  <li key={k} className="text-xs text-warning">{ISSUE_TEXT[k] || k}</li>
                ))}
              </ul>
            )}
            {enabled && view?.manifestUrl && !view.canInstall && (
              <>
                <p className="mt-2 text-xs text-muted">Add this to the AIOStreams configuration as an addon by URL:</p>
                <button
                  type="button"
                  className="mt-1 text-xs text-muted hover:text-default underline underline-offset-2 break-all text-left"
                  title="Copy link"
                  onClick={async () => { (await copyToClipboard(view.manifestUrl!)) ? toast.success('Link copied') : toast.error('Copy failed - select and copy the link text directly'); }}
                >
                  {view.manifestUrl}
                </button>
              </>
            )}
            {enabled && view && !view.baseKnown && (
              <p className="mt-2 text-xs text-warning">
                Fill in “Public address of this instance” under Settings → Integrations first - AIOStreams has to be able to reach this link.
              </p>
            )}
          </div>
        </div>
        <Button variant={enabled ? 'ghost' : 'primary'} size="sm" isLoading={busy} onClick={toggle} disabled={!view}>
          {enabled ? 'Turn off' : 'Turn on'}
        </Button>
      </div>

      {enabled && view && view.viewers.length > 0 && (
        <div className="mt-4 ml-13 flex flex-col gap-2">
          <p className="text-xs text-muted">
            The AIOStreams users watching through this link, and who each one is here. Nothing is recorded for a user until they are matched to someone with this turned on.
          </p>
          {view.viewers.map((v) => (
            <div key={v.viewer} className="flex items-center justify-between gap-3 flex-wrap rounded-lg px-3 py-2" style={{ background: 'var(--color-surface-hover)' }}>
              <span className="text-sm font-mono">{v.viewer}</span>
              <div className="flex items-center gap-2">
                {v.userId && v.userEnabled === false && (
                  <span className="text-xs text-warning">turned off for that person</span>
                )}
                {!v.userId && !v.skipped && <span className="text-xs text-warning">not linked - its viewing is not recorded</span>}
                {v.skipped && <span className="text-xs text-muted">not tracked</span>}
                <select
                  className="text-sm rounded-md px-2 py-1 border"
                  style={{ borderColor: 'var(--color-surface-border)', backgroundColor: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
                  value={v.skipped ? 'skip' : v.userId || ''}
                  onChange={(e) => link(v.viewer, e.target.value)}
                  aria-label={`Who is ${v.viewer}`}
                >
                  <option value="" disabled={!!v.userId || v.skipped} style={{ backgroundColor: 'var(--color-surface)' }}>Choose who this is</option>
                  {view.people.map((p) => (
                    <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--color-surface)' }}>{p.username}</option>
                  ))}
                  <option value="skip" style={{ backgroundColor: 'var(--color-surface)' }}>Don&apos;t track it</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
