'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { CheckCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';

// What this instance hasn't been set up with yet.
//
// Every fact here was already discoverable - but only by opening five
// different pages and knowing what to look for, which is exactly what a new
// operator cannot do. This puts the unfinished items in one place with a
// link each.
//
// Deliberately NOT a nag: nothing listed is required for SlickSync to work,
// items disappear as they're done, the whole card can be dismissed forever,
// and it hides itself once everything is complete. Dismissal is per-device
// (localStorage) for the same reason Beginner Mode is - it's about one
// person's view, not a shared setting somebody else flips.

const DISMISS_KEY = 'slicksync-setup-checklist-dismissed';

interface ChecklistItem {
  key: string;
  label: string;
  detail: string;
  href: string;
  done: boolean;
}

export function SetupChecklist() {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume hidden until localStorage is read post-mount

  useEffect(() => {
    try { setDismissed(localStorage.getItem(DISMISS_KEY) === '1'); } catch { setDismissed(false); }
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api.getSetupStatus();
      setItems([
        { key: 'users', label: 'Add a user', detail: 'Connect a Stremio or Nuvio account so there is something to sync.', href: '/users', done: s.users.done },
        { key: 'addons', label: 'Add an addon', detail: 'Browse the directory or paste a manifest URL.', href: '/addons', done: s.addons.done },
        { key: 'notifications', label: 'Turn on notifications', detail: 'Otherwise nothing tells you when an addon goes down or a backup fails.', href: '/settings', done: s.notifications.done },
        { key: 'timezone', label: 'Set your timezone', detail: 'Watch Time Today and streaks bucket by day - this decides when "today" ends.', href: '/settings', done: s.timezone.done },
        { key: 'offsiteBackup', label: 'Send backups off-site', detail: 'A backup sitting next to a dead server is not a backup.', href: '/tasks', done: s.offsiteBackup.done },
        { key: 'recoveryKit', label: 'Export a Recovery Kit', detail: 'The only way to restore Vault credentials onto a brand-new instance.', href: '/settings', done: s.recoveryKit.done },
        { key: 'automation', label: 'Try an automation recipe', detail: 'One click sets up "tell me when an addon goes down".', href: '/tasks', done: s.automation.done },
      ]);
    } catch {
      // Silent: a checklist that cannot load is not worth an error banner on
      // someone's dashboard.
      setItems([]);
    }
  }, []);

  useEffect(() => { if (!dismissed) load(); }, [dismissed, load]);

  if (dismissed || !items) return null;
  const remaining = items.filter((i) => !i.done);
  // Nothing left to do - the card retires itself rather than sitting there
  // as a wall of ticks.
  if (remaining.length === 0) return null;

  const handleDismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
    setDismissed(true);
  };

  return (
    <Card padding="lg" className="mb-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-base font-semibold text-default">Finish setting up</h3>
          <p className="text-xs text-muted mt-0.5">
            {items.length - remaining.length} of {items.length} done. None of this is required - it is just the stuff people usually want on.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="p-1.5 rounded-lg text-subtle hover:text-default shrink-0"
          aria-label="Dismiss setup checklist"
          title="Hide this permanently"
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-2">
        {remaining.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="flex items-start gap-3 p-3 rounded-xl transition-colors nav-item-hover-pill"
            style={{ background: 'var(--color-surface-hover)' }}
          >
            <div className="w-5 h-5 rounded-full border-2 shrink-0 mt-0.5" style={{ borderColor: 'var(--color-surface-border)' }} />
            <div className="min-w-0">
              <span className="block text-sm font-medium text-default">{item.label}</span>
              <span className="block text-xs text-muted mt-0.5">{item.detail}</span>
            </div>
          </Link>
        ))}
      </div>

      {items.length - remaining.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted mt-3">
          <CheckCircleIcon className="w-4 h-4" style={{ color: 'var(--color-success)' }} />
          {items.filter((i) => i.done).map((i) => i.label).join(' · ')}
        </p>
      )}

      <div className="mt-3">
        <Button variant="ghost" size="sm" onClick={load}>Refresh</Button>
      </div>
    </Card>
  );
}
