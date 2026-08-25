'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { api, AddonHealthConfig } from '@/lib/api';
import { BoltIcon } from '@heroicons/react/24/outline';

// Per-addon health-check overrides, shown inside the Backup Addon card -
// the two belong together: the health check is what DECIDES a failover,
// so how it decides should be configurable next to what it fails over to.
// Consumed by server/utils/addonHealthCheck.js:
//   - probeUrl: check this URL instead of the manifest. A manifest served
//     from cache while the addon's backend is dead reads as "online" - a
//     catalog/stream endpoint is often the truer signal.
//   - failureThreshold: consecutive failed runs before the addon flips
//     offline (and failover/alerts fire). Default 1 = today's behavior.
//   - intervalMinutes: probe this addon less often than the global cadence.
//
// The Automate button hands off to the existing automation engine (which
// already has addon.offline/addon.online triggers) with a rule pre-filled
// for THIS addon - discoverability for plumbing that already existed.
interface AddonHealthSettingsProps {
  addonId: string;
  addonName: string;
  healthConfig: AddonHealthConfig | null | undefined;
  onSaved: (next: AddonHealthConfig | null) => void;
}

export function AddonHealthSettings({ addonId, addonName, healthConfig, onSaved }: AddonHealthSettingsProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [probeUrl, setProbeUrl] = useState(healthConfig?.probeUrl || '');
  const [threshold, setThreshold] = useState(healthConfig?.failureThreshold ? String(healthConfig.failureThreshold) : '');
  const [interval, setIntervalMin] = useState(healthConfig?.intervalMinutes ? String(healthConfig.intervalMinutes) : '');
  const [saving, setSaving] = useState(false);

  const customized = !!(healthConfig && (healthConfig.probeUrl || healthConfig.failureThreshold || healthConfig.intervalMinutes));

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.setAddonHealthConfig(addonId, {
        probeUrl: probeUrl.trim(),
        failureThreshold: threshold.trim(),
        intervalMinutes: interval.trim(),
      });
      onSaved(res.data?.healthConfig ?? null);
      toast.success('Health check settings saved');
      setExpanded(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save health settings');
    } finally {
      setSaving(false);
    }
  };

  const handleAutomate = () => {
    // Handoff read by AutomationPanel on the Tasks page - a new rule opens
    // pre-scoped to this addon going offline; the user picks the action.
    try {
      sessionStorage.setItem('slicksync-automation-prefill', JSON.stringify({
        name: `${addonName} went offline`,
        triggerType: 'addon.offline',
        conditions: [{ field: 'addonId', op: 'eq', value: addonId }],
      }));
    } catch { /* private mode - the panel just opens blank */ }
    router.push('/tasks?open=automation');
  };

  const inputClass = 'w-full px-3 py-2 rounded-lg text-sm border border-transparent focus:border-primary focus:outline-none';
  const inputStyle = { background: 'var(--color-surface)', color: 'var(--color-text)' } as const;

  return (
    <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--color-surface-border)' }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-left"
        >
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            Health check settings
            {customized && (
              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full font-medium align-middle" style={{ background: 'var(--color-primaryMuted)', color: 'var(--color-primary)' }}>
                Customized
              </span>
            )}
          </span>
          <span className="block text-[11px] mt-0.5" style={{ color: 'var(--color-text-subtle)' }}>
            {expanded ? 'What counts as "offline" for this addon' : 'Custom probe URL, failure threshold, check interval'}
          </span>
        </button>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" leftIcon={<BoltIcon className="w-4 h-4" />} onClick={handleAutomate} title="Create an automation rule that fires when this addon goes offline">
            Automate
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide' : 'Edit'}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Custom probe URL <span style={{ color: 'var(--color-text-subtle)' }}>(optional — default probes the manifest)</span>
            </label>
            <input
              type="text"
              value={probeUrl}
              onChange={(e) => setProbeUrl(e.target.value)}
              placeholder="https://… a catalog or status endpoint that only answers when the addon truly works"
              spellCheck={false}
              className={inputClass}
              style={inputStyle}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
                Failures before offline <span style={{ color: 'var(--color-text-subtle)' }}>(1–10)</span>
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                placeholder="1"
                className={inputClass}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
                Check interval, minutes <span style={{ color: 'var(--color-text-subtle)' }}>(5–1440)</span>
              </label>
              <input
                type="number"
                min={5}
                max={1440}
                value={interval}
                onChange={(e) => setIntervalMin(e.target.value)}
                placeholder="global default"
                className={inputClass}
                style={inputStyle}
              />
            </div>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--color-text-subtle)' }}>
            Failures-before-offline stops one network blip from triggering failover and alerts; the raw result
            of every probe still lands in Health History either way. Clearing a field returns it to the default.
          </p>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
