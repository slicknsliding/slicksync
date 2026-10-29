// "Open in …" on a title: which app it opens, chosen per device (this
// browser's storage - a phone can open Swiftfin while the TV opens Wholphin),
// and the link each app understands. Only apps that open straight to a title
// are listed; the item ids come from the server (/jellyfin/open-targets).

export type OpenWithAppId = 'aiostreams' | 'swiftfin' | 'streamyfin' | 'infuse' | 'web' | 'shortcut';

export interface OpenTargetServer {
  address: string;
  kind: 'jellyfin' | 'aiostreams' | 'aiometadata' | string;
  serverId: string | null;
  people: { name: string; userId: string | null }[];
  itemId: string | null;
}
export interface OpenTargetDevice {
  personId: string;
  credentialId: string | null;
  person: string;
  address: string;
  itemId: string;
  sessionId: string;
  device: string;
  client: string | null;
}
export interface OpenTargets { servers: OpenTargetServer[]; devices: OpenTargetDevice[]; tmdbId: string | null }

export interface OpenWithApp {
  id: OpenWithAppId;
  name: string;
  platforms: string;
  color: string;
  letter: string;
}

export const OPEN_WITH_APPS: OpenWithApp[] = [
  { id: 'aiostreams', name: 'AIOStreams', platforms: 'Android, desktop · AIOStreams servers', color: '#7c6ff0', letter: 'A' },
  { id: 'swiftfin', name: 'Swiftfin', platforms: 'iPhone, iPad, Apple TV', color: '#2a6df4', letter: 'S' },
  { id: 'streamyfin', name: 'Streamyfin', platforms: 'iPhone, Android', color: '#9b3fd1', letter: 'S' },
  { id: 'infuse', name: 'Infuse', platforms: 'iPhone, Apple TV, Mac · titles in its own library', color: '#e46a2a', letter: 'I' },
];
// Any app at all on iPhone, iPad or Mac: a Shortcut the person made once
// ("Open App -> Odin") is run by its name. It opens the app, not the title.
export const SHORTCUT_APP: OpenWithApp = { id: 'shortcut', name: 'Any app (through a Shortcut)', platforms: 'iPhone, iPad, Mac · opens the app, not the title', color: '#5b5b66', letter: '⌘' };
export const WEB_APP: OpenWithApp = { id: 'web', name: 'The server’s own page', platforms: 'In a browser · works on any device', color: '#00a4dc', letter: 'J' };

const STORAGE_KEY = 'slicksync-open-with';
export function rememberedApp(): OpenWithAppId | null {
  try { return (localStorage.getItem(STORAGE_KEY) as OpenWithAppId | null) || null; } catch { return null; }
}
export function rememberApp(id: OpenWithAppId) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* private mode: this visit only */ }
}

const SHORTCUT_KEY = 'slicksync-open-with-shortcut';
export interface ShortcutChoice { app: string; shortcut: string }
export function rememberedShortcut(): ShortcutChoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(SHORTCUT_KEY) || 'null');
    return v && typeof v.app === 'string' && typeof v.shortcut === 'string' && v.shortcut.trim() ? v : null;
  } catch { return null; }
}
export function rememberShortcut(choice: ShortcutChoice) {
  try { localStorage.setItem(SHORTCUT_KEY, JSON.stringify(choice)); } catch { /* this visit only */ }
}

const plainId = (id: string | null) => (id ? id.replace(/-/g, '') : '');

/**
 * The links an app gets for a title, one per server it can reach (several
 * people on one server share it; Swiftfin's link names the user, so it gets
 * one per person there).
 */
export function linksFor(app: OpenWithAppId, t: OpenTargets, type: 'movie' | 'series'): { label: string; detail: string; url: string }[] {
  const out: { label: string; detail: string; url: string }[] = [];
  const host = (a: string) => a.replace(/^https?:\/\//, '');
  const names = (s: OpenTargetServer) => s.people.map((p) => p.name).join(', ');
  if (app === 'shortcut') {
    const sc = rememberedShortcut();
    if (sc && t.servers?.length) out.push({ label: sc.app || 'Your app', detail: `Runs your Shortcut “${sc.shortcut}”`, url: `shortcuts://run-shortcut?name=${encodeURIComponent(sc.shortcut)}` });
    return out;
  }
  if (app === 'infuse') {
    if (t.tmdbId && t.servers?.length) out.push({ label: 'Infuse', detail: 'Opens it in your Infuse library', url: `infuse://${type === 'movie' ? 'movie' : 'series'}/${t.tmdbId}` });
    return out;
  }
  for (const s of t.servers || []) {
    if (!s.itemId) continue;
    const id = s.itemId;
    if (app === 'aiostreams') {
      if (s.kind === 'aiostreams') out.push({ label: names(s) || 'AIOStreams', detail: host(s.address), url: `aiostreams://item/${id}?server=${encodeURIComponent(s.address)}` });
    } else if (app === 'swiftfin') {
      if (!s.serverId) continue;
      for (const p of s.people) if (p.userId) out.push({ label: p.name, detail: host(s.address), url: `swiftfin://${plainId(s.serverId)}/${plainId(p.userId)}/item/${plainId(id)}` });
    } else if (app === 'streamyfin') {
      out.push({ label: names(s), detail: host(s.address), url: `streamyfin://items/page?id=${encodeURIComponent(id)}` });
    } else if (app === 'web') {
      // Only a real Jellyfin has a web app; AIOStreams and AIOMetadata don't.
      if (s.kind === 'jellyfin') out.push({ label: names(s), detail: host(s.address), url: `${s.address}/web/#/details?id=${encodeURIComponent(id)}${s.serverId ? `&serverId=${encodeURIComponent(s.serverId)}` : ''}` });
    }
  }
  return out;
}

/** Apps that can open this title here at all, in list order. */
export function availableApps(t: OpenTargets, type: 'movie' | 'series'): OpenWithApp[] {
  return [...OPEN_WITH_APPS, WEB_APP, SHORTCUT_APP].filter((a) => linksFor(a.id, t, type).length > 0);
}
