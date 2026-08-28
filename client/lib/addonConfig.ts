// Decoding/re-encoding of the configuration most Stremio-style addons carry
// INSIDE their manifest URL. There is no config API in the addon protocol -
// an addon's settings (providers, quality filters, debrid keys, languages)
// live as one path segment right before /manifest.json, in one of three
// wire shapes seen across the ecosystem:
//
//   kv       host/providers=yts,eztv|realdebrid=KEY/manifest.json
//            (Torrentio and friends: key=value pairs joined by |)
//   json     host/%7B%22lang%22%3A%22en%22%7D/manifest.json
//            (URL-encoded JSON object)
//   b64json  host/eyJsYW5nIjoiZW4ifQ==/manifest.json
//            (base64 or base64url of a JSON object - Comet, MediaFusion &co)
//
// Anything else (encrypted blobs, opaque tokens - AIOStreams runs this way)
// is reported as undecodable so callers can fall back to the addon's own
// hosted /configure page instead of showing garbage fields.
//
// Consumer: the addon detail page's Edit config panel (decode -> edit
// fields -> rebuild -> save through the existing updateAddon flow). The
// button only renders when decoding succeeds; opaque configs keep using
// the addon's own hosted configure page via the page's existing action.
// (A Vault "Magic Import" scan built on this extraction was removed
// 2026-08-25: self-hosted fleets keep keys server-side/encrypted where a
// URL scan can never see them, so it read as broken rather than useful.)

export interface AddonConfigField {
  key: string;
  value: string;
  /** How the value must be put back when rebuilding: */
  kind: 'string' | 'number' | 'boolean' | 'string-list' | 'json';
  /** Render as a masked input - set for key/token-looking field names. */
  sensitive: boolean;
}

export interface DecodedAddonConfig {
  shape: 'kv' | 'json' | 'b64json';
  fields: AddonConfigField[];
  /** Rebuilds the full manifest URL with edited field values. Throws with a
   * user-showable message when a value can't be represented (e.g. a `|` in
   * a kv value would corrupt the whole segment). */
  rebuild: (fields: AddonConfigField[]) => string;
}

const SENSITIVE_KEY_RE = /key|token|pass|secret|debrid|premiumize|torbox|offcloud|putio|apikey/i;

// A base64/base64url string long enough to plausibly be an IV, ciphertext,
// or digest rather than a short human value.
const LOOKS_LIKE_CIPHER_BLOB_RE = /^[A-Za-z0-9+/_-]{12,}={0,2}$/;

// Some addons (AIOStreams and its forks chief among them) store their real
// settings server-side and put only an ENCRYPTED reference blob in the
// manifest URL - still valid JSON, so the shape-sniffing below would
// otherwise treat it as a normal editable config. Confirmed live: a real
// AIOStreams install URL decodes to exactly {"i":"<iv>","e":"<ciphertext>",
// "t":"<tag>"} - cryptic single/double-letter keys, every value an opaque
// base64 blob, nothing resembling a real setting name. Editing "i" or "e"
// directly would hand back a ciphertext the addon's own server can no
// longer decrypt, silently breaking it rather than changing any setting.
//
// Heuristic, not a hardcoded AIOStreams check, so any addon using the same
// pattern (short cryptic keys + blob-shaped values, no recognizable setting
// name anywhere) is caught the same way: a small object where every key is
// at most 3 characters AND every value looks like a cipher blob.
function looksLikeEncryptedEnvelope(obj: Record<string, unknown>): boolean {
  const entries = Object.entries(obj);
  if (entries.length === 0 || entries.length > 6) return false;
  return entries.every(([key, value]) => {
    // Single characters only. Tried <=2 first and it false-positived on a
    // plausible real shape - short provider-abbreviation keys (rd/tb/pm for
    // realdebrid/torbox/premiumize) paired with long API-key values, which
    // are exactly what a compact debrid-style addon config looks like. The
    // one shape actually confirmed live is AIOStreams' own envelope, whose
    // keys (i, e, t) are all single characters - restricting to that exact
    // width keeps the real case caught without that false-positive risk.
    if (key.length > 1) return false;
    if (typeof value !== 'string') return false;
    // A short flag value (AIOStreams' own "t":"a") doesn't need to look like
    // a blob itself - only the key's cryptic shortness matters there - but a
    // longer value must actually look like base64 to count as a cipher blob
    // rather than e.g. a legitimately short setting someone abbreviated.
    return value.length <= 4 || LOOKS_LIKE_CIPHER_BLOB_RE.test(value);
  });
}

function splitManifestUrl(manifestUrl: string): { url: URL; segments: string[]; configIndex: number } | null {
  let url: URL;
  try { url = new URL(manifestUrl.replace(/^stremio:\/\//i, 'https://')); } catch { return null; }
  const segments = url.pathname.split('/');
  const last = segments[segments.length - 1] || '';
  if (last.toLowerCase() !== 'manifest.json') return null;
  const configIndex = segments.length - 2;
  // configIndex 0 is the empty segment before the leading slash - i.e. the
  // URL is host/manifest.json with no config segment at all.
  if (configIndex <= 0 || !segments[configIndex]) return null;
  return { url, segments, configIndex };
}

function b64Decode(seg: string): string | null {
  // Accept both standard and url-safe alphabets; reject anything with
  // characters outside either, so random path words don't "decode".
  if (!/^[A-Za-z0-9+/\-_]+={0,2}$/.test(seg)) return null;
  try {
    const normalized = seg.replace(/-/g, '+').replace(/_/g, '/');
    return atob(normalized);
  } catch { return null; }
}

function jsonToFields(obj: Record<string, unknown>): AddonConfigField[] {
  return Object.entries(obj).map(([key, value]) => {
    const sensitive = SENSITIVE_KEY_RE.test(key);
    if (typeof value === 'string') return { key, value, kind: 'string' as const, sensitive };
    if (typeof value === 'number') return { key, value: String(value), kind: 'number' as const, sensitive };
    if (typeof value === 'boolean') return { key, value: String(value), kind: 'boolean' as const, sensitive };
    if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return { key, value: value.join(','), kind: 'string-list' as const, sensitive };
    }
    // Nested structure - editable as raw JSON rather than dropped, so no
    // part of a config is invisible in the editor.
    return { key, value: JSON.stringify(value), kind: 'json' as const, sensitive };
  });
}

function fieldsToJson(fields: AddonConfigField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'string') out[f.key] = f.value;
    else if (f.kind === 'number') {
      const n = Number(f.value);
      if (!Number.isFinite(n)) throw new Error(`"${f.key}" must be a number`);
      out[f.key] = n;
    } else if (f.kind === 'boolean') {
      if (f.value !== 'true' && f.value !== 'false') throw new Error(`"${f.key}" must be true or false`);
      out[f.key] = f.value === 'true';
    } else if (f.kind === 'string-list') {
      out[f.key] = f.value === '' ? [] : f.value.split(',').map((s) => s.trim());
    } else {
      try { out[f.key] = JSON.parse(f.value); }
      catch { throw new Error(`"${f.key}" must stay valid JSON`); }
    }
  }
  return out;
}

export function decodeAddonConfig(manifestUrl: string): DecodedAddonConfig | null {
  const parts = splitManifestUrl(manifestUrl);
  if (!parts) return null;
  const { url, segments, configIndex } = parts;
  const rawSegment = segments[configIndex];
  let decoded: string;
  try { decoded = decodeURIComponent(rawSegment); } catch { decoded = rawSegment; }

  const rebuildWith = (newSegment: string) => {
    const next = [...segments];
    next[configIndex] = newSegment;
    return `${url.origin}${next.join('/')}${url.search}`;
  };

  // JSON (URL-encoded or plain)
  if (decoded.startsWith('{')) {
    try {
      const obj = JSON.parse(decoded);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && !looksLikeEncryptedEnvelope(obj)) {
        return {
          shape: 'json',
          fields: jsonToFields(obj),
          rebuild: (fields) => rebuildWith(encodeURIComponent(JSON.stringify(fieldsToJson(fields)))),
        };
      }
    } catch { /* fall through */ }
  }

  // base64(JSON)
  const b64 = b64Decode(rawSegment);
  if (b64 && b64.startsWith('{')) {
    try {
      const obj = JSON.parse(b64);
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && !looksLikeEncryptedEnvelope(obj)) {
        // Preserve the alphabet the addon itself used - a server expecting
        // url-safe base64 may reject `+`/`/`.
        const urlSafe = /[-_]/.test(rawSegment) || !/[+/]/.test(rawSegment);
        return {
          shape: 'b64json',
          fields: jsonToFields(obj),
          rebuild: (fields) => {
            let enc = btoa(JSON.stringify(fieldsToJson(fields)));
            if (urlSafe) enc = enc.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            return rebuildWith(enc);
          },
        };
      }
    } catch { /* fall through */ }
  }

  // key=value|key=value
  if (/^[^|=]+=[^|]*(\|[^|=]+=[^|]*)*$/.test(decoded) && decoded.includes('=')) {
    const fields: AddonConfigField[] = decoded.split('|').map((pair) => {
      const eq = pair.indexOf('=');
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      return { key, value, kind: 'string' as const, sensitive: SENSITIVE_KEY_RE.test(key) };
    });
    return {
      shape: 'kv',
      fields,
      rebuild: (edited) => {
        for (const f of edited) {
          if (f.value.includes('|') || f.key.includes('|') || f.key.includes('=')) {
            throw new Error(`"${f.key}" can't contain | or = characters in this addon's format`);
          }
        }
        // These segments travel unencoded in the wild (Torrentio's own
        // configure page emits them that way) - only spaces need escaping.
        return rebuildWith(edited.map((f) => `${f.key}=${f.value}`).join('|').replace(/ /g, '%20'));
      },
    };
  }

  return null;
}
