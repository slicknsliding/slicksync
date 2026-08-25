'use client';

import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { decodeAddonConfig, AddonConfigField } from '@/lib/addonConfig';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';

// In-place addon configuration editor. Decodes the settings most addons
// carry inside their manifest URL (see lib/addonConfig.ts for the wire
// shapes) into editable fields; Save rebuilds the URL and hands it to the
// SAME save path the manual URL input already uses - which re-fetches the
// manifest server-side and updates every user/group carrying the addon.
// Nothing new happens on save that pasting the rebuilt URL wouldn't do;
// this just removes the "reconfigure on the addon's website, copy, paste"
// loop for formats we can read.
//
// Addons whose config is encrypted/opaque (AIOStreams-style) get the
// fallback: a link to the addon's own hosted /configure page - by
// convention prefilled from the URL's config segment - plus the existing
// URL input to paste the result back into.
interface AddonConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  addonName: string;
  manifestUrl: string;
  /** The detail page's existing save handler (ManifestUrlInput's onSave). */
  onSave: (data: { manifestUrl: string }) => Promise<void>;
}

export function AddonConfigModal({ isOpen, onClose, addonName, manifestUrl, onSave }: AddonConfigModalProps) {
  const decoded = useMemo(() => decodeAddonConfig(manifestUrl), [manifestUrl]);
  const [fields, setFields] = useState<AddonConfigField[] | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Fields state initializes lazily from the decoded config each time the
  // modal opens fresh (keyed remount handles reset - see call site).
  const current = fields ?? decoded?.fields ?? [];

  const setField = (key: string, value: string) => {
    setFields(current.map((f) => (f.key === key ? { ...f, value } : f)));
  };

  const handleSave = async () => {
    if (!decoded) return;
    let rebuilt: string;
    try {
      rebuilt = decoded.rebuild(current);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Invalid value');
      return;
    }
    if (rebuilt === manifestUrl) { onClose(); return; }
    setSaving(true);
    try {
      await onSave({ manifestUrl: rebuilt });
      toast.success('Configuration saved and redeployed');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Configure ${addonName}`} size="lg">
      {decoded ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            These settings live inside the addon&apos;s install URL. Saving rebuilds the URL, re-fetches the
            manifest, and updates every user and group that has this addon — no remove/re-import needed.
          </p>
          <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
            {current.map((f) => (
              <div key={f.key}>
                <label className="flex items-center justify-between text-xs font-medium text-muted mb-1">
                  <span className="font-mono">{f.key}</span>
                  <span className="flex items-center gap-2">
                    {f.kind !== 'string' && <span className="text-subtle normal-case">{f.kind === 'string-list' ? 'comma-separated' : f.kind}</span>}
                    {f.sensitive && (
                      <button
                        type="button"
                        onClick={() => setRevealed((prev) => {
                          const next = new Set(prev);
                          if (next.has(f.key)) next.delete(f.key); else next.add(f.key);
                          return next;
                        })}
                        className="text-subtle hover:text-default transition-colors"
                        aria-label={revealed.has(f.key) ? 'Hide value' : 'Show value'}
                      >
                        {revealed.has(f.key) ? <EyeSlashIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </span>
                </label>
                {f.kind === 'boolean' ? (
                  <select
                    value={f.value}
                    onChange={(e) => setField(f.key, e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-surface-hover text-default text-sm border border-transparent focus:border-primary focus:outline-none"
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    type={f.sensitive && !revealed.has(f.key) ? 'password' : 'text'}
                    value={f.value}
                    onChange={(e) => setField(f.key, e.target.value)}
                    spellCheck={false}
                    className="w-full px-3 py-2 rounded-lg bg-surface-hover text-default text-sm font-mono border border-transparent focus:border-primary focus:outline-none"
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save & redeploy'}
            </Button>
          </div>
        </div>
      ) : (
        // Unreachable in practice - the detail page only renders its "Edit
        // config" button when decodeAddonConfig succeeds (opaque configs are
        // served by the page's existing external Configure action instead).
        // Kept as a plain close-out rather than dead fallback UI.
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      )}
    </Modal>
  );
}
