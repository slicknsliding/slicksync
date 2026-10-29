'use client';

// What's New in the v2 page design: each release as a box with its version,
// a Latest chip (it copies the update command), its title and date. The
// newest is open, the rest folded. The page loads the releases and owns the
// copy handler; this draws them.

import { useState } from 'react';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';

export type ChangelogV2Release = {
  version: string;
  tagName: string;
  date: string;
  title?: string;
  features: string[];
  bugFixes: string[];
  miscChores: string[];
  otherSections: { title: string; items: string[] }[];
  htmlUrl: string;
  isPreRelease: boolean;
};

const cap = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

function Group({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="font-semibold text-[14px] text-default mb-1.5">{title}</div>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="text-sm text-muted pl-4 relative before:content-['•'] before:absolute before:left-0">{cap(it)}</li>
        ))}
      </ul>
    </div>
  );
}

function ReleaseBox({ release, latest, current, open, onToggle, copied, onCopy }: {
  release: ChangelogV2Release;
  latest: boolean;
  current: boolean;
  open: boolean;
  onToggle: () => void;
  copied: boolean;
  onCopy: () => void;
}) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="v2-box" style={current ? { borderColor: 'var(--color-primary)' } : undefined}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onToggle(); } }}
        className="flex items-center gap-x-2.5 gap-y-1 flex-wrap px-[18px] py-3.5 cursor-pointer"
      >
        <a
          href={release.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stop}
          className="font-bold text-[17px] hover:text-primary transition-colors"
          title="Open this release on GitHub"
        >
          v{release.version}
        </a>
        {latest && (
          <button
            type="button"
            onClick={(e) => { stop(e); onCopy(); }}
            className="v2-chip"
            style={{ color: '#22c55e', borderColor: 'color-mix(in srgb, #22c55e 35%, transparent)', cursor: 'pointer', gap: 5 }}
            title="Copy the command that updates this server"
          >
            {copied ? <CheckIcon className="w-3 h-3" /> : <ClipboardDocumentIcon className="w-3 h-3" />}
            {copied ? 'Copied!' : 'Latest'}
          </button>
        )}
        {current && <span className="v2-chip" style={{ color: 'var(--color-primary)', borderColor: 'color-mix(in srgb, var(--color-primary) 35%, transparent)' }}>Installed</span>}
        {release.isPreRelease && <span className="v2-chip" style={{ color: 'var(--color-warning, #f59e0b)', borderColor: 'color-mix(in srgb, var(--color-warning, #f59e0b) 35%, transparent)' }}>Pre-release</span>}
        <span className="text-muted text-[13px]">
          {release.title ? `${release.title} · ` : ''}
          {/* A plain YYYY-MM-DD date is read as UTC midnight; showing it in
              UTC keeps it on the day it says, wherever the viewer is. */}
          {new Date(release.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}
        </span>
        <span className="flex-1" />
        <span className="text-muted">{open ? <ChevronDownIcon className="w-5 h-5" /> : <ChevronRightIcon className="w-5 h-5" />}</span>
      </div>
      {open && (
        <div className="px-[18px] pb-4 pt-1 space-y-4 border-t border-[var(--color-surface-border)]">
          <div className="pt-3 space-y-4">
            <Group title="New" items={release.features} />
            <Group title="Fixed" items={release.bugFixes} />
            <Group title="Behind the scenes" items={release.miscChores} />
            {release.otherSections.map((s) => <Group key={`${release.version}-${s.title}`} title={cap(s.title)} items={s.items} />)}
            {release.features.length + release.bugFixes.length + release.miscChores.length + release.otherSections.reduce((n, s) => n + s.items.length, 0) === 0 && (
              <p className="text-sm text-muted">No notes for this release.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChangelogV2({ releases, appVersion, copied, onCopy }: {
  releases: ChangelogV2Release[];
  appVersion: string;
  copied: boolean;
  onCopy: () => void;
}) {
  // The newest release starts open; each box opens and folds on its own.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  return (
    <div className="space-y-3">
      {releases.map((r, i) => {
        const open = opened[r.version] ?? i === 0;
        return (
          <ReleaseBox
            key={r.tagName || r.version}
            release={r}
            latest={i === 0}
            current={r.version === appVersion}
            open={open}
            onToggle={() => setOpened((prev) => ({ ...prev, [r.version]: !open }))}
            copied={copied}
            onCopy={onCopy}
          />
        );
      })}
    </div>
  );
}
