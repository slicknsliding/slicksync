'use client';

// A person's Addons in the v2 page design: the two tabs become two sections.
// What their group gives them (each with Leave out / Bring back) and their
// own on their app (with Remove, and Keep / Stop keeping in ⋯), ending in an
// Add an addon tile. Sections can be moved, folded and hidden.

import { useState, type ReactNode } from 'react';
import { PlusIcon, PuzzlePieceIcon, ShieldCheckIcon, ShieldExclamationIcon } from '@heroicons/react/24/outline';
import { ArrangeButton, ArrangeBar, ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import type { PageArrange } from '@/lib/arrange';
import type { GroupAddon, StremioAddon } from '@/lib/user-api';
import { MeHead } from './MeBits';
import { V2Button, V2Status, type V2Tone } from './V2Bits';
import { V2MoreMenu } from './V2Detail';

export const ADDON_SECTIONS = ['group', 'own'] as const;

function Tile({ logo, name, line, status, tone, button, menu }: {
  logo?: string;
  name: string;
  line?: string;
  status: string;
  tone: V2Tone;
  button?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="v2-tool" style={{ cursor: 'default' }}>
      <span className="v2-tool-icon">
        {logo
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={logo} alt="" className="w-6 h-6 object-contain" />
          : <PuzzlePieceIcon className="w-5 h-5" />}
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span className="block font-semibold text-[14.5px] text-default truncate">{name}</span>
        <span className="block text-muted text-[12.5px] truncate">{line || ' '}</span>
        <span className="block mt-1"><V2Status tone={tone}>{status}</V2Status></span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        {button}
        {menu}
      </span>
    </div>
  );
}

export function MeAddonsV2({
  arrange, groupName, providerLabel, groupAddons, excludedIds, stremioAddons, protectedNames, busy,
  onToggleExclude, onToggleProtect, onRemove, onAdd,
}: {
  arrange: PageArrange;
  groupName?: string | null;
  providerLabel: string;
  groupAddons: GroupAddon[];
  excludedIds: string[];
  stremioAddons: StremioAddon[];
  protectedNames: string[];
  busy: string | null;
  onToggleExclude: (id: string, excluded: boolean) => void;
  onToggleProtect: (name: string, isProtected: boolean) => void;
  onRemove: (name: string) => void;
  onAdd: (url: string) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const on = groupAddons.filter((a) => !excludedIds.includes(a.id)).length;
  const labels: Record<string, string> = { group: groupName ? `From ${groupName}` : 'From your group', own: `Your own, on ${providerLabel}` };

  const submit = async () => {
    const value = url.trim();
    if (!value || saving) return;
    setSaving(true);
    const ok = await onAdd(value);
    setSaving(false);
    if (ok) { setUrl(''); setAdding(false); }
  };

  return (
    <div>
      <MeHead
        title="Your addons"
        sub={`${on} from ${groupName || 'your group'} · ${stremioAddons.length} of your own`}
        actions={<ArrangeButton arrange={arrange} />}
      />
      <ArrangeBar arrange={arrange} />

      {arrange.shown.map((key) => {
        if (key === 'group') {
          return (
            <ArrangeSection key={key} arrange={arrange} id={key} title={labels.group} meta="kept in step for you" noun="section">
              {groupAddons.length === 0 ? (
                <p className="text-sm text-muted py-1">Your group doesn’t have any addons yet.</p>
              ) : (
                <>
                  <div className="v2-tiles v2-tiles-2">
                    {groupAddons.map((a) => {
                      const left = excludedIds.includes(a.id);
                      return (
                        <Tile
                          key={a.id}
                          logo={a.logo}
                          name={a.name}
                          line={a.description}
                          status={left ? 'Left out' : a.isProtected ? 'On, protected' : 'On'}
                          tone={left ? 'off' : 'ok'}
                          button={<V2Button disabled={busy === a.id} onClick={() => onToggleExclude(a.id, left)}>{left ? 'Bring back' : 'Leave out'}</V2Button>}
                        />
                      );
                    })}
                  </div>
                  <p className="text-muted text-[12.5px] mt-2.5">Addons you leave out aren’t put on your {providerLabel} account.</p>
                </>
              )}
            </ArrangeSection>
          );
        }
        return (
          <ArrangeSection key={key} arrange={arrange} id={key} title={labels.own} meta={`${stremioAddons.length}`} noun="section">
            <div className="v2-tiles v2-tiles-2">
              {stremioAddons.map((a) => {
                const name = a.manifest?.name || '';
                const kept = protectedNames.includes(name);
                const official = !!a.flags?.official;
                return (
                  <Tile
                    key={a.manifest.id}
                    logo={a.manifest.logo}
                    name={name}
                    line={a.manifest.description}
                    status={official ? 'Official' : kept ? 'Kept' : 'Not kept'}
                    tone={official || kept ? 'ok' : 'off'}
                    button={!kept && !official ? <V2Button disabled={busy === name} onClick={() => onRemove(name)}>Remove</V2Button> : undefined}
                    menu={(
                      <V2MoreMenu
                        label={`More for ${name}`}
                        items={[{
                          label: kept ? 'Stop keeping it' : 'Keep it through syncs',
                          icon: kept ? <ShieldExclamationIcon className="w-4 h-4" /> : <ShieldCheckIcon className="w-4 h-4" />,
                          disabled: busy === name,
                          onClick: () => onToggleProtect(name, kept),
                        }]}
                      />
                    )}
                  />
                );
              })}
              {adding ? (
                <div className="v2-tool" style={{ cursor: 'default', flexWrap: 'wrap' }}>
                  <input
                    type="url"
                    autoFocus
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setAdding(false); }}
                    placeholder="Paste the addon’s link"
                    aria-label="Addon link"
                    className="flex-1 min-w-[160px] px-3 py-2 text-sm rounded-lg"
                    style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' }}
                  />
                  <V2Button onClick={() => { setAdding(false); setUrl(''); }}>Cancel</V2Button>
                  <V2Button primary disabled={!url.trim() || saving} onClick={submit}>{saving ? 'Adding…' : 'Add'}</V2Button>
                </div>
              ) : (
                <button
                  type="button"
                  className="rounded-2xl px-3.5 py-3 flex items-center justify-center gap-2 text-muted min-h-[64px] hover:text-default"
                  style={{ border: '1px dashed var(--color-surface-border)' }}
                  onClick={() => setAdding(true)}
                >
                  <PlusIcon className="w-4 h-4" />
                  Add an addon
                </button>
              )}
            </div>
            <p className="text-muted text-[12.5px] mt-2.5">Kept addons aren’t removed when SlickSync syncs.</p>
          </ArrangeSection>
        );
      })}
      <HiddenTray arrange={arrange} labelOf={(id) => labels[id] || id} />
    </div>
  );
}
