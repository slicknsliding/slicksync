// Local, static how-to knowledge base for the command palette's free-text
// fallback (see CommandPalette.tsx) - answers "how do I do X" without
// needing AI Services configured. Deliberately not AI-generated: a fixed,
// reviewed set of short guides is both instant (no network round-trip) and
// always available, unlike the old AI fallback which needed an external key
// and only worked for whoever had one configured. Keep entries short (1-3
// sentences) and update this list as new features ship - it's meant to be
// the same kind of living reference as changelog.json, just phrased as
// answers instead of release notes.

export type HelpCategory =
  | 'Getting started'
  | 'Users & Groups'
  | 'Addons'
  | 'Catalogs & Collections'
  | 'Vault & credentials'
  | 'Watching & Discover'
  | 'Sharing & integrations'
  | 'Notifications & Automation'
  | 'Appearance'
  | 'Health & maintenance'
  | 'Security & account'
  | 'Troubleshooting';

// Order categories appear in on the Guides page - roughly "what a new user
// needs first" down to "what you only read when something's wrong".
export const HELP_CATEGORY_ORDER: HelpCategory[] = [
  'Getting started',
  'Users & Groups',
  'Addons',
  'Catalogs & Collections',
  'Vault & credentials',
  'Watching & Discover',
  'Sharing & integrations',
  'Notifications & Automation',
  'Appearance',
  'Health & maintenance',
  'Security & account',
  'Troubleshooting',
];

export interface HelpEntry {
  id: string;
  title: string;
  category: HelpCategory;
  // Lowercase search terms - include synonyms/misspellings a user might
  // actually type, not just the feature's official name.
  keywords: string[];
  // Short summary - what the command palette shows inline. Keep it to 1-3
  // sentences; anything longer belongs in the fields below, which only the
  // full topic page (/guides/[id]) renders.
  answer: string;
  // Numbered walkthrough, when the topic is a "how do I actually do this".
  steps?: string[];
  // Extra paragraphs - background, how it works under the hood, what it
  // deliberately doesn't do.
  details?: string[];
  // Gotchas worth calling out separately so they don't get lost in prose.
  tips?: string[];
  // ids of other entries worth reading next.
  related?: string[];
  // Renders the actual feature in a modal ON the guide page, instead of
  // navigating away to find it. Reading the steps and doing the thing at
  // the same time beats being dropped on a page with the instructions now
  // behind you. Only set this where the feature is a genuinely
  // self-contained component - see the switch in guides/[id]/page.tsx.
  embed?: 'automation';
  href?: string;
  linkLabel?: string;
}

export const HELP_ENTRIES: HelpEntry[] = [
  {
    id: 'automation-create',
    title: 'Setting up an Automation rule',
    category: 'Notifications & Automation',
    keywords: ['automation', 'automate', 'rule', 'trigger', 'webhook', 'schedule', 'condition'],
    answer: 'Tasks → Automation → Manage Rules → New Rule. Pick a trigger, optionally add conditions to narrow when it fires, then choose an action like sending a notification or calling a webhook.',
    steps: [
      'Go to Tasks → Automation → Manage Rules.',
      'Click New Rule and give it a name you\'ll recognise later.',
      'Pick a trigger: a scheduled time, or an event like "when a user is created".',
      'For a scheduled trigger set the hour and minute, then pick days if you want it on specific ones - leave them all unselected and it runs every day. That is how you express "every Sunday at 3am".',
      'Optionally add conditions - these narrow when the rule actually fires. Each condition row has its own remove button on the right if you add one by mistake.',
      'Choose an action: send a notification (push/bell/Discord), sync users, enable or disable an addon, move someone in or out of a group, or POST to a webhook URL.',
      'Save. The rule runs from that point on - it does not retroactively fire for things that already happened.',
    ],
    details: [
      'Automation runs on the same background engine that already drives notifications and health checks, so it keeps working whether or not a browser is open.',
      'The webhook action POSTs the trigger\'s own data as JSON to whatever URL you give it, which is the hook for wiring SlickSync into something else (Home Assistant, n8n, a Discord bot, your own script).',
      "The Sync users action runs the same sync as the Sync button, and can target the user from the trigger, one specific user, everyone in a group, or every active user. Paired with a scheduled trigger, that is how you get an unattended weekly sync.",
      "Times use your account timezone (Settings -> Privacy & Display) rather than the server clock, so a rule set for Sunday just after midnight lands on the day you meant.",
      "Each scheduled rule runs on its own time - a rule set for 9am is not affected by another set for 3am.",
    ],
    tips: [
      'A rule with no conditions fires every time its trigger does - that\'s usually what you want for a daily schedule, and rarely what you want for a per-user event.',
      "Tasks already has a simpler auto-sync that runs on an interval (every hour, every day, every 7 days). Use that if you just want regular syncing; use an automation rule when you need a specific time, specific days, or only part of the household.",
      'Test a webhook against a throwaway endpoint (webhook.site or similar) before pointing it at something that takes real action.',
    ],
    related: ['notifications-setup', 'watch-notification-overrides', 'catalog-federation'],
    // Opens the real Automation panel in a modal on this guide page, so the
    // steps above stay on screen while you follow them.
    embed: 'automation',
  },
  {
    id: 'catalog-create',
    title: 'Creating a catalog',
    category: 'Catalogs & Collections',
    keywords: ['catalog', 'list', 'create list', 'new catalog', 'make a catalog'],
    answer: 'Catalogs → New Catalog. Start empty and add titles manually, import from an MDBList or TMDb list URL, or use Suggest Titles to auto-populate from a text description (genre, decade, or a phrase like "heist movies").',
    steps: [
      'Go to Catalogs and click New Catalog.',
      'Name it - the name matters, since Suggest Titles matches against it (a catalog called "90s Horror" gets much better suggestions than one called "List 3").',
      'Add titles one of four ways: manually from any poster\'s right-click menu, Import from an MDBList/TMDb URL, Suggest Titles, or Describe a catalog for a plain-English starting point.',
      'Optionally set custom cover art, a Content Rating allowlist, or daily auto-refresh if it was imported from a URL.',
    ],
    details: [
      'Right-clicking a catalog on the Catalogs index gives you Pin to top, Cover art, Rename, Content Rating, and Delete without opening it first.',
      'Imported catalogs remember their source URL, so Refresh re-pulls from it and shows you a diff before applying anything.',
    ],
    tips: [
      'Suggest Titles and Describe-a-catalog both need a (free) TMDb key in Settings → External API Keys to do real keyword matching. Without one they fall back to plain title search, which is much weaker.',
      'Auto-refresh is opt-in per catalog - it will not silently start changing a catalog you built by hand.',
    ],
    related: ['catalog-rating-policy', 'catalog-nuvio-collections', 'auto-themed-catalogs'],
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'catalog-nuvio-collections',
    title: 'Getting a catalog into Nuvio Collections',
    category: 'Catalogs & Collections',
    keywords: ['nuvio collections', 'import catalog', 'export catalog', 'aiometadata', 'simkl', 'mdblist', 'catalog to nuvio'],
    answer: 'Catalogs aren\'t installed directly into Nuvio. Export the catalog first (open it → More → Export to MDBList or Export to SIMKL), then point AIOMetadata (or wherever your Nuvio Collections source folders come from) at that exported list.',
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'catalog-rating-policy',
    title: 'Content Rating on a catalog',
    category: 'Catalogs & Collections',
    keywords: ['content rating', 'kids catalog', 'rating policy', 'allowlist', 'family friendly'],
    answer: 'Open a catalog → Content Rating. Check the ratings you want to keep (e.g. G, PG), preview what stays vs. what gets removed, then apply. New titles that don\'t match get rejected going forward, and a daily sweep keeps it enforced automatically.',
    steps: [
      'Open the catalog, then click Content Rating in the button row (it sits just left of Suggest titles).',
      'Check the certifications this catalog is allowed to contain.',
      'Review the preview - it shows exactly what stays and what gets removed before anything happens.',
      'Apply. If it removed more than you expected, use the one-step undo.',
    ],
    details: [
      'This is a real allowlist, not a passive flag: applying it removes everything that does not match, and the policy stays enforced afterward.',
      'Enforcement works in two directions - an add-time gate rejects non-matching titles going forward, and a daily sweep re-checks the catalog in case something was re-certified or re-imported.',
      'Clearing the policy stops enforcement; it does not bring back previously removed titles.',
    ],
    tips: [
      'Titles with no certification data at all are treated as not matching. If a catalog empties out more than expected, that is usually why.',
      'This is per-catalog, not account-wide. A "Kids Night" catalog can be locked to G/PG while everything else is untouched.',
    ],
    related: ['catalog-create', 'auto-themed-catalogs'],
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'vault-add-credential',
    title: 'Adding a credential to the Vault',
    category: 'Vault & credentials',
    keywords: ['vault', 'credential', 'api key', 'add key', 'debrid', 'real-debrid', 'torbox'],
    answer: 'Vault → Add Entry. Pick a category (debrid, usenet, AI, etc.), paste the secret, and SlickSync runs a real check against the provider to confirm it works - not just that something was typed in.',
    steps: [
      'Go to Vault → Add Entry.',
      'Pick the provider/category - that\'s what decides which real health-check runs against it.',
      'Paste the secret and save. SlickSync immediately tests it against the provider\'s own API.',
      'Optionally fill in cost and billing cycle, which feeds the renewal calendar and spend forecast.',
      'Optionally set an expiry date to get renewal alerts ahead of time.',
    ],
    details: [
      'Everything is AES-GCM encrypted at rest. The edit form deliberately shows a blank secret field rather than the stored value - click the eye icon to fetch and reveal the real one.',
      'Real-Debrid and TorBox entries additionally show live usage on the card (active downloads, premium days remaining) pulled from the provider.',
      'A nightly encrypted export lands in data/backup/vault/, separate from the main config backup.',
    ],
    tips: [
      'A failing check is a real signal, not a false alarm - it means the credential genuinely is not working right now. If an indexer blocks your server\'s IP and that is expected, use the Health page\'s Ignore instead of deleting the entry.',
    ],
    related: ['vault-auto-remove', 'vault-backup-key', 'vault-cost-tracking', 'vault-organize', 'health-ignore'],
    href: '/vault?open=add',
    linkLabel: 'Add an entry',
  },
  {
    id: 'vault-auto-remove',
    title: 'Debrid auto-remove torrents',
    category: 'Vault & credentials',
    keywords: ['auto remove', 'autoremove', 'debrid cleanup', 'delete torrent', 'free up slots'],
    answer: 'On a Real-Debrid/TorBox Vault entry, toggle "Auto-remove" and set a day count. Once a torrent has finished downloading and sat idle past that many days, it\'s deleted from your provider account automatically. Off by default - opt in per entry.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'key-pool',
    title: 'The Key Pool - several keys per provider, one shared allowance',
    category: 'Vault & credentials',
    keywords: ['key pool', 'multiple keys', 'quota', 'rate limit', 'mdblist limit', 'spread keys', 'rotate keys', 'pooled allowance', 'quota weighting', 'auto retire', 'remove dead key'],
    answer: 'Each metadata key in Settings can hold extra keys beyond the primary and backup - the "Add key pool" chip under the field. With any pool keys present, lookups rotate across every healthy key instead of always using the primary, so three free MDBList keys stop being three separate 1,000/day allowances and become one pooled one.',
    steps: [
      'Settings -> External API Keys -> "Add key pool" under the key you want to spread.',
      'Paste a key, press Enter. Repeat for as many as you have (up to 10).',
      'That is all - rotation starts on the next lookup.',
    ],
    details: [
      'The daily check tests every key in the pool individually, and rotation skips any key it found failing or rate-limited - a dead pool member is routed around, not retried on every third request.',
      'If every key in the pool is marked bad, lookups fall back to the primary rather than nothing: a marked-bad key is still better than no key, and the next check unmarks it the moment it recovers.',
      'With no pool keys configured, nothing changes: the primary is used, with the backup taking over only when a check has found the primary bad - exactly the failover behaviour that already existed.',
      'Pool keys are real secrets: stripped from plain config exports and carried in the Disaster Recovery Kit, the same as the primaries.',
      'Two opt-in behaviours appear under the pool fields once any pool has keys. "Spread by remaining quota" sends requests to the key with the most allowance left instead of strict turns - for providers that report usage (MDBList today); near-equal keys still alternate so no single key gets driven to its limit. "Auto-retire failing pool keys" removes a pool key that has failed for 3 straight days, with one notification naming it by its last 4 characters - primaries and backups are never touched, one bad check never retires anything.',
    ],
    related: ['vault-backup-key', 'provider-key-health', 'vault-key-rotation'],
  },
  {
    id: 'vault-injection',
    title: 'Keys that never leave the server',
    category: 'Vault & credentials',
    keywords: ['vault inject', 'placeholder', 'hide key', 'key in url', 'secure addon url', 'proxy key', 'key never leaves'],
    answer: 'Vault-inject an addon (its page -> Proxy -> "Keys stay in the Vault") and the key inside its URL is replaced by a Vault reference. Devices receive the proxied address; the server resolves the real secret on every request. The key then never appears in the stored URL, in synced manifests, or on any device - and rotating it needs no rewrite and no re-sync at all, because there is nothing downstream holding a copy.',
    steps: [
      'Put the key in the Vault first, as its own entry.',
      'Open the addon -> Proxy section -> "Vault-inject". It names which Vault entries it matched and turns the proxy on for that addon.',
      'Users pick up the proxied URL on their next sync. Done - from now on, rotate the Vault entry and every device follows instantly.',
    ],
    details: [
      'This is the step past rotation propagation: propagation rewrites configs when a key changes; injection removes the key from configs entirely, so a change has nothing to chase.',
      'Works for keys that appear plainly in the addon URL (Torrentio-style). Keys buried inside encoded config blobs are detected and named, but not converted - those addons keep full rotation-propagation coverage instead.',
      '"Restore plain URL" undoes it, writing the current secrets back into the URL - refused if a referenced Vault entry no longer resolves, so a working setup is never replaced with a broken one.',
      'A leaked proxied URL exposes no credential - the reference only resolves server-side, for the account that owns it.',
    ],
    related: ['vault-key-rotation', 'vault-add-credential'],
  },
  {
    id: 'vault-key-rotation',
    title: 'Rotate a key once and every addon follows',
    category: 'Vault & credentials',
    keywords: ['key rotation', 'rotate key', 'debrid key changed', 'new real-debrid key', 'update addon key', 'propagation', 'heal addons'],
    answer: 'Automatic. Saving a changed secret on a Vault entry rewrites every addon config that embeds the old key and re-syncs the users carrying those addons - debrid and usenet keys live inside addon URLs (Torrentio, AIOStreams and the rest each carry a copy), so without this, rotating a key in the Vault fixed nothing downstream.',
    steps: [
      'Edit the Vault entry and paste the new secret, exactly as you normally would.',
      'The save reports what happened: how many addons were rewritten and how many users re-synced. A notification carries the same summary with the addon names.',
    ],
    details: [
      'It finds the old key whether it sits raw in the URL or inside a base64-encoded config blob, and re-encodes the blob exactly as it found it - same alphabet, same padding.',
      'Secrets shorter than 12 characters never propagate, so a short test value can never rewrite half a URL by coincidence.',
      'Only the addon URL changes - the addon itself, its name, its group assignments all stay put. Users are re-synced only if one of their groups carries an affected addon.',
      'If propagation hits a problem, the Vault save itself still succeeds - the new secret is stored either way, and the summary says what did and did not happen.',
    ],
    related: ['vault-add-credential', 'vault-backup-key'],
  },
  {
    id: 'vault-backup-key',
    title: 'Backup keys & automatic failover',
    category: 'Vault & credentials',
    keywords: ['backup key', 'failover', 'spare key', 'second key', 'expired key', 'key rotation', 'redundancy', 'shared keys', 'per user keys'],
    answer: 'Any Vault entry can nominate another entry as its backup using the "Backup key" dropdown on its card, and the TMDb/OMDb/MDBList/RPDB keys in Settings each take an optional backup key of their own. When a health check finds the primary failing, expired or rate-limited, lookups switch to the backup instead of breaking.',
    steps: [
      'Vault: open the entry, pick another entry from the "Backup key" dropdown. Only active entries in the same category are offered, and an entry cannot back up itself.',
      'Metadata keys: Settings -> External API Keys -> "Add a backup key" under whichever key you want covered.',
      'Set the dropdown back to "None", or clear the backup field, to turn failover off again.',
    ],
    details: [
      'The switch only happens once a check has actually found the key bad - never because it merely has not been checked yet. Silently moving to a second key while the first one is fine would make quotas and billing impossible to reason about.',
      'Backups are not chained. If the backup is failing too, nothing further is tried, so a backup pointed back at its own primary cannot loop.',
      'What actually swaps: metadata lookups (posters, ratings, list imports) and AI catalog search. Debrid auto-remove deliberately does NOT swap - it deletes torrents from the provider account the key belongs to, and Vault entries have no owner, so a "backup" may well be a different person’s account. Reading a quota with the wrong key is harmless; deleting with it is not. If a spare account should also be swept, give it its own entry and turn auto-remove on there.',
      'Keys are shared across everyone on the SlickSync account, not set per user. The metadata keys power SlickSync’s own posters and ratings, and Vault is the operator’s credential register. The keys that genuinely differ per person are the ones inside each user’s addon URLs - those are separate addons, and an addon has its own "backup addon" setting for the same purpose.',
      'Automation can react to all of this: "A backup credential takes over" and "A backup metadata key takes over" fire the moment a spare picks up the slack, and the failure triggers carry a "Has a backup key" field so you can alert loudly only when there is nothing to fall back on. Tasks -> Automation -> Recipes has ready-made versions of both.',
      'Failover can also complete itself: the "Promote the backup key to primary" automation action makes the succession permanent - the backup becomes the primary, the dead key is kept as the new backup, and any addon still embedding the old key is rewritten and re-synced. Two ready-made recipes pair it with the takeover triggers.',
    ],
    href: '/vault',
    linkLabel: 'Open Vault',
    related: ['vault-add-credential', 'provider-key-health', 'automation-recipes', 'health-ignore'],
  },
  {
    id: 'vault-renewal-forecast',
    title: 'Renewal calendar & spend forecast',
    category: 'Vault & credentials',
    keywords: ['renewal', 'spend forecast', 'billing', 'cost', 'subscription cost'],
    answer: 'Vault entries with cost tracking filled in (monthly/yearly billing) feed the renewal forecast card near the top of the Vault page. It\'s collapsed by default - tap the summary line to expand the individual upcoming renewals.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'public-stats-page',
    title: 'Getting a public stats share link',
    category: 'Sharing & integrations',
    keywords: ['public stats', 'share stats', 'stats page', 'shareable link', 'u/'],
    answer: 'This is a per-user, self-service setting - it lives in your own user portal, not the admin console. Log in at /login?mode=user with that account\'s own Stremio/Nuvio credentials, then Settings → Public Stats Page and flip the toggle. It shows you the real link to copy.',
    steps: [
      'Go to /login?mode=user and sign in with that user\'s own Stremio or Nuvio credentials.',
      'Open Settings → Public Stats Page.',
      'Turn the toggle on. A link in the form /u/your-slug appears.',
      'Copy the link. Anyone with it can view that page without logging in.',
    ],
    details: [
      'The page shows total watch time, top titles, and current streak for that one user only. It does not expose email, IP, addons, credentials, or anything about other people in the household.',
      'Turning the toggle back off takes the link offline immediately.',
    ],
    tips: [
      'Admins cannot flip this on behalf of a user from the admin console - it is deliberately the user\'s own decision, since it publishes their data.',
    ],
    related: ['scrobble-api', 'account-deletion-export'],
    href: '/login?mode=user',
    linkLabel: 'Open your user portal login',
  },
  {
    id: 'scrobble-api',
    title: 'Using the Scrobble-in API',
    category: 'Sharing & integrations',
    keywords: ['scrobble', 'trakt api', 'infuse', 'kodi trakt', 'third party player'],
    answer: 'In a Trakt-compatible player (Infuse, Kodi\'s Trakt plugin, etc.), point its "custom Trakt server" URL at https://your-instance/api/scrobble and use your per-user API key as the token. The player then writes straight into your SlickTrax history once you cross 80% watched.',
    steps: [
      'Log in to your own user portal at /login?mode=user - this is a per-user key, not the admin account key.',
      'Go to Settings → API Access and copy your personal API key.',
      'In your player, find the Trakt integration and its custom/self-hosted server URL field.',
      'Set the URL to https://your-instance/api/scrobble and paste the API key as the token.',
      'Play something past 80% - it should land in that user\'s SlickTrax history.',
    ],
    details: [
      'This deliberately mirrors Trakt\'s own scrobble API shape, so any client that already speaks Trakt works without needing a SlickSync-specific plugin.',
      'It covers sources SlickSync can otherwise never see - a local file in Infuse, a Plex/Jellyfin play via Kodi - which is the whole point of having it alongside the proxy and native tracking.',
    ],
    tips: [
      'The admin account\'s API key will NOT work here. It has to be the individual user\'s own key from their user portal.',
      'Scrobbles only count at 80%+ watched, matching Trakt\'s own threshold - a quick preview of something won\'t pollute your history.',
    ],
    related: ['csv-import-export', 'public-stats-page', 'api-docs'],
    href: '/login?mode=user',
    linkLabel: 'Open your user portal login',
  },
  {
    id: 'csv-import-export',
    title: 'Importing or exporting watch history',
    category: 'Sharing & integrations',
    keywords: ['csv import', 'csv export', 'letterboxd', 'imdb export', 'trakt export', 'watch history import', 'netflix history', 'netflix viewing activity', 'tv time', 'plex history', 'tautulli', 'movary'],
    answer: 'Open a user\'s detail page → History → Import or Export. Import accepts a Letterboxd or IMDb CSV, the JSON files from Trakt own free export, and CSVs from Netflix (viewing activity), TV Time, Plex/Tautulli, or Movary. Get yours from imdb.com/exports, letterboxd.com/settings/data, or trakt.tv/settings/data. Export produces a Letterboxd-compatible CSV, so your data is never stuck here.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'command-palette',
    title: 'Using the command palette',
    category: 'Getting started',
    keywords: ['command palette', 'ctrl k', 'cmd k', 'search everything', 'keyboard shortcut'],
    answer: 'Press Ctrl+K (Cmd+K on Mac) anywhere to jump to a page, user, addon, or catalog by typing part of its name - or type a how-to question like this one for a quick answer, no AI setup required.',
  },
  {
    id: 'onboarding-wizard',
    title: 'The first-run onboarding wizard',
    category: 'Getting started',
    keywords: ['onboarding wizard', 'first run', 'new install walkthrough', 'replay tour', 'welcome tour', 'back button'],
    answer: 'A full-screen walkthrough shown on your very first visit - connect an account, add addons, invite your household, and a rundown of what\'s different from the original Syncio fork. Has a Back button if you click past a step too fast, and can be replayed any time from Settings → Welcome Tour. For what shipped in a specific version afterward, check the changelog directly.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'advanced-sync',
    title: 'What Advanced Sync does',
    category: 'Getting started',
    keywords: ['advanced sync', 'sync mode', 'sync settings'],
    answer: 'Settings → Sync Mode → Advanced Sync. Normal sync pushes your stored addon list to users as-is. Advanced sync re-fetches each addon\'s live manifest from its source first, so upstream changes (new catalogs, updated resources) get pushed too - slower per sync since it hits the network for every addon.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'ai-services-setup',
    title: 'Setting up AI Services',
    category: 'Vault & credentials',
    keywords: ['ai services', 'openai key', 'nl catalog', 'natural language catalog', 'ai key'],
    answer: 'Settings → External API Keys → AI Services. Paste a base URL (OpenAI, OpenRouter, Groq, Gemini, DeepSeek all work) and an API key, then pick a model - SlickSync verifies it with a real test request on save. Entirely optional: nothing here breaks without it.',
    steps: [
      'Go to Settings → External API Keys → AI Services.',
      'Enter the base URL for any OpenAI-compatible endpoint and your API key.',
      'Pick a model from the dropdown - it loads live from whichever provider you configured, rather than a hardcoded list that goes stale.',
      'Save. A real test request runs immediately, so a bad pairing fails loudly instead of silently doing nothing later.',
    ],
    details: [
      'It powers three optional extras only: nuanced natural-language catalog building, the "why this matches" line on SlickTrax recommendation rows, and AI-generated addon incident summaries.',
      'Everything else works with no key at all - including the command palette, which uses a built-in local guide rather than any AI.',
      'Natural-language catalog building also works without a key using a built-in keyword parser; a key just makes it understand more nuanced descriptions.',
    ],
    tips: [
      'The base URL and model have to actually match each other. A Gemini model name pointed at OpenAI\'s endpoint will fail - that mismatch used to fail silently and is exactly what the save-time verification now catches.',
      'Keys resolve per-account first, with the instance-wide env var only as a fallback.',
    ],
    related: ['catalog-create', 'auto-themed-catalogs', 'addon-health-alerts'],
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'theme-build-share',
    title: 'Building or sharing a custom theme',
    category: 'Sharing & integrations',
    keywords: ['theme', 'custom theme', 'theme code', 'share theme', 'colors'],
    answer: 'Themes → Build your own theme. Pick a base theme, set your own accent colors and optional overrides, then Save as new theme. Use "Copy theme code" to get a paste-able code someone else can import with "Import from a code" - no server round-trip needed.',
    href: '/themes',
    linkLabel: 'Open Themes',
  },
  {
    id: 'health-ignore',
    title: 'Muting a Health page alert',
    category: 'Health & maintenance',
    keywords: ['health ignore', 'mute alert', 'dismiss health', 'proxy unreachable', 'health attention'],
    answer: 'On Metrics → Health, hover a failing item and click the eye icon to ignore it - it stops counting toward Attention and its notifications, and stays reversible from that card\'s "ignored" list. Proxy (a single connectivity check, not a list) has its own mute toggle shown once it\'s in Attention state.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'sync-mode-basics',
    title: 'Syncing addons to users',
    category: 'Getting started',
    keywords: ['sync addons', 'sync users', 'push addons', 'sync all'],
    answer: 'Add addons on the Addons page, assign them to a User or Group, then use Sync (per-user or "Sync All Groups") to push that list to their real Stremio/Nuvio account. See "Advanced Sync" if you also want upstream manifest changes pulled in automatically.',
    href: '/addons',
    linkLabel: 'Open Addons',
  },
  {
    id: 'invite-household',
    title: 'Inviting your household',
    category: 'Getting started',
    keywords: ['invite', 'invitation', 'add household member', 'invite link'],
    answer: 'Invitations → New Invitation. Share the generated link - whoever opens it connects their own Stremio/Nuvio account without you doing it for them, and they land in your account\'s Users list automatically. Right-click an invitation -> Show QR to hand it to a phone: point the camera, the invite opens, they connect their own account, and sync sets them up - nothing typed, no credentials through you.',
    href: '/invitations',
    linkLabel: 'Open Invitations',
  },
  {
    id: 'backup-restore',
    title: 'Backing up or restoring your setup',
    category: 'Health & maintenance',
    keywords: ['backup', 'restore', 'disaster recovery', 'export config', 'snapshot'],
    answer: 'Tasks → Automatic Backups (or Configuration → Export Config) for a full config snapshot, and Vault\'s own Disaster Recovery Kit for a passphrase-encrypted bundle that includes every stored secret too. Restoring first shows exactly what would change - which addons, users, and groups would be removed, brought back, or rewound - before anything is touched.',
    steps: [
      'For config only: Tasks → Configuration → Export Config downloads a full settings snapshot.',
      'For config plus every Vault secret: Vault → Disaster Recovery Kit, choose a passphrase, download the bundle.',
      'To restore: Tasks → Configuration → Import Config, or the Recovery Kit\'s own import if you need the secrets back too.',
      'Automatic backups run on a schedule and are validated for real restorability, not just "is this valid JSON".',
    ],
    details: [
      'The Disaster Recovery Kit is the one that survives losing the whole server - it is portable to a brand new instance because the secrets travel with it, re-encrypted under your passphrase rather than the instance key.',
      'A plain config export deliberately does NOT include Vault secrets. That is what makes it safe to hand around or keep in normal storage.',
      'Backup notifications are configured to stay silent when a backup succeeds - you only get pinged if one fails validation.',
    ],
    tips: [
      'The Recovery Kit passphrase is not recoverable. If you lose it, the bundle is unreadable - there is no reset.',
      'Your /app/data volume (database, encryption key, Vault backups, avatars) survives container updates. Backups matter for losing the volume or the host, not for routine updates.',
    ],
    related: ['config-import-export-reset', 'db-storage-card', 'account-id-danger-zone'],
    href: '/tasks',
    linkLabel: 'Open Tasks',
  },
  {
    id: 'addon-templates',
    title: 'Reusing an addon set as a template',
    category: 'Addons',
    keywords: ['addon template', 'save template', 'apply template', 'deploy addons'],
    answer: 'Tasks → Addon Templates → Save New Template, from an existing user or group\'s current addon set. Apply it to any other user/group later instead of rebuilding the same list by hand.',
    href: '/tasks?open=addon-templates',
    linkLabel: 'Save a template',
  },
  {
    id: 'watchlist-reactions',
    title: 'Watchlist, Watched indicators, and Reactions',
    category: 'Watching & Discover',
    keywords: ['watchlist', 'watched indicator', 'reactions', 'thumbs up', 'slicktrax'],
    answer: 'These are SlickTrax features, on by default: Watchlist (bookmark a title from its detail popup), Watched indicators (checkmarks on posters you\'ve already seen), and Reactions (thumbs up/down next to the rating, feeding what gets recommended to you). Each has its own opt-out in Settings → SlickTrax.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'groups',
    title: 'Using Groups',
    category: 'Users & Groups',
    keywords: ['group', 'groups', 'sync all groups', 'household group'],
    answer: 'Groups → New Group. Assign users and addons to a group instead of managing each user one at a time - "Sync All Groups" pushes every member\'s addon list in one go, and a group-level addon reorder pushes to everyone in it.',
    href: '/groups',
    linkLabel: 'Open Groups',
  },
  {
    id: 'discover-browse',
    title: 'Browsing and searching in Discover',
    category: 'Watching & Discover',
    keywords: ['discover', 'browse', 'search movies', 'genre filter', 'because you watched'],
    answer: 'Discover → browse Popular/New/Top Rated, filter by genre, or search titles and people (actors/directors, with a filmography deep-dive). "Because you watched" / "For You" rows use your own household\'s taste once there\'s enough watch history. The Show: All / Unwatched switch on For You rows hides everything the household has already seen.',
    href: '/discover',
    linkLabel: 'Open Discover',
  },
  {
    id: 'nuvio-collections-manager',
    title: 'Building Nuvio Collections (home-screen folders)',
    category: 'Catalogs & Collections',
    keywords: ['nuvio collections manager', 'build collection', 'home screen folder', 'community covers', 'cover art nuvio', 'linked catalog', 'link catalog to folder', 'folder auto update'],
    answer: 'Catalogs → Nuvio Collections. Pick an account and profile, then build/organize that profile\'s actual Nuvio home-screen folders - templates, drag reorder, custom or Community Covers art, broken-source detection. This is separate from a SlickSync Catalog; TMDb-templated folders still need a TMDb key set in the Nuvio app itself to render.',
    details: [
      'Folders can be LINKED to a SlickSync Catalog: when adding a source to a folder, the picker offers "Link a SlickSync Catalog" above the addon list. A linked folder follows the catalog from then on - refresh it, auto-refresh it, edit it, and the folder updates on the device by itself, no re-push needed.',
      'Linking is served through that user\'s SlickTrax Addon (the catalog rides it as a live addon catalog). If the addon is off for the user, linking turns it on and syncs it in the same step. Linked sources show a "linked · auto-updates" tag in the folder\'s source list.',
    ],
    related: ['catalog-create', 'slicktrax-addon', 'nuvio-collections-covers'],
    href: '/catalogs/nuvio-collections',
    linkLabel: 'Open Nuvio Collections',
  },
  {
    id: 'tv-mode',
    title: 'Using SlickSync on a TV / D-pad',
    category: 'Appearance',
    keywords: ['tv mode', 'android tv', 'fire tv', 'd-pad', 'remote control'],
    answer: 'TV layout is auto-detected on Android TV / Fire TV - no setting to flip. Every page becomes fully navigable with just the remote\'s D-pad and Enter, including the detail modal\'s action buttons and Cast row.',
  },
  {
    id: '2fa-sso',
    title: 'Enabling 2FA or SSO login',
    category: 'Security & account',
    keywords: ['2fa', 'two factor', 'totp', 'sso', 'oidc', 'authenticator app'],
    answer: 'Settings → Two-Factor Authentication for TOTP 2FA (opt-in): scan the QR code in an authenticator app and save the backup codes it shows you once. SSO (OIDC) is operator-configured via server environment variables, not a per-account toggle.',
    steps: [
      'Go to Settings → Two-Factor Authentication → Enable 2FA.',
      'Scan the QR code with any authenticator app (Google Authenticator, Authy, 1Password, Bitwarden).',
      'Enter the 6-digit code it shows to confirm the pairing actually works.',
      'Save the 10 backup codes it then shows you - this is the only time they are displayed.',
    ],
    details: [
      'Once enabled, a password alone will not get you in: login stops at a code prompt. The pending-2FA state is a short-lived one-shot token, not a real session, so it cannot be replayed.',
      'Disabling 2FA or regenerating backup codes both require a fresh code, not just an active session - a hijacked session alone cannot turn your own second factor off.',
      'OIDC/SSO is fully additive when an operator has configured it: password login keeps working, and 2FA still applies after an SSO sign-in.',
    ],
    tips: [
      'Each backup code works exactly once. Store them somewhere that is not the same device as your authenticator app.',
      'TOTP codes rotate every 30 seconds and depend on your device clock being roughly correct - if codes are always rejected, check the clock first.',
    ],
    related: ['account-id-danger-zone', 'account-deletion-export'],
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'notifications-setup',
    title: 'Setting up notifications',
    category: 'Notifications & Automation',
    keywords: ['notifications', 'push notifications', 'discord webhook', 'digest', 'bell'],
    answer: 'Settings → Notifications. Native push and the in-app bell are primary and need no setup beyond allowing the browser prompt; Discord is optional (paste a webhook URL). Digest mode batches everything into one daily/weekly summary instead of alert-by-alert.',
    steps: [
      'Open Settings → Notifications.',
      'For phone/desktop push: install SlickSync to your home screen first (it is a PWA), then hit Enable phone notifications and accept the browser prompt.',
      'Optionally paste a Discord webhook URL and hit Test to confirm it posts.',
      'Turn on the specific event types you care about - activity, sync, invites, Vault, addon health, new device, backups, proxy connectivity, update available.',
      'Optionally turn on Digest mode to batch all of the above into one daily or weekly summary.',
    ],
    details: [
      'Push and the in-app bell are the primary channels and always work with zero Discord setup. A webhook only adds Discord delivery on top - nothing requires it.',
      'VAPID keys for push self-generate on first boot, so there is no key setup to do.',
      'Individual users can opt out of their own notifications or set a personal Discord webhook that overrides the account-wide one.',
    ],
    tips: [
      'On iPhone, push only works after you add SlickSync to the Home Screen - Safari will not offer the prompt from a normal browser tab. This is an iOS restriction, not a SlickSync one.',
      'A revoked device stops receiving push immediately; you do not need to reinstall to re-add it later.',
    ],
    related: ['watch-notification-overrides', 'discord-poster-recap', 'automation-create'],
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'poster-ratings-rpdb',
    title: 'Showing ratings on posters (RPDB / poster ratings)',
    category: 'Watching & Discover',
    keywords: ['poster ratings', 'rpdb', 'rating posterdb', 'imdb badge on poster'],
    answer: 'Settings → SlickTrax → Poster ratings shows IMDb/Rotten Tomatoes/Metacritic badges on every poster card in Discover and Catalogs (off by default). For posters with the rating baked right into the art itself, also add a free RatingPosterDB key under External API Keys.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'year-in-review-taste',
    title: 'Year in Review and Taste Profiles',
    category: 'Watching & Discover',
    keywords: ['year in review', 'wrapped', 'taste profile', 'taste overlap', 'airing calendar'],
    answer: 'Metrics → Content has Year in Review (a Wrapped-style annual recap) and Taste Profiles (what genres/actors you actually gravitate to, plus real overlap between household members). The Airing Calendar / "Coming Up" panel on Dashboard tracks new episodes for shows you watch, with per-show muting.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'account-merge-mismatch',
    title: 'Account merge and mismatch alerts',
    category: 'Users & Groups',
    keywords: ['account merge', 'merge accounts', 'mismatch', 'unrecognized account'],
    answer: 'Users → a user\'s own page → Merge lets you absorb a second provider identity (e.g. a Nuvio login for someone already added via Stremio) into one existing user, with a preview and full undo. A "mismatch" notification means streaming was seen on a provider account that isn\'t added to SlickSync yet - add it as a User to resolve.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'now-playing-continue-watching',
    title: 'Now Playing and Continue Watching',
    category: 'Watching & Discover',
    keywords: ['now playing', 'continue watching', 'resume', 'currently watching'],
    answer: 'Dashboard shows live Now Playing (who\'s streaming what right now, with a resume-on-another-device link straight into Stremio/Nuvio) and a Continue Watching row for mid-episode/movie resumes - both update automatically, nothing to configure.',
    href: '/',
    linkLabel: 'Open Dashboard',
  },
  {
    id: 'add-nuvio-account',
    title: 'Adding a Nuvio account',
    category: 'Getting started',
    keywords: ['nuvio account', 'add nuvio', 'nuvio login', 'nuvio oauth'],
    answer: 'Users → New User → pick Nuvio as the provider - email/password or OAuth device-code (QR) login both work. Everything else (sync, metrics, expiry tracking, backups) treats it exactly the same as a Stremio account.',
    steps: [
      'Go to Users → New User.',
      'Choose Nuvio as the provider.',
      'Either sign in with email/password, or use the OAuth device-code flow and approve it on another device by scanning the QR.',
      'Once connected, every profile on that Nuvio account syncs - not just the primary one - each with its own label.',
    ],
    details: [
      'Nuvio is a first-class provider here, not a bolted-on extra: provider badges appear everywhere an account shows up, and refresh tokens are encrypted at rest with access tokens auto-refreshing.',
      'The same email can hold both a Stremio and a Nuvio account. SlickSync auto-disambiguates by username, then email, then recent history, and leaves it unresolved rather than guessing when it genuinely cannot tell.',
      'If one person has both, Account Merge can fold them into a single identity - with a preview first and a full undo afterward.',
    ],
    tips: [
      'Nuvio Collections (the home-screen folders in the Nuvio app) are managed separately from Catalogs - see the Nuvio Collections guide.',
    ],
    related: ['account-merge-mismatch', 'nuvio-collections-manager', 'sync-mode-basics'],
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'nuvio-self-hosted-backend',
    title: 'Pointing Nuvio at your own self-hosted backend',
    category: 'Getting started',
    keywords: ['self host nuvio', 'nuvio server', 'custom nuvio backend', 'nuvio self-hosted', 'backend url', 'anon key', 'own server'],
    answer: 'Settings → External API Keys → Nuvio backend URL. Enter the Backend URL from your self-hosted deployment and hit Detect - it reads that server\'s own /.well-known/nuvio to fill in the key. Leave blank to use the official api.nuvio.tv.',
    steps: [
      'Deploy Nuvio\'s self-host stack (github.com/NuvioMedia/self-host) and note its Backend URL, e.g. https://backend.example.com.',
      'In SlickSync go to Settings → External API Keys → Nuvio backend URL.',
      'Paste the Backend URL and click Detect. SlickSync reads /.well-known/nuvio from that server and fills in the anon key.',
      'If Detect can\'t read it, run ./nuvio credentials on your deployment and paste the anon key into the field below the URL by hand.',
    ],
    details: [
      'This is per-account, not instance-wide. It resolves the account\'s own setting first and only falls back to the NUVIO_SUPABASE_URL / NUVIO_SUPABASE_ANON_KEY environment variables - matching how every other integration here (TMDb, OMDb, MDBList, RPDB, SIMKL, AI Services) already works. Nuvio\'s backend used to be the one that could only be set via env vars, needing a container restart to change.',
      'Everything routes through it once set: login, token refresh, addon sync, library and watch-progress pulls, and Nuvio Collections.',
      'The anon key is a publishable client key by design - it ships inside the Nuvio apps themselves - not a service-role secret. Do not paste your SERVICE_ROLE_KEY here.',
      'SlickSync needs no Nuvio app rebuild to use your backend. It talks to the backend directly over HTTPS, so this setting works on its own. Pointing the actual Nuvio apps at your backend is a separate job - see "Is self-hosting a Nuvio backend worth it?".',
    ],
    tips: [
      'Both fields are required for the override to apply. A URL on its own is deliberately ignored rather than half-applied, since authenticating against a different backend with the wrong key fails in confusing ways.',
      'Clearing both fields returns that account to the official api.nuvio.tv immediately - no restart needed.',
      'Detect refuses a server whose discovery document does not identify itself as Nuvio, so a typo pointing at some unrelated host fails loudly instead of saving a key that breaks every later sync.',
    ],
    related: ['add-nuvio-account', 'nuvio-self-hosted-worth-it', 'nuvio-collections-manager', 'private-vs-public-mode'],
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'nuvio-self-hosted-worth-it',
    title: 'Is self-hosting a Nuvio backend worth it?',
    category: 'Getting started',
    keywords: ['why self host nuvio', 'nuvio backend advantages', 'self hosted nuvio worth it', 'nuvio own server benefits', 'nuvio rebuild client', 'nuvio local.properties', 'nuvio.env.js'],
    answer: 'It buys you ownership, not extra features - the same Nuvio app against your own database. Worth it if you want your data on your own hardware or you are tired of depending on api.nuvio.tv being up. The catch is the Nuvio apps: only the Web/Tizen/webOS builds can be repointed without recompiling.',
    details: [
      'What you gain: your library, watch progress, collections and profiles live in your own Postgres, with Supabase Studio access to it. You are unaffected when the official backend has a bad day. And you control auth - DISABLE_SIGNUP, MFA, rate limits and password policy are all yours.',
      'What you do not gain: any feature the official backend does not already have. It is the same client app pointed somewhere else.',
      'SlickSync is the easy part. It speaks to the backend directly over HTTPS, so pointing an account at your own server takes nothing but the Backend URL and key - no app builds involved.',
      'The Nuvio apps are the hard part, and it differs by platform. Web, Tizen and webOS read their backend from nuvio.env.js, a plain script the app loads at startup - so a built deployment can be repointed by editing that one file. Android TV, Mobile and Desktop bake the values in from local.properties at build time, so those genuinely need a rebuild and reinstall from source.',
      'Store-installed Nuvio apps stay pointed at api.nuvio.tv regardless of what you run.',
    ],
    tips: [
      'Deploy with ./nuvio setup --domain your.domain --proxy external if you already run Traefik, Caddy or nginx. The stack then binds to localhost only and joins your proxy network instead of grabbing ports 80 and 443.',
      'It is a full Supabase stack - roughly a dozen containers including Postgres. Budget a couple of GB of RAM and do not put it on a box that is already close to its limit alongside something you care about.',
      'Run ./nuvio credentials to print the Backend URL and publishable key, and ./nuvio doctor to check the deployment before wiring anything to it.',
    ],
    related: ['nuvio-self-hosted-backend', 'add-nuvio-account'],
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'aiostreams-proxy-setup',
    title: 'Connecting the AIOStreams proxy (live Now Playing)',
    category: 'Getting started',
    keywords: ['aiostreams', 'proxy', 'proxy setup', 'live now playing', 'presence', 'who is watching', 'aiostreams_url', 'connect proxy', 'is the proxy required'],
    answer: 'Now Playing gets its live "who is watching right now" signal from an AIOStreams proxy. Set AIOSTREAMS_URL (plus the auth pair if your instance needs one) in your .env and restart. Without it, History and Watch Time still work - only the live panel stays empty.',
    steps: [
      'On your AIOStreams instance, note its base URL, e.g. https://aiostreams.example.com.',
      'In SlickSync\'s .env, set AIOSTREAMS_URL to that address.',
      'If your AIOStreams has AIOSTREAMS_AUTH set, mirror the same values into AIOSTREAMS_AUTH_USERNAME and AIOSTREAMS_AUTH_PASSWORD - they have to match or every poll is rejected.',
      'Restart SlickSync, then open Metrics -> Health. The Proxy card tells you whether the connection actually works.',
      'Play something routed through AIOStreams. It should appear in Now Playing within about 30 seconds.',
    ],
    details: [
      'This is optional. History, Watch Time, streaks, Metrics and Year in Review all come from each provider\'s own library state and work with no proxy at all. The proxy adds live presence, which nothing else can provide.',
      'The two signals are deliberately separate and answer different questions. The proxy says "someone is streaming this right now" and disappears the moment playback stops; the provider library says "this was watched" and is the permanent record. That is why a usenet stream shows up in History but never in Now Playing - it never passed through the proxy.',
      'Attribution matches the AIOStreams username against your users, first by username and then by the local part of their email. If two users share an email address, SlickSync will not guess between them - set AIOSTREAMS_FALLBACK_USER_IDS to a comma-separated list of user IDs to break the tie in that order.',
      'AIOSTREAMS_IGNORE_IPS excludes specific addresses, useful when something automated hits the proxy and you do not want it counted as a watch.',
    ],
    tips: [
      'If Now Playing is empty while something is genuinely streaming, check the Proxy card on the Health page first - a wrong URL or mismatched auth is by far the most common cause.',
      'AIOStreams has moved its stats endpoint between versions before, which killed Now Playing detection while everything else looked healthy. If you just updated AIOStreams and live presence stopped, start there.',
    ],
    related: ['now-playing-continue-watching', 'system-health-overview'],
    href: '/metrics?tab=health',
    linkLabel: 'Open Health',
  },
  {
    id: 'airing-calendar',
    title: 'The Airing Calendar and Coming Up',
    category: 'Watching & Discover',
    keywords: ['airing calendar', 'coming up', 'upcoming episodes', 'new episodes', 'schedule', 'next episode'],
    answer: 'A date-grouped agenda of upcoming episodes for every show anyone in the household is actively watching. It builds itself from real watch history - there is no list to curate - and surfaces on the Dashboard as a "Coming Up" panel.',
    steps: [
      'Watch at least one episode of a series through any connected account.',
      'That show starts appearing in the Airing Calendar automatically, grouped by air date.',
      'The Dashboard\'s Coming Up panel shows the nearest few; the calendar itself has the full run.',
      'To stop following a show, mute it from the calendar - per-show muting keeps one finished series from cluttering everyone\'s view.',
    ],
    details: [
      'Membership comes from actual watch history, not a watchlist. If nobody has watched a series, it will not appear even if it is on a Watchlist.',
      'It is household-wide rather than per-user, so a show one person follows is visible to everyone on the instance.',
      'Episode data comes from the same metadata sources as the rest of Discover, so a show with no published schedule upstream simply has no future dates to show.',
    ],
    tips: [
      'Muting is per show and reversible - it hides upcoming episodes without touching watch history or affecting anyone\'s stats.',
    ],
    related: ['now-playing-continue-watching', 'rewatch-completion'],
    href: '/',
    linkLabel: 'Open Dashboard',
  },
  {
    id: 'metrics-overview',
    title: 'What each Metrics tab shows',
    category: 'Health & maintenance',
    keywords: ['metrics', 'stats', 'leaderboard', 'analytics', 'reports', 'tabs', 'users content admin health'],
    answer: 'Metrics has four tabs. Users covers per-person watching and lifecycle, Content covers what is being watched, Admin covers the instance itself, and Health is the live "is anything broken right now" page.',
    steps: [
      'Open Metrics and pick a tab across the top.',
      'Use the range selector (top right, 30 days by default) to widen or narrow every figure on the page.',
      'Check Health first when something seems wrong - it is the only tab reporting live status rather than history.',
    ],
    details: [
      'Users - watch time per person, leaderboards, streaks, taste profiles, and lifecycle buckets (new / active / at-risk / churned), so a household member who has gone quiet is easy to spot.',
      'Content - most-watched titles, an hourly activity heatmap, binge detection, completion versus drop-off, and Year in Review.',
      'Admin - instance-level figures including the database storage card, which breaks the actual file size down per table.',
      'Health - sync drift per user, addon reachability with uptime percentages, Vault credential expiry, and AIOStreams proxy connectivity, plus a unified incident timeline and an update-available check.',
      'Everything is computed from data already stored. There is nothing to enable and no separate collection step.',
    ],
    tips: [
      'The date range applies to the whole tab, so a leaderboard that looks wrong is often just a narrower window than you expected.',
      'Individual Health checks can be muted if one is permanently noisy for your setup.',
    ],
    related: ['system-health-overview', 'year-in-review-taste'],
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'catalog-federation',
    title: "Sharing a catalog with another household",
    category: 'Sharing & integrations',
    keywords: ['federation', 'share catalog', 'share link', 'another instance', 'subscribe to catalog', 'other household', 'publish catalog'],
    answer: "Publish a catalog and you get a link. Another household pastes it into their own SlickSync and gets your list of titles - which plays through THEIR addons and debrid, not yours. Nobody shares an account, and no credentials travel.",
    steps: [
      "Open the catalog, click the ... menu, and choose Publish to other instances.",
      "Copy the link it shows you and send it to the other household.",
      "They go to Catalogs, click Import, and paste the link - no API key needed, the link itself is the access.",
      "On their side it lands as a normal catalog. If they turn on Auto-refresh it will keep following yours as you change it.",
    ],
    details: [
      "This is separate from the Share option directly above it in the same menu. Share means other accounts on THIS instance; Publish means a different household entirely. They are deliberately two different opt-ins, so sharing internally never exposes anything to the internet.",
      "What travels: the title, year and poster of each item. What does not: your credentials, your addons, your users, your watch history. That is the whole point - they get your curation and resolve it with their own setup.",
      "Issue a new link replaces the current one and the old URL stops working immediately. Use it if a link ends up somewhere it should not.",
      "Unpublish stops any further pulls. It does NOT reach into their instance and delete what they already have - anyone subscribed keeps the titles from their last refresh.",
    ],
    tips: [
      "The link is built from the address you are viewing SlickSync on. If your instance answers on a different hostname from the outside, correct that part before sending it.",
      "Treat the link like a password for that one catalog: anyone holding it can read the titles, and it is the only thing standing between them and the list.",
    ],
    related: ['catalog-create', 'automation-create'],
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'watch-history-days',
    title: "Why a title shows up on more than one day",
    category: 'Watching & Discover',
    keywords: ['watch history', 'rewatch', 'same movie twice', 'watched again', 'activity days', 'per day'],
    answer: "Activity shows a title once for each day you actually watched it, each with that day's own watch time. Rewatching something adds a card on the new day rather than moving the old one.",
    details: [
      "This used to work differently: a rewatch moved the single card forward to the newest day, so the earlier viewing vanished from the list even though the time was still counted in Metrics.",
      "For films the earlier days were recovered, so history you already had should now show properly.",
      "For series it only builds up from the point this arrived. Older series records only named the show, not which episode, and inventing an episode for a past day would put a confidently wrong label on a card - so those days are left out rather than guessed at.",
      "A card showing a date with no clock time is one of these recovered days. The day was recorded, the time of day was not, and showing a made-up time would read as though you watched at midnight.",
    ],
    tips: [
      "Metrics totals were always correct - this only changed what the Activity list shows you.",
      "Activity is cached for about five minutes, so a watch you just finished may take a moment to appear.",
    ],
    related: ['rewatch-completion', 'account-timezone'],
    href: '/activity',
    linkLabel: 'Open Activity',
  },
  {
    id: 'simkl-link',
    title: 'Linking SIMKL',
    category: 'Watching & Discover',
    keywords: ['simkl', 'link simkl', 'simkl pin', 'simkl sync'],
    answer: 'On a user\'s own page, Link SIMKL and enter the PIN code it gives you. Once linked, watch history syncs both ways on a 30-minute schedule, and that user becomes available as a target for Catalogs\' SIMKL import/export (Plan to Watch).',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'catalog-simkl-plan-to-watch',
    title: 'Importing/exporting a catalog via SIMKL',
    category: 'Catalogs & Collections',
    keywords: ['simkl plan to watch', 'simkl import', 'simkl export catalog'],
    answer: 'SIMKL has no API for named custom lists, so Catalogs targets its "Plan to Watch" list instead - open a catalog → More → Export to SIMKL, pick which SIMKL-linked user, and it pushes there (or pulls from it, for import).',
    href: '/catalogs',
    linkLabel: 'Open Catalogs',
  },
  {
    id: 'account-deletion-export',
    title: 'Deleting your account or exporting your data',
    category: 'Users & Groups',
    keywords: ['delete account', 'export my data', 'account deletion', 'self service delete'],
    answer: 'Self-service watch-history export and full account deletion are both available from your own user portal (/login?mode=user) under Settings - not something an admin has to do for you, and not reversible once confirmed.',
    href: '/login?mode=user',
    linkLabel: 'Open your user portal login',
  },
  {
    id: 'public-registration',
    title: 'Public self-service registration (public-mode instances only)',
    category: 'Getting started',
    keywords: ['public mode', 'self registration', 'superadmin', 'multi tenant'],
    answer: 'On a public multi-tenant deployment, new accounts can self-register instead of an admin creating them, and a Superadmin console handles search, bulk enable/disable/delete, an audit log, and abandoned-account cleanup across every tenant. Not applicable on a private, single-household instance.',
  },
  {
    id: 'vault-organize',
    title: 'Organizing the Vault (categories, drag reorder, snooze)',
    category: 'Vault & credentials',
    keywords: ['vault organize', 'vault category', 'reorder vault', 'snooze expiry', 'vault right click'],
    answer: 'Vault entries are grouped by category and drag-to-reorder within it; right-click (or long-press) an entry for a quick menu including copy-to-clipboard. If an expiry warning is a known non-issue for now, Snooze silences it for 7 days without dismissing it for good.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'vault-cost-tracking',
    title: 'Tracking Vault subscription costs',
    category: 'Vault & credentials',
    keywords: ['vault cost', 'cost per hour', 'multi currency', 'spend summary'],
    answer: 'Edit a Vault entry and fill in monthly/yearly billing plus a currency - it feeds the spend summary, cost-per-hour-watched figures, and the renewal forecast card, all computed automatically from what you enter.',
    href: '/vault',
    linkLabel: 'Open Vault',
  },
  {
    id: 'rewatch-completion',
    title: 'Rewatch and completion tracking',
    category: 'Watching & Discover',
    keywords: ['rewatch', 'completion tracking', 'finished watching', 'started and dropped'],
    answer: 'SlickTrax distinguishes a true completion (finished) from something started-and-dropped, and separately tracks rewatches - both feed into Metrics and Year in Review automatically; there\'s nothing to turn on.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'not-interested-feedback',
    title: '"Not interested" feedback on a title',
    category: 'Watching & Discover',
    keywords: ['not interested', 'hide recommendation', 'dont recommend'],
    answer: 'From a title\'s detail popup or a recommendation row, mark it "Not interested" to suppress it (and similar titles) from your own For You / Because You Watched rows going forward.',
  },
  {
    id: 'discord-poster-recap',
    title: 'Monthly Discord poster-mosaic recap',
    category: 'Notifications & Automation',
    keywords: ['discord recap', 'poster mosaic', 'monthly recap discord'],
    answer: 'If a Discord webhook is configured (Settings → Notifications), SlickSync automatically posts a poster-mosaic recap of the household\'s watched titles once a month - no separate toggle beyond having the webhook set.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'watch-notification-overrides',
    title: 'Per-user watch notification settings',
    category: 'Notifications & Automation',
    keywords: ['watch notification', 'started watching notification', 'per user discord webhook'],
    answer: 'Each user can opt out of their own "started/finished watching" notifications, and set a personal Discord webhook that overrides the account-wide one - both live on that user\'s own settings, not the admin Settings page.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'more-like-this-collection',
    title: '"More Like This" and franchise collections on the detail modal',
    category: 'Watching & Discover',
    keywords: ['more like this', 'similar titles', 'collection', 'franchise', 'box office'],
    answer: 'A title\'s detail popup includes a collapsed "More Like This" row (TMDb-powered recommendations) and, for franchise entries, a "Part of the X Collection" row - both are disclosures, tap to expand. Box office figures (via OMDb) show there too when available.',
  },
  {
    id: 'nuvio-collections-covers',
    title: 'Cover art for Nuvio Collections folders',
    category: 'Catalogs & Collections',
    keywords: ['community covers', 'gif cover', 'collection cover art', 'folder cover'],
    answer: 'In the Nuvio Collections manager, a folder\'s cover can be a custom image URL, an animated GIF, or picked from Community Covers (a searchable, community-submitted library built into the picker).',
    href: '/catalogs/nuvio-collections',
    linkLabel: 'Open Nuvio Collections',
  },
  {
    id: 'nebula-layout',
    title: 'Switching to the Nebula layout',
    category: 'Appearance',
    keywords: ['nebula', 'layout mode', 'top nav layout', 'glass panel'],
    answer: 'Themes → Layout. Nebula is an alternate top-nav, glass-panel layout you can pick independently of your color Theme - it\'s a structural choice, not another color option.',
    href: '/themes',
    linkLabel: 'Open Themes',
  },
  {
    id: 'api-docs',
    title: 'The interactive API docs',
    category: 'Sharing & integrations',
    keywords: ['api docs', 'swagger', 'developer api', 'rest api'],
    answer: 'Settings → API Key → Interactive API docs opens a Swagger UI at /api/docs, generated straight from the external developer API\'s own route handlers. It only covers the external API (/api/ext), not the internal admin routes this UI itself uses.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'addon-health-alerts',
    title: 'Getting alerted when an addon goes down',
    category: 'Addons',
    keywords: ['addon offline alert', 'addon failover', 'addon health notification'],
    answer: 'Addon reachability is checked automatically on a schedule; going offline (or coming back) fires a notification through whichever channels you have on (push/bell by default, Discord if configured) and logs an event to the Health page\'s incident timeline - no per-addon setup needed.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'system-health-overview',
    title: 'What the System Health page checks',
    category: 'Health & maintenance',
    keywords: ['system health', 'health board', 'what does health check', 'uptime percent'],
    answer: 'Metrics → Health checks four things: Sync (per-user addon drift), Addons (reachability + uptime %), Vault (credential failures/expiry), and the AIOStreams Proxy (connectivity) - plus a unified incident timeline of every offline/online and vault/proxy event, and an update-available check.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'db-storage-card',
    title: 'The database storage card',
    category: 'Health & maintenance',
    keywords: ['db storage', 'database size', 'sqlite size', 'table breakdown'],
    answer: 'Metrics → Admin has a DB storage card showing the SQLite file\'s current size and a per-table breakdown, read-only - useful for spotting what\'s actually taking up space.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'user-lifecycle-tracking',
    title: 'User lifecycle tracking (new/active/at-risk/churned)',
    category: 'Users & Groups',
    keywords: ['user lifecycle', 'at risk user', 'churned user', 'inactive user'],
    answer: 'Metrics → Users buckets every household member into new, active, at-risk, or churned based on their recent watch activity, so a household member who\'s gone quiet is easy to spot without checking each profile by hand.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'addon-performance-card',
    title: 'Addon performance, heatmap, and binge detection',
    category: 'Addons',
    keywords: ['addon performance', 'hourly heatmap', 'binge watch detection', 'top items'],
    answer: 'Metrics → Content includes an addon performance card, an hourly-activity heatmap, top-watched items, viewing streaks, and binge-watch detection - all computed automatically from existing watch history, nothing to configure.',
    href: '/metrics',
    linkLabel: 'Open Metrics',
  },
  {
    id: 'private-mode-custom-names',
    title: 'Private Mode and Custom Addon Names',
    category: 'Addons',
    keywords: ['private mode', 'hide sensitive', 'custom addon names', 'rename addon display'],
    answer: 'Settings → Privacy & Display. Private Mode masks emails, IPs, and API keys throughout the UI (handy for screen-sharing or screenshots). Custom Addon Names shows the display name you gave an addon instead of its original manifest name, everywhere it appears.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'account-timezone',
    title: 'Setting the account timezone',
    category: 'Security & account',
    keywords: ['timezone', 'time zone', 'watch time today wrong day'],
    answer: 'Settings → Privacy & Display → Timezone. Auto-detected from your browser on first visit, then stored explicitly - background jobs (like Watch Time Today and streaks) have no browser to check against later, so update this by hand if you travel or move.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'unsafe-mode',
    title: 'What Unsafe Mode does',
    category: 'Security & account',
    keywords: ['unsafe mode', 'skip confirmation', 'destructive operations'],
    answer: 'Settings → Sync Mode → Unsafe Mode lets sync/delete operations skip their normal confirmation step. Off by default and not recommended - it removes a safety net, not a feature you need for normal use.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'auto-themed-catalogs',
    title: 'Auto-generated catalogs',
    category: 'Catalogs & Collections',
    keywords: ['auto generated catalog', 'auto themed catalog', 'taste cluster catalog'],
    answer: 'Settings → SlickTrax → Auto-generated catalogs (off by default). Detects a real taste cluster in your watch history (e.g. "90s Action") and saves it as an actual Catalog instead of just a recommendation row - checked daily; delete the generated catalog to stop it coming back.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'account-id-danger-zone',
    title: 'Your Account ID, and deleting the whole account',
    category: 'Security & account',
    keywords: ['account id', 'uuid login', 'danger zone', 'delete my account admin'],
    answer: 'Settings → Account ID (public-mode instances) shows your login UUID - copy and save it, since there\'s no password-reset flow if it\'s lost. Settings → Danger Zone is where the account itself (not a single user) can be permanently deleted - irreversible.',
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'protected-addons',
    title: 'Protecting an addon from bulk changes',
    category: 'Addons',
    keywords: ['protected addon', 'protect addon', 'lock addon'],
    answer: 'Drag an addon card onto the "Protected" filter tab on the Addons page (or use its own toggle) to mark it protected - protected addons are skipped by bulk remove/sync-reset operations, so a core addon can\'t be wiped out by an accidental bulk action.',
    href: '/addons',
    linkLabel: 'Open Addons',
  },
  {
    id: 'import-export-addons',
    title: 'Importing or exporting your addon list',
    category: 'Addons',
    keywords: ['import addons', 'export addons', 'addon list backup'],
    answer: 'Addons → Import Addons accepts a Stremio/Nuvio-style addon collection JSON. Export Addons produces the same format back out, so your addon set is portable between instances or usable as a manual backup.',
    href: '/addons',
    linkLabel: 'Open Addons',
  },
  {
    id: 'bulk-sync-delete-users-groups',
    title: 'Bulk syncing or deleting all Users/Groups',
    category: 'Users & Groups',
    keywords: ['sync all users', 'delete all users', 'sync all groups', 'delete all groups', 'bulk sync'],
    answer: 'Users → Sync All Users (or Groups → Sync All Groups) pushes every user/group\'s addon list in one action. "Delete All" in either sidebar is a real bulk-delete - it\'s destructive and asks for confirmation first.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'library-history-export-clear',
    title: 'Exporting or clearing a user\'s Library/History',
    category: 'Users & Groups',
    keywords: ['clear library', 'clear history', 'export library', 'export history all users'],
    answer: 'A user\'s detail page has Library (Export or Clear Library) and History (Export, Import, or Clear History) sections. Export downloads a copy first; Clear is a real, confirmation-gated deletion of that data from SlickSync, not from Stremio/Nuvio itself.',
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'config-import-export-reset',
    title: 'Importing, exporting, or resetting your Configuration',
    category: 'Health & maintenance',
    keywords: ['export config', 'import config', 'reset config', 'configuration backup'],
    answer: 'Tasks → Configuration. Export Config downloads a full settings snapshot; Import Config restores from one. Reset Config wipes account settings back to defaults - confirmation-gated since it\'s not reversible.',
    href: '/tasks',
    linkLabel: 'Open Tasks',
  },

  // --- Troubleshooting -----------------------------------------------------
  // These encode real, diagnosed causes rather than generic advice. Several
  // of them exist because the symptom looks like a SlickSync bug but is
  // actually something upstream (another Stremio client overwriting the
  // account, Stremio's own cloud sync failing) - the answer people need is
  // "here's how to tell which", not "try restarting".
  {
    id: 'history-not-updating',
    title: 'Watch history is missing or not updating',
    category: 'Troubleshooting',
    keywords: ['history missing', 'history not updating', 'no watch history', 'nothing in history', 'watch history empty', 'not tracking'],
    answer: 'Usually this is Stremio\'s own cloud sync failing upstream, not SlickSync. Check the account\'s library directly first - if History is empty there too, SlickSync has nothing to read and the fix is on the Stremio side.',
    steps: [
      'Open the provider account\'s own library/History in the Stremio or Nuvio app itself.',
      'If History is empty there too: the provider\'s cloud sync is the problem, not SlickSync. Logging that account out and back in on the affected device usually rebuilds it.',
      'If History IS populated there but not here: check Metrics → Health for a sync drift warning, then run a manual sync on that user.',
      'If only live "Now Playing" is missing while History fills in normally, that is a different thing - see the Now Playing guide.',
    ],
    details: [
      'SlickSync reads each provider\'s own library state on a 1-minute poll. It is a reader, not the source of truth - it cannot invent history the provider never recorded.',
      'This has been confirmed live more than once: a completely empty History in SlickSync traced back to the upstream Stremio account genuinely having no history to sync.',
    ],
    tips: [
      'A watch that happened on an account not added to SlickSync will never appear. The account-mismatch notification exists to flag exactly that case.',
    ],
    related: ['now-playing-empty', 'sync-mode-basics', 'account-merge-mismatch'],
    href: '/metrics',
    linkLabel: 'Open Health',
  },
  {
    id: 'addons-reverted',
    title: 'Addons keep reverting or going back to Unsynced',
    category: 'Troubleshooting',
    keywords: ['addons reverted', 'unsynced', 'sync reverts', 'addons changed back', 'sync not sticking', 'keeps unsyncing'],
    answer: 'If a user syncs fine and then flips back to Unsynced hours later, something else is writing to that provider account - almost always another Stremio client still logged in. SlickSync is being overwritten, not failing. Account Guard now catches this for you: when an account changes and SlickSync did not do it, a warning appears on the Users page (and in the bell) naming what changed.',
    steps: [
      'Confirm the sync itself succeeded at the time (the user went green, then later went back to Unsynced on its own).',
      'Log out every other Stremio/Nuvio session on that account - the web app, other devices, an old TV, another management tool.',
      'Re-sync from SlickSync.',
      'If it stays synced afterward, the other session was the writer.',
    ],
    details: [
      'Stremio accounts are last-write-wins. Any client that pushes its own addon list overwrites whatever was there, including what SlickSync just set - and it will look exactly like SlickSync "failed" hours after the fact.',
      'This is the single most common cause of "sync does not stick" and it is not a SlickSync bug - it is two writers fighting over one account.',
    ],
    tips: [
      'Reordering addons at the group level does push down to that group\'s users - a pure reorder used to be skipped as a no-op, which is fixed.',
      'Protected addons are excluded from being removed by a sync, which is useful if one specific addon keeps disappearing.',
    ],
    related: ['account-guard', 'sync-mode-basics', 'protected-addons', 'nuvio-collections-vanished'],
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'account-guard',
    title: 'Account Guard - alerts when something else changes an account',
    category: 'Users & Groups',
    keywords: ['account guard', 'changed outside', 'external change', 'another session', 'overwritten', 'addons changed by themselves', 'foreign write', 're-assert', 'accept change'],
    answer: 'Account Guard watches the addon set of every connected user and raises a warning when it changes and SlickSync was not the one changing it - almost always another logged-in Stremio or Nuvio session. The warning appears as a banner on the Users page and a bell/push notification, naming what was added or removed. Two buttons resolve it: Re-assert puts the SlickSync setup back, Accept keeps the outside change as the new normal.',
    steps: [
      'Nothing to set up - it is always on and checks every account hourly.',
      'When a banner appears on the Users page, read what changed.',
      'Press Re-assert to sync the SlickSync setup back onto the account, or Accept change to adopt what is there now.',
    ],
    details: [
      'Detection is fingerprint-based: every SlickSync sync records what it wrote, and the hourly sweep compares the live addon set on the account against that record. A difference means an outside writer - the exact failure that used to look like "sync not sticking".',
      'Each distinct outside change alerts once, not every hour. If the account drifts again to yet another state, that is a new alert.',
      'The guard only ever watches - it never writes to the account on its own. Re-assert is a normal sync you trigger.',
      'If you meant to make the change yourself in the Stremio app, press Accept - the guard adopts it as the new baseline and stays quiet. Note the user may still show Unsynced, since the account now differs from the addon set of the group.',
      'If alerts keep coming back for the same user, another device is still logged into that account and actively writing - log out the other sessions there.',
    ],
    related: ['addons-reverted', 'sync-mode-basics', 'nuvio-collections-vanished'],
    href: '/users',
    linkLabel: 'Open Users',
  },
  {
    id: 'now-playing-empty',
    title: 'Now Playing is empty while something is actually streaming',
    category: 'Troubleshooting',
    keywords: ['now playing empty', 'not showing whats playing', 'live playback missing', 'proxy not working', 'nobody watching'],
    answer: 'Now Playing comes from the AIOStreams proxy, which only sees streams routed through it. Check Metrics → Health for the proxy status first - if it is unreachable, live presence is dead even though History keeps working normally.',
    steps: [
      'Open Metrics → Health and look at the Proxy section.',
      'If it shows an error, the proxy connection is the problem - check that AIOSTREAMS_URL and the auth credentials are still correct.',
      'If the proxy is healthy but a specific stream never appears, check whether that stream is actually routed through the proxy at all.',
      'Remember usenet-sourced playback bypasses the proxy entirely - it shows up in History afterward, but never in live Now Playing.',
    ],
    details: [
      'SlickSync runs two independent pipelines on purpose. The proxy gives real-time presence (and disappears the instant playback stops); native library polling gives the permanent record including sources the proxy cannot see.',
      'That means an empty Now Playing with a healthy History is a proxy-side issue, and a populated Now Playing with missing History is a provider-side one. The two failures look similar but have completely different causes.',
      'A known real case: AIOStreams moved its stats endpoint between versions, which silently killed Now Playing detection while everything else looked fine. If you run an unusual AIOStreams build and Now Playing is dead, that is worth checking.',
    ],
    tips: [
      'The proxy connectivity notification will tell you when this breaks, rather than you noticing days later - it is worth turning on.',
    ],
    related: ['history-not-updating', 'now-playing-continue-watching', 'system-health-overview'],
    href: '/metrics',
    linkLabel: 'Open Health',
  },
  {
    id: 'nuvio-collections-vanished',
    title: 'Nuvio Collections vanished or reverted after saving',
    category: 'Troubleshooting',
    keywords: ['collections vanished', 'collections reverted', 'nuvio folders gone', 'collections disappeared', 'collections not saving'],
    answer: 'Same root cause as addons reverting: another Nuvio client wrote to the account after SlickSync did, and last-write-wins means it overwrote your collections. SlickSync\'s own writes have been verified correct against the live account.',
    steps: [
      'Check whether the Nuvio app is open and logged in on another device.',
      'Close/log out those sessions, re-apply the collection layout from SlickSync, then re-open the Nuvio app.',
      'If a folder saves fine but never renders on-device, check whether it actually has sources attached - an empty folder syncs successfully and then silently shows nothing.',
    ],
    details: [
      'SlickSync\'s Nuvio Collections integration has been confirmed live to write exactly what you configure. When collections revert, the write succeeded and was then replaced.',
      'A folder built from a TMDb template inside the Nuvio app itself needs a TMDb key in the Nuvio app\'s own settings to render - that is separate from SlickSync\'s TMDb key.',
    ],
    tips: [
      'SlickSync flags folders with zero sources attached specifically because that case looks like a sync bug and is not one.',
    ],
    related: ['nuvio-collections-manager', 'addons-reverted', 'nuvio-collections-covers'],
    href: '/catalogs/nuvio-collections',
    linkLabel: 'Open Nuvio Collections',
  },
  {
    id: 'watch-time-wrong',
    title: 'Watch time or Watch Time Today looks wrong',
    category: 'Troubleshooting',
    keywords: ['watch time wrong', 'inflated hours', 'watch time today wrong', 'too many hours', 'duration wrong', 'stats wrong'],
    answer: 'Almost always a timezone or day-bucketing question. Check Settings → Timezone first: background jobs have no browser to ask, so if it is set wrong, "today" is being calculated against the wrong day boundary.',
    steps: [
      'Open Settings and confirm the Timezone matches where you actually are.',
      'If a single title shows an absurd duration, note whether it was resumed days after you last watched it.',
      'Check whether the same person has two accounts (a Stremio one and a Nuvio one) that have not been merged - unmerged, they count separately.',
    ],
    details: [
      'Timezone is auto-detected from your browser on first visit then stored explicitly, precisely because scheduled jobs cannot re-check it later. Travelling or moving without updating it will skew daily figures.',
      'Resuming something days later used to re-stamp the entire accumulated watch time as freshly watched today; now only genuinely new progress counts toward today and the rest stays on the day it actually happened.',
      'Proxy connection lifetime is deliberately not treated as watch time - a long-open connection is not the same as a long watch, and conflating them once produced wildly inflated totals.',
    ],
    tips: [
      'Same-email Stremio/Nuvio pairs are deduped in leaderboards and totals, so one person never counts as two - but only once they are actually recognised as the same person.',
    ],
    related: ['account-timezone', 'account-merge-mismatch', 'rewatch-completion'],
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'addon-shows-offline',
    title: 'An addon shows offline but works fine for me',
    category: 'Troubleshooting',
    keywords: ['addon offline', 'addon down', 'false offline', 'addon unreachable', 'health check failing'],
    answer: 'The health check runs from your server, not your browser - so an addon that works on your phone can genuinely be unreachable from the server (IP blocks, geo-restrictions, Cloudflare). If the failure is expected, Ignore it rather than deleting the addon.',
    steps: [
      'Open Metrics → Health and find the addon in question.',
      'If it is genuinely fine and the failure is expected (an indexer that blocks datacentre IPs, for example), use Ignore on that entry.',
      'Ignoring drops it out of Attention and stops its notifications, and is reversible from the same card at any time.',
    ],
    details: [
      'Uptime percentages over 7 and 30 days are reconstructed from the same health-check history that drives the online/offline alerts, so an ignored addon still records history - it just stops nagging.',
      'HTTP 522/502/500 responses from an addon are recorded as real downtime, because from the server\'s perspective that is exactly what they are.',
    ],
    tips: [
      'Ignore is the right tool for "known and accepted", not for "I do not want to think about this" - an ignored addon that genuinely breaks later will not alert you.',
    ],
    related: ['addon-health-alerts', 'health-ignore', 'system-health-overview'],
    href: '/metrics',
    linkLabel: 'Open Health',
  },
  {
    id: 'updating-slicksync',
    title: 'Updating SlickSync to a new version',
    category: 'Health & maintenance',
    keywords: ['update', 'upgrade', 'new version', 'docker pull', 'how to update'],
    answer: 'docker compose pull && docker compose up -d against whichever compose file you use. Your /app/data volume (database, encryption key, Vault backups, avatars) survives updates - no git pull or rebuild needed on the default config.',
    steps: [
      'Run: docker compose -f docker-compose.private.yml pull (or the public one).',
      'Run: docker compose -f docker-compose.private.yml up -d.',
      'Check Metrics → Health → Version to confirm what is actually running now.',
    ],
    details: [
      'The default compose files pull a pre-built image rather than building from source, so updating does not need the repo checked out at all.',
      'Schema changes that are purely additive apply automatically on boot. Anything destructive is deliberately never auto-applied - it gets logged loudly instead, and the app still boots.',
      'The :private and :public tags are the stable release channels. :beta exists for testing unreleased work and is not recommended unless you specifically want that.',
    ],
    tips: [
      'Metrics → Health also tells you when a newer stable release exists, so you do not have to watch GitHub for it.',
    ],
    related: ['system-health-overview', 'backup-restore', 'decryption-errors'],
    href: '/metrics',
    linkLabel: 'Open Health',
  },
  {
    id: 'decryption-errors',
    title: 'Decryption errors, or "credentials may be invalid" after an update',
    category: 'Troubleshooting',
    keywords: ['decryption error', 'unable to authenticate data', 'credentials invalid', 'encryption key', 'unsupported state'],
    answer: 'This means the running code is deriving a different encryption key than the one your data was encrypted with - usually a lost or changed key file. Read paths fall back to previous keys automatically, which is why some things still work while others fail.',
    steps: [
      'Check that data/server_secret.key was not lost or replaced.',
      'Look at the boot logs for "[keyManager] ENCRYPTION_KEY differs from the previously persisted key" - that confirms this diagnosis.',
      'To consolidate everything back onto one key, run the bundled consolidate-encryption-keys.js script in dry-run first, then with --apply --sync-keyfile.',
    ],
    details: [
      'A telltale symptom is a user whose library and history still update fine while sync claims the credentials are invalid - that is data split across key generations, not an actually-bad credential.',
      'Every read path falls back to the previous key so nothing is lost, but that leaves some secrets still encrypted under the old key until they are re-encrypted.',
    ],
    tips: [
      'If you set ENCRYPTION_KEY in .env, keep it stable. Removing it later makes the app generate a new one and silently split your data again.',
    ],
    related: ['updating-slicksync', 'backup-restore', 'vault-add-credential'],
  },
  {
    id: 'private-vs-public-mode',
    title: 'Private vs. public mode - which am I running?',
    category: 'Getting started',
    keywords: ['private mode', 'public mode', 'multi tenant', 'self host mode', 'difference between modes', 'registration'],
    answer: 'Private mode is one household on one instance with SQLite and no signup. Public mode is multi-tenant with PostgreSQL, self-registration, and isolated accounts. They are chosen at deploy time by which compose file you run.',
    details: [
      'Private: SQLite embedded, one shared instance, no registration, image tag :private. This is the default and what most self-hosters want.',
      'Public: PostgreSQL required, self-registered accounts fully isolated from each other, a Superadmin console for the operator, image tag :public.',
      'In public mode your login ID is a randomly generated UUID shown once at registration - there is no email-based recovery, so it has to be saved.',
      'Note the unrelated "Private Mode" toggle in Settings → Privacy & Display: that just masks emails/IPs/API keys in the UI for screen-sharing, and has nothing to do with which deployment mode you are on.',
    ],
    tips: [
      'Switching modes after the fact is not a toggle - it is a different database engine and a different image.',
    ],
    related: ['public-registration', 'private-mode-custom-names', 'account-id-danger-zone'],
  },
  {
    id: 'install-on-phone',
    title: 'Installing SlickSync on your phone',
    category: 'Getting started',
    keywords: ['install on phone', 'pwa', 'home screen', 'mobile app', 'add to home screen', 'ios android'],
    answer: 'SlickSync is a PWA - use your browser\'s "Add to Home Screen" (iOS Safari) or "Install app" (Android Chrome). Installing is also what unlocks native push notifications, especially on iPhone.',
    steps: [
      'Open your instance in the phone\'s browser.',
      'iOS: Safari → Share → Add to Home Screen. Android: Chrome → menu → Install app.',
      'Open SlickSync from the new home-screen icon, not the browser tab.',
      'Go to Settings → Notifications → Enable phone notifications and accept the prompt.',
    ],
    details: [
      'On iOS, push notifications genuinely do not work from a normal Safari tab - the Home Screen install is required. That is an Apple restriction that applies to every web app, not something specific to SlickSync.',
      'Each installed device is managed separately under Settings → Notifications, so you can rename or revoke one without touching the others.',
    ],
    related: ['notifications-setup', 'tv-mode'],
    href: '/settings',
    linkLabel: 'Open Settings',
  },
  {
    id: 'what-is-slicksync',
    title: 'What SlickSync is, and how it differs from Syncio',
    category: 'Getting started',
    keywords: ['what is slicksync', 'syncio', 'fork', 'difference from syncio', 'why slicksync'],
    answer: 'SlickSync manages a household\'s Stremio and Nuvio accounts from one dashboard - addons, credentials, watch history, and live playback. It began as a fork of Syncio and has since added Nuvio as a full second provider, plus a lot more.',
    details: [
      'The largest additions over upstream: Nuvio as a first-class provider (not bolted on), an encrypted credential Vault with real health checks and cost tracking, dual-pipeline watch tracking with live Now Playing, Catalogs and a full Nuvio Collections manager, SlickTrax as a built-in Trakt alternative, automation with webhooks, theming, and a public/multi-tenant mode.',
      'The Changelog page has the complete version-by-version history if you want the detail.',
    ],
    related: ['onboarding-wizard', 'private-vs-public-mode'],
    href: '/changelog',
    linkLabel: 'Open Changelog',
  },
  {
    id: 'addon-configure-in-place',
    title: 'Editing an addon\'s configuration in place',
    category: 'Addons',
    keywords: ['configure addon', 'addon settings', 'edit addon config', 'change debrid key', 'addon options', 'reconfigure', 'torrentio settings'],
    answer: 'Open the addon\'s page → Configure (next to the Manifest URL). Most addons store their entire configuration inside the install URL; SlickSync decodes it into editable fields, and saving rebuilds the URL and updates every user and group carrying the addon - no remove-and-re-import.',
    steps: [
      'Go to Addons and open the addon.',
      'Click Configure, next to the Manifest URL field.',
      'Edit the fields (keys and tokens are masked - use the eye icon to reveal).',
      'Save & redeploy. The manifest is re-fetched and everyone carrying the addon gets the new configuration on their next sync.',
    ],
    details: [
      'There is no configuration API in the addon protocol - settings travel as one path segment in the install URL, in a few common formats (key=value pairs, JSON, or base64 JSON). SlickSync can decode and rebuild all of those.',
      'Addons using an encrypted or custom format (AIOStreams, for example) can\'t be decoded into fields. For those, Configure links to the addon\'s own hosted configuration page - usually pre-filled with the current settings - and the new URL it produces can be pasted straight into the Manifest URL field.',
    ],
    tips: [
      'Saving here is exactly equivalent to pasting a new install URL - the same validation and manifest re-fetch runs either way.',
    ],
    related: ['protected-addons', 'addon-health-settings'],
  },
  {
    id: 'addon-health-settings',
    title: 'Custom health checks and offline automation for an addon',
    category: 'Addons',
    keywords: ['health check', 'addon offline', 'failover', 'probe url', 'failure threshold', 'check interval', 'automate addon', 'backup addon'],
    answer: 'Open the addon → the Backup Addon card → Health check settings. Set a custom probe URL, how many consecutive failures count as offline, and how often this addon is checked. The Automate button creates an automation rule pre-scoped to this addon going offline.',
    steps: [
      'Open the addon and scroll to the Backup Addon card.',
      'Click Edit next to Health check settings.',
      'Optionally set a custom probe URL - an endpoint that only answers when the addon genuinely works, not just serves a cached manifest.',
      'Set failures-before-offline (1-10) so a single network blip can\'t trigger failover and alerts.',
      'Optionally set a per-addon check interval; leave blank for the global cadence.',
      'Or click Automate to open a pre-filled automation rule for this addon going offline - pick the action and save.',
    ],
    details: [
      'The failure threshold gates the offline TRANSITION (failover, notifications, automation triggers) - the raw result of every probe still lands in the Health History card, so blips stay visible without paging anyone.',
      'The automation side uses the engine\'s existing "addon goes offline" trigger; the Automate button just arrives with the trigger picked and a condition scoping it to this specific addon.',
    ],
    related: ['protected-addons', 'automation-create'],
  },
  {
    id: 'share-codes',
    title: 'Share codes: sending a catalog, collection layout, or template to someone',
    category: 'Sharing & integrations',
    keywords: ['share code', 'share catalog', 'export code', 'import code', 'send catalog', 'share template', 'share collections', 'copy paste code'],
    answer: 'Catalogs, Nuvio collection layouts, and addon templates can each be turned into one copy-paste code that any other SlickSync can import. No accounts, no files, no external service - the code itself carries everything.',
    steps: [
      'Catalog: open it → More → Share as code. Import by pasting the code into Catalogs → Import, in the same field that takes a URL.',
      'Nuvio collections: Collections page → Share code. Import with Paste code - it stages into your draft, so you review and press Save changes like any other edit.',
      'Addon template: Tasks → Addon Templates → Share on the template. Import with Import from Code.',
    ],
    details: [
      'Every share is two steps on purpose: the dialog first states exactly what the code will contain, and only produces it after you confirm. Nothing is shared by flipping a switch.',
      'Codes are generated entirely in your browser - producing one sends nothing anywhere. What a code contains is fixed at the moment you generate it; later changes to the catalog or template do not travel to anyone holding an older code.',
      'Each kind has its own prefix so a wrong paste fails cleanly instead of importing something unexpected: SSC1 for catalogs, SSN1 for collections, SSA1 for templates. Themes use the same idea (SST1).',
    ],
    tips: [
      'Addon template codes include each addon\'s install URL, and those URLs often embed debrid/API keys. "Strip API keys" is ON by default: it replaces each key with a placeholder, so the code carries the setup and not your credentials, and whoever imports it is prompted for their own keys before anything is created. Turn it off only if you genuinely mean to hand over working keys.',
      'An addon whose settings are encrypted by the addon\'s own server (AIOStreams and similar) cannot be safely stripped - there is no way to tell which part of an opaque blob is a secret. Those are left out of a stripped code entirely, and the dialog names which ones, rather than shipping a URL that looks stripped but is not.',
      'Short codes get a "Show QR" button - handy for carrying one to a phone or TV without typing. Longer codes (a catalog of any real size) have no QR: past roughly a thousand characters the square stops being reliably scannable off a screen, so it is not offered rather than shown broken.',
      'Catalog and collection codes carry no credentials - only titles, folders, and which catalogs a folder points at.',
    ],
    related: ['catalog-create', 'theme-build-share'],
  },
  {
    id: 'provider-key-health',
    title: 'Checking whether your TMDb / OMDb / MDBList / RPDB keys still work',
    category: 'Health & maintenance',
    keywords: ['api key not working', 'key expired', 'key revoked', 'rate limited', 'posters missing', 'ratings missing', 'check keys', 'tmdb key', 'omdb key', 'mdblist key', 'rpdb key', 'key health'],
    answer: 'Settings -> External API Keys -> Check keys now. Each configured key is tested against the provider for real, and a badge next to it shows Working, Not working, or Rate limited. The same check also runs quietly once a day.',
    steps: [
      'Settings -> scroll to External API Keys. Each key is also verified automatically the moment you save it - the badge updates on its own.',
      'Press "Check keys now". Only keys you have actually filled in are checked - blank fields are skipped and reported as "No API keys configured to check".',
      'Read the badge beside each key. Hover it to see the exact message and when it was last checked.',
    ],
    details: [
      'These keys fail silently by design: a revoked OMDb key does not throw an error, it just quietly stops returning ratings, and a rate-limited RPDB key just stops returning posters. Nothing in the app would otherwise tell you - you would notice missing artwork and have nothing to report.',
      'The daily background check notifies you the first time a working key starts failing, and again when it recovers - not on every check, so a key that has been broken for a week will not nag you daily.',
      'MDBList also reports real usage against its quota (for example 1,240/100,000), turning amber past 70% and red past 90%. The other three providers expose no usage figure at all - TMDb removed rate limiting years ago, and OMDb and RPDB publish no usage endpoint - so no number is shown for them rather than a made-up one.',
    ],
    tips: [
      'Clearing a key also clears its stored result, so a badge can never linger against an empty field.',
      'Automation can act on this too: metadata_key.failed and metadata_key.recovered are available as triggers.',
    ],
    related: ['maintenance-and-updates', 'system-health-overview'],
  },
  {
    id: 'slicktrax-addon',
    title: 'The SlickTrax Addon - your rows inside Stremio and Nuvio',
    category: 'Sharing & integrations',
    keywords: ['slicktrax addon', 'stremio addon', 'continue watching in stremio', 'watchlist in stremio', 'catalogs in stremio', 'trax addon', 'addon rows'],
    answer: 'SlickSync can serve a real Stremio addon of its own, per user: Continue Watching, the household Watchlist, and every Catalog appear as live rows inside Stremio and Nuvio on that user\'s devices. Enable it on the user\'s page under Watch-Tracking Integrations - sync installs it and keeps it installed.',
    steps: [
      'Open the user -> Watch-Tracking Integrations -> SlickTrax Addon -> Enable.',
      'Run a sync (or let the schedule do it). The addon appears in their app like any other.',
      'That\'s all - the rows update themselves, because they are computed live from SlickSync\'s own data on every request.',
    ],
    details: [
      'Continue Watching in the addon is cross-provider: Stremio and Nuvio watches merge into one row, which no external tracker can offer because none of them see both pipelines.',
      'The addon is catalog-only by design. It adds rows; it never touches streams or playback - those stay with the user\'s own addons.',
      'The URL contains a private token, so it works without a login - treat it like a password. Disabling the addon makes the next sync remove it, and re-enabling keeps the same URL so already-installed copies resume working.',
      'Auto-install needs PUBLIC_APP_URL set on the server so sync knows the address other devices can reach. Without it, the toggle still gives you the manifest URL to install by hand.',
    ],
    related: ['share-codes', 'watch-tracking-integrations'],
  },
  {
    id: 'self-updating',
    title: 'Updates that apply themselves - and undo themselves',
    category: 'Health & maintenance',
    keywords: ['auto update', 'automatic update', 'self update', 'rollback', 'update rollback', 'watchdog', 'unattended update'],
    answer: 'Tasks -> Maintenance -> Applying updates. "Back up and update now" has always been one click; the "Update automatically" toggle makes it unattended - a daily check at an hour you pick, backup first, and a watchdog that restores the previous version automatically if the new one fails its health check within two minutes.',
    details: [
      'The watchdog is a tiny detached helper that outlives the restart - the one process that can still act if the new version never comes up. It polls the container health check and, on failure, retags the previous image and recreates. No compose edits, nothing to configure.',
      'After every update (or rollback) the instance reports its own verdict as a notification: "Updated to X" or "Update rolled back - running normally on the old image."',
      'A rolled-back release is not retried every hour - the next automatic attempt waits for the following day, and the notification tells you to check the release notes first.',
      '"Roll back to the previous version" is also a button, for the case where the new version is healthy but you want the old one anyway. It works until the previous image is pruned from the host.',
      'All of this needs the Docker socket mounted into the container, the same requirement one-click updates always had - the panel explains the trade-off where that is not set up.',
    ],
    related: ['updating-slicksync', 'backup-restore'],
  },
  {
    id: 'one-code-migration',
    title: 'Moving to a new server with one code',
    category: 'Health & maintenance',
    keywords: ['migrate server', 'move instance', 'migration code', 'new vps', 'transfer everything', 'change server'],
    answer: 'Tasks -> Maintenance -> Move to a New Server. Generate a code on the OLD instance, paste it on the NEW one, and everything transfers - users, groups, addons, settings, and every Vault secret - over an encrypted handshake. The Disaster Recovery Kit is the manual version of this; the code collapses it into a minute.',
    steps: [
      'On the old server: Generate migration code. It is single-use and expires in 15 minutes.',
      'On the new (fresh) server: paste it under "This is the NEW server" and press Receive.',
      'Done. Point your devices and DNS at the new address whenever you are ready.',
    ],
    details: [
      'Receiving REPLACES the new instance\'s data - it is meant for a fresh install, and the confirmation says so before anything happens.',
      'The two servers must be able to reach each other directly - the new one fetches the bundle straight from the old.',
      'Treat the code like a password: whoever holds it holds the household, exactly as with a Disaster Recovery Kit file plus its passphrase. It stops working after one use or 15 minutes, whichever comes first.',
      'If the old server cannot be reached (dead machine), the Disaster Recovery Kit file remains the offline path - this feature does not replace it.',
    ],
    related: ['backup-restore', 'migrate-from-syncio'],
  },
  {
    id: 'migrate-from-syncio',
    title: 'Switching from Syncio (or a Syncio-family manager)',
    category: 'Getting started',
    keywords: ['syncio', 'migrate', 'switch from syncio', 'import syncio', 'aiomanager', 'competitor', 'move to slicksync'],
    answer: 'Export your config from the old manager, then import it here: Settings -> Backup & Restore -> Import. SlickSync\'s importer descends from Syncio\'s own export format, so users, groups, and addons come across directly - and common field-name variations from sibling forks are handled automatically.',
    steps: [
      'In the old manager, export your configuration (usually Settings -> Export or Backup).',
      'Here: Settings -> Backup & Restore -> Import, pick the file.',
      'Review what arrived, then run a sync. Users reconnect nothing - their provider credentials come across with the import.',
    ],
    details: [
      'Importing REPLACES this account\'s current users, groups, and addons with the file\'s contents - it is a migration, not a merge. Run it on a fresh instance, or export a backup here first.',
      'A file the importer does not recognise reports exactly what it contained (field names only, never values) - send that message along and support for that format is usually a quick addition.',
      'Managers that are not Syncio-descended keep their own storage formats; their files will produce that diagnostic rather than a broken half-import.',
    ],
    related: ['backup-restore', 'invite-household'],
  },
  {
    id: 'watch-tracking-integrations',
    title: 'Linking a user to SIMKL, or bringing a history over from Trakt',
    category: 'Sharing & integrations',
    keywords: ['simkl', 'trakt', 'import trakt', 'leave trakt', 'trakt history', 'watch tracker', 'sync history', 'link simkl', 'trakt export', 'migrate from trakt', 'trakt vip'],
    answer: 'SIMKL is an ongoing two-way sync, set up under a user -> Watch-Tracking Integrations. Trakt is a one-time migration and works from a file: download your data from Trakt itself, then import it under Watch History Import/Export on the same page.',
    steps: [
      'SIMKL: press Link SIMKL and follow the PIN flow. From then on history AND ratings sync both ways, checked every 30 minutes. Ratings already set here are never overwritten by a pull - SIMKL only fills in titles with no local rating yet.',
      'Trakt: go to trakt.tv/settings/data and download your export. It arrives as a ZIP.',
      'Unzip it. Inside are JSON files split by type - the history and ratings ones are what matter here.',
      'Back in SlickSync, open the user -> Watch History Import/Export -> Import history, and pick a JSON file. Import the history file and the ratings file separately if you want both.',
    ],
    details: [
      'Trakt export is free and works on a normal account. It needs no API key and no app registration, and it does not use up the single connected-app slot a free Trakt account gets.',
      'Movies and their ratings are imported. Episode history in the export is counted and reported as skipped rather than guessed at, because there is no episode-level write path here yet - the same limit the CSV importer has always had.',
      'Nothing SlickSync recorded natively is ever overwritten, so running an import twice is safe and simply fills gaps.',
      'This used to connect to Trakt API directly instead, which was smoother. Trakt now requires a paid VIP subscription to register an API application at all, so that route could only ever work for someone willing to pay Trakt in order to leave it. The export path has no such gate.',
    ],
    tips: [
      'The same importer reads IMDb and Letterboxd CSV exports - get those from imdb.com/exports and letterboxd.com/settings/data. It matches on column names rather than one fixed format, so most third-party export tools work too.',
      'Big library? The import caps at 2000 entries per file. Trakt already splits large exports into numbered files, so import them one after another.',
    ],
    related: ['share-codes', 'csv-import-export'],
  },
  {
    id: 'addon-directory',
    title: 'Finding addons without hunting for a manifest URL',
    category: 'Addons',
    keywords: ['browse addons', 'addon directory', 'find addons', 'install addon', 'torrentio', 'comet', 'mediafusion', 'add addon', 'stremio addons', 'where to get addons'],
    answer: 'Addons -> Browse. Search the public Stremio addon directory and add one straight into SlickSync, instead of finding a manifest URL somewhere else and pasting it.',
    steps: [
      'Addons -> Browse.',
      'Search by name, or filter by category (movies, anime, torrents, debrid support and so on).',
      'Press Add on the one you want. It lands in your addon list, ready to assign to a user or group.',
    ],
    details: [
      'The list is sorted by popularity, so the addons most people actually use (Torrentio, Comet, MediaFusion, AIOStreams) are on the first page rather than buried.',
      'Some addons show "Configure first" instead of Add. Those store their settings inside their install URL - a debrid key, quality filters, which providers to use - so adding the plain address would give you the addon with nothing set up. That button opens their own setup page; paste the URL it produces into Add afterwards.',
      'Adding from here re-fetches the addon manifest from the addon itself rather than trusting the directory listing, so what you get is whatever the addon really is right now.',
    ],
    tips: [
      'Adding an addon does not give it to anyone yet - assign it to a user or group, which is what actually pushes it to their Stremio or Nuvio account.',
      'The directory is someone else is public listing of community addons. SlickSync neither vets nor hosts them.',
    ],
    related: ['addon-configure-in-place', 'addon-health-settings'],
  },
  {
    id: 'sync-preview',
    title: 'Seeing what a sync will change before it runs',
    category: 'Users & Groups',
    keywords: ['sync preview', 'what will sync do', 'before syncing', 'sync changes', 'dry run', 'confirm sync', 'sync safety'],
    answer: 'Pressing Sync on a user now shows exactly which addons would be added, removed, or reordered, and waits for you to confirm.',
    steps: [
      'Open a user and press Sync.',
      'Read the summary: what gets added, what gets removed, and whether the order changes.',
      'Press Sync now to go ahead, or Cancel to leave everything untouched.',
    ],
    details: [
      'Syncing rewrites the addon list on someone real Stremio or Nuvio account. Previously the button just did it, so the only way to know what changed was to remember what was there before.',
      'A pure reorder is reported as a reorder, not as removing everything and adding it all back - the comparison matches addons by their address rather than their position.',
      'If nothing would change, it says so plainly rather than pretending there is work to do.',
    ],
    tips: [
      'The preview uses the same comparison the sync itself uses, so it cannot tell you one thing and then do another.',
    ],
    related: ['sync-mode-basics', 'advanced-sync'],
  },
  {
    id: 'history-doctor',
    title: 'Checking watch history for records that are wrong',
    category: 'Health & maintenance',
    keywords: ['history doctor', 'duplicate history', 'wrong watch history', 'watch history check', 'orphaned history', 'clean history', 'fix history', 'duplicates'],
    answer: 'Tasks -> Maintenance -> Watch history check. Scans for watch records that are provably wrong and offers to remove them. Scanning never changes anything.',
    steps: [
      'Tasks -> Maintenance, then Scan history.',
      'Read what it found - each entry says what it is and why it is considered wrong.',
      'Press Fix to remove them, or just leave it. Scanning alone changes nothing.',
    ],
    details: [
      'Finds two things. Duplicates copied between providers: the same episode at the exact same watch time under two accounts of different types, where one was written later. Millisecond-identical watch times do not happen by coincidence, so a match at that precision means one record was copied from the other.',
      'And orphaned records: history belonging to a user that no longer exists. Those are invisible everywhere in the app but still counted in totals.',
      'Fixing only ever deletes the redundant copy. The original watch record each duplicate came from is kept, so no actual watch history is lost.',
    ],
    tips: [
      'Finding nothing is the normal result. This is a check, not routine maintenance - there is no need to run it on a schedule.',
      'Pressing Fix re-scans first, so a page left open from earlier cannot cause it to delete something that is no longer a problem.',
    ],
    related: ['maintenance-and-updates', 'history-not-updating'],
  },
  {
    id: 'dropped-shows',
    title: 'The Graveyard - shows started, never finished, and buried',
    category: 'Watching & Discover',
    keywords: ['dropped shows', 'abandoned', 'unfinished', 'never finished', 'gave up on', 'stopped watching', 'graveyard', 'bury show', 'wipe show', 'delete watch history', 'erase history'],
    answer: 'Activity -> Graveyard. Shows started and then left alone for over 45 days sit on the Unfinished shelf, with how far you got. Bury one and it moves to the graveyard below - where every buried show is listed, can be dug back up, or wiped permanently.',
    steps: [
      'Activity -> Graveyard.',
      'Pick a show back up, or press Bury to lay it to rest.',
      'In the graveyard, Dig up brings a show back - or press Wipe twice to erase it and its watch history permanently.',
      'Tick the checkboxes (or Select all) to bury, dig up, or wipe many shows at once - a bulk wipe names the total episode count and asks twice, same as a single one.',
    ],
    details: [
      'Continue Watching only looks back 120 days, so anything older quietly disappeared from the app altogether - never resumed, never acknowledged. This is where those end up.',
      'Shows whose last watched episode is marked finished are not listed. Finishing something is not abandoning it.',
      'Burying uses the same dismissal as Continue Watching, so a buried show will not resurface there either - and shows dismissed from Continue Watching rest in the graveyard too. Dig up returns a show to wherever it belongs: Continue Watching if recent, Unfinished if not.',
      'Wipe is the permanent option: it deletes every watched episode of that show for that person, so watch time and stats stop counting it. The button asks a second time and names exactly how many episodes it is about to erase - and there is no undo.',
    ],
    related: ['now-playing-continue-watching', 'rewatch-completion'],
  },
  {
    id: 'watching-together',
    title: 'Watching together - the watch-ahead alarm',
    category: 'Watching & Discover',
    keywords: ['watch together', 'watch ahead', 'watching ahead', 'shared show', 'frontier', 'spoiler protection', 'watch pact', 'couple show'],
    answer: 'Open any series (its detail popup from Discover, Continue Watching, or a catalog) and use the Watching Together section to pick who is watching it as a group. From then on, if any member starts an episode another member has not seen, the household gets a push and bell alert naming exactly who got ahead of whom.',
    steps: [
      'Open the show and expand Watching Together.',
      'Tap the people watching it together (at least two), then Start watching together.',
      'That is it - the alarm arms itself. Stop ends the pact any time.',
    ],
    details: [
      'The shared frontier is the furthest episode EVERYONE in the group has seen - shown in the section header, along with who the group is waiting on.',
      'The alert fires when the watch is first recorded, one alert per person per episode - pausing and resuming the same episode never nags twice.',
      'Nothing is ever blocked. SlickSync does not sit in the play path; it makes getting ahead visible while there is still time to grab the remote.',
      'Rewatching an episode everyone has already seen never alerts - only genuinely new ground does.',
      'Automation has a matching trigger, "Someone watches ahead of the group", for anything beyond the built-in alert - a pointed Discord message, for instance.',
    ],
    related: ['now-playing-continue-watching', 'automation-create', 'dropped-shows'],
  },
  {
    id: 'setup-checklist',
    title: 'The "finish setting up" card on the Dashboard',
    category: 'Getting started',
    keywords: ['setup checklist', 'finish setup', 'getting started', 'what next', 'new install', 'dashboard checklist', 'dismiss checklist'],
    answer: 'A card on the Dashboard listing what this instance has not been configured with yet, each linking to the right page. It disappears once everything is done.',
    steps: [
      'Open the Dashboard - the card appears there if anything is outstanding.',
      'Click any item to go straight to the page that handles it.',
      'Press the X to hide the card permanently if you would rather not see it.',
    ],
    details: [
      'Nothing on the list is required. SlickSync works without any of it - these are the things people usually want on, gathered in one place instead of spread across five pages.',
      'Items disappear as they are completed, and the whole card retires itself once the list is empty.',
      'Hiding it is per-device, so dismissing it on your laptop does not hide it for anyone else in the household.',
    ],
    related: ['maintenance-and-updates', 'provider-key-health'],
  },
  {
    id: 'automation-ai-writer',
    title: 'Describing an automation in plain English',
    category: 'Notifications & Automation',
    keywords: ['ai rule', 'describe automation', 'plain english rule', 'draft rule', 'write automation for me', 'natural language automation'],
    answer: 'Tasks -> Automation -> New rule has a "describe it" box: write what you want ("if RPDB dies and has no backup, alert me loudly") and Draft it opens the normal editor with a real rule filled in. Review the plain-words sentence at the top, adjust anything, save. Nothing is created until you do.',
    details: [
      'Needs AI Services configured (Settings -> External API Keys) - the same key natural-language Catalog building uses. Without it, the box says so instead of failing quietly.',
      'The model only proposes. Everything it returns is validated against the real trigger/condition/action registry: an invented trigger is rejected outright, and unknown fields are dropped with a note - a draft can never contain anything the editor itself could not build.',
      'A draft is an ordinary rule afterwards - nothing special about it, fully editable, same as one built by hand or from a recipe.',
    ],
    related: ['automation-recipes'],
  },
  {
    id: 'automation-recipes',
    title: 'Setting up automation without building a rule from scratch',
    category: 'Notifications & Automation',
    keywords: ['automation recipes', 'automation examples', 'automation templates', 'quick automation', 'rule examples', 'recipes', 'watch trigger', 'finished watching trigger', 'scrobble webhook', 'run backup automatically'],
    answer: 'Tasks -> Automation -> Recipes. Ready-made starting points like "tell me when an addon goes down" - picking one opens the normal rule editor already filled in.',
    steps: [
      'Tasks -> Automation, then Recipes.',
      'Pick the one that describes what you want.',
      'The rule editor opens pre-filled. Change anything you like, then Save. Nothing is created until you do.',
    ],
    details: [
      'A recipe produces an ordinary rule - there is nothing special about it afterwards, and it can be edited or deleted like any other.',
      'Recipes needing something from you say so up front. The webhook one, for instance, needs your webhook URL before it will save.',
      'Only recipes whose trigger exists on this version are shown.',
    ],
    related: ['automation-create', 'provider-key-health'],
  },
  {
    id: 'trash-and-undo',
    title: 'Getting back something you deleted',
    category: 'Health & maintenance',
    keywords: ['trash', 'undo delete', 'restore', 'deleted by mistake', 'recover catalog', 'recover addon', 'recover user', 'restore user', 'undo wipe', 'undo import', 'recently deleted', 'undo'],
    answer: 'Nearly every destructive action lands in the Trash first: deleted users, groups, addons, catalogs and Vault entries, removals from a group, graveyard wipes, and watch-history imports. Everything stays recoverable for 30 days under Tasks -> Maintenance -> Recently deleted.',
    steps: [
      'Right after deleting a catalog or addon, press Undo on the confirmation message.',
      'For everything else, or later on: Tasks -> Maintenance -> Recently deleted, then Restore.',
      'Delete forever removes an entry permanently - that one has nothing behind it, so it asks first.',
    ],
    details: [
      'Restoring brings the item back as it was. A user returns with their watch history, group memberships and merged-provider credentials intact; an addon comes back with its group assignments re-attached, skipping any group deleted since.',
      'A restored Vault entry keeps its secret (it was archived encrypted, exactly as stored). If its backup-key partner was deleted in the meantime, that one link is left empty rather than failing the restore.',
      'Undoing a graveyard wipe brings the episode history of that show back and re-buries it - it returns to the graveyard, not to Continue Watching.',
      'Undoing a history import removes exactly the rows that import created and never touches anything that existed before it - the import itself never overwrites existing records either.',
      'Anything not restored within 30 days is cleared automatically.',
    ],
    tips: [
      'The Undo message stays on screen longer than a normal notification, because an undo you did not have time to read is not much of an undo.',
    ],
    related: ['maintenance-and-updates', 'catalog-create'],
  },
  {
    id: 'beginner-mode',
    title: 'Beginner Mode: explanations on the pages themselves',
    category: 'Getting started',
    keywords: ['beginner mode', 'help text', 'explanations', 'new user', 'hints', 'tips', 'learning slicksync'],
    answer: 'Settings -> Privacy & Display -> Beginner Mode. Adds a short explanation to the top of pages, each linking into the full guide.',
    steps: [
      'Settings, then turn on Beginner Mode under Privacy & Display.',
      'Explanations appear on the pages that have them. Turn it off and they disappear.',
    ],
    details: [
      'The setting is per-device, not per-account. Whether you want explanations is about how you read the app, not something one household member should decide for everyone.',
      'Each explanation is one sentence plus a link to the guide covering that feature properly - deliberately thin, so it never becomes a second, out-of-date copy of the guides.',
    ],
    related: ['setup-checklist'],
  },
  {
    id: 'container-health-check',
    title: 'Checking that SlickSync itself is actually up',
    category: 'Health & maintenance',
    keywords: ['health check', 'healthcheck', 'container unhealthy', 'is it running', 'api not responding', 'backend down', 'liveness', 'readiness', 'docker healthy', '503'],
    answer: 'The container reports its own health, and /health on the API port answers 200 when the backend and database are both fine, or 503 when the database is unreachable.',
    steps: [
      'From the host: docker ps - the STATUS column shows healthy or unhealthy.',
      'Directly: curl http://localhost:4000/health inside the container, or against whatever port you mapped 4000 to.',
      'For a picture of your addons, Vault and sync instead, use the System Health page in the app - that is a different thing (see below).',
    ],
    details: [
      'This container runs two processes - the web frontend and the API backend - and either can fail on its own. The health check probes both, so a dead backend marks the container unhealthy even while the frontend still serves pages. It used to check only the frontend, which meant a dead backend could sit unnoticed behind a "healthy" container.',
      '/health is deliberately tiny: it confirms the backend answers and does one trivial database round-trip. It carries no account data and needs no login, so it is safe to point a monitor or an orchestrator probe at.',
      '200 means serving normally. 503 means the process is alive but the database is not reachable - a genuinely different situation from a crash, and worth distinguishing when something is restarting in a loop.',
    ],
    tips: [
      'Do not confuse this with System Health in the app (Metrics -> Health). That answers "are my addons and credentials working"; this answers "is SlickSync itself running".',
    ],
    related: ['system-health-overview', 'maintenance-and-updates'],
  },
  {
    id: 'maintenance-and-updates',
    title: 'Off-site backups, database upkeep, and applying updates',
    category: 'Health & maintenance',
    keywords: ['offsite backup', 'off-site backup', 's3 backup', 'webdav backup', 'backblaze', 'retention', 'vacuum', 'integrity check', 'database maintenance', 'update slicksync', 'one click update'],
    answer: 'Tasks → Maintenance. Send a copy of every backup to S3 or WebDAV, let the database look after itself (integrity checks, compaction, trimming old logs), and apply an update without SSHing into the box.',
    steps: [
      'Off-site backups: pick S3 or WebDAV, fill in the destination, then Test target to confirm it works before trusting it.',
      'Set "Keep locally" if you want old backup files cleaned up automatically - 0 keeps every one, which is the default.',
      'Database upkeep: integrity checks are on by default (they only read). Compaction and log trimming are off until you turn them on.',
      'Updates: if this container can update itself the button says so; otherwise the page shows the exact command to run on the host.',
    ],
    details: [
      'Backups have always been written next to the database they protect, which does not help if the machine itself is gone. An off-site copy is what covers that. S3 here means any S3-compatible service - AWS, Backblaze B2, Wasabi, Cloudflare R2, MinIO - and WebDAV covers Nextcloud, rsync.net and similar.',
      'A failed upload never fails the backup: the local copy is already written and validated first, and an upload problem raises a notification instead of failing silently.',
      'Database upkeep never touches watch history, users, catalogs, or the Vault. Trimming only caps addon health-check history and automation run history - the two tables nothing reads by date. Compaction refuses to run if the disk lacks the free space to do it safely.',
      'Updating in place requires the Docker socket mounted into the container, which effectively grants control of the host\'s Docker. That is a deliberate security trade, so it is never enabled for you - without it, everything else here still works and you get the command to run instead.',
      'When it is available, updating always backs up first and downloads the new image before anything restarts, so a failed download leaves the running version untouched.',
      'Off-site backups deliberately carry no Vault secrets - only the Disaster Recovery Kit does, and it is only ever produced when you export it by hand. Automating that would mean continuously copying every credential to a third-party bucket and keeping its passphrase on the server, which is worse than the problem it solves. Instead, Settings has an opt-in "Recovery Kit reminders" toggle that nudges you when your kit is over 60 days old (or was never made) and the Vault actually holds credentials.',
    ],
    related: ['backup-restore', 'system-health-overview'],
  },
];

// Very small keyword-overlap scorer, not a real search engine - good enough
// for a few dozen short entries. Title match outweighs a keyword match,
// which outweighs an answer-body match, so a query like "automation" surfaces
// the automation guide above a guide that merely mentions it in passing. The
// long-form fields (steps/details/tips) are searched too but scored lowest,
// so a topic that merely mentions a term in passing never outranks the one
// actually about it.
// Words that carry no signal on their own. Without this, a query like
// "how to" scores nearly every entry (almost every answer contains "to")
// and returns four effectively random guides. Queries made up entirely of
// these return nothing here - the Guides nav entry catches them instead,
// which is the more useful answer to "how to" anyway.
const STOPWORDS = new Set([
  'how', 'to', 'do', 'does', 'the', 'a', 'an', 'my', 'in', 'on', 'is', 'it',
  'for', 'of', 'and', 'can', 'what', 'where', 'why', 'when', 'with', 'you',
  'your', 'me', 'get', 'set', 'up', 'use', 'using',
]);

// Punctuation-insensitive, so "auto-remove" matches "auto remove" and
// "2fa?" matches "2fa". `+` survives because it's meaningful in a few
// product names.
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9+\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function words(text: string): string[] {
  return text.split(' ').filter(Boolean);
}

interface Haystack {
  title: string;
  titleWords: string[];
  keywords: string[];
  keywordWords: string[];
  answer: string;
  body: string;
  category: string;
  all: string;
}

// Built once per entry rather than per keystroke - this runs on every
// character typed into the palette.
const HAYSTACKS = new WeakMap<HelpEntry, Haystack>();
function haystackFor(entry: HelpEntry): Haystack {
  const cached = HAYSTACKS.get(entry);
  if (cached) return cached;
  const title = normalize(entry.title);
  const keywords = entry.keywords.map(normalize);
  const answer = normalize(entry.answer);
  const body = normalize([
    ...(entry.steps || []),
    ...(entry.details || []),
    ...(entry.tips || []),
  ].join(' '));
  const category = normalize(entry.category);
  const built: Haystack = {
    title,
    titleWords: words(title),
    keywords,
    keywordWords: keywords.flatMap(words),
    answer,
    body,
    category,
    all: `${title} ${keywords.join(' ')} ${answer} ${body} ${category}`,
  };
  HAYSTACKS.set(entry, built);
  return built;
}

function scoreEntry(entry: HelpEntry, phrase: string, terms: string[]): number {
  const h = haystackFor(entry);
  let score = 0;

  // Whole-phrase hits are the strongest signal there is.
  if (h.title === phrase) score += 60;
  else if (h.title.includes(phrase)) score += 40;
  if (h.keywords.some((k) => k === phrase)) score += 45;
  else if (h.keywords.some((k) => k.includes(phrase))) score += 18;

  for (const term of terms) {
    // A whole word in the title beats a substring of one ("sync" as a word
    // in "Syncing addons" shouldn't score the same as the topic actually
    // being about sync).
    if (h.titleWords.includes(term)) score += 14;
    else if (h.title.includes(term)) score += 7;

    if (h.keywordWords.includes(term)) score += 10;
    else if (h.keywords.some((k) => k.includes(term))) score += 5;

    if (h.category.includes(term)) score += 3;
    if (h.answer.includes(term)) score += 2;
    if (h.body.includes(term)) score += 1;
  }

  return score;
}

export function searchHelp(query: string, limit = 4): HelpEntry[] {
  const phrase = normalize(query);
  if (!phrase) return [];
  const allTerms = words(phrase).filter((t) => t.length >= 2);
  if (allTerms.length === 0) return [];
  // Keep stopwords only if that's all there is to go on - in which case we
  // deliberately return nothing rather than noise.
  const terms = allTerms.filter((t) => !STOPWORDS.has(t));
  if (terms.length === 0) return [];

  // Require EVERY meaningful term to appear somewhere in the entry. Without
  // this, "how do i use 2fa" scored every guide containing "use" or "do"
  // and buried the actual 2FA guide behind unrelated addon results
  // (confirmed live 2026-08-20: 30 results, correct answer ranked 3rd).
  const strict = HELP_ENTRIES
    .filter((entry) => terms.every((t) => haystackFor(entry).all.includes(t)))
    .map((entry) => ({ entry, score: scoreEntry(entry, phrase, terms) }))
    .filter((s) => s.score > 0);

  // Fall back to any-term matching only if requiring all of them found
  // nothing, so a typo or an extra word still returns something useful
  // rather than a dead end.
  const pool = strict.length > 0
    ? strict
    : HELP_ENTRIES
        .map((entry) => ({ entry, score: scoreEntry(entry, phrase, terms) }))
        .filter((s) => s.score > 0);

  if (pool.length === 0) return [];
  pool.sort((a, b) => b.score - a.score);

  // Relevance floor relative to the best hit - cuts the long tail of
  // entries that merely mention a word in passing, which is what made the
  // results list read as "30 results" of mostly noise.
  const best = pool[0].score;
  const floor = Math.max(best * 0.3, 4);
  return pool.filter((s) => s.score >= floor).slice(0, limit).map((s) => s.entry);
}

export function getHelpEntry(id: string): HelpEntry | undefined {
  return HELP_ENTRIES.find((e) => e.id === id);
}

// Grouped for the Help index page. Only returns categories that actually
// have entries, in HELP_CATEGORY_ORDER order, so adding a category to the
// union without writing entries for it yet can't render an empty heading.
export function helpEntriesByCategory(entries: HelpEntry[] = HELP_ENTRIES): Array<{ category: HelpCategory; entries: HelpEntry[] }> {
  return HELP_CATEGORY_ORDER
    .map((category) => ({ category, entries: entries.filter((e) => e.category === category) }))
    .filter((group) => group.entries.length > 0);
}
