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
 * This turns on the exchange for one person and hands over the link to add
 * to AIOStreams; it also lists the AIOStreams profiles that have shown up, so
 * each can be linked to the right person instead of guessed.
 */
export function WatchStateRow({ userId }: { userId: string }) {
  const [view, setView] = useState<WatchStateView | null>(null);
  const [busy, setBusy] = useState(false);

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
      toast.success(next.enabled ? 'AIOStreams watch history on' : 'AIOStreams watch history off');
    } catch (err: any) {
      toast.error(err?.message || 'Could not change that');
    } finally {
      setBusy(false);
    }
  };

  const link = async (viewer: string, target: string) => {
    try {
      setView(await api.linkWatchStateViewer(userId, viewer, target || null));
      toast.success(target === 'skip' ? 'Profile left out' : target ? 'Profile linked' : 'Profile unlinked');
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
                ? 'What this person watches in AIOStreams\' apps is recorded here, and what they watched anywhere else shows up there.'
                : 'For anyone watching through AIOStreams\' apps - Odin, Infuse, Swiftfin or its desktop app - which never reach a Stremio or Nuvio library.'}
            </p>
            {enabled && view?.manifestUrl && (
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
            AIOStreams profiles using this link. A profile is only recorded once it is linked to a person who has this turned on, and never when it is left out.
          </p>
          {view.viewers.map((v) => (
            <div key={v.viewer} className="flex items-center justify-between gap-3 flex-wrap rounded-lg px-3 py-2" style={{ background: 'var(--color-surface-hover)' }}>
              <span className="text-sm font-mono">{v.viewer}</span>
              <div className="flex items-center gap-2">
                {v.userId && v.userEnabled === false && (
                  <span className="text-xs text-warning">turned off for that person</span>
                )}
                {!v.userId && !v.skipped && <span className="text-xs text-warning">not linked - its viewing is not recorded</span>}
                {v.skipped && <span className="text-xs text-muted">not counted</span>}
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
                  <option value="skip" style={{ backgroundColor: 'var(--color-surface)' }}>Nobody - don&apos;t count it</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
