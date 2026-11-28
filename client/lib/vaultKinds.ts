// What each kind of Vault entry is and what it asks for.
//
// Adding to the Vault starts with picking a kind; the form then shows only
// what that kind has (a login asks for a username and a password, a note
// only for the note). Some kinds come in more than one form: an IPTV login
// or a playlist address, an AIOStreams configuration or an app sign-in.
// Everything here is plain data and pure functions, so the form
// (components/vault/VaultEntryForm) only draws it, and editing an entry
// reads the same definitions back.
//
// How a kind is stored (server/routes/vault.js keeps one row per entry):
//   secret           the key, password, playlist address or note (encrypted)
//   provider         the username a check signs in with (Stremio, Nuvio,
//                    Jellyfin, IPTV, AIOStreams app), or the service's name
//   testType         which check runs ('manual' = none)
//   testConfig       everything else that is not secret: address, host and
//                    port, UUID, the form picked, a login's username

import type { VaultCategory, VaultEntry, VaultTestType } from '@/lib/api';

export type Billing = 'none' | 'monthly' | 'yearly' | 'once' | 'free';

export interface VaultFormValues {
  name: string;
  kind: VaultCategory;
  /** Which form of the kind ('' when the kind has only one). */
  form: string;
  /** The service picked (debrid, metadata) or typed (VPN, a login's website). */
  service: string;
  /** Typed when the picked service is "Another one". */
  serviceName: string;
  secret: string;
  username: string;
  /** Indexer address, IPTV / Jellyfin server, AIOStreams instance or app server. */
  url: string;
  host: string;
  port: string;
  ssl: boolean;
  dataCap: string;
  uuid: string;
  /** Something else → a key: what the key is called. */
  secretLabel: string;
  /** Something else → a key: how it is checked. */
  check: VaultTestType;
  checkUrl: string;
  checkHost: string;
  checkPort: string;
  aiBaseUrl: string;
  aiModel: string;
  dashboardUrl: string;
  billing: Billing;
  cost: string;
  expiresAt: string;
  notifyDaysBefore: string;
  autoRenew: boolean;
}

export const EMPTY_VALUES: VaultFormValues = {
  name: '', kind: 'custom', form: '', service: '', serviceName: '', secret: '', username: '', url: '',
  host: '', port: '', ssl: true, dataCap: '', uuid: '', secretLabel: '', check: 'manual', checkUrl: '',
  checkHost: '', checkPort: '', aiBaseUrl: '', aiModel: '', dashboardUrl: '',
  billing: 'none', cost: '', expiresAt: '', notifyDaysBefore: '3', autoRenew: false,
};

export type FieldKey = 'service' | 'serviceName' | 'secret' | 'username' | 'url' | 'host' | 'port' | 'ssl' | 'dataCap' | 'uuid' | 'secretLabel' | 'aiBaseUrl' | 'aiModel';

export interface FieldDef {
  key: FieldKey;
  label: string | ((v: VaultFormValues) => string);
  type: 'text' | 'secret' | 'pick' | 'switch' | 'note';
  placeholder?: string;
  options?: string[];
  required?: boolean;
  /** Sits beside the next field on wide screens. */
  half?: boolean;
  hint?: string;
  /** Shown only when this says so (a "which service?" box under "Another one"). */
  when?: (v: VaultFormValues) => boolean;
}

export interface FormDef {
  id: string;
  /** Its name on the switch at the top, when the kind has more than one form. */
  tab?: string;
  intro?: string;
  fields: FieldDef[];
  /** Optional extras, under More. */
  more?: FieldDef[];
  /** How SlickSync checks it, ending the sentence "SlickSync checks this ...". Null: it cannot. */
  check: (v: VaultFormValues) => string | null;
  /** Said instead, when there is no check. */
  none?: string;
  /** The end date is read from the service, so there is none to type. */
  autoDate?: (v: VaultFormValues) => boolean;
  /** The person picks the check (Something else → a key). */
  pickCheck?: boolean;
  noBilling?: boolean;
  noMore?: boolean;
}

export interface KindDef {
  id: VaultCategory;
  title: string;
  line: string;
  /** A file under /logos, for the services that have a mark of their own. */
  logo?: string;
  emoji?: string;
  /** Takes the whole last row of the tiles. */
  wide?: boolean;
  forms: FormDef[];
}

const OTHER = 'Another one';
const NOTHING_TO_CHECK = 'SlickSync keeps this one. It has nothing to check it against.';
const VPN_NONE = 'SlickSync keeps this and reminds you before it runs out. A VPN cannot be checked from here.';

/** Debrid services SlickSync can ask directly, and the check each uses. */
export const DEBRID_CHECKS: Record<string, VaultTestType> = {
  'Real-Debrid': 'real_debrid', TorBox: 'torbox', AllDebrid: 'alldebrid', Premiumize: 'premiumize', 'Debrid-Link': 'debrid_link',
};
/** Metadata services SlickSync can ask directly. */
export const METADATA_CHECKS: Record<string, VaultTestType> = {
  TMDb: 'tmdb_key', OMDb: 'omdb_key', MDBList: 'mdblist_key', RPDB: 'rpdb_key',
};
const METADATA_SERVICES = ['TMDb', 'OMDb', 'MDBList', 'RPDB', 'Trakt', 'SIMKL', 'MyAnimeList', OTHER];
const CLIENT_ID_SERVICES = /^(Trakt|SIMKL|MyAnimeList)$/;

/** Checks that read the end date from the service, and what to call that service. */
export const AUTO_DATE_SOURCES: Partial<Record<VaultTestType, string>> = {
  real_debrid: 'Real-Debrid', torbox: 'TorBox', alldebrid: 'AllDebrid', premiumize: 'Premiumize', debrid_link: 'Debrid-Link',
  xtream_auth: 'the IPTV server', m3u_playlist: 'the playlist’s server',
};

const otherName = (v: VaultFormValues) => v.service === OTHER;

export const KINDS: KindDef[] = [
  {
    id: 'debrid', emoji: '⚡', title: 'Debrid service', line: 'Real-Debrid, TorBox, AllDebrid…',
    forms: [{
      id: '',
      fields: [
        { key: 'service', label: 'Service', type: 'pick', options: [...Object.keys(DEBRID_CHECKS), OTHER], required: true },
        { key: 'serviceName', label: 'Which service', type: 'text', placeholder: 'Its name', when: otherName },
        { key: 'secret', label: 'API key', type: 'secret', placeholder: 'Paste the API key', required: true },
      ],
      check: (v) => (DEBRID_CHECKS[v.service] ? `by asking ${v.service}. It also reads the day your plan ends, so there is no date to type.` : null),
      autoDate: (v) => !!DEBRID_CHECKS[v.service],
      none: 'SlickSync keeps this key. It has no check for a service it does not know.',
    }],
  },
  {
    id: 'usenet_indexer', emoji: '🗂️', title: 'Usenet indexer', line: 'Where NZBs are found',
    forms: [{
      id: '',
      fields: [
        { key: 'url', label: 'Indexer address', type: 'text', placeholder: 'https://indexer.example.com', required: true },
        { key: 'secret', label: 'API key', type: 'secret', placeholder: 'Indexer API key', required: true },
      ],
      check: () => 'by asking the indexer: it has to answer and accept the key. When the indexer reports it, you also see how many API calls you have used today.',
    }],
  },
  {
    id: 'usenet_provider', emoji: '📡', title: 'Usenet provider', line: 'Where downloads come from',
    forms: [{
      id: '',
      fields: [
        { key: 'host', label: 'Host', type: 'text', placeholder: 'news.example.com', required: true, half: true },
        { key: 'port', label: 'Port', type: 'text', placeholder: '563', required: true, half: true },
        { key: 'username', label: 'Username', type: 'text', placeholder: 'Account username', required: true, half: true },
        { key: 'secret', label: 'Password', type: 'secret', placeholder: 'Account password', required: true, half: true },
        { key: 'ssl', label: 'Use SSL', type: 'switch' },
      ],
      more: [{ key: 'dataCap', label: 'Data cap in GB', type: 'text', placeholder: 'Leave blank for no cap' }],
      check: () => 'by signing in to the news server with this username and password.',
    }],
  },
  {
    id: 'iptv', emoji: '📺', title: 'IPTV / Live TV', line: 'A login, or a playlist address',
    forms: [
      {
        id: 'login', tab: 'A login',
        fields: [
          { key: 'url', label: 'Server address', type: 'text', placeholder: 'http://iptv.example.com:8080', required: true },
          { key: 'username', label: 'Username', type: 'text', placeholder: 'Your IPTV username', required: true, half: true },
          { key: 'secret', label: 'Password', type: 'secret', placeholder: 'Your IPTV password', required: true, half: true },
        ],
        check: () => 'by signing in to the server. It also reads the day the login runs out, so there is no date to type.',
        autoDate: () => true,
      },
      {
        id: 'playlist', tab: 'A playlist address',
        fields: [{ key: 'secret', label: 'Playlist address', type: 'secret', placeholder: 'An M3U address', required: true, hint: 'Kept hidden like a password, because a playlist address usually has the login inside it.' }],
        check: () => 'by loading the playlist and making sure it lists channels. When the address carries a login, it also reads the day it runs out.',
        autoDate: () => true,
      },
    ],
  },
  {
    id: 'stremio', logo: 'stremio', title: 'Stremio sign-in', line: 'An account’s email and password',
    forms: [{
      id: '',
      fields: [
        { key: 'username', label: 'Email', type: 'text', placeholder: 'you@example.com', required: true },
        { key: 'secret', label: 'Password', type: 'secret', placeholder: 'Account password', required: true },
      ],
      check: () => 'by signing in to Stremio.',
    }],
  },
  {
    id: 'nuvio', logo: 'nuvio', title: 'Nuvio sign-in', line: 'An account’s email and password',
    forms: [{
      id: '',
      fields: [
        { key: 'username', label: 'Email', type: 'text', placeholder: 'you@example.com', required: true },
        { key: 'secret', label: 'Password', type: 'secret', placeholder: 'Account password', required: true },
      ],
      check: () => 'by signing in to Nuvio.',
    }],
  },
  {
    id: 'jellyfin', logo: 'jellyfin', title: 'Jellyfin sign-in', line: 'A server, a username and a password',
    forms: [{
      id: '',
      fields: [
        { key: 'url', label: 'Server address', type: 'text', placeholder: 'https://jellyfin.example.com', required: true },
        { key: 'username', label: 'Username', type: 'text', placeholder: 'Your Jellyfin username', required: true, half: true },
        { key: 'secret', label: 'Password', type: 'secret', placeholder: 'Your Jellyfin password', required: true, half: true },
      ],
      check: () => 'by signing in to the server.',
    }],
  },
  {
    id: 'aiostreams', logo: 'aiostreams', title: 'AIOStreams', line: 'A configuration, or an app sign-in',
    forms: [
      {
        id: 'config', tab: 'A configuration',
        intro: 'The UUID and password you use on AIOStreams’ own Configure page. This is the setup itself: the addons, services and filters.',
        fields: [
          { key: 'url', label: 'Instance address', type: 'text', placeholder: 'https://aiostreams.example.com', required: true },
          { key: 'uuid', label: 'UUID', type: 'text', placeholder: '00000000-0000-4000-8000-000000000000', required: true },
          { key: 'secret', label: 'Password', type: 'secret', placeholder: 'The configuration password', required: true },
        ],
        check: (v) => (v.url.trim() && v.uuid.trim() ? 'by opening the configuration with it, the same way it already reads people’s AIOStreams setups.' : null),
        none: 'Add the instance address and the UUID, and SlickSync can check the password opens the configuration.',
      },
      {
        id: 'app', tab: 'An app sign-in',
        intro: 'What you type into the AIOStreams app on a phone, computer or TV to sign in.',
        fields: [
          { key: 'url', label: 'Server address', type: 'text', placeholder: 'https://aiostreams.example.com/jellyfin', required: true },
          { key: 'username', label: 'Username', type: 'text', placeholder: 'The UUID, or UUID/name for a household member', required: true },
          { key: 'secret', label: 'Password', type: 'secret', placeholder: 'The configuration password, or password/PIN', required: true },
        ],
        check: () => 'by signing in the way the app does.',
      },
    ],
  },
  {
    id: 'metadata', emoji: '🎬', title: 'Metadata or tracker', line: 'TMDb, OMDb, MDBList, RPDB, Trakt, SIMKL…',
    forms: [{
      id: '',
      fields: [
        { key: 'service', label: 'Service', type: 'pick', options: METADATA_SERVICES, required: true },
        { key: 'serviceName', label: 'Which service', type: 'text', placeholder: 'Its name', when: otherName },
        { key: 'secret', label: (v) => (CLIENT_ID_SERVICES.test(v.service) ? 'Client ID' : 'API key'), type: 'secret', placeholder: 'Paste it', required: true },
      ],
      check: (v) => (METADATA_CHECKS[v.service] ? `by asking ${v.service} whether it accepts the key.` : null),
      none: NOTHING_TO_CHECK,
    }],
  },
  {
    id: 'ai', emoji: '✨', title: 'AI service', line: 'A key for an AI model',
    forms: [{
      id: '',
      fields: [{ key: 'secret', label: 'API key', type: 'secret', placeholder: 'Paste the API key', required: true }],
      more: [
        { key: 'aiBaseUrl', label: 'API address', type: 'text', placeholder: 'Leave blank for OpenAI’s own' },
        { key: 'aiModel', label: 'Model', type: 'text', placeholder: 'Leave blank for a small, fast one' },
      ],
      check: () => 'by asking the service whether it accepts the key.',
    }],
  },
  {
    id: 'vpn', emoji: '🛡️', title: 'VPN', line: 'A VPN subscription',
    forms: [
      {
        id: 'login', tab: 'Username and password',
        fields: [
          { key: 'service', label: 'Service', type: 'text', placeholder: 'Your VPN’s name' },
          { key: 'username', label: 'Username', type: 'text', placeholder: 'VPN username', required: true, half: true },
          { key: 'secret', label: 'Password', type: 'secret', placeholder: 'VPN password', required: true, half: true },
        ],
        check: () => null, none: VPN_NONE,
      },
      {
        id: 'account', tab: 'Account number or key',
        fields: [
          { key: 'service', label: 'Service', type: 'text', placeholder: 'Your VPN’s name' },
          { key: 'secret', label: 'Account number or key', type: 'secret', placeholder: 'Paste it', required: true },
        ],
        check: () => null, none: VPN_NONE,
      },
    ],
  },
  {
    id: 'note', emoji: '📝', title: 'A note', line: 'Anything you want kept safe',
    forms: [{
      id: '',
      fields: [{ key: 'secret', label: 'Note', type: 'note', placeholder: 'A recovery code, a PIN, the answer to a security question, a Wi-Fi password, an address… anything.', required: true, hint: 'Kept hidden like a password until you press Reveal.' }],
      check: () => null, none: 'A note is only kept. Nothing to check, no dates, no billing.', noBilling: true, noMore: true,
    }],
  },
  {
    id: 'custom', emoji: '➕', title: 'Something else', line: 'Any other key, token or login', wide: true,
    forms: [
      {
        id: 'key', tab: 'A key or token',
        fields: [
          { key: 'secretLabel', label: 'What it is called', type: 'text', placeholder: 'API key' },
          { key: 'secret', label: 'The key', type: 'secret', placeholder: 'Paste the key or token', required: true },
        ],
        check: () => null, pickCheck: true,
      },
      {
        id: 'login', tab: 'A login',
        fields: [
          { key: 'service', label: 'Website or service', type: 'text', placeholder: 'Where this login is for' },
          { key: 'username', label: 'Username or email', type: 'text', required: true },
          { key: 'secret', label: 'Password', type: 'secret', required: true },
        ],
        check: () => null, none: 'SlickSync keeps this login. There is nothing to check it against.',
      },
    ],
  },
];

export const kindOf = (id: VaultCategory): KindDef => KINDS.find((k) => k.id === id) || KINDS[KINDS.length - 1];
export const formOf = (v: Pick<VaultFormValues, 'kind' | 'form'>): FormDef => {
  const kind = kindOf(v.kind);
  return kind.forms.find((f) => f.id === v.form) || kind.forms[0];
};

/** The values a kind starts with when its tile is picked. */
export function startValues(kind: VaultCategory, form?: string): VaultFormValues {
  const k = kindOf(kind);
  const f = k.forms.find((x) => x.id === form) || k.forms[0];
  const pick = f.fields.find((x) => x.type === 'pick');
  return { ...EMPTY_VALUES, kind, form: f.id, service: pick?.options?.[0] ?? '' };
}

/** The check a saved entry runs. */
export function testTypeOf(v: VaultFormValues): VaultTestType {
  switch (v.kind) {
    case 'debrid': return DEBRID_CHECKS[v.service] || 'manual';
    case 'usenet_indexer': return 'newznab_caps';
    case 'usenet_provider': return 'nntp_auth';
    case 'iptv': return v.form === 'playlist' ? 'm3u_playlist' : 'xtream_auth';
    case 'stremio': return 'stremio_auth';
    case 'nuvio': return 'nuvio_auth';
    case 'jellyfin': return 'jellyfin_auth';
    case 'aiostreams': return v.form === 'app' ? 'jellyfin_auth' : (v.url.trim() && v.uuid.trim() ? 'aiostreams_config' : 'manual');
    case 'metadata': return METADATA_CHECKS[v.service] || 'manual';
    case 'ai': return 'openai_compatible';
    case 'custom': return v.form === 'login' ? 'manual' : v.check;
    default: return 'manual';
  }
}

/** True when the entry's end date is read from the service. */
export const datedByService = (v: VaultFormValues): boolean => !!formOf(v).autoDate?.(v);

const text = (s: string) => s.trim();
const serviceLabel = (v: VaultFormValues) => (v.service === OTHER ? text(v.serviceName) : text(v.service));

/**
 * What is missing, in words, or null when the form can be saved. When
 * editing, the secret may stay blank (it keeps the one on file), and a box
 * that was empty on an older entry may stay empty.
 */
export function missing(v: VaultFormValues, opts: { editing: boolean; wasEmpty?: Partial<Record<FieldKey, boolean>> } = { editing: false }): string | null {
  if (!text(v.name)) return 'Give it a name';
  const form = formOf(v);
  for (const f of form.fields) {
    if (!f.required || f.type === 'switch') continue;
    if (f.when && !f.when(v)) continue;
    const value = String(v[f.key] ?? '');
    if (text(value)) continue;
    if (opts.editing && (f.type === 'secret' || f.type === 'note')) continue;
    // A usenet provider's username lives inside its secret, so it too may stay blank on an edit.
    if (opts.editing && v.kind === 'usenet_provider' && f.key === 'username') continue;
    if (opts.editing && opts.wasEmpty?.[f.key]) continue;
    const label = typeof f.label === 'function' ? f.label(v) : f.label;
    return `${label} is needed`;
  }
  if (v.kind === 'usenet_provider') {
    if (!/^\d{1,5}$/.test(text(v.port)) || Number(v.port) < 1 || Number(v.port) > 65535) return 'Port is a number, like 563';
    // Its username and password are saved as one piece, so changing one means typing both.
    if (opts.editing && (text(v.username) !== '') !== (v.secret !== '')) return 'To change the login, type both the username and the password';
  }
  if (form.pickCheck) {
    if (v.check === 'generic_http' && !text(v.checkUrl)) return 'The address to open is needed';
    if (v.check === 'tcp_reachability' && (!text(v.checkHost) || !text(v.checkPort))) return 'The server and its port are needed';
  }
  if ((v.billing === 'monthly' || v.billing === 'yearly' || v.billing === 'once') && text(v.cost) && !(Number(v.cost) >= 0)) return 'Cost is a number, like 5.00';
  return null;
}

export interface VaultPayload {
  name: string;
  category: VaultCategory;
  provider: string | null;
  secretLabel: string;
  secret?: string;
  testType: VaultTestType;
  testConfig: Record<string, unknown> | null;
  dashboardUrl: string | null;
  cost: number | null;
  costCycle: 'monthly' | 'yearly' | 'once' | 'free';
  expiresAt?: string | null;
  notifyDaysBefore: number;
  autoRenew: boolean;
}

/** What is sent to the server for these values. The secret is left out when it was not typed (an edit keeps the one on file). */
export function toPayload(v: VaultFormValues): VaultPayload {
  const form = formOf(v);
  const cfg: Record<string, unknown> = {};
  let provider: string | null = null;
  let secretLabel = 'API Key';
  let secret: string | undefined = v.secret !== '' ? v.secret : undefined;
  if (form.id) cfg.form = form.id;

  switch (v.kind) {
    case 'debrid': provider = serviceLabel(v) || null; break;
    case 'usenet_indexer': cfg.url = text(v.url); break;
    case 'usenet_provider':
      cfg.host = text(v.host); cfg.port = Number(v.port); cfg.ssl = v.ssl;
      if (text(v.dataCap) && Number(v.dataCap) > 0) cfg.dataCapGB = Number(v.dataCap);
      secretLabel = 'Password';
      secret = text(v.username) && v.secret !== '' ? JSON.stringify({ username: text(v.username), password: v.secret }) : undefined;
      break;
    case 'iptv':
      if (form.id === 'playlist') { secretLabel = 'Playlist address'; secret = secret?.trim(); }
      else { cfg.url = text(v.url); provider = text(v.username) || null; secretLabel = 'Password'; }
      break;
    case 'stremio': case 'nuvio': provider = text(v.username) || null; secretLabel = 'Password'; break;
    case 'jellyfin': cfg.url = text(v.url); provider = text(v.username) || null; secretLabel = 'Password'; break;
    case 'aiostreams':
      if (text(v.url)) cfg.url = text(v.url);
      secretLabel = 'Password';
      if (form.id === 'app') provider = text(v.username) || null;
      else if (text(v.uuid)) cfg.uuid = text(v.uuid);
      break;
    case 'metadata':
      provider = serviceLabel(v) || null;
      secretLabel = CLIENT_ID_SERVICES.test(v.service) ? 'Client ID' : 'API Key';
      break;
    case 'ai':
      if (text(v.aiBaseUrl)) cfg.baseUrl = text(v.aiBaseUrl);
      if (text(v.aiModel)) cfg.model = text(v.aiModel);
      break;
    case 'vpn':
      provider = text(v.service) || null;
      if (form.id === 'login') { cfg.username = text(v.username); secretLabel = 'Password'; }
      else secretLabel = 'Account number or key';
      break;
    case 'note': secretLabel = 'Note'; break;
    case 'custom':
      if (form.id === 'login') { provider = text(v.service) || null; cfg.username = text(v.username); secretLabel = 'Password'; }
      else {
        secretLabel = text(v.secretLabel) || 'API Key';
        if (v.check === 'generic_http') cfg.url = text(v.checkUrl);
        if (v.check === 'tcp_reachability') { cfg.host = text(v.checkHost); cfg.port = Number(v.checkPort); }
      }
      break;
  }

  const tracked = v.billing === 'monthly' || v.billing === 'yearly';
  const cost = (tracked || v.billing === 'once') && text(v.cost) !== '' && Number(v.cost) >= 0 ? Number(v.cost) : null;
  const byService = datedByService(v);
  const payload: VaultPayload = {
    name: text(v.name),
    category: v.kind,
    provider,
    secretLabel,
    testType: testTypeOf(v),
    testConfig: Object.keys(cfg).length ? cfg : null,
    dashboardUrl: form.noMore ? null : (text(v.dashboardUrl) || null),
    cost,
    costCycle: v.billing === 'none' ? 'monthly' : v.billing,
    notifyDaysBefore: /^\d+$/.test(text(v.notifyDaysBefore)) ? Math.min(365, Number(v.notifyDaysBefore)) : 3,
    autoRenew: tracked && !byService && v.autoRenew,
  };
  if (secret !== undefined) payload.secret = secret;
  // A date read from the service is the service's to set; every other date is what was typed, or nothing.
  if (!byService) payload.expiresAt = tracked && v.expiresAt ? v.expiresAt : null;
  else if (!tracked && v.billing !== 'none') payload.expiresAt = null;
  return payload;
}

const pickByValue = (map: Record<string, VaultTestType>, type: VaultTestType) => Object.keys(map).find((k) => map[k] === type);
const matchService = (options: string[], name: string) => options.find((o) => o.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, ''));

/** The form filled in from a saved entry (for editing, or for making another like it). The secret is never part of it. */
export function fromEntry(e: VaultEntry): VaultFormValues {
  const cfg = (e.testConfig || {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x : x == null ? '' : String(x));
  const kind = kindOf(e.category).id;
  const v: VaultFormValues = { ...EMPTY_VALUES, name: e.name, kind, dashboardUrl: e.dashboardUrl || '' };
  const provider = e.provider || '';

  switch (kind) {
    case 'debrid': {
      const known = pickByValue(DEBRID_CHECKS, e.testType) || matchService(Object.keys(DEBRID_CHECKS), provider);
      v.service = known || OTHER; v.serviceName = known ? '' : provider;
      break;
    }
    case 'usenet_indexer': v.url = str(cfg.url); break;
    case 'usenet_provider': v.host = str(cfg.host); v.port = str(cfg.port); v.ssl = cfg.ssl !== false; v.dataCap = str(cfg.dataCapGB); break;
    case 'iptv':
      if (e.testType === 'm3u_playlist' || cfg.form === 'playlist') v.form = 'playlist';
      else { v.form = 'login'; v.url = str(cfg.url); v.username = provider; }
      break;
    case 'stremio': case 'nuvio': v.username = provider; break;
    case 'jellyfin': v.url = str(cfg.url); v.username = provider; break;
    case 'aiostreams':
      v.url = str(cfg.url);
      if (cfg.form === 'app') { v.form = 'app'; v.username = provider; }
      else { v.form = 'config'; v.uuid = str(cfg.uuid); }
      break;
    case 'metadata': {
      const known = pickByValue(METADATA_CHECKS, e.testType) || matchService(METADATA_SERVICES, provider);
      v.service = known && known !== OTHER ? known : OTHER; v.serviceName = v.service === OTHER ? provider : '';
      break;
    }
    case 'ai': v.aiBaseUrl = str(cfg.baseUrl); v.aiModel = str(cfg.model); break;
    case 'vpn':
      v.service = provider;
      if (cfg.form === 'login') { v.form = 'login'; v.username = str(cfg.username); } else v.form = 'account';
      break;
    case 'note': break;
    default:
      if (cfg.form === 'login') { v.form = 'login'; v.service = provider; v.username = str(cfg.username); }
      else {
        v.form = 'key'; v.secretLabel = e.secretLabel && e.secretLabel !== 'API Key' ? e.secretLabel : '';
        v.check = e.testType; v.checkUrl = str(cfg.url); v.checkHost = str(cfg.host); v.checkPort = str(cfg.port);
      }
  }

  const cycle = e.costCycle || 'monthly';
  const typedDate = !!e.expiresAt && !AUTO_DATE_SOURCES[e.testType];
  v.billing = cycle === 'once' || cycle === 'free' ? cycle : (e.cost != null || typedDate ? cycle : 'none');
  v.cost = e.cost != null ? String(e.cost) : '';
  v.expiresAt = e.expiresAt ? e.expiresAt.split('T')[0] : '';
  v.notifyDaysBefore = String(e.notifyDaysBefore ?? 3);
  v.autoRenew = !!e.autoRenew;
  return v;
}

/**
 * A whole address pasted into one box, taken apart: an indexer address with
 * its key inside, or an IPTV address with the login inside. Returns the
 * boxes to fill, or null when the text is an ordinary address.
 */
export function splitPasted(v: Pick<VaultFormValues, 'kind' | 'form'>, pasted: string): Partial<VaultFormValues> | null {
  let url: URL;
  try { url = new URL(pasted.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (v.kind === 'usenet_indexer') {
    const key = url.searchParams.get('apikey') || url.searchParams.get('api_key');
    if (!key) return null;
    const path = url.pathname.replace(/\/api\/?$/i, '').replace(/\/+$/, '');
    return { url: `${url.origin}${path}`, secret: key };
  }
  if (v.kind === 'iptv' && v.form !== 'playlist') {
    const username = url.searchParams.get('username');
    const password = url.searchParams.get('password');
    if (!username || !password) return null;
    const path = url.pathname.replace(/\/(get|player_api|xmltv)\.php$/i, '').replace(/\/+$/, '');
    return { url: `${url.origin}${path}`, username, secret: password };
  }
  return null;
}

/** What a kind is called on its tab and on a card. */
export const KIND_LABELS: Record<VaultCategory, string> = {
  debrid: 'Debrid Services', usenet_provider: 'Usenet Providers', usenet_indexer: 'Usenet Indexers', stremio: 'Stremio', nuvio: 'Nuvio',
  jellyfin: 'Jellyfin', metadata: 'Metadata & Trackers', ai: 'AI Services', vpn: 'VPN', iptv: 'IPTV', aiostreams: 'AIOStreams', note: 'Notes', custom: 'Custom',
};
