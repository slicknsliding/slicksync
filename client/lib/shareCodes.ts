// Share codes: any shareable piece of a SlickSync setup as one compact
// copy-paste string, working between any two instances with no accounts,
// no files, and no server round-trip to produce. Same wire format the
// theme codes established (lib/theme.tsx, SST1:): a typed prefix +
// base64(encodeURIComponent(JSON)) - the encodeURIComponent wrap is what
// lets btoa/atob round-trip arbitrary UTF-8 (titles in any language).
//
// Three payload kinds, one per prefix, each validated structurally on
// decode so a truncated paste or a code of the wrong kind fails cleanly
// instead of importing garbage:
//   SSC1:  a catalog (name + items)
//   SSN1:  Nuvio home-screen collections (the same array shape the
//          Collections page's JSON export/import already uses)
//   SSA1:  an addon template (name + addon list with manifest URLs -
//          NOTE: those URLs can embed API keys; every share UI for this
//          kind must warn before generating, see ShareCodeDialog usage)

export interface CatalogSharePayload {
  name: string;
  description?: string;
  items: Array<{ id: string; type: 'movie' | 'series'; name: string; poster?: string | null; year?: number | string | null }>;
}

export interface NuvioCollectionsSharePayload {
  // Deliberately loose: the Collections page owns this array's real shape
  // (its import path re-validates and re-ids everything anyway), and
  // pinning a full type here would just drift from it.
  collections: Array<{ title: string; folders: unknown[] } & Record<string, unknown>>;
}

export interface AddonTemplateSharePayload {
  name: string;
  description?: string;
  addons: Array<{ name: string; manifestUrl: string | null; stremioAddonId?: string | null; version?: string | null }>;
}

export type DecodedShareCode =
  | { kind: 'catalog'; payload: CatalogSharePayload }
  | { kind: 'nuvioCollections'; payload: NuvioCollectionsSharePayload }
  | { kind: 'addonTemplate'; payload: AddonTemplateSharePayload };

const PREFIX: Record<DecodedShareCode['kind'], string> = {
  catalog: 'SSC1:',
  nuvioCollections: 'SSN1:',
  addonTemplate: 'SSA1:',
};

function encode(prefix: string, payload: unknown): string {
  return prefix + btoa(encodeURIComponent(JSON.stringify(payload)));
}

export function encodeCatalogShareCode(payload: CatalogSharePayload): string {
  return encode(PREFIX.catalog, payload);
}
export function encodeNuvioCollectionsShareCode(payload: NuvioCollectionsSharePayload): string {
  return encode(PREFIX.nuvioCollections, payload);
}
export function encodeAddonTemplateShareCode(payload: AddonTemplateSharePayload): string {
  return encode(PREFIX.addonTemplate, payload);
}

/** True when a pasted string LOOKS like any share code - cheap check for
 * input fields that accept both URLs and codes. */
export function looksLikeShareCode(text: string): boolean {
  const t = text.trim();
  return Object.values(PREFIX).some((p) => t.startsWith(p));
}

export function decodeShareCode(code: string): DecodedShareCode | null {
  const trimmed = code.trim();
  const kind = (Object.keys(PREFIX) as Array<DecodedShareCode['kind']>).find((k) => trimmed.startsWith(PREFIX[k]));
  if (!kind) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(atob(trimmed.slice(PREFIX[kind].length))));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;

  if (kind === 'catalog') {
    if (typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.items)) return null;
    const items = (p.items as unknown[]).filter((it): it is CatalogSharePayload['items'][number] => {
      if (!it || typeof it !== 'object') return false;
      const o = it as Record<string, unknown>;
      return typeof o.id === 'string' && typeof o.name === 'string' && (o.type === 'movie' || o.type === 'series');
    });
    if (items.length === 0) return null;
    return { kind, payload: { name: p.name.trim(), description: typeof p.description === 'string' ? p.description : undefined, items } };
  }

  if (kind === 'nuvioCollections') {
    if (!Array.isArray(p.collections)) return null;
    const collections = (p.collections as unknown[]).filter((c): c is NuvioCollectionsSharePayload['collections'][number] => {
      if (!c || typeof c !== 'object') return false;
      const o = c as Record<string, unknown>;
      return typeof o.title === 'string' && Array.isArray(o.folders);
    });
    if (collections.length === 0) return null;
    return { kind, payload: { collections } };
  }

  // addonTemplate
  if (typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.addons)) return null;
  const addons = (p.addons as unknown[]).filter((a): a is AddonTemplateSharePayload['addons'][number] => {
    if (!a || typeof a !== 'object') return false;
    const o = a as Record<string, unknown>;
    return typeof o.name === 'string' && (typeof o.manifestUrl === 'string' || o.manifestUrl === null);
  });
  if (addons.length === 0) return null;
  return { kind, payload: { name: p.name.trim(), description: typeof p.description === 'string' ? p.description : undefined, addons } };
}
