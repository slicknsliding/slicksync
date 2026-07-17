# Credits

SlickSync is a fork of [Syncio](https://github.com/iamneur0/syncio) by
**neur0**, with additional features and ideas credited to
[AIOManager](https://github.com/Sonicx161/AIOManager) by **Sonicx161**.

## What SlickSync adds on top of Syncio

### Multi-provider sync (Nuvio as a first-class provider)

The core of SlickSync is treating Nuvio as a first-class provider,
side-by-side with Stremio, rather than bolting it on:

- Two connection methods for Nuvio - OAuth device-code/QR flow, or direct
  email+password - matching how Stremio accounts already connect.
- Every Nuvio profile syncs, not just the primary one. Nuvio accounts
  support multiple profiles (like Netflix profiles); SlickSync pulls
  library, watch progress, and addon data from all of them and merges the
  results, labeling which profile each activity came from.
- Same email can exist as both a Stremio and a Nuvio user - useful when
  someone uses both apps on different devices.
- Nuvio refresh tokens are encrypted at rest; access tokens auto-refresh
  without user interaction.
- Nuvio's library is read-only by nature. Attempted edits return a clear
  error instead of silently failing.
- A provider badge shows on every user, everywhere they appear - purple
  for Stremio, a two-tone blue/orange split for Nuvio - fixed colors
  independent of the active theme, so the two are always visually
  distinguishable.
- Addon import pulls real manifest data (icon, version, description) for
  both providers - Nuvio's own storage only keeps a bare URL+name per
  addon, so SlickSync fetches each addon's actual `manifest.json` to fill
  in the rest.
- 1-minute poll cycle for fast detection of new activity, library changes,
  and session state, across every connected account and profile.

### Activity, Now Playing, and watch history

- Per-day, per-user Activity feed grouped by date, with poster art,
  season/episode for series, and which profile the watch came from.
- Top Watched / Recent Activity / Top Viewers on the Dashboard and each
  user's detail page, built from real session duration - not just a
  count of events.
- **Live "Now Playing" via AIOStreams proxy integration**: detects active
  streams in real time by observing connections through AIOStreams' built-in
  proxy, independent of library-poll delays. Handles multiple SlickSync
  profiles sharing one AIOStreams login, disambiguating which profile is
  actually streaming using existing watch history as a signal, and groups
  reconnections from seeking so duration stays continuous instead of
  resetting.
- The proxy is a **presence signal only** - it never writes watch history or
  durations. A proxy connection's wall-clock lifetime isn't watch time, so
  History and Watch Time come from each provider's own counters, which also
  covers sources the proxy never carries (usenet).
- **Correct-or-nothing posters** for proxy-detected entries: a strict
  Cinemeta title search that returns a poster only on an exact normalized-title
  match, plus an exact year match when the filename carries a year. No
  confident match means no poster rather than a wrong one.

### 🔐 Vault - credential tracking with expiry alerts and active-checks

Track API keys, accounts, and credentials (debrid services, Usenet
providers/indexers, VPN, AI services, or your own Stremio/Nuvio-specific
secrets) in one place:

- Encrypted at rest, same AES-GCM scheme as the rest of the app.
- Expiry tracking with configurable days-before-expiry alerts.
- Real active-checks, not just "is the server up":
  - Real-Debrid, TorBox, and Newznab indexers validate the actual key
    against the provider's own API.
  - Stremio credentials are verified with a real login attempt against
    Stremio's API - checked against the account's actual auth state (not
    inferred from a wrapper's return value), so it correctly distinguishes
    a genuinely bad password from a transient issue.
  - Generic HTTP/TCP-reachability checks for anything else.
- ntfy and/or Discord notifications when something's expiring or a check
  starts failing.
- Scheduled export: a decrypted snapshot writes to `data/backup/vault/`
  nightly (`VAULT_BACKUP_INTERVAL_HOURS` to change the interval), so Vault
  data can be pulled off-server for backup or synced into an external
  password manager. On-demand backup via `POST /api/vault/backup-now`.
- Drag-and-drop reordering within the Vault.
- Move addons directly from the Addons page into the Vault to store ones
  you're not currently using, keeping the Addons page cleaner - and move
  them back out just as easily.

### Profiles and personalization

- Custom avatar/profile picture upload per user, instead of only
  generated/Gravatar avatars.

### 🎨 Themes

Ten full themes, each with its own background, surface, text, accent, and
chart-color palette - switchable live from Settings, applied everywhere
instantly. The app logo (a chain-link mark, representing "sync") is a
theme-reactive inline SVG rather than a static image - it recolors
automatically with whichever theme is active, everywhere it renders:
sidebar, login page, invite pages, and the user-connect modal.

## License

SlickSync is distributed under the MIT License, same as the original
Syncio project. See [LICENSE](./LICENSE) for the full text, which
preserves the original project's copyright notice alongside this fork's.

## Upstream projects

If you're looking for the original, unmodified Syncio project, it's here:
**https://github.com/iamneur0/syncio**

AIOManager, a separate and actively developed project in the same space,
is here: **https://github.com/Sonicx161/AIOManager**
