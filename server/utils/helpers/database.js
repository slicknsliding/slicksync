/**
 * Common database query patterns to reduce duplication
 */

/**
 * Find user by ID with account scoping
 */
async function findUserById(prisma, userId, accountId, include = {}) {
  return await prisma.user.findUnique({
    where: {
      id: userId,
      accountId: accountId
    },
    include
  });
}

/**
 * Find group by ID with account scoping
 */
async function findGroupById(prisma, groupId, accountId, include = {}) {
  return await prisma.group.findUnique({
    where: {
      id: groupId,
      accountId: accountId
    },
    include
  });
}

/**
 * Find addon by ID with account scoping
 */
async function findAddonById(prisma, addonId, accountId, include = {}) {
  return await prisma.addon.findUnique({
    where: {
      id: addonId,
      accountId: accountId
    },
    include
  });
}

/**
 * Get all users for an account
 */
async function getAllUsers(prisma, accountId, include = {}) {
  return await prisma.user.findMany({
    where: { accountId },
    include,
    orderBy: { id: 'asc' }
  });
}

/**
 * Get all groups for an account
 */
async function getAllGroups(prisma, accountId, include = {}) {
  return await prisma.group.findMany({
    where: { accountId },
    include,
    orderBy: { id: 'asc' }
  });
}

/**
 * Get all addons for an account
 */
async function getAllAddons(prisma, accountId, include = {}) {
  return await prisma.addon.findMany({
    where: { accountId },
    include,
    orderBy: { id: 'asc' }
  });
}

/**
 * Check if user exists and is active
 */
async function isUserActive(prisma, userId, accountId) {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
      accountId: accountId
    },
    select: { isActive: true }
  });
  return user?.isActive === true;
}

/**
 * Check if group exists and is active
 */
async function isGroupActive(prisma, groupId, accountId) {
  const group = await prisma.group.findUnique({
    where: {
      id: groupId,
      accountId: accountId
    },
    select: { isActive: true }
  });
  return group?.isActive === true;
}

/**
 * Get groups that contain a specific user
 */
async function getUserGroups(prisma, userId, accountId, include = {}) {
  return await prisma.group.findMany({
    where: {
      accountId,
      userIds: {
        contains: userId
      }
    },
    include
  });
}

/**
 * Get users that belong to a specific group
 */
async function getGroupUsers(prisma, groupId, accountId, include = {}) {
  const group = await prisma.group.findUnique({
    where: { id: groupId, accountId },
    select: { userIds: true }
  });

  if (!group?.userIds) return [];

  const userIds = JSON.parse(group.userIds);
  return await prisma.user.findMany({
    where: {
      id: { in: userIds },
      accountId
    },
    include
  });
}

/**
 * True when every id is a row of this model in this account (an empty list is
 * fine). Used before writing a link to ids a client sent, so one account can
 * never be pointed at another's addons or groups.
 */
async function idsInAccount(prisma, model, ids, accountId) {
  const wanted = [...new Set((ids || []).map((id) => String(id)))];
  if (wanted.length === 0) return true;
  if (!accountId) return false;
  const found = await prisma[model].count({ where: { id: { in: wanted }, accountId } });
  return found === wanted.length;
}

/**
 * Get account ID for private mode
 */
function getAccountId(req) {
  const { INSTANCE_TYPE, DEFAULT_ACCOUNT_ID } = require('../config');

  if (INSTANCE_TYPE === 'public') {
    return req.appAccountId || null;
  }
  return DEFAULT_ACCOUNT_ID;
}

/**
 * Create scoped where clause for account-based queries
 */
function scopedWhere(req, extra = {}) {
  const accId = getAccountId(req);
  if (!accId) return { id: 'impossible-match' }; // impossible match
  return { accountId: accId, ...extra };
}

/**
 * Get group addons with proper ordering and decryption
 */
async function getGroupAddons(prisma, groupId, req) {
  const accId = getAccountId(req);
  if (!accId) return [];

  const group = await prisma.group.findUnique({
    where: { id: groupId, accountId: accId },
    include: { addons: { include: { addon: true } } }
  });

  if (!group) return [];

  const { decrypt } = require('../encryption');

  const filtered = (group.addons || []).filter(ga => ga?.addon && ga.addon.isActive !== false && (!accId || ga.addon.accountId === accId))
  const sorted = filtered.slice().sort((a, b) => ((a?.position ?? 0) - (b?.position ?? 0)))

  // Function to recursively find the best addon (online one in the chain).
  // Uses the stored isOnline value from the periodic health checker rather than
  // doing a live HTTP check on every sync — live checks cause false negatives
  // when an addon is momentarily slow, incorrectly triggering the backup.
  const findBestAddonInChain = async (addon, depth = 0) => {
    if (depth > 5) {
      console.warn(`[getGroupAddons] Backup chain too deep for ${addon.name}, stopping recursion`);
      return addon;
    }

    // Trust the health checker's stored status (isOnline defaults to true)
    const isAddonOnline = addon.isOnline !== false;

    if (isAddonOnline) {
      return addon;
    }

    // Addon is marked offline by health checker — check for a backup
    if (addon.backupAddonId) {
      const backupAddon = await prisma.addon.findUnique({
        where: { id: addon.backupAddonId }
      });

      if (backupAddon && backupAddon.isActive) {
        console.log(`[getGroupAddons] Primary ${addon.name} is offline, switching to backup ${backupAddon.name}`);
        return findBestAddonInChain(backupAddon, depth + 1);
      }
    }

    // No backup or chain exhausted — return the offline addon as-is
    return addon;
  };

  // Process all addons in parallel
  const processedAddons = await Promise.all(sorted.map(async ga => {
    // Find the best addon in the chain (may be a backup)
    const bestAddon = await findBestAddonInChain(ga.addon);
    const isBackup = bestAddon.id !== ga.addon.id;

    if (isBackup) {
      console.log(`[getGroupAddons] Using backup addon ${bestAddon.name} for primary ${ga.addon.name}`);
    }

    // Always use the DB-stored manifest for consistent fingerprint comparison.
    // The DB manifest is kept current by the health checker (reloadAddon on status change)
    // and manual reloads from the UI. Using live-fetched manifests caused intermittent
    // synced/unsynced flicker when the fetch occasionally failed and fell back to a stale DB copy.
    const manifest = (() => {
      try {
        const raw = bestAddon.manifest
        if (!raw) return null
        let dec = null
        try { dec = decrypt(raw, req) } catch { dec = raw }
        try { return typeof dec === 'string' ? JSON.parse(dec) : dec } catch { return dec }
      } catch { return null }
    })()

    if (!manifest) return null

    // Decrypt manifestUrl for transportUrl
    let transportUrl = (() => {
      try { return decrypt(bestAddon.manifestUrl, req) } catch { return bestAddon.manifestUrl }
    })()

    // Vault-injected addon: the stored URL carries {{vault:...}} placeholders
    // that only the server-side /proxy layer can resolve, so the account MUST
    // receive the proxy URL - pushing the raw placeholder URL would hand
    // devices an unfetchable address. Uses the same base-URL resolution the
    // SlickTrax addon injection uses: PUBLIC_APP_URL wins, else the base an
    // admin's own session observed. With neither, the raw URL goes through
    // unchanged and the vaultify endpoint refuses to create this state in
    // the first place (it requires a resolvable base).
    if (typeof transportUrl === 'string' && transportUrl.includes('{{vault:') && bestAddon.proxyEnabled && bestAddon.proxyUuid) {
      // The same address SlickTrax uses (utils/ownAddress.js).
      const base = await require('../ownAddress').publicBase(prisma, bestAddon.accountId).catch(() => '')
      if (base) transportUrl = `${base}/proxy/${bestAddon.proxyUuid}/manifest.json`
    }

    // Set transportName to empty string
    const transportName = ""

    // Strip manifest.manifestUrl to mirror getUserAddons shape
    const { manifestUrl: _omitManifestUrl, ...cleanManifest } = (manifest && typeof manifest === 'object') ? manifest : {}

    return {
      id: bestAddon.id,
      name: bestAddon.name,
      description: bestAddon.description || null,
      version: bestAddon.version || cleanManifest.version || null,
      resources: bestAddon.resources ? JSON.parse(bestAddon.resources) : (cleanManifest.resources || []),
      logo: bestAddon.iconUrl || bestAddon.customLogo || null,
      customLogo: bestAddon.customLogo || null,
      transportUrl,
      transportName,
      manifest: cleanManifest,
      // Include info about whether we're using backup
      isBackup,
      primaryAddonId: isBackup ? ga.addon.id : undefined,
      primaryAddonName: isBackup ? ga.addon.name : undefined,
    }
  }));

  return processedAddons.filter(Boolean)
}

// A group's members are a JSON list on the group row, so every membership
// change reads the list, changes it and writes it back. Two of those at once
// (two invitations accepted together, an automation run, an admin edit during
// an accept) both read the old list, and the second write erased the first
// person - who then silently stopped getting the group's addons. So they run
// one at a time per household, each as one transaction: it either lands whole
// or not at all. In-process on purpose: one server process serves a
// household, so a database lock would add nothing (and SQLite has no
// row-level one).
const membershipQueues = new Map(); // accountId -> tail of the queue
function inMembershipQueue(accountId, task) {
  // One queue per household whichever way its id is spelled: a
  // single-household install's rows can say 'default' or nothing at all.
  accountId = accountId || require('../config').DEFAULT_ACCOUNT_ID;
  const run = (membershipQueues.get(accountId) || Promise.resolve()).then(task);
  const tail = run.then(() => {}, () => {});
  membershipQueues.set(accountId, tail);
  tail.then(() => { if (membershipQueues.get(accountId) === tail) membershipQueues.delete(accountId); });
  return run;
}

// Long-transaction settings (no five-second cutoff, room to wait for the
// connection) so a membership change made while a sync or a backup is busy
// still goes through. Called with a transaction client already, it just runs.
function inTransaction(prisma, fn) {
  if (typeof prisma.$transaction !== 'function') return fn(prisma);
  return require('../userMerge').runLongTransaction(prisma, fn);
}

// The member ids stored on a group row: [] when none, null when the stored
// text is not a list (left alone rather than overwritten).
function readMemberIds(raw) {
  if (!raw) return [];
  try {
    const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Assign a user to a group (removes from other groups first)
 */
async function assignUserToGroup(prisma, userId, groupId, req) {
  const accId = getAccountId(req);
  if (!accId) throw new Error('Account context required');

  // Validate groupId is a valid string
  if (!groupId || typeof groupId !== 'string' || groupId.trim() === '') {
    throw new Error(`Invalid groupId: ${groupId}`);
  }

  await inMembershipQueue(accId, () => inTransaction(prisma, async (db) => {
    if (!(await moveIntoGroup(db, accId, userId, groupId))) {
      throw new Error(`Target group not found: ${groupId} (accountId: ${accId})`);
    }
  }));
}

// Put someone in a group and take them out of the household's others. For
// callers already inside withMembershipLock. False when the group is gone.
async function moveIntoGroup(db, accountId, userId, groupId) {
  const allGroups = await db.group.findMany({
    where: { accountId },
    select: { id: true, userIds: true }
  });
  if (!allGroups.some((group) => group.id === groupId)) return false;

  for (const group of allGroups) {
    const ids = readMemberIds(group.userIds);
    if (ids === null) {
      if (group.id === groupId) throw new Error(`Group ${groupId} has a member list that cannot be read`);
      continue;
    }
    // In the target group they are added, in every other group removed.
    const next = group.id === groupId
      ? (ids.includes(userId) ? ids : [...ids, userId])
      : ids.filter((id) => id !== userId);
    if (next.length !== ids.length) {
      await db.group.update({
        where: { id: group.id },
        data: { userIds: JSON.stringify(next) }
      });
    }
  }
  return true;
}

// Take someone out of every group of their household. For callers already
// inside withMembershipLock (a merge, a delete that is one transaction).
async function dropFromAllGroups(db, accountId, userId) {
  const groups = await db.group.findMany({
    where: { accountId, userIds: { contains: userId } },
    select: { id: true, userIds: true }
  });
  const left = [];
  for (const group of groups) {
    const ids = readMemberIds(group.userIds);
    if (ids === null) continue;
    const next = ids.filter((id) => id !== userId);
    if (next.length !== ids.length) {
      await db.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify(next) } });
      left.push(group.id);
    }
  }
  return left;
}

/**
 * Take someone out of every group of their household, one membership change
 * at a time like the rest. Returns the ids of the groups they left.
 */
async function removeUserFromAllGroups(prisma, userId, accountId) {
  return inMembershipQueue(accountId, () => inTransaction(prisma, (db) => dropFromAllGroups(db, accountId, userId)));
}

/**
 * Run work that changes group members - a merge, a restore, a delete -
 * while no other membership change in the household runs, so neither one
 * writes over the other. The work must not call the helpers above (they
 * wait for this same queue); it uses moveIntoGroup / dropFromAllGroups.
 */
function withMembershipLock(accountId, task) {
  return inMembershipQueue(accountId, task);
}

/**
 * Take a user out of one group.
 */
async function removeUserFromGroup(prisma, userId, groupId, req) {
  const accId = getAccountId(req);
  if (!accId) throw new Error('Account context required');

  await inMembershipQueue(accId, () => inTransaction(prisma, async (db) => {
    const group = await db.group.findFirst({
      where: { id: groupId, accountId: accId },
      select: { id: true, userIds: true }
    });
    if (!group) throw new Error(`Target group not found: ${groupId} (accountId: ${accId})`);
    const ids = readMemberIds(group.userIds);
    if (ids === null) throw new Error(`Group ${groupId} has a member list that cannot be read`);
    const next = ids.filter((id) => id !== userId);
    if (next.length !== ids.length) {
      await db.group.update({ where: { id: groupId }, data: { userIds: JSON.stringify(next) } });
    }
  }));
}

/**
 * Replace a group's members with the given people. The final list is worked
 * out once and written once - not emptied and refilled one person at a time,
 * which left the group short for as long as that took - and only ids that are
 * real people of this account are kept. Everyone who ends up in the group is
 * taken out of the account's other groups, as assigning one person does.
 * Returns the ids that were kept.
 */
async function setGroupMembers(prisma, groupId, userIds, req) {
  const accId = getAccountId(req);
  if (!accId) throw new Error('Account context required');

  const asked = [...new Set((Array.isArray(userIds) ? userIds : []).filter((id) => typeof id === 'string' && id.trim() !== ''))];

  return inMembershipQueue(accId, () => inTransaction(prisma, async (db) => {
    const allGroups = await db.group.findMany({
      where: { accountId: accId },
      select: { id: true, userIds: true }
    });
    if (!allGroups.some((group) => group.id === groupId)) {
      throw new Error(`Target group not found: ${groupId} (accountId: ${accId})`);
    }

    const people = asked.length
      ? await db.user.findMany({ where: { id: { in: asked }, accountId: accId }, select: { id: true } })
      : [];
    const real = new Set(people.map((person) => person.id));
    const members = asked.filter((id) => real.has(id));
    const kept = new Set(members);

    for (const group of allGroups) {
      if (group.id === groupId) {
        const before = readMemberIds(group.userIds);
        if (before === null || before.length !== members.length || before.some((id, i) => id !== members[i])) {
          await db.group.update({ where: { id: groupId }, data: { userIds: JSON.stringify(members) } });
        }
        continue;
      }
      const ids = readMemberIds(group.userIds);
      if (ids === null) continue;
      const next = ids.filter((id) => !kept.has(id));
      if (next.length !== ids.length) {
        await db.group.update({ where: { id: group.id }, data: { userIds: JSON.stringify(next) } });
      }
    }
    return members;
  }));
}

/**
 * Ensure email uniqueness across all accounts
 * If a user with the same email exists in another account, delete it first
 * This ensures one email can only exist in one account at a time
 */
async function ensureEmailUniqueness(prisma, email, targetAccountId) {
  // This used to DELETE every person with this email in every other
  // household - on a shared instance, one household adding someone wiped
  // that person (and any Nuvio or Jellyfin row with the same email) out of
  // another household, leaving their history behind. Each household owns its
  // own people: the Postgres schema (shared instances) is unique per
  // household, and a private instance has the one household. Nothing to do.
  void prisma; void email; void targetAccountId
}

module.exports = {
  findUserById,
  findGroupById,
  findAddonById,
  getAllUsers,
  getAllGroups,
  getAllAddons,
  isUserActive,
  isGroupActive,
  getUserGroups,
  getGroupUsers,
  getAccountId,
  idsInAccount,
  scopedWhere,
  getGroupAddons,
  assignUserToGroup,
  removeUserFromGroup,
  setGroupMembers,
  removeUserFromAllGroups,
  withMembershipLock,
  moveIntoGroup,
  dropFromAllGroups,
  ensureEmailUniqueness
};
