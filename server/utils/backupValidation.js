// Validates a backup file's structural soundness - the same "does this
// even have the right shape" question server/routes/publicAuth.js's
// config-import handler answers today, except that only ever happens
// destructively (mid-restore, all current data already wiped) and only
// when someone's already relying on the backup being good. This runs
// read-only right after a backup is written, so a corrupted or
// incomplete file is caught immediately instead of at the worst possible
// moment.
//
// Deliberately checks against what config-import actually requires/uses
// (see its own guard: `!configData.users && !configData.addons` is an
// outright reject) rather than an independent notion of "valid" - the
// point is predicting whether a real restore would work, not just
// well-formed JSON.

function validateBackupData(configData) {
  const issues = [];

  if (!configData || typeof configData !== 'object' || Array.isArray(configData)) {
    return { valid: false, issues: ['Not a valid JSON object'], counts: null };
  }

  const { users, groups, addons } = configData;

  if (!Array.isArray(users) && !Array.isArray(addons)) {
    issues.push('Missing both users and addons - config-import rejects this outright');
  }

  const addonNames = new Set();
  if (addons !== undefined && !Array.isArray(addons)) {
    issues.push('"addons" is present but not an array');
  } else if (Array.isArray(addons)) {
    addons.forEach((a, i) => {
      if (!a || typeof a !== 'object') { issues.push(`addons[${i}] is not an object`); return; }
      if (!a.name) issues.push(`addons[${i}] has no name`);
      else addonNames.add(a.name);
      if (!a.manifestUrl && !a.originalManifest) {
        issues.push(`Addon "${a.name || i}" has no manifestUrl or originalManifest - would restore as unusable`);
      }
    });
  }

  if (groups !== undefined && !Array.isArray(groups)) {
    issues.push('"groups" is present but not an array');
  } else if (Array.isArray(groups)) {
    groups.forEach((g, i) => {
      if (!g || typeof g !== 'object') { issues.push(`groups[${i}] is not an object`); return; }
      if (!g.name) issues.push(`groups[${i}] has no name`);
      if (Array.isArray(g.addons) && addonNames.size > 0) {
        for (const ga of g.addons) {
          if (ga?.name && !addonNames.has(ga.name)) {
            issues.push(`Group "${g.name || i}" references addon "${ga.name}", which isn't in this backup's addons list`);
          }
        }
      }
    });
  }

  if (users !== undefined && !Array.isArray(users)) {
    issues.push('"users" is present but not an array');
  } else if (Array.isArray(users)) {
    users.forEach((u, i) => {
      if (!u || typeof u !== 'object') { issues.push(`users[${i}] is not an object`); return; }
      if (!u.username && !u.email) issues.push(`users[${i}] has neither username nor email`);
    });
  }

  const counts = {
    users: Array.isArray(users) ? users.length : 0,
    groups: Array.isArray(groups) ? groups.length : 0,
    addons: Array.isArray(addons) ? addons.length : 0,
  };

  return { valid: issues.length === 0, issues, counts };
}

module.exports = { validateBackupData };
