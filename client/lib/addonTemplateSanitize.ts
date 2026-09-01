// "Strip keys" for addon template share codes - reuses decodeAddonConfig
// (addonConfig.ts), the same URL-config decoder the addon detail page's
// in-place editor already relies on, rather than writing a second parser.
//
// An addon template code currently exports install URLs wholesale - see
// ShareCodeDialog's warning on the template dialog, which exists precisely
// because those URLs often carry a real debrid/API key. This lets the
// exporter swap every field the decoder already flags `sensitive` for a
// placeholder, so the code carries the addon's STRUCTURE (which catalogs,
// which resources) without the secrets, and the importer is prompted to
// supply their own values before anything is created.
//
// Addons whose config can't be decoded at all (AIOStreams-style encrypted
// envelopes - see addonConfig.ts's own opaque-envelope detection) can't be
// safely stripped either: there's no way to tell which part of an opaque
// blob is a secret. Those are excluded from a sanitized export entirely,
// with the exporter told so plainly, rather than shipping a URL that LOOKS
// stripped but silently still carries whatever's really inside.

import { decodeAddonConfig, type AddonConfigField } from './addonConfig';

export const KEY_PLACEHOLDER = '__SLICKSYNC_YOUR_KEY__';

export interface SanitizeResult {
  addons: Array<{ name: string; manifestUrl: string | null; stremioAddonId: string | null; version: string | null }>;
  /** Names of addons dropped because their config couldn't be decoded, so
   * nothing could be safely stripped from them. */
  excluded: string[];
  /** True if at least one addon actually had a field replaced - lets the
   * importer-side prompt skip entirely for a template that never needed it. */
  hasPlaceholders: boolean;
}

export function sanitizeTemplateAddons(
  addons: Array<{ name: string; manifestUrl: string | null; stremioAddonId: string | null; version: string | null }>
): SanitizeResult {
  const excluded: string[] = [];
  let hasPlaceholders = false;

  const sanitized = addons.map((addon) => {
    if (!addon.manifestUrl) return addon;
    const decoded = decodeAddonConfig(addon.manifestUrl);
    if (!decoded) {
      // Opaque config (or no config segment at all - a plain URL with
      // nothing to strip). Only actually exclude it if it looked like it
      // HAD a config to begin with; a bare manifest URL with no embedded
      // config is already safe as-is.
      const hasConfigSegment = /\/[^/]+\/manifest\.json$/i.test(addon.manifestUrl) && !/^https?:\/\/[^/]+\/manifest\.json$/i.test(addon.manifestUrl);
      if (hasConfigSegment) {
        excluded.push(addon.name);
        return { ...addon, manifestUrl: null };
      }
      return addon;
    }
    const anySensitive = decoded.fields.some((f) => f.sensitive);
    if (!anySensitive) return addon;
    hasPlaceholders = true;
    const redacted: AddonConfigField[] = decoded.fields.map((f) => (f.sensitive ? { ...f, value: KEY_PLACEHOLDER } : f));
    try {
      return { ...addon, manifestUrl: decoded.rebuild(redacted) };
    } catch {
      // Couldn't rebuild with the placeholder in place (e.g. a kv-shaped
      // addon whose format can't represent this value) - safer to exclude
      // than to fall back to the original, key-bearing URL.
      excluded.push(addon.name);
      return { ...addon, manifestUrl: null };
    }
  });

  return { addons: sanitized, excluded, hasPlaceholders };
}

/** Import-side counterpart: which of a decoded template's addons still
 * carry the placeholder, and what field names need a real value for each.
 * Used to build the "fill in your own keys" prompt before creating
 * anything. */
export function findPlaceholderFields(
  addons: Array<{ name: string; manifestUrl: string | null }>
): Array<{ addonName: string; fieldKeys: string[] }> {
  const result: Array<{ addonName: string; fieldKeys: string[] }> = [];
  for (const addon of addons) {
    // Deliberately NOT a raw `manifestUrl.includes(KEY_PLACEHOLDER)` check
    // first: for a base64-shaped config the placeholder lives INSIDE the
    // encoded segment, so a string match on the URL misses it entirely and
    // the importer is never prompted - the addon then deploys still holding
    // the placeholder. Decode first, inspect the real field values.
    if (!addon.manifestUrl) continue;
    const decoded = decodeAddonConfig(addon.manifestUrl);
    if (!decoded) continue;
    const fieldKeys = decoded.fields.filter((f) => f.value === KEY_PLACEHOLDER).map((f) => f.key);
    if (fieldKeys.length > 0) result.push({ addonName: addon.name, fieldKeys });
  }
  return result;
}

/** Substitutes real values back in before the addons are actually created.
 * `values` is keyed "addonName::fieldKey" -> the value the importer typed. */
export function applyPlaceholderValues(
  addons: Array<{ name: string; manifestUrl: string | null; stremioAddonId: string | null; version: string | null }>,
  values: Record<string, string>
): Array<{ name: string; manifestUrl: string | null; stremioAddonId: string | null; version: string | null }> {
  return addons.map((addon) => {
    // Same reasoning as findPlaceholderFields above - decode before
    // deciding whether this addon has anything to substitute.
    if (!addon.manifestUrl) return addon;
    const decoded = decodeAddonConfig(addon.manifestUrl);
    if (!decoded) return addon;
    if (!decoded.fields.some((f) => f.value === KEY_PLACEHOLDER)) return addon;
    const filled = decoded.fields.map((f) => {
      if (f.value !== KEY_PLACEHOLDER) return f;
      const key = `${addon.name}::${f.key}`;
      return { ...f, value: values[key] ?? '' };
    });
    try {
      return { ...addon, manifestUrl: decoded.rebuild(filled) };
    } catch {
      return addon;
    }
  });
}
