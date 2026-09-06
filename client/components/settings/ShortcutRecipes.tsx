'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { ClipboardDocumentIcon, CheckIcon, DevicePhoneMobileIcon } from '@heroicons/react/24/outline';

// iOS Shortcuts recipes with this instance's own address and key filled in.
//
// Apple does not let a web app register as a share target, so on an iPhone
// the way to hand SlickSync a link, or to ask it what you were watching,
// is a Shortcut. Every one of these is three or four actions; what people
// get wrong is the URL and the header, so those are the copyable parts.
// Nothing here is iOS-specific - the same calls work from Tasker, Home
// Assistant or a shell script - Shortcuts is just what everyone has.

interface Recipe {
  title: string;
  does: string;
  steps: string[];
  copy: Array<{ label: string; value: string; secret?: boolean }>;
}

function buildRecipes(base: string, authHeader: string): Recipe[] {
  return [
    {
      title: 'Send to SlickSync',
      does: 'From any app’s share sheet, a link or a title opens Discover already searched – an IMDb link resolves straight to the title.',
      steps: [
        'New Shortcut → Details → turn on "Show in Share Sheet", accept URLs and Text.',
        'Add "URL Encode" with Shortcut Input.',
        'Add "Open URLs" with the address below, then paste the encoded text right after the "=".',
      ],
      copy: [{ label: 'Address', value: `${base}/discover?st_text=` }],
    },
    {
      title: 'What was I watching',
      does: 'Reads the next episode of everything in progress and opens the one you pick straight in Stremio or Nuvio. Works as a Siri phrase or a Home Screen button.',
      steps: [
        'Add "Get Contents of URL" with the address below, Method GET, and a header named Authorization set to the value below.',
        'Add "Get Dictionary Value" for the key "items", then "Choose from List".',
        'Add "Get Dictionary Value" for the key "appUrl", then "Open URLs".',
      ],
      copy: [
        { label: 'Address', value: `${base}/api/ext/continue-watching?limit=5` },
        { label: 'Authorization header', value: authHeader, secret: true },
      ],
    },
    {
      title: 'Sync everything',
      does: 'Syncs the whole household in one tap, or on a schedule as a Personal Automation – when you get home, at bedtime, whenever.',
      steps: [
        'Add "Get Contents of URL" with the address below, Method POST, and the Authorization header.',
        'Put the Shortcut on the Home Screen, or attach it to an Automation.',
      ],
      copy: [
        { label: 'Address', value: `${base}/api/ext/groups/sync` },
        { label: 'Authorization header', value: authHeader, secret: true },
      ],
    },
  ];
}

export function ShortcutRecipes({ baseUrl, apiKey }: { baseUrl?: string | null; apiKey: string | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = (baseUrl && baseUrl.trim() ? baseUrl.trim() : origin).replace(/\/$/, '');
  const authHeader = apiKey ? `Bearer ${apiKey}` : 'Bearer <your API key>';
  const recipes = buildRecipes(base, authHeader);

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      toast.success('Copied');
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      toast.error('Could not copy – select it and copy by hand');
    }
  };

  return (
    <Card padding="lg">
      <div className="flex items-start gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary-muted shrink-0">
          <DevicePhoneMobileIcon className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold font-display text-default">iOS Shortcuts</h3>
          <p className="text-xs text-muted">
            Apple doesn’t let a web app appear in the share sheet, so on an iPhone these three Shortcuts are how you hand SlickSync a link or ask it what you were watching. Your own address and key are already filled in – copy, paste, done.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {recipes.map((r) => {
          const isOpen = open === r.title;
          return (
            <div key={r.title} className="rounded-xl border border-default bg-surface-hover">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : r.title)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
                aria-expanded={isOpen}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-default">{r.title}</p>
                  <p className="text-xs text-muted">{r.does}</p>
                </div>
                <span className="text-xs text-subtle shrink-0">{isOpen ? 'Hide' : 'Show steps'}</span>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 space-y-3">
                  <ol className="list-decimal pl-5 space-y-1 text-xs text-default">
                    {r.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                  <div className="space-y-2">
                    {r.copy.map((c) => {
                      const key = `${r.title}:${c.label}`;
                      const shown = c.secret && apiKey ? `Bearer ${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : c.value;
                      return (
                        <div key={key} className="flex items-center gap-2">
                          <span className="text-[11px] uppercase tracking-wider text-muted w-40 shrink-0">{c.label}</span>
                          <code className="flex-1 min-w-0 truncate text-xs px-2 py-1.5 rounded-md bg-surface text-default">{shown}</code>
                          <button
                            type="button"
                            onClick={() => copy(key, c.value)}
                            className="p-1.5 rounded-md text-muted hover:text-default hover:bg-surface transition-colors shrink-0"
                            title={`Copy ${c.label.toLowerCase()}`}
                            aria-label={`Copy ${c.label.toLowerCase()}`}
                          >
                            {copied === key ? <CheckIcon className="w-4 h-4 text-success" /> : <ClipboardDocumentIcon className="w-4 h-4" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {r.copy.some((c) => c.secret) && !apiKey && (
                    <p className="text-xs text-warning">Generate an API key above first – the header needs it.</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-subtle mt-3">
        The sync one changes real state – anyone holding that key can sync your household, so treat it like a password. Full walkthrough in <a href="/guides/ios-shortcuts" className="text-primary hover:underline">Guides → iOS Shortcuts</a>.
      </p>
    </Card>
  );
}
