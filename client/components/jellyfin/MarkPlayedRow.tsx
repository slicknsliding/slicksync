'use client';

// Watch-tracking row: what this person finishes in Stremio, Nuvio or
// AIOStreams is marked played on their real Jellyfin server too
// (server/utils/jellyfinMarkPlayed.js). Renders nothing for anyone without a
// real Jellyfin sign-in - their own, or one merged into them.

import { useEffect, useState } from 'react';
import { CheckBadgeIcon } from '@heroicons/react/24/outline';
import { ToggleSwitch } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';

export function MarkPlayedRow({ userId }: { userId: string }) {
  const [state, setState] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getJellyfinMarkPlayed(userId).then(setState).catch(() => setState(null));
  }, [userId]);

  if (!state?.available) return null;

  const toggle = async (enabled: boolean) => {
    setSaving(true);
    try {
      setState(await api.setJellyfinMarkPlayed(userId, enabled));
    } catch (e: any) {
      toast.error(e?.message || 'Could not change that');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="border-t" style={{ borderColor: 'var(--color-surface-border)' }} />
      <div className="flex items-center justify-between gap-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-primary-muted shrink-0">
            <CheckBadgeIcon className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h4 className="font-semibold text-default">Keep Jellyfin in step</h4>
            <p className="text-sm text-muted">
              What they finish anywhere else is marked played on their Jellyfin server, and what they stop part-way picks up at the same spot there. Checked every 10 minutes.
            </p>
          </div>
        </div>
        <ToggleSwitch checked={state.enabled} onChange={() => toggle(!state.enabled)} disabled={saving} title="Keep Jellyfin in step" />
      </div>
    </>
  );
}
