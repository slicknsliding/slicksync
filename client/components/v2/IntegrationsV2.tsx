'use client';

// Settings → Integrations in the v2 page design. Each outside service is one
// tile that says Working, Not working or Not set with one button (Add, Change
// or Fix). The button opens a window with the long "how to get a key" text and
// the same fields Classic shows, saved the same way. SlickSync's own API key
// sits in rows below, and the iPhone Shortcuts are folded until wanted.

import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { ArrowTopRightOnSquareIcon, ArrowPathIcon, ClipboardDocumentIcon, EyeIcon, EyeSlashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { ComboBox, Modal, ProviderKeyHealthBadge, ProviderKeyHealthUnchecked } from '@/components/ui';
import { ArrangeSection, HiddenTray } from '@/components/ui/Arrange';
import { BackupKeyField, PoolKeysField } from '@/components/settings/KeyFields';
import { LumiereDbField } from '@/components/settings/LumiereDbField';
import { ShortcutRecipes } from '@/components/settings/ShortcutRecipes';
import { invalidatePersonalFeatures } from '@/lib/hooks/usePersonalFeatures';
import { api, type SyncSettings } from '@/lib/api';
import { toast } from '@/components/ui/Toast';
import type { PageArrange } from '@/lib/arrange';
import { V2Tiles } from './V2Detail';
import { V2Button } from './V2Bits';
import { V2Rows, V2SetRow, V2Switch, V2Word } from './SettingsV2';

type Sync = Partial<SyncSettings>;
type SaveOne = (key: keyof SyncSettings, value: unknown) => Promise<void>;
type Option = { value: string; label: string };

export const INTEGRATION_KEYS = ['keys', 'api', 'shortcuts'];

type Tone = 'ok' | 'off' | 'warn' | 'bad';
type KeyId = 'tmdb' | 'omdb' | 'mdblist' | 'rpdb' | 'ai' | 'simkl' | 'trakt' | 'mal' | 'lumiere' | 'nuvio';
type Health = NonNullable<SyncSettings['keyHealth']>[string] | undefined;

/** What a provider key says about itself, in one word and the button that fits. */
function judge(has: boolean, health: Health): { tone: Tone; word: string; button: 'Add' | 'Change' | 'Fix'; line?: string } {
  if (!has) return { tone: 'off', word: 'Not set', button: 'Add' };
  if (!health) return { tone: 'off', word: 'Not checked yet', button: 'Change' };
  const usage = health.usage ? `${health.usage.used.toLocaleString()}/${health.usage.limit.toLocaleString()} used today` : undefined;
  if (health.ok) return { tone: 'ok', word: 'Working', button: 'Change', line: usage };
  if (health.rateLimited) return { tone: 'warn', word: 'Limit reached', button: 'Change', line: usage };
  return { tone: 'bad', word: 'Not working', button: 'Fix', line: health.message && health.message !== 'OK' ? health.message : undefined };
}

export type IntegrationsProps = {
  arrange: PageArrange;
  sync: Sync;
  setSync: Dispatch<SetStateAction<Sync>>;
  save: SaveOne;
  isPublic: boolean;
  checkingKeys: boolean;
  onCheckKeys: () => void;
  checkSingleKey: (provider: 'tmdb' | 'omdb' | 'mdblist' | 'rpdb', value?: string) => void;
  ai: {
    configured: boolean;
    apiKey: string; setApiKey: (v: string) => void;
    keyVisible: boolean; setKeyVisible: (v: boolean) => void;
    baseUrl: string; setBaseUrl: (v: string) => void;
    model: string; setModel: (v: string) => void;
    saving: boolean;
    checkStatus: 'ok' | 'error' | null;
    checkMessage: string | null;
    baseUrlOptions: Option[];
    modelOptions: Option[];
    loadingModels: boolean;
    liveCount: number;
    onBlur: () => void;
    onReveal: () => void;
    onRemove: () => void;
  };
  nuvio: { discovering: boolean; onDetect: () => void };
  apiKey: {
    value: string | null;
    visible: boolean;
    setVisible: (v: boolean) => void;
    masked: string;
    hideSensitive: boolean;
    generating: boolean;
    onGenerate: () => void;
    onCopy: () => void;
  };
  shortcutsBase?: string | null;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-default mb-1.5">{label}</label>
      {children}
    </div>
  );
}

const inputClass = 'input-base w-full px-3 py-2 text-sm';

export function IntegrationsV2(p: IntegrationsProps) {
  const { arrange, sync, setSync, save, isPublic, ai, apiKey } = p;
  const [open, setOpen] = useState<KeyId | null>(null);
  // A field saves when it loses focus, so let go of it before the window goes.
  const close = () => { (document.activeElement as HTMLElement | null)?.blur?.(); setOpen(null); };

  const text = (field: keyof SyncSettings, placeholder: string, after?: () => void) => (
    <input
      type="text"
      value={(sync[field] as string | undefined) || ''}
      onChange={(e) => setSync((prev) => ({ ...prev, [field]: e.target.value }))}
      onBlur={async () => { await save(field, sync[field]); after?.(); }}
      placeholder={placeholder}
      aria-label={placeholder}
      autoComplete="off"
      spellCheck={false}
      className={inputClass}
    />
  );

  type Meta = 'tmdb' | 'omdb' | 'mdblist' | 'rpdb';
  const metaFields: Record<Meta, { key: keyof SyncSettings; backup: keyof SyncSettings; pool: keyof SyncSettings; label: string; howTo: string; after?: () => void }> = {
    tmdb: { key: 'tmdbApiKey', backup: 'tmdbApiKeyBackup', pool: 'tmdbApiKeyPool', label: 'TMDb API key',
      howTo: 'Enables the cast and crew deep-dive: click any actor in a title’s details to see everything else they’re in. Get a free key at themoviedb.org → Settings → API. Leave blank to keep the feature off.' },
    omdb: { key: 'omdbApiKey', backup: 'omdbApiKeyBackup', pool: 'omdbApiKeyPool', label: 'OMDb API key',
      howTo: 'Adds Rotten Tomatoes and Metacritic ratings. Get a free key at omdbapi.com/apikey.aspx. Paste just the key itself, not the test link OMDb’s confirmation email shows (the one starting “http://www.omdbapi.com/?i=…”). Leave blank to use the server’s own key, if one is set.' },
    mdblist: { key: 'mdblistApiKey', backup: 'mdblistApiKeyBackup', pool: 'mdblistApiKeyPool', label: 'MDBList API key',
      howTo: 'Lets you import an MDBList list into Lists. Get a free key at mdblist.com → Preferences → API Access. Leave blank to keep list import to TMDb lists only.' },
    rpdb: { key: 'rpdbApiKey', backup: 'rpdbApiKeyBackup', pool: 'rpdbApiKeyPool', label: 'RPDB API key',
      howTo: 'Upgrades posters everywhere to rating-embedded art from RatingPosterDB, when Poster ratings (in Features) is also on. The free key works fine. Get one at ratingposterdb.com → API Key. Leave blank to keep today’s posters.',
      after: () => invalidatePersonalFeatures() },
  };

  const metaModal = (id: Meta) => {
    const f = metaFields[id];
    const value = (sync[f.key] as string | undefined) || '';
    const health = sync.keyHealth?.[id];
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted">{f.howTo}</p>
        {value && (
          <div>{health ? <ProviderKeyHealthBadge result={health} /> : <ProviderKeyHealthUnchecked />}</div>
        )}
        <input
          type="text"
          value={value}
          onChange={(e) => setSync((prev) => ({ ...prev, [f.key]: e.target.value }))}
          onBlur={async () => { await save(f.key, sync[f.key]); f.after?.(); p.checkSingleKey(id, value); }}
          placeholder={f.label}
          aria-label={f.label}
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
        <div>
          <BackupKeyField
            field={String(f.backup)}
            value={(sync[f.backup] as string | undefined) || ''}
            primaryFilled={!!value}
            onChange={(v) => setSync((prev) => ({ ...prev, [f.backup]: v }))}
            onSave={() => save(f.backup, sync[f.backup])}
          />
          <PoolKeysField
            field={String(f.pool)}
            keys={(sync[f.pool] as string[] | undefined) || []}
            primaryFilled={!!value}
            onSave={async (next) => {
              setSync((prev) => ({ ...prev, [f.pool]: next }));
              await api.updateSyncSettings({ [f.pool]: next } as Partial<SyncSettings>);
            }}
          />
        </div>
      </div>
    );
  };

  const aiModal = (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Powers natural-language Catalog building (Catalogs → “Describe a catalog”): describe what you want in plain English and get a real saved Catalog back. It works without a key too, using a built-in keyword reader; a key just helps it understand nuanced descriptions. Defaults to OpenAI, but any OpenAI-compatible address works (OpenRouter, Groq, a local proxy). The address and model need to match each other: a Gemini model name against OpenAI’s own address will fail.
      </p>
      <div className="flex items-center gap-2 min-h-[1.5rem]">
        {ai.saving && <span className="text-xs text-subtle">Verifying…</span>}
        {!ai.saving && ai.configured && ai.checkStatus === 'ok' && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-success-muted)', color: 'var(--color-success)' }}>Verified</span>
        )}
        {!ai.saving && ai.configured && ai.checkStatus === 'error' && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-error-muted)', color: 'var(--color-error)' }} title={ai.checkMessage || undefined}>Check failed</span>
        )}
        {!ai.saving && ai.configured && !ai.checkStatus && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-surface-border)', color: 'var(--color-text-muted)' }}>Not yet verified</span>
        )}
        <span className="flex-1" />
        {ai.configured && (
          <button type="button" onClick={ai.onRemove} className="inline-flex items-center gap-1 text-xs text-subtle hover:text-error transition-colors" title="Remove AI Services">
            <XMarkIcon className="w-4 h-4" />Remove
          </button>
        )}
      </div>
      {ai.checkStatus === 'error' && ai.checkMessage && <p className="text-xs" style={{ color: 'var(--color-error)' }}>{ai.checkMessage}</p>}
      <div className="relative">
        <input
          type={ai.keyVisible ? 'text' : 'password'}
          value={ai.apiKey}
          onChange={(e) => ai.setApiKey(e.target.value)}
          onBlur={ai.onBlur}
          placeholder={ai.configured ? '•••••••• (leave blank to keep current)' : 'API key'}
          aria-label="AI Services API key"
          autoComplete="off"
          spellCheck={false}
          className="input-base w-full px-3 py-2 pr-10 text-sm"
        />
        {ai.configured && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { if (!ai.keyVisible) ai.onReveal(); ai.setKeyVisible(!ai.keyVisible); }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-surface-hover transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            title={ai.keyVisible ? 'Hide key' : 'Show key'}
          >
            {ai.keyVisible ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2">
        <ComboBox value={ai.baseUrl} onChange={ai.setBaseUrl} onBlur={ai.onBlur} placeholder="API base URL (optional, default OpenAI)" options={ai.baseUrlOptions} />
        <ComboBox value={ai.model} onChange={ai.setModel} onBlur={ai.onBlur} placeholder="Model (optional, default gpt-5.2-mini)" options={ai.modelOptions} />
      </div>
      <p className="text-[11px] text-subtle">
        {ai.loadingModels
          ? 'Loading current models from the provider…'
          : ai.liveCount > 0
            ? `${ai.liveCount} models loaded live from the provider.`
            : 'Showing common suggestions. Enter a key to load the provider’s actual current model list.'}
      </p>
    </div>
  );

  const link = (href: string) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{href.replace(/^https?:\/\//, '')}</a>;

  const modals: Record<KeyId, { title: string; body: ReactNode }> = {
    tmdb: { title: 'TMDb API key', body: metaModal('tmdb') },
    omdb: { title: 'OMDb API key', body: metaModal('omdb') },
    mdblist: { title: 'MDBList API key', body: metaModal('mdblist') },
    rpdb: { title: 'RPDB API key', body: metaModal('rpdb') },
    ai: { title: 'AI services', body: aiModal },
    simkl: {
      title: 'SIMKL Client ID',
      body: (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Lets you link a person’s SIMKL account for watch-history sync. Get one free: sign in at {link('https://simkl.com/settings/developer')} → under “List of your apps”, click <strong>+ Add a New App</strong> → give it any name and redirect address (SlickSync’s SIMKL sign-in uses a PIN, so the redirect is never used; any placeholder like https://slicksync.local works) → paste the <strong>Client ID</strong> it shows here. The Client Secret isn’t needed. Leave blank to use the server’s own, if one is set.
          </p>
          {text('simklClientId', 'SIMKL Client ID')}
        </div>
      ),
    },
    trakt: {
      title: 'Trakt Client ID',
      body: (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Lets you import a public Trakt list by pasting its address into Catalogs → Import. Get one free at {link('https://trakt.tv/oauth/applications/new')} → any name, any redirect address → paste the <strong>Client ID</strong> here. This reads public lists only; it does not connect a Trakt account, and it does not use up the one connected-app slot a free Trakt account gets.
          </p>
          {text('traktClientId', 'Trakt Client ID')}
        </div>
      ),
    },
    mal: {
      title: 'MyAnimeList Client ID',
      body: (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Lets you import a public MyAnimeList anime list by pasting its address into Catalogs → Import. Get one free at {link('https://myanimelist.net/apiconfig/create')} → any name, App Type “other”, any redirect address → paste the <strong>Client ID</strong> here. This reads public lists only and does not connect your MAL account. AniList lists need no key at all.
          </p>
          {text('malClientId', 'MyAnimeList Client ID')}
        </div>
      ),
    },
    lumiere: {
      title: 'LumiereDB',
      body: (
        <LumiereDbField
          value={sync.lumiereDbUrl || ''}
          onChange={(v) => setSync((prev) => ({ ...prev, lumiereDbUrl: v }))}
          onSave={(v) => save('lumiereDbUrl', v)}
        />
      ),
    },
    nuvio: {
      title: 'Nuvio backend',
      body: (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Point Nuvio at your own <a href="https://github.com/NuvioMedia/self-host" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">self-hosted backend</a> instead of the official one. Enter the Backend URL from your deployment (for example https://backend.example.com) and press Detect: it reads that server’s own <code>/.well-known/nuvio</code> to fill in the key for you. Leave blank to use api.nuvio.tv.
          </p>
          <Field label="Nuvio backend URL">
            <div className="flex gap-2">
              <input
                type="text"
                value={sync.nuvioServerUrl || ''}
                onChange={(e) => setSync((prev) => ({ ...prev, nuvioServerUrl: e.target.value }))}
                onBlur={() => save('nuvioServerUrl', sync.nuvioServerUrl)}
                placeholder="https://backend.example.com"
                aria-label="Nuvio backend URL"
                autoComplete="off"
                spellCheck={false}
                className="input-base flex-1 min-w-0 px-3 py-2 text-sm"
              />
              <V2Button onClick={p.nuvio.onDetect} disabled={p.nuvio.discovering}>{p.nuvio.discovering ? 'Detecting…' : 'Detect'}</V2Button>
            </div>
          </Field>
          <input
            type="text"
            value={sync.nuvioAnonKey || ''}
            onChange={(e) => setSync((prev) => ({ ...prev, nuvioAnonKey: e.target.value }))}
            onBlur={() => save('nuvioAnonKey', sync.nuvioAnonKey)}
            placeholder="Anon key (filled in by Detect, or paste it from ./nuvio credentials)"
            aria-label="Nuvio anon key"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <p className="text-xs text-subtle">Both fields are needed for the override to apply. A URL on its own is ignored rather than half-applied.</p>
        </div>
      ),
    },
  };

  // The tiles, in the order they show.
  type KeyTile = { id: KeyId; title: string; also: string; line: string; tone: Tone; word: string; button: 'Add' | 'Change' | 'Fix' };
  const meta = (id: Meta, title: string, also: string, line: string): KeyTile => {
    const j = judge(!!sync[metaFields[id].key], sync.keyHealth?.[id]);
    return { id, title, also, line: j.line ? `${line} · ${j.line}` : line, tone: j.tone, word: j.word, button: j.button };
  };
  const simple = (id: KeyId, title: string, also: string, line: string, has: boolean): KeyTile =>
    ({ id, title, also, line, tone: has ? 'ok' : 'off', word: has ? 'Set' : 'Not set', button: has ? 'Change' : 'Add' });
  const aiJudge = !ai.configured ? { tone: 'off' as Tone, word: 'Not set', button: 'Add' as const }
    : ai.checkStatus === 'ok' ? { tone: 'ok' as Tone, word: 'Working', button: 'Change' as const }
    : ai.checkStatus === 'error' ? { tone: 'bad' as Tone, word: 'Not working', button: 'Fix' as const }
    : { tone: 'off' as Tone, word: 'Not checked yet', button: 'Change' as const };
  const nuvioHas = !!sync.nuvioServerUrl?.trim() && !!sync.nuvioAnonKey?.trim();
  const nuvioHalf = !nuvioHas && (!!sync.nuvioServerUrl?.trim() || !!sync.nuvioAnonKey?.trim());
  const tiles: KeyTile[] = [
    meta('tmdb', 'TMDb', 'TMDb API key', 'Cast and crew, and everything else someone is in'),
    meta('omdb', 'OMDb', 'OMDb API key', 'Rotten Tomatoes and Metacritic scores'),
    meta('mdblist', 'MDBList', 'MDBList API key', 'Import MDBList lists'),
    meta('rpdb', 'RPDB', 'RPDB API key', 'Posters with ratings on them'),
    { id: 'ai', title: 'AI services', also: 'AI Services', line: 'Describe a catalog in your own words', ...aiJudge },
    simple('simkl', 'SIMKL', 'SIMKL Client ID', 'Link people’s SIMKL accounts', !!sync.simklClientId?.trim()),
    simple('trakt', 'Trakt', 'Trakt Client ID', 'Import public Trakt lists', !!sync.traktClientId?.trim()),
    simple('mal', 'MyAnimeList', 'MyAnimeList Client ID', 'Import MyAnimeList lists', !!sync.malClientId?.trim()),
    ...(isPublic ? [] : [simple('lumiere', 'LumiereDB', 'LumiereDB address', 'Your own copy of IMDb’s data', !!sync.lumiereDbUrl?.trim())]),
    nuvioHalf
      ? { id: 'nuvio' as const, title: 'Nuvio backend', also: 'Nuvio backend URL', line: 'Your own Nuvio server. Both fields are needed.', tone: 'warn' as Tone, word: 'Incomplete', button: 'Fix' as const }
      : simple('nuvio', 'Nuvio backend', 'Nuvio backend URL', 'Your own Nuvio server', nuvioHas),
  ];
  const working = tiles.filter((x) => x.word === 'Working' || x.word === 'Set').length;
  const bad = tiles.filter((x) => x.tone === 'bad' || x.tone === 'warn').length;
  const notSet = tiles.filter((x) => x.word === 'Not set').length;
  const summary = [working && `${working} working`, bad && `${bad} not`, notSet && `${notSet} not set`].filter(Boolean).join(' · ');

  const hasPool = (['tmdbApiKeyPool', 'omdbApiKeyPool', 'mdblistApiKeyPool', 'rpdbApiKeyPool'] as const).some((f) => (sync[f] || []).length > 0);
  // A switch that saves at once, and puts itself back if the save fails.
  const flag = (field: 'keyPoolQuotaWeighting' | 'quotaAutopilot' | 'keyPoolAutoRetire', on: [string, string?], off: [string, string?]) => async (v: boolean) => {
    setSync((prev) => ({ ...prev, [field]: v }));
    try {
      await api.updateSyncSettings({ [field]: v } as Partial<SyncSettings>);
      const [title, line] = v ? on : off;
      toast.success(title, { line });
    } catch {
      toast.error('Could not save that setting');
      setSync((prev) => ({ ...prev, [field]: !v }));
    }
  };

  const sections: Record<string, ReactNode> = {
    keys: (
      <ArrangeSection key="keys" arrange={arrange} id="keys" title="Keys" meta={summary} noun="section">
        <p className="text-muted text-[12.5px] mb-3">Optional keys for outside services. Yours come first; the server’s own (if it has one) is the fallback.</p>
        <V2Tiles wide={2}>
          {tiles.map((t) => (
            <div key={t.id} id={t.id === 'ai' ? 'provider-key-ai' : `provider-key-${t.id}`} data-setting={t.title} data-setting-also={t.also} className="v2-tool" style={{ alignItems: 'center' }}>
              <span className="flex-1 min-w-0">
                <p className="font-semibold text-[14.5px] text-default">{t.title}</p>
                <p className="text-muted text-[12.5px] mt-0.5">{t.line}</p>
              </span>
              <V2Word tone={t.tone}>{t.word}</V2Word>
              <V2Button primary={t.button === 'Fix'} onClick={() => setOpen(t.id)} label={`${t.button} ${t.title}`}>{t.button}</V2Button>
            </div>
          ))}
        </V2Tiles>
        <div className="mt-3">
          <V2Button onClick={p.onCheckKeys} disabled={p.checkingKeys} icon={<ArrowPathIcon className={`w-4 h-4${p.checkingKeys ? ' animate-spin' : ''}`} />}>
            {p.checkingKeys ? 'Checking…' : 'Check all keys'}
          </V2Button>
        </div>
        {hasPool && (
          <div className="mt-4">
            <V2Rows>
              <V2SetRow
                title="Spread by remaining quota"
                line="Send requests to the pool key with the most allowance left instead of taking strict turns. Applies where usage is reported (MDBList today)."
                control={<V2Switch on={sync.keyPoolQuotaWeighting === true} label="Toggle quota-aware pool weighting"
                  onChange={flag('keyPoolQuotaWeighting', ['Pool favors the fullest key', 'Requests go to the key with the most quota left.'], ['Pool takes strict turns', 'Each key gets its turn in order.'])} />}
              />
              <V2SetRow
                title="Pause background lookups near the cap"
                line="Once today’s OMDb use passes 90%, background work (decorating notifications) stops fetching ratings until the midnight-UTC reset. Titles you open always fetch."
                control={<V2Switch on={sync.quotaAutopilot === true} label="Toggle quota autopilot"
                  onChange={flag('quotaAutopilot', ['Background lookups ease off', 'They stand down near the daily cap.'], ['Background lookups always run'])} />}
              />
              <V2SetRow
                title="Auto-retire failing pool keys"
                line="A pool key that has failed for 3 straight days is removed from the pool, with a notification naming it. Your main and backup keys are never touched."
                control={<V2Switch on={sync.keyPoolAutoRetire === true} label="Toggle auto-retire for failing pool keys"
                  onChange={flag('keyPoolAutoRetire', ['Dead pool keys retire themselves', 'A key that stays dead for 3 days is dropped.'], ['Pool keys stay until removed', 'Only you can remove them now.'])} />}
              />
            </V2Rows>
          </div>
        )}
      </ArrangeSection>
    ),
    api: (
      <ArrangeSection key="api" arrange={arrange} id="api" title="SlickSync’s own API" noun="section">
        <V2Rows>
          <V2SetRow
            title="Your API key"
            line={<code className="font-mono break-all">{apiKey.visible ? apiKey.value : (apiKey.hideSensitive ? '••••••••••••••••' : apiKey.masked)}</code>}
            control={(
              <>
                <button type="button" className="arrange-icon" aria-label={apiKey.visible ? 'Hide the key' : 'Show the key'} title={apiKey.visible ? 'Hide' : 'Show'} onClick={() => apiKey.setVisible(!apiKey.visible)}>
                  {apiKey.visible ? <EyeSlashIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                </button>
                <V2Button onClick={apiKey.onCopy} disabled={!apiKey.value} icon={<ClipboardDocumentIcon className="w-4 h-4" />}>Copy</V2Button>
                <V2Button onClick={apiKey.onGenerate} disabled={apiKey.generating} icon={<ArrowPathIcon className={`w-4 h-4${apiKey.generating ? ' animate-spin' : ''}`} />}>
                  {apiKey.value ? 'Rotate' : 'Generate'}
                </V2Button>
              </>
            )}
            below={<p className="text-xs text-muted">Use this key to sign API requests. Keep it secret.</p>}
          />
          <V2SetRow
            title="API docs"
            also="Interactive API docs"
            line="Try every call in the browser"
            control={<a href="/api/docs" target="_blank" rel="noopener noreferrer" className="v2-btn">Open<ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" /></a>}
          />
        </V2Rows>
        <p className="text-xs text-muted mt-3">
          Looking for the scrobble-in key or the Public Stats Page switch? Those belong to each person: sign in at <a href="/login?mode=user" className="text-primary hover:underline">/login?mode=user</a> with that person’s own Stremio or Nuvio sign-in and open their Settings page. The key above won’t work for either.
        </p>
      </ArrangeSection>
    ),
    shortcuts: (
      <ArrangeSection key="shortcuts" arrange={arrange} id="shortcuts" title="iPhone Shortcuts" meta="3" noun="section">
        <ShortcutRecipes bare baseUrl={p.shortcutsBase} apiKey={apiKey.value} />
      </ArrangeSection>
    ),
  };

  const labels: Record<string, string> = { keys: 'Keys', api: 'SlickSync’s own API', shortcuts: 'iPhone Shortcuts' };
  const m = open ? modals[open] : null;
  return (
    <>
      {arrange.shown.map((k) => sections[k] ?? null)}
      <HiddenTray arrange={arrange} labelOf={(k) => labels[k] ?? k} />
      <Modal isOpen={!!m} onClose={close} title={m?.title} size="md">
        {m?.body}
        <div className="flex justify-end mt-4">
          <V2Button primary onClick={close}>Done</V2Button>
        </div>
      </Modal>
    </>
  );
}
