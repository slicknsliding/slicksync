'use client';

// Adding to the Vault, and editing what is there.
//
// Step one: pick what it is, as tiles. Step two: only the boxes that kind
// has, the ones that must be filled marked. Billing and the extras sit in
// two folded strips. SlickSync says in one line how it will check the entry,
// or says plainly when it cannot. Editing opens straight on step two.
//
// What each kind asks for, and how it is stored, lives in lib/vaultKinds.

import { useMemo, useState, type ClipboardEvent, type ReactNode } from 'react';
import { ChevronLeftIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { Button, Input, ToggleSwitch } from '@/components/ui';
import type { VaultEntry, VaultTestType } from '@/lib/api';
import {
  AUTO_DATE_SOURCES, KINDS, datedByService, formOf, fromEntry, kindOf, missing, splitPasted, startValues, testTypeOf, toPayload,
  type Billing, type FieldDef, type FieldKey, type KindDef, type VaultFormValues, type VaultPayload,
} from '@/lib/vaultKinds';

const BILLING: { id: Billing; label: string }[] = [
  { id: 'none', label: 'Not tracked' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'yearly', label: 'Yearly' },
  { id: 'once', label: 'One-time' },
  { id: 'free', label: 'Free' },
];
const BILLING_WORDS: Record<Billing, string> = { none: 'Not tracked', monthly: 'Monthly', yearly: 'Yearly', once: 'One-time · lifetime', free: 'Free' };

// The checks someone can pick for a key of their own, in plain words.
const OWN_CHECKS: { id: VaultTestType; label: string }[] = [
  { id: 'manual', label: 'Don’t check it, just keep it' },
  { id: 'generic_http', label: 'Open an address and expect an answer' },
  { id: 'tcp_reachability', label: 'See that a server answers' },
];

const SELECT_CLASS = 'w-full px-4 py-3 rounded-xl focus:outline-none';
const SELECT_STYLE = { background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text)' } as const;

function formatDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${d}, ${y}`;
}

/** A kind's own mark: the service's logo where it has one, an emoji otherwise. */
export function KindMark({ kind, size = 28 }: { kind: KindDef; size?: number }) {
  if (kind.logo) {
    const file = kind.logo === 'stremio' || kind.logo === 'jellyfin' ? `${kind.logo}.svg` : `${kind.logo}.png`;
    // eslint-disable-next-line @next/next/no-img-element -- a 28px mark from /public; nothing for the image optimizer to do
    return <img className="vault-kind-mark" src={`/logos/${file}`} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  }
  return <span className="vault-kind-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.78) }} aria-hidden="true">{kind.emoji}</span>;
}

function Label({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <label className="block text-sm font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
      {children}{required && <span aria-hidden="true" style={{ color: 'var(--color-error)' }}> *</span>}
    </label>
  );
}

function Fold({ title, summary, open, onToggle, children }: { title: string; summary: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="vault-fold">
      <button type="button" onClick={onToggle} aria-expanded={open}>
        {title}<small>{summary} {open ? '▾' : '▸'}</small>
      </button>
      {open && <div className="vault-fold-body">{children}</div>}
    </div>
  );
}

export function VaultEntryForm({ editing, startWith, currency, planOffer, arrivedViaAlert, saving, onCancel, onSubmit, onRevealSecret }: {
  /** The entry being edited, with its details (api.getVaultEntry); null when adding. */
  editing: VaultEntry | null;
  /** Adding, but starting from these (Duplicate). */
  startWith?: VaultFormValues | null;
  currency: string;
  /** TorBox's plan and list price, offered once for an empty Cost box. */
  planOffer?: { name: string; monthlyUsd: number } | null;
  /** Opened from an alert's "Fix now": the link to the provider goes on top. */
  arrivedViaAlert?: boolean;
  saving: boolean;
  onCancel: () => void;
  /** `test`: run its check straight after adding. */
  onSubmit: (payload: VaultPayload, opts: { test: boolean }) => void;
  /** Editing: fetch the secret on file, for the eye in the box. */
  onRevealSecret?: () => Promise<string | null>;
}) {
  const [v, setV] = useState<VaultFormValues | null>(() => (editing ? fromEntry(editing) : startWith ?? null));
  const [open, setOpen] = useState<{ billing: boolean; more: boolean }>({ billing: false, more: false });
  const [problem, setProblem] = useState<string | null>(null);
  const [pastedNote, setPastedNote] = useState<string | null>(null);
  // Boxes an older entry never filled may stay empty when it is edited.
  const wasEmpty = useMemo(() => {
    const out: Partial<Record<FieldKey, boolean>> = {};
    if (!editing) return out;
    const start = fromEntry(editing);
    for (const f of formOf(start).fields) if (f.type !== 'switch' && !String(start[f.key] ?? '').trim()) out[f.key] = true;
    return out;
  }, [editing]);

  const set = (patch: Partial<VaultFormValues>) => { setProblem(null); setV((prev) => (prev ? { ...prev, ...patch } : prev)); };

  // ---------- step one: what is it? ----------
  if (!v) {
    return (
      <div>
        <h2 className="text-xl font-semibold font-display text-default pr-10">Add to the Vault</h2>
        <p className="text-sm text-muted mt-1 mb-4">What is it?</p>
        <div className="vault-tiles">
          {KINDS.map((k) => {
            const pick = () => { setV(startValues(k.id)); setOpen({ billing: false, more: false }); setPastedNote(null); };
            return (
              <button key={k.id} type="button" className={k.wide ? 'vault-tile wide' : 'vault-tile'} onClick={pick}>
                <KindMark kind={k} />
                <span>{k.title}</span>
                <small>{k.line}</small>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ---------- step two: what that kind has ----------
  const kind = kindOf(v.kind);
  const form = formOf(v);
  const checkText = form.pickCheck ? null : form.check(v);
  const willCheck = form.pickCheck ? v.check !== 'manual' : !!checkText;
  const byService = datedByService(v);
  const source = AUTO_DATE_SOURCES[testTypeOf(v)];
  const tracked = v.billing === 'monthly' || v.billing === 'yearly';
  const per = v.billing === 'yearly' ? 'year' : 'month';
  // The date on file came from the service only while the entry still uses the check it was saved with.
  const dateOnFile = editing && editing.expiresAt && editing.testType === testTypeOf(v) ? editing.expiresAt.split('T')[0] : '';

  const paste = (f: FieldDef) => (e: ClipboardEvent<HTMLInputElement>) => {
    if (f.key !== 'url') return;
    const parts = splitPasted(v, e.clipboardData.getData('text'));
    if (!parts) return;
    e.preventDefault();
    set(parts);
    setPastedNote(v.kind === 'usenet_indexer' ? 'Found a key in what you pasted and moved it to its own box.' : 'Found a login in what you pasted and moved it to its own boxes.');
  };

  const reveal = async () => {
    if (!onRevealSecret || v.secret) return;
    const secret = await onRevealSecret();
    if (secret == null) return;
    // A usenet provider's username and password are kept as one piece.
    if (v.kind === 'usenet_provider') {
      try { const both = JSON.parse(secret) as { username?: string; password?: string }; set({ username: both.username || '', secret: both.password || '' }); return; } catch { /* an older entry: the secret is the password alone */ }
    }
    set({ secret });
  };

  const field = (f: FieldDef) => {
    if (f.when && !f.when(v)) return null;
    const label = typeof f.label === 'function' ? f.label(v) : f.label;
    const value = v[f.key];
    if (f.type === 'switch') {
      return (
        <div key={f.key} className="flex items-center justify-between p-3 rounded-xl" style={{ background: 'var(--color-subtle)' }}>
          <span className="text-sm" style={{ color: 'var(--color-text)' }}>{label}</span>
          <ToggleSwitch checked={!!value} onChange={() => set({ [f.key]: !value } as Partial<VaultFormValues>)} />
        </div>
      );
    }
    const keepNote = editing && (f.type === 'secret' || f.type === 'note') ? ' (leave blank to keep what is saved)' : '';
    let box: ReactNode;
    if (f.type === 'pick') {
      box = (
        <select value={String(value)} onChange={(e) => set({ [f.key]: e.target.value } as Partial<VaultFormValues>)} className={SELECT_CLASS} style={SELECT_STYLE} aria-label={label}>
          {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    } else if (f.type === 'note') {
      box = (
        <textarea
          value={String(value)}
          onChange={(e) => set({ [f.key]: e.target.value } as Partial<VaultFormValues>)}
          placeholder={editing ? 'Type a new note to replace the one that is saved' : f.placeholder}
          rows={4}
          aria-label={label}
          className="slicksync-input w-full rounded-xl px-4 py-3 border focus:outline-none"
          style={{ backgroundColor: 'var(--color-surface-hover)', color: 'var(--color-text)', borderColor: 'var(--color-surface-border)', resize: 'vertical' }}
        />
      );
    } else {
      box = (
        <Input
          type={f.type === 'secret' ? 'password' : 'text'}
          value={String(value)}
          onChange={(e) => set({ [f.key]: e.target.value } as Partial<VaultFormValues>)}
          onPaste={paste(f)}
          placeholder={editing && f.type === 'secret' ? '••••••••' : f.placeholder}
          aria-label={label}
          autoComplete="off"
          onRevealClick={editing && f.type === 'secret' && f.key === 'secret' ? () => { void reveal(); } : undefined}
        />
      );
    }
    return (
      <div key={f.key} className="min-w-0">
        <Label required={f.required}>{label}{keepNote}</Label>
        {box}
        {f.hint && <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>{f.hint}</p>}
        {f.key === 'url' && pastedNote && <p className="text-xs mt-1.5" style={{ color: 'var(--color-secondary)' }}>{pastedNote}</p>}
      </div>
    );
  };
  // Two boxes marked `half` in a row share a line on wide screens.
  const fields = (list: FieldDef[]) => {
    const out: ReactNode[] = [];
    const shown = list.filter((f) => !f.when || f.when(v));
    for (let i = 0; i < shown.length; i++) {
      const a = shown[i], b = shown[i + 1];
      if (a.half && b?.half) { out.push(<div key={`${a.key}+${b.key}`} className="grid grid-cols-1 sm:grid-cols-2 gap-3">{field(a)}{field(b)}</div>); i++; }
      else out.push(field(a));
    }
    return out;
  };

  const billingSummary = (() => {
    const base = BILLING_WORDS[v.billing];
    if ((tracked || v.billing === 'once') && v.cost.trim() && Number(v.cost) >= 0) {
      try { return `${base} · ${new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(v.cost))}`; } catch { return base; }
    }
    return base;
  })();

  const submit = () => {
    const what = missing(v, { editing: !!editing, wasEmpty });
    if (what) { setProblem(what); return; }
    onSubmit(toPayload(v), { test: !editing && willCheck });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 pr-10">
        {!editing && !startWith && (
          <button type="button" onClick={() => { setV(null); setProblem(null); }} aria-label="Back to the kinds" className="p-2 rounded-lg shrink-0" style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text)' }}>
            <ChevronLeftIcon className="w-4 h-4" />
          </button>
        )}
        <KindMark kind={kind} />
        <h2 className="text-xl font-semibold font-display text-default min-w-0 break-words">{kind.title}</h2>
      </div>

      {arrivedViaAlert && v.dashboardUrl && (
        <button
          type="button"
          onClick={() => window.open(v.dashboardUrl, '_blank', 'noopener,noreferrer')}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl text-left transition-colors"
          style={{ background: 'var(--color-primaryMuted)', border: '1px solid var(--color-primary)' }}
        >
          <span className="text-sm font-medium" style={{ color: 'var(--color-primary)' }}>Get the new value from the provider, then paste it below</span>
          <ArrowTopRightOnSquareIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-primary)' }} />
        </button>
      )}

      {kind.forms.length > 1 && (
        <div className="vault-seg" role="group" aria-label="Which form">
          {kind.forms.map((f) => {
            const on = f.id === form.id;
            // Switching the form keeps the name and the billing, and starts the boxes over.
            const go = () => { if (!on) { setPastedNote(null); setProblem(null); setV({ ...startValues(v.kind, f.id), name: v.name, billing: v.billing, cost: v.cost, expiresAt: v.expiresAt, notifyDaysBefore: v.notifyDaysBefore, autoRenew: v.autoRenew, dashboardUrl: v.dashboardUrl }); } };
            return <button key={f.id} type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={go}>{f.tab}</button>;
          })}
        </div>
      )}
      {form.intro && <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{form.intro}</p>}

      <div>
        <Label required>Name</Label>
        <Input value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="What you call it" aria-label="Name" autoComplete="off" />
      </div>
      {fields(form.fields)}

      {form.pickCheck ? (
        <>
          <div>
            <Label>How should SlickSync check it?</Label>
            <select value={v.check} onChange={(e) => set({ check: e.target.value as VaultTestType })} className={SELECT_CLASS} style={SELECT_STYLE} aria-label="How should SlickSync check it?">
              {OWN_CHECKS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              {/* An older entry may carry a check this list no longer offers; it keeps it until changed. */}
              {!OWN_CHECKS.some((c) => c.id === v.check) && <option value={v.check}>Keep its current check</option>}
            </select>
          </div>
          {v.check === 'generic_http' && (
            <div><Label required>Address to open</Label><Input value={v.checkUrl} onChange={(e) => set({ checkUrl: e.target.value })} placeholder="https://…" aria-label="Address to open" /></div>
          )}
          {v.check === 'tcp_reachability' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><Label required>Server</Label><Input value={v.checkHost} onChange={(e) => set({ checkHost: e.target.value })} placeholder="server.example.com" aria-label="Server" /></div>
              <div><Label required>Port</Label><Input value={v.checkPort} onChange={(e) => set({ checkPort: e.target.value })} placeholder="443" aria-label="Port" /></div>
            </div>
          )}
        </>
      ) : checkText ? (
        <div className="vault-check"><span aria-hidden="true" style={{ color: 'var(--color-success)' }}>✓</span><span>SlickSync checks this <b>{checkText}</b></span></div>
      ) : (
        <div className="vault-check none"><span aria-hidden="true">•</span><span>{form.none}</span></div>
      )}

      {!form.noBilling && (
        <Fold title="Billing" summary={billingSummary} open={open.billing} onToggle={() => setOpen((o) => ({ ...o, billing: !o.billing }))}>
          <div>
            <Label>How do you pay for it?</Label>
            <div className="vault-seg" role="group" aria-label="How do you pay for it?">
              {BILLING.map((b) => <button key={b.id} type="button" className={v.billing === b.id ? 'on' : ''} aria-pressed={v.billing === b.id} onClick={() => set({ billing: b.id })}>{b.label}</button>)}
            </div>
          </div>
          {tracked && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Cost per {per}</Label>
                  <Input type="number" value={v.cost} onChange={(e) => set({ cost: e.target.value })} placeholder="e.g. 5.00" aria-label={`Cost per ${per}`} />
                </div>
                <div>
                  <Label>Next renewal</Label>
                  {byService ? (
                    <div className="w-full px-4 py-3 rounded-xl flex items-center gap-2 text-sm" style={{ ...SELECT_STYLE, color: dateOnFile ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                      <span>{dateOnFile ? formatDay(dateOnFile) : `Read from ${source || 'the service'} at every check`}</span>
                      {dateOnFile && source && <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: 'var(--color-primary-muted)', color: 'var(--color-primary)' }}>From {source.replace(/^the /, '')}</span>}
                    </div>
                  ) : (
                    <Input type="date" value={v.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} aria-label="Next renewal" />
                  )}
                </div>
              </div>
              {/* Offered, never filled in by itself, and only in dollars: the price is TorBox's US list price. */}
              {planOffer && !v.cost && v.service === 'TorBox' && currency === 'USD' && (
                <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'var(--color-surface-hover)', border: '1px solid var(--color-surface-border)', color: 'var(--color-text-muted)' }}>
                  <span>TorBox {planOffer.name} is ${planOffer.monthlyUsd} a month</span>
                  <Button type="button" variant="primary" size="sm" className="ml-auto" onClick={() => set({ cost: String(planOffer.monthlyUsd), billing: 'monthly' })}>Use</Button>
                </div>
              )}
              {!byService && (
                <>
                  <div className="flex items-center justify-between gap-3 p-3 rounded-xl" style={{ background: 'var(--color-subtle)' }}>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium" style={{ color: 'var(--color-text)' }}>It renews by itself</span>
                      <span className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>The date moves on a {per} each time. No warning unless a check fails.</span>
                    </span>
                    <ToggleSwitch checked={v.autoRenew} onChange={() => set({ autoRenew: !v.autoRenew })} />
                  </div>
                  {!v.autoRenew && (
                    <div style={{ maxWidth: '12rem' }}>
                      <Label>Warn me this many days before</Label>
                      <Input type="number" value={v.notifyDaysBefore} onChange={(e) => set({ notifyDaysBefore: e.target.value })} aria-label="Warn me this many days before" />
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {v.billing === 'once' && (
            <>
              <div>
                <Label>What you paid (optional)</Label>
                <Input type="number" value={v.cost} onChange={(e) => set({ cost: e.target.value })} placeholder="e.g. 30.00" aria-label="What you paid" />
              </div>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>A lifetime plan: it never expires, never warns, and is left out of the monthly and yearly totals. Its card says Lifetime.</p>
            </>
          )}
          {v.billing === 'free' && <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Free: no cost, no renewal, no warnings.</p>}
          {v.billing === 'none' && (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              SlickSync keeps it{willCheck ? ' and checks it' : ''}, and leaves money out of it.{byService ? ` The end date is still read from ${source || 'the service'}.` : ''}
            </p>
          )}
          {(tracked || v.billing === 'once') && <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Amounts are in {currency}; change the currency at the top of the Vault.</p>}
        </Fold>
      )}

      {!form.noMore && (
        <Fold title="More" summary="Optional" open={open.more} onToggle={() => setOpen((o) => ({ ...o, more: !o.more }))}>
          {fields(form.more || [])}
          <div>
            <Label>Dashboard link</Label>
            <Input value={v.dashboardUrl} onChange={(e) => set({ dashboardUrl: e.target.value })} placeholder="Where you manage it, https://…" aria-label="Dashboard link" />
          </div>
        </Fold>
      )}

      {problem && <p className="text-sm" role="alert" style={{ color: 'var(--color-error)' }}>{problem}</p>}

      <div className="flex gap-3 pt-1">
        <button type="button" onClick={onCancel} className="flex-1 py-3 text-sm font-medium rounded-xl transition-colors" style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text)' }}>Cancel</button>
        <Button variant="primary" className="flex-1" onClick={submit} isLoading={saving}>{editing ? 'Save changes' : willCheck ? 'Add and test' : 'Add'}</Button>
      </div>
    </div>
  );
}
