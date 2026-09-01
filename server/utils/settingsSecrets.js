// The secret-bearing fields inside AppAccount.sync, named in ONE place.
//
// Two features have to agree on this list and previously kept their own
// copies, which silently drifted: buildConfigExportPayload (publicAuth.js)
// strips these so real keys never land in a plain, easily-shared config
// export, and the Disaster Recovery Kit captures these so they survive a
// restore. Anything on the strip list but missing from the capture list is
// simply destroyed on restore - stripped from the export, saved nowhere
// else. That had already happened to omdbApiKey, simklClientId and
// nuvioAnonKey.
//
// So: add a new secret settings field HERE and both sides pick it up.
const SETTINGS_SECRET_FIELDS = [
  'webhookUrl',
  'tmdbApiKey',
  'omdbApiKey',
  'mdblistApiKey',
  'rpdbApiKey',
  'simklClientId',
  'traktClientId',
  'traktClientSecret',
  'nuvioAnonKey',
  // Failover partners - real keys, same handling as the primaries.
  'tmdbApiKeyBackup',
  'omdbApiKeyBackup',
  'mdblistApiKeyBackup',
  'rpdbApiKeyBackup',
]

module.exports = { SETTINGS_SECRET_FIELDS }
