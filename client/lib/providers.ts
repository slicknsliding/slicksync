// What kind of login a person has, answered the same way on every page.
// Stremio and Nuvio were the only two for a long time, so many places ask
// "Nuvio? otherwise Stremio" - a person signed in to a Jellyfin-compatible
// server is neither. Mirrors server/utils/providerInfo.js.

export type ProviderType = 'stremio' | 'nuvio' | 'jellyfin';

type ProviderLike = {
  providerType?: string | null;
  jellyfinServerKind?: string | null;
  jellyfinServerLabel?: string | null;
} | null | undefined;

const JELLYFIN_KIND_LABELS: Record<string, string> = {
  jellyfin: 'Jellyfin',
  aiostreams: 'AIOStreams',
  aiometadata: 'AIOMetadata',
};

/** The app's name: Stremio, Nuvio, or the kind of Jellyfin-compatible server. */
export function providerLabel(user: ProviderLike): string {
  const type = user?.providerType || 'stremio';
  if (type === 'nuvio') return 'Nuvio';
  if (type === 'jellyfin') {
    return user?.jellyfinServerLabel || JELLYFIN_KIND_LABELS[user?.jellyfinServerKind || ''] || 'Jellyfin';
  }
  return 'Stremio';
}

/** Whether SlickSync manages an addon list for this person. */
export function hasAddonList(user: ProviderLike): boolean {
  return (user?.providerType || 'stremio') !== 'jellyfin';
}

export function isJellyfin(user: ProviderLike): boolean {
  return user?.providerType === 'jellyfin';
}

/** The badge colour for a person's app: AIOStreams and AIOMetadata servers get their own. */
export function providerBadgeVariant(user: ProviderLike): 'stremio' | 'nuvio' | 'jellyfin' | 'aiostreams' | 'aiometadata' {
  const type = user?.providerType || 'stremio';
  if (type === 'nuvio') return 'nuvio';
  if (type === 'jellyfin') {
    const kind = user?.jellyfinServerKind;
    return kind === 'aiostreams' ? 'aiostreams' : kind === 'aiometadata' ? 'aiometadata' : 'jellyfin';
  }
  return 'stremio';
}

// A Jellyfin, AIOStreams or AIOMetadata login has no email, so SlickSync makes
// one from the person's id on that server - "<32 hex>@<server host>" (see
// identityEmail in server/providers/jellyfinAuth.js). It keeps people apart,
// but on screen it is just a long id, so wherever an email would show, the
// server they sign in to shows instead.
const SERVER_IDENTITY_EMAIL = /^[0-9a-f]{32}@(.+)$/i;

/** The address to show for a person: their email, or for a server login, that server. */
export function displayEmail(email?: string | null): string {
  if (!email) return '';
  const m = SERVER_IDENTITY_EMAIL.exec(email);
  return m ? m[1] : email;
}

/** The same, for a bare providerType (merged-in logins carry only that). */
export function providerTypeLabel(type?: string | null): string {
  return type === 'nuvio' ? 'Nuvio' : type === 'jellyfin' ? 'Jellyfin' : 'Stremio';
}
