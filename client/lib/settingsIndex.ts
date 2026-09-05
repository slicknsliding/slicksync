// Searchable index of the individual controls on the Settings page, for the
// command palette's deep-search. Each entry's `anchor` is the control's
// VISIBLE label text on /settings - SettingRow emits it verbatim as a
// data-setting attribute, and the page's highlight effect falls back to a
// text scan for the labelled blocks that aren't SettingRows. That means a
// renamed setting degrades gracefully (the palette still lands on /settings,
// just without the flash) rather than breaking, but keep anchors in step
// with the page's labels when either changes.
//
// Keywords are the words people actually type, not restatements of the
// label - same convention as the palette's own NAV_ITEMS keywords.

export interface SettingsIndexEntry {
  /** Visible label on /settings - doubles as the highlight anchor. */
  label: string;
  keywords: string;
  /** Extra display context under the palette row, e.g. which section it's in. */
  section: string;
}

const S = (label: string, section: string, keywords = ''): SettingsIndexEntry => ({ label, section, keywords });

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  // Privacy & Display
  S('Beginner Mode', 'Privacy & Display', 'help explanations tips new'),
  S('Private Mode', 'Privacy & Display', 'hide sensitive emails ips blur mask'),
  S('Custom Addon Names', 'Privacy & Display', 'rename labels'),
  S('Timezone', 'Privacy & Display', 'time zone clock today streaks travel'),
  // Sync Mode
  S('Advanced Sync', 'Sync Mode', 'manifest refetch live'),
  S('Unsafe Mode', 'Sync Mode', 'destructive confirmation dangerous'),
  // Notifications
  S('Phone notifications (PWA)', 'Notifications', 'push mobile install app device'),
  S('Devices', 'Notifications', 'push devices rename revoke subscribed'),
  S('Webhook URL', 'Notifications', 'discord webhook'),
  S('Activity notifications', 'Notifications', 'started watching ping'),
  S('Sync notifications', 'Notifications', 'drift'),
  S('Invite notifications', 'Notifications', ''),
  S('Vault notifications', 'Notifications', 'credentials expiry'),
  S('Addon health notifications', 'Notifications', 'offline down'),
  S('New device notifications', 'Notifications', 'unconfirmed ip alert'),
  S('Backup notifications', 'Notifications', ''),
  S('Proxy connectivity notifications', 'Notifications', 'aiostreams unreachable'),
  S('Update available notifications', 'Notifications', 'release version new'),
  S('Recovery Kit reminders', 'Notifications', 'disaster recovery stale'),
  S('Monthly poster mosaic', 'Notifications', 'recap collage'),
  S('Digest mode', 'Notifications', 'summary batch daily weekly digest frequency'),
  // SlickTrax
  S('Watchlist', 'SlickTrax', 'bookmark save later'),
  S('Watched indicators', 'SlickTrax', 'seen checkmarks'),
  S('Seasonal anime row', 'SlickTrax', 'anime anilist airing season countdown'),
  S('Spoiler guard', 'SlickTrax', 'watching together watch ahead frontier spoiler pact'),
  S('Recommendations', 'SlickTrax', 'for you suggested rows'),
  S('Auto-generated catalogs', 'SlickTrax', ''),
  S('Poster ratings', 'SlickTrax', 'rpdb art'),
  S('Reactions', 'SlickTrax', 'like dislike'),
  S('Streaming availability', 'SlickTrax', 'where to watch providers logos'),
  S('Autoplay trailer', 'SlickTrax', 'youtube video'),
  S('Autoplay with sound', 'SlickTrax', 'mute trailer audio'),
  // External API Keys
  S('TMDb API key', 'External API Keys', 'tmdb metadata movie database'),
  S('OMDb API key', 'External API Keys', 'omdb ratings rotten tomatoes metacritic usage meter limit'),
  S('MDBList API key', 'External API Keys', 'mdblist score import'),
  S('RPDB API key', 'External API Keys', 'rpdb rating posters art'),
  S('Spread by remaining quota', 'External API Keys', 'key pool weighting quota'),
  S('Auto-retire failing pool keys', 'External API Keys', 'key pool dead remove'),
  S('Pause background lookups near the cap', 'External API Keys', 'quota autopilot omdb limit defer background'),
  S('SIMKL Client ID', 'External API Keys', 'simkl link trending'),
  S('Trakt Client ID', 'External API Keys', 'trakt list import public list'),
  S('Nuvio backend URL', 'External API Keys', 'self-hosted server custom'),
  S('AI Services', 'External API Keys', 'openai key model llm draft explanations'),
  // Security & account
  S('Your API Key', 'Scrobble API', 'scrobble trakt infuse kodi external api'),
  S('Two-Factor Authentication', 'Security', '2fa totp authenticator backup codes security'),
  S('Profile Picture', 'Account', 'avatar image'),
  S('Account ID', 'Account', 'identifier'),
  S('Danger Zone', 'Account', 'delete account wipe remove everything'),
];

/** Palette-style substring match over label + keywords + section. */
export function searchSettings(query: string, limit = 4): SettingsIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_INDEX
    .filter((e) => e.label.toLowerCase().includes(q) || e.keywords.includes(q) || e.section.toLowerCase().includes(q))
    .slice(0, limit);
}
