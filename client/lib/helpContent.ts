// Local, static how-to knowledge base for the command palette's free-text
// fallback (see CommandPalette.tsx) - answers "how do I do X" without
// needing AI Services configured. Deliberately not AI-generated: a fixed,
// reviewed set of short guides is both instant (no network round-trip) and
// always available, unlike the old AI fallback which needed an external key
// and only worked for whoever had one configured. Keep entries short (1-3
// sentences) and update this list as new features ship - it's meant to be
// the same kind of living reference as changelog.json, just phrased as
// answers instead of release notes.

export interface HelpEntry {
  id: string;
  title: string;
  // Lowercase search terms - include synonyms/misspellings a user might
  // actually type, not just the feature's official name.
  keywords: string[];
  answer: string;
  href?: string;
  linkLabel?: string;
}

export const HELP_ENTRIES: HelpEntry[] = [
  {
    id: 'automation-create',
    title: 'Setting up an Automation rule',
    keywords: ['automation', 'automate', 'rule', 'trigger', 'webhook', 'schedule', 'condition'],
    answer: 'Tasks → Automation → Manage Rules → New Rule. Pick a trigger (e.g. "at a scheduled time each day" or "when a user is created"), optionally add conditions to narrow when it fires, then choose an action like sending a notification. Each condition row has its own remove button on the right.',
    href: '/tasks',
    linkLabel: 'Open Automation',
  },
  {
    id: 'catalog-create',
    title: 'Creating a catalog',
    keywords: ['catalog', 'list', 'create list', 'new catalog', 'make a catalog'],
    answer: 'Catalogs → New Catalog. Start empty and add titles manually, import from an MDBList or TMDb list URL, or use Suggest Titles to auto-populate from a text description (genre, decade, or a phrase like "heist movies").',
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'catalog-nuvio-collections',
    title: 'Getting a catalog into Nuvio Collections',
    keywords: ['nuvio collections', 'import catalog', 'export catalog', 'aiometadata', 'simkl', 'mdblist', 'catalog to nuvio'],
    answer: 'Catalogs aren\'t installed directly into Nuvio. Export the catalog first (open it → More → Export to MDBList or Export to SIMKL), then point AIOMetadata (or wherever your Nuvio Collections source folders come from) at that exported list.',
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'catalog-rating-policy',
    title: 'Content Rating on a catalog',
    keywords: ['content rating', 'kids catalog', 'rating policy', 'allowlist', 'family friendly'],
    answer: 'Open a catalog → Content Rating. Check the ratings you want to keep (e.g. G, PG), preview what stays vs. what gets removed, then apply. New titles that don\'t match get rejected going forward, and a daily sweep keeps it enforced automatically.',
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'vault-add-credential',
    title: 'Adding a credential to the Vault',
    keywords: ['vault', 'credential', 'api key', 'add key', 'debrid', 'real-debrid', 'torbox'],
    answer: 'Vault → Add Entry. Pick a category (debrid, usenet, AI, etc.), paste the secret, and SlickSync runs a real check against the provider to confirm it works - not just that something was typed in.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'vault-auto-remove',
    title: 'Debrid auto-remove torrents',
    keywords: ['auto remove', 'autoremove', 'debrid cleanup', 'delete torrent', 'free up slots'],
    answer: 'On a Real-Debrid/TorBox Vault entry, toggle "Auto-remove" and set a day count. Once a torrent has finished downloading and sat idle past that many days, it\'s deleted from your provider account automatically. Off by default - opt in per entry.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'vault-renewal-forecast',
    title: 'Renewal calendar & spend forecast',
    keywords: ['renewal', 'spend forecast', 'billing', 'cost', 'subscription cost'],
    answer: 'Vault entries with cost tracking filled in (monthly/yearly billing) feed the renewal forecast card near the top of the Vault page. It\'s collapsed by default - tap the summary line to expand the individual upcoming renewals.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'public-stats-page',
    title: 'Getting a public stats share link',
    keywords: ['public stats', 'share stats', 'stats page', 'shareable link', 'u/'],
    answer: 'This is a per-user, self-service setting - it lives in your own user portal, not the admin console. Log in at /login?mode=user with the same Stremio/Nuvio credentials that account uses, then go to Settings → Public Stats Page and flip the toggle. It\'ll show you the real link to copy.',
    href: '/login?mode=user',
    linkLabel: 'Open your user portal login',
  },
  {
    id: 'scrobble-api',
    title: 'Using the Scrobble-in API',
    keywords: ['scrobble', 'trakt api', 'infuse', 'kodi trakt', 'third party player'],
    answer: 'In a Trakt-compatible player (Infuse, Kodi\'s Trakt plugin, etc.), set its "custom Trakt server" URL to https://your-instance/api/scrobble and use your per-user API key (from your own user portal Settings, /login?mode=user) as the token. The player\'s existing Trakt integration then writes straight into your SlickTrax history once you cross 80% watched.',
    href: '/login?mode=user',
    linkLabel: 'Open your user portal login',
  },
  {
    id: 'csv-import-export',
    title: 'Importing or exporting watch history',
    keywords: ['csv import', 'csv export', 'letterboxd', 'imdb export', 'trakt export', 'watch history import'],
    answer: 'Open a user\'s detail page → History → Import or Export. Import accepts a Trakt, Letterboxd, or IMDb CSV export. Export produces a Letterboxd-compatible CSV, so your data is never stuck here.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'command-palette',
    title: 'Using the command palette',
    keywords: ['command palette', 'ctrl k', 'cmd k', 'search everything', 'keyboard shortcut'],
    answer: 'Press Ctrl+K (Cmd+K on Mac) anywhere to jump to a page, user, addon, or catalog by typing part of its name - or type a how-to question like this one for a quick answer, no AI setup required.',
  },
  {
    id: 'onboarding-wizard',
    title: 'The first-run onboarding wizard',
    keywords: ['onboarding wizard', 'first run', 'new install walkthrough'],
    answer: 'A one-time, full-screen walkthrough shown only on your very first visit - connect an account, add addons, invite your household, and a rundown of what\'s different from the original Syncio fork. For what shipped in a specific version afterward, check the changelog directly.',
    href: '/changelog',
    linkLabel: 'Open changelog',
  },
  {
    id: 'advanced-sync',
    title: 'What Advanced Sync does',
    keywords: ['advanced sync', 'sync mode', 'sync settings'],
    answer: 'Settings → Sync Mode → Advanced Sync. Normal sync pushes your stored addon list to users as-is. Advanced sync re-fetches each addon\'s live manifest from its source first, so upstream changes (new catalogs, updated resources) get pushed too - slower per sync since it hits the network for every addon.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'ai-services-setup',
    title: 'Setting up AI Services',
    keywords: ['ai services', 'openai key', 'nl catalog', 'natural language catalog', 'ai key'],
    answer: 'Settings → External API Keys → AI Services. Paste a base URL (OpenAI, OpenRouter, Groq, Gemini, DeepSeek all work) and an API key, then pick a model - SlickSync verifies it with a real test request on save. This powers natural-language catalog building (Suggest Titles) and auto-themed catalogs.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'theme-build-share',
    title: 'Building or sharing a custom theme',
    keywords: ['theme', 'custom theme', 'theme code', 'share theme', 'colors'],
    answer: 'Themes → Build your own theme. Pick a base theme, set your own accent colors and optional overrides, then Save as new theme. Use "Copy theme code" to get a paste-able code someone else can import with "Import from a code" - no server round-trip needed.',
    href: '/themes',
    linkLabel: 'Open Themes',
  },
  {
    id: 'health-ignore',
    title: 'Muting a Health page alert',
    keywords: ['health ignore', 'mute alert', 'dismiss health', 'proxy unreachable', 'health attention'],
    answer: 'On Metrics → Health, hover a failing item and click the eye icon to ignore it - it stops counting toward Attention and its notifications, and stays reversible from that card\'s "ignored" list. Proxy (a single connectivity check, not a list) has its own mute toggle shown once it\'s in Attention state.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'sync-mode-basics',
    title: 'Syncing addons to users',
    keywords: ['sync addons', 'sync users', 'push addons', 'sync all'],
    answer: 'Add addons on the Addons page, assign them to a User or Group, then use Sync (per-user or "Sync All Groups") to push that list to their real Stremio/Nuvio account. See "Advanced Sync" if you also want upstream manifest changes pulled in automatically.',
    href: '/addons',
    linkLabel: 'Open Addons',
  },
  {
    id: 'invite-household',
    title: 'Inviting your household',
    keywords: ['invite', 'invitation', 'add household member', 'invite link'],
    answer: 'Invitations → New Invitation. Share the generated link - whoever opens it connects their own Stremio/Nuvio account without you doing it for them, and they land in your account\'s Users list automatically.',
    href: '/invitations',
    linkLabel: 'Open Invitations',
  },
  {
    id: 'backup-restore',
    title: 'Backing up or restoring your setup',
    keywords: ['backup', 'restore', 'disaster recovery', 'export config', 'snapshot'],
    answer: 'Tasks → Automatic Backups (or Configuration → Export Config) for a full config snapshot, and Vault\'s own Disaster Recovery Kit for a passphrase-encrypted bundle that includes every stored secret too.',
    href: '/tasks',
    linkLabel: 'Open Tasks',
  },
  {
    id: 'addon-templates',
    title: 'Reusing an addon set as a template',
    keywords: ['addon template', 'save template', 'apply template', 'deploy addons'],
    answer: 'Tasks → Addon Templates → Save New Template, from an existing user or group\'s current addon set. Apply it to any other user/group later instead of rebuilding the same list by hand.',
    href: '/tasks',
    linkLabel: 'Open Tasks',
  },
  {
    id: 'watchlist-reactions',
    title: 'Watchlist, Watched indicators, and Reactions',
    keywords: ['watchlist', 'watched indicator', 'reactions', 'thumbs up', 'slicktrax'],
    answer: 'These are SlickTrax features, on by default: Watchlist (bookmark a title from its detail popup), Watched indicators (checkmarks on posters you\'ve already seen), and Reactions (thumbs up/down next to the rating, feeding what gets recommended to you). Each has its own opt-out in Settings → SlickTrax.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'groups',
    title: 'Using Groups',
    keywords: ['group', 'groups', 'sync all groups', 'household group'],
    answer: 'Groups → New Group. Assign users and addons to a group instead of managing each user one at a time - "Sync All Groups" pushes every member\'s addon list in one go, and a group-level addon reorder pushes to everyone in it.',
    href: '/groups',
    linkLabel: 'Open Groups',
  },
  {
    id: 'discover-browse',
    title: 'Browsing and searching in Discover',
    keywords: ['discover', 'browse', 'search movies', 'genre filter', 'because you watched'],
    answer: 'Discover → browse Popular/New/Top Rated, filter by genre, or search titles and people (actors/directors, with a filmography deep-dive). "Because you watched" / "For You" rows use your own household\'s taste once there\'s enough watch history.',
    href: '/discover',
    linkLabel: 'Open Discover',
  },
  {
    id: 'nuvio-collections-manager',
    title: 'Building Nuvio Collections (home-screen folders)',
    keywords: ['nuvio collections manager', 'build collection', 'home screen folder', 'community covers', 'cover art nuvio'],
    answer: 'Catalogs → Nuvio Collections. Pick an account and profile, then build/organize that profile\'s actual Nuvio home-screen folders - templates, drag reorder, custom or Community Covers art, broken-source detection. This is separate from a SlickSync Catalog; TMDb-templated folders still need a TMDb key set in the Nuvio app itself to render.',
    href: '/catalogs/nuvio-collections',
    linkLabel: 'Open Nuvio Collections',
  },
  {
    id: 'tv-mode',
    title: 'Using SlickSync on a TV / D-pad',
    keywords: ['tv mode', 'android tv', 'fire tv', 'd-pad', 'remote control'],
    answer: 'TV layout is auto-detected on Android TV / Fire TV - no setting to flip. Every page becomes fully navigable with just the remote\'s D-pad and Enter, including the detail modal\'s action buttons and Cast row.',
  },
  {
    id: '2fa-sso',
    title: 'Enabling 2FA or SSO login',
    keywords: ['2fa', 'two factor', 'totp', 'sso', 'oidc', 'authenticator app'],
    answer: 'Settings → Security for TOTP 2FA (opt-in): scan the QR code in an authenticator app and save the backup codes it shows you once. SSO (OIDC) is a separate, operator-configured option set via environment variables on the server, not a per-account toggle - ask whoever runs this instance if it\'s available here.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'notifications-setup',
    title: 'Setting up notifications',
    keywords: ['notifications', 'push notifications', 'discord webhook', 'digest', 'bell'],
    answer: 'Settings → Notifications. Native push and the in-app bell are primary and need no setup beyond allowing the browser prompt; Discord is optional (paste a webhook URL). Digest mode batches everything into one daily/weekly summary instead of alert-by-alert, and Devices lets you rename/revoke individual push subscriptions.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'poster-ratings-rpdb',
    title: 'Showing ratings on posters (RPDB / poster ratings)',
    keywords: ['poster ratings', 'rpdb', 'rating posterdb', 'imdb badge on poster'],
    answer: 'Settings → SlickTrax → Poster ratings shows IMDb/Rotten Tomatoes/Metacritic badges on every poster card in Discover and Catalogs (off by default). For posters with the rating baked right into the art itself, also add a free RatingPosterDB key under External API Keys.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'year-in-review-taste',
    title: 'Year in Review and Taste Profiles',
    keywords: ['year in review', 'wrapped', 'taste profile', 'taste overlap', 'airing calendar'],
    answer: 'Metrics → Content has Year in Review (a Wrapped-style annual recap) and Taste Profiles (what genres/actors you actually gravitate to, plus real overlap between household members). The Airing Calendar / "Coming Up" panel on Dashboard tracks new episodes for shows you watch, with per-show muting.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'account-merge-mismatch',
    title: 'Account merge and mismatch alerts',
    keywords: ['account merge', 'merge accounts', 'mismatch', 'unrecognized account'],
    answer: 'Users → a user\'s own page → Merge lets you absorb a second provider identity (e.g. a Nuvio login for someone already added via Stremio) into one existing user, with a preview and full undo. A "mismatch" notification means streaming was seen on a provider account that isn\'t added to SlickSync yet - add it as a User to resolve.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'now-playing-continue-watching',
    title: 'Now Playing and Continue Watching',
    keywords: ['now playing', 'continue watching', 'resume', 'currently watching'],
    answer: 'Dashboard shows live Now Playing (who\'s streaming what right now, with a resume-on-another-device link straight into Stremio/Nuvio) and a Continue Watching row for mid-episode/movie resumes - both update automatically, nothing to configure.',
    href: '/',
    linkLabel: 'Open Dashboard',
  },
  {
    id: 'add-nuvio-account',
    title: 'Adding a Nuvio account',
    keywords: ['nuvio account', 'add nuvio', 'nuvio login', 'nuvio oauth'],
    answer: 'Users → New User → pick Nuvio as the provider - email/password or OAuth device-code login both work. A provider badge (Stremio vs. Nuvio) shows next to the user everywhere afterward, and everything else (sync, metrics, expiry tracking, backups) treats it the same as a Stremio account.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'simkl-link',
    title: 'Linking SIMKL',
    keywords: ['simkl', 'link simkl', 'simkl pin', 'simkl sync'],
    answer: 'On a user\'s own page, Link SIMKL and enter the PIN code it gives you. Once linked, watch history syncs both ways on a 30-minute schedule, and that user becomes available as a target for Catalogs\' SIMKL import/export (Plan to Watch).',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'catalog-simkl-plan-to-watch',
    title: 'Importing/exporting a catalog via SIMKL',
    keywords: ['simkl plan to watch', 'simkl import', 'simkl export catalog'],
    answer: 'SIMKL has no API for named custom lists, so Catalogs targets its "Plan to Watch" list instead - open a catalog → More → Export to SIMKL, pick which SIMKL-linked user, and it pushes there (or pulls from it, for import).',
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'account-deletion-export',
    title: 'Deleting your account or exporting your data',
    keywords: ['delete account', 'export my data', 'account deletion', 'self service delete'],
    answer: 'Self-service watch-history export and full account deletion are both available from your own user portal (/login?mode=user) under Settings - not something an admin has to do for you, and not reversible once confirmed.',
    href: '/login?mode=user',
    linkLabel: 'Open your user portal login',
  },
  {
    id: 'public-registration',
    title: 'Public self-service registration (public-mode instances only)',
    keywords: ['public mode', 'self registration', 'superadmin', 'multi tenant'],
    answer: 'On a public multi-tenant deployment, new accounts can self-register instead of an admin creating them, and a Superadmin console handles search, bulk enable/disable/delete, an audit log, and abandoned-account cleanup across every tenant. Not applicable on a private, single-household instance.',
  },
  {
    id: 'vault-organize',
    title: 'Organizing the Vault (categories, drag reorder, snooze)',
    keywords: ['vault organize', 'vault category', 'reorder vault', 'snooze expiry', 'vault right click'],
    answer: 'Vault entries are grouped by category and drag-to-reorder within it; right-click (or long-press) an entry for a quick menu including copy-to-clipboard. If an expiry warning is a known non-issue for now, Snooze silences it for 7 days without dismissing it for good.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'vault-cost-tracking',
    title: 'Tracking Vault subscription costs',
    keywords: ['vault cost', 'cost per hour', 'multi currency', 'spend summary'],
    answer: 'Edit a Vault entry and fill in monthly/yearly billing plus a currency - it feeds the spend summary, cost-per-hour-watched figures, and the renewal forecast card, all computed automatically from what you enter.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'rewatch-completion',
    title: 'Rewatch and completion tracking',
    keywords: ['rewatch', 'completion tracking', 'finished watching', 'started and dropped'],
    answer: 'SlickTrax distinguishes a true completion (finished) from something started-and-dropped, and separately tracks rewatches - both feed into Metrics and Year in Review automatically; there\'s nothing to turn on.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'not-interested-feedback',
    title: '"Not interested" feedback on a title',
    keywords: ['not interested', 'hide recommendation', 'dont recommend'],
    answer: 'From a title\'s detail popup or a recommendation row, mark it "Not interested" to suppress it (and similar titles) from your own For You / Because You Watched rows going forward.',
  },
  {
    id: 'discord-poster-recap',
    title: 'Monthly Discord poster-mosaic recap',
    keywords: ['discord recap', 'poster mosaic', 'monthly recap discord'],
    answer: 'If a Discord webhook is configured (Settings → Notifications), SlickSync automatically posts a poster-mosaic recap of the household\'s watched titles once a month - no separate toggle beyond having the webhook set.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'watch-notification-overrides',
    title: 'Per-user watch notification settings',
    keywords: ['watch notification', 'started watching notification', 'per user discord webhook'],
    answer: 'Each user can opt out of their own "started/finished watching" notifications, and set a personal Discord webhook that overrides the account-wide one - both live on that user\'s own settings, not the admin Settings page.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'more-like-this-collection',
    title: '"More Like This" and franchise collections on the detail modal',
    keywords: ['more like this', 'similar titles', 'collection', 'franchise', 'box office'],
    answer: 'A title\'s detail popup includes a collapsed "More Like This" row (TMDb-powered recommendations) and, for franchise entries, a "Part of the X Collection" row - both are disclosures, tap to expand. Box office figures (via OMDb) show there too when available.',
  },
  {
    id: 'nuvio-collections-covers',
    title: 'Cover art for Nuvio Collections folders',
    keywords: ['community covers', 'gif cover', 'collection cover art', 'folder cover'],
    answer: 'In the Nuvio Collections manager, a folder\'s cover can be a custom image URL, an animated GIF, or picked from Community Covers (a searchable, community-submitted library built into the picker).',
    href: '/catalogs/nuvio-collections',
    linkLabel: 'Open Nuvio Collections',
  },
  {
    id: 'nebula-layout',
    title: 'Switching to the Nebula layout',
    keywords: ['nebula', 'layout mode', 'top nav layout', 'glass panel'],
    answer: 'Themes → Layout. Nebula is an alternate top-nav, glass-panel layout you can pick independently of your color Theme - it\'s a structural choice, not another color option.',
    href: '/themes',
    linkLabel: 'Open Themes',
  },
  {
    id: 'api-docs',
    title: 'The interactive API docs',
    keywords: ['api docs', 'swagger', 'developer api', 'rest api'],
    answer: 'Settings → API Key → Interactive API docs opens a Swagger UI at /api/docs, generated straight from the external developer API\'s own route handlers. It only covers the external API (/api/ext), not the internal admin routes this UI itself uses.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'addon-health-alerts',
    title: 'Getting alerted when an addon goes down',
    keywords: ['addon offline alert', 'addon failover', 'addon health notification'],
    answer: 'Addon reachability is checked automatically on a schedule; going offline (or coming back) fires a notification through whichever channels you have on (push/bell by default, Discord if configured) and logs an event to the Health page\'s incident timeline - no per-addon setup needed.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'system-health-overview',
    title: 'What the System Health page checks',
    keywords: ['system health', 'health board', 'what does health check', 'uptime percent'],
    answer: 'Metrics → Health checks four things: Sync (per-user addon drift), Addons (reachability + uptime %), Vault (credential failures/expiry), and the AIOStreams Proxy (connectivity) - plus a unified incident timeline of every offline/online and vault/proxy event, and an update-available check.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'db-storage-card',
    title: 'The database storage card',
    keywords: ['db storage', 'database size', 'sqlite size', 'table breakdown'],
    answer: 'Metrics → Admin has a DB storage card showing the SQLite file\'s current size and a per-table breakdown, read-only - useful for spotting what\'s actually taking up space.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'user-lifecycle-tracking',
    title: 'User lifecycle tracking (new/active/at-risk/churned)',
    keywords: ['user lifecycle', 'at risk user', 'churned user', 'inactive user'],
    answer: 'Metrics → Users buckets every household member into new, active, at-risk, or churned based on their recent watch activity, so a household member who\'s gone quiet is easy to spot without checking each profile by hand.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'addon-performance-card',
    title: 'Addon performance, heatmap, and binge detection',
    keywords: ['addon performance', 'hourly heatmap', 'binge watch detection', 'top items'],
    answer: 'Metrics → Content includes an addon performance card, an hourly-activity heatmap, top-watched items, viewing streaks, and binge-watch detection - all computed automatically from existing watch history, nothing to configure.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'private-mode-custom-names',
    title: 'Private Mode and Custom Addon Names',
    keywords: ['private mode', 'hide sensitive', 'custom addon names', 'rename addon display'],
    answer: 'Settings → Privacy & Display. Private Mode masks emails, IPs, and API keys throughout the UI (handy for screen-sharing or screenshots). Custom Addon Names shows the display name you gave an addon instead of its original manifest name, everywhere it appears.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'account-timezone',
    title: 'Setting the account timezone',
    keywords: ['timezone', 'time zone', 'watch time today wrong day'],
    answer: 'Settings → Privacy & Display → Timezone. Auto-detected from your browser on first visit, then stored explicitly - background jobs (like Watch Time Today and streaks) have no browser to check against later, so update this by hand if you travel or move.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'unsafe-mode',
    title: 'What Unsafe Mode does',
    keywords: ['unsafe mode', 'skip confirmation', 'destructive operations'],
    answer: 'Settings → Sync Mode → Unsafe Mode lets sync/delete operations skip their normal confirmation step. Off by default and not recommended - it removes a safety net, not a feature you need for normal use.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'auto-themed-catalogs',
    title: 'Auto-generated catalogs',
    keywords: ['auto generated catalog', 'auto themed catalog', 'taste cluster catalog'],
    answer: 'Settings → SlickTrax → Auto-generated catalogs (off by default). Detects a real taste cluster in your watch history (e.g. "90s Action") and saves it as an actual Catalog instead of just a recommendation row - checked daily; delete the generated catalog to stop it coming back.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'account-id-danger-zone',
    title: 'Your Account ID, and deleting the whole account',
    keywords: ['account id', 'uuid login', 'danger zone', 'delete my account admin'],
    answer: 'Settings → Account ID (public-mode instances) shows your login UUID - copy and save it, since there\'s no password-reset flow if it\'s lost. Settings → Danger Zone is where the account itself (not a single user) can be permanently deleted - irreversible.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'protected-addons',
    title: 'Protecting an addon from bulk changes',
    keywords: ['protected addon', 'protect addon', 'lock addon'],
    answer: 'Drag an addon card onto the "Protected" filter tab on the Addons page (or use its own toggle) to mark it protected - protected addons are skipped by bulk remove/sync-reset operations, so a core addon can\'t be wiped out by an accidental bulk action.',
    href: '/addons',
    linkLabel: 'Open Addons',
  },
  {
    id: 'import-export-addons',
    title: 'Importing or exporting your addon list',
    keywords: ['import addons', 'export addons', 'addon list backup'],
    answer: 'Addons → Import Addons accepts a Stremio/Nuvio-style addon collection JSON. Export Addons produces the same format back out, so your addon set is portable between instances or usable as a manual backup.',
    href: '/addons',
    linkLabel: 'Open Addons',
  },
  {
    id: 'bulk-sync-delete-users-groups',
    title: 'Bulk syncing or deleting all Users/Groups',
    keywords: ['sync all users', 'delete all users', 'sync all groups', 'delete all groups', 'bulk sync'],
    answer: 'Users → Sync All Users (or Groups → Sync All Groups) pushes every user/group\'s addon list in one action. "Delete All" in either sidebar is a real bulk-delete - it\'s destructive and asks for confirmation first.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'library-history-export-clear',
    title: 'Exporting or clearing a user\'s Library/History',
    keywords: ['clear library', 'clear history', 'export library', 'export history all users'],
    answer: 'A user\'s detail page has Library (Export or Clear Library) and History (Export, Import, or Clear History) sections. Export downloads a copy first; Clear is a real, confirmation-gated deletion of that data from SlickSync, not from Stremio/Nuvio itself.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'config-import-export-reset',
    title: 'Importing, exporting, or resetting your Configuration',
    keywords: ['export config', 'import config', 'reset config', 'configuration backup'],
    answer: 'Tasks → Configuration. Export Config downloads a full settings snapshot; Import Config restores from one. Reset Config wipes account settings back to defaults - confirmation-gated since it\'s not reversible.',
    href: '/tasks',
    linkLabel: 'Open Tasks',
  },
];

// Very small keyword-overlap scorer, not a real search engine - good enough
// for a few dozen short entries. Title match outweighs a keyword match,
// which outweighs an answer-body match, so a query like "automation" surfaces
// the automation guide above a guide that merely mentions it in passing.
export function searchHelp(query: string, limit = 4): HelpEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  const scored = HELP_ENTRIES.map((entry) => {
    let score = 0;
    const titleLower = entry.title.toLowerCase();
    const answerLower = entry.answer.toLowerCase();
    if (titleLower.includes(q)) score += 6;
    if (entry.keywords.some((k) => k === q)) score += 5;
    for (const term of terms) {
      if (titleLower.includes(term)) score += 3;
      if (entry.keywords.some((k) => k.includes(term))) score += 2;
      if (answerLower.includes(term)) score += 1;
    }
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}
