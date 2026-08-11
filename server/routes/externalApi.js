const express = require('express')
const { parsePresentedKey } = require('../utils/apiKey')
const crypto = require('crypto')
const { getServerKey, aesGcmDecrypt } = require('../utils/encryption')
const { sendSyncNotification } = require('../utils/notify')

module.exports = ({ prisma, getAccountId, scopedWhere, reloadDeps, syncGroupUsers }) => {
  const router = express.Router()

  // API key auth middleware - iterate accounts to find matching key
  router.use(async (req, res, next) => {
    // If request already has appAccountId (e.g. from global JWT auth), allow it to pass through
    if (req.appAccountId) return next()

    try {
      const presented = parsePresentedKey(req.headers['authorization'] || '')
      if (!presented) return res.status(401).json({ message: 'Missing or invalid API key' })
      
      // Find account by decrypting stored keys and comparing
      const accounts = await prisma.appAccount.findMany({ where: { apiKeyHash: { not: null } }, select: { id: true, apiKeyHash: true } })
      const serverKey = getServerKey()
      for (const acct of accounts) {
        try {
          // Derive account-specific key and decrypt
          const accountKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(acct.id || ''), serverKey])).digest()
          const decrypted = aesGcmDecrypt(accountKey, acct.apiKeyHash)
          if (decrypted === presented) {
            req.appAccountId = acct.id
            return next()
          }
        } catch {
          // Decryption failed for this account, try next
          continue
        }
      }
      return res.status(401).json({ message: 'Invalid API key' })
    } catch (e) {
      return res.status(401).json({ message: 'Unauthorized' })
    }
  })

  /**
   * @openapi
   * /account:
   *   get:
   *     summary: Get account statistics
   *     description: Brief stats for the account that owns the API key used to authenticate.
   *     responses:
   *       200:
   *         description: Account info and counts
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 id: { type: string }
   *                 uuid: { type: string }
   *                 email: { type: string }
   *                 linkedProvider: { type: string, nullable: true }
   *                 avatarUrl: { type: string, nullable: true }
   *                 displayName: { type: string, nullable: true }
   *                 lastRunAt: { type: string, format: date-time, nullable: true }
   *                 totalUsers: { type: integer }
   *                 totalGroups: { type: integer }
   *                 totalAddons: { type: integer }
   *                 pendingInvites: { type: integer }
   *       401:
   *         description: Missing or invalid API key
   */
  // GET /ext/account - brief stats
  router.get('/account', async (req, res) => {
    try {
      console.log(`[ext/account] Fetching stats for accountId: "${req.appAccountId}"`)
      const account = await prisma.appAccount.findUnique({
        where: { id: req.appAccountId },
        select: { id: true, uuid: true, email: true, linkedProvider: true, sync: true, avatarUrl: true, displayName: true }
      })
      const sync = account?.sync && typeof account.sync === 'string' ? JSON.parse(account.sync) : account?.sync || {}
      const [totalUsers, totalGroups, totalAddons, pendingInvites] = await Promise.all([
        prisma.user.count({ where: { accountId: req.appAccountId } }),
        prisma.group.count({ where: { accountId: req.appAccountId } }),
        prisma.addon.count({ where: { accountId: req.appAccountId } }),
        prisma.inviteRequest.count({ where: { accountId: req.appAccountId, status: 'pending' } })
      ])
      console.log(`[ext/account] Result: users=${totalUsers}, groups=${totalGroups}, addons=${totalAddons}`)
      return res.json({
        id: account?.id,
        uuid: account?.uuid,
        email: account?.email,
        linkedProvider: account?.linkedProvider || null,
        avatarUrl: account?.avatarUrl || null,
        displayName: account?.displayName || null,
        lastRunAt: sync?.lastRunAt || null,
        totalUsers,
        totalGroups,
        totalAddons,
        pendingInvites
      })
    } catch (e) {
      console.error(`[ext/account] Error:`, e.message)
      return res.status(500).json({ message: 'Failed to get account info' })
    }
  })

  /**
   * @openapi
   * /metrics.json:
   *   get:
   *     summary: Get full dashboard metrics
   *     description: Same data the Metrics dashboard page renders, scoped to the API key's account. Served from an in-memory cache refreshed every 5 minutes when available; built on demand otherwise.
   *     parameters:
   *       - in: query
   *         name: period
   *         schema: { type: string, enum: ['7d', '30d', '90d', 'all'], default: '30d' }
   *         description: Lookback window, same semantics as the Metrics page's own period selector.
   *     responses:
   *       200:
   *         description: Metrics payload (shape mirrors the admin Metrics page)
   *       401:
   *         description: Missing or invalid API key
   */
  // GET /ext/metrics.json - full metrics JSON for this account (API key scoped)
  router.get('/metrics.json', async (req, res) => {
    try {
      const accountId = req.appAccountId
      if (!accountId) {
        return res.status(401).json({ error: 'Unauthorized' })
      }

      const { period = '30d' } = req.query // same semantics as /users/metrics

      const { getCachedMetrics, setCachedMetrics } = require('../utils/metricsCache')
      const { buildMetricsForAccount } = require('../utils/metricsBuilder')

      // Try in-memory metrics cache first (populated by activityMonitor every 5 minutes)
      const cached = getCachedMetrics(accountId, period)
      if (cached) {
        return res.json(cached)
      }

      // Build on demand (also used on first boot or if scheduler hasn't run yet)
      // Use reloadDeps.decrypt which matches the decrypt function signature expected by buildMetricsForAccount
      const metrics = await buildMetricsForAccount({
        prisma,
        accountId,
        period,
        decrypt: reloadDeps.decrypt
      })

      setCachedMetrics(accountId, period, metrics)
      return res.json(metrics)
    } catch (e) {
      console.error('[ext/metrics] Failed to build metrics:', e)
      return res.status(500).json({ error: 'Failed to fetch metrics' })
    }
  })

  /**
   * @openapi
   * /addons/reload:
   *   post:
   *     summary: Reload addons by Stremio addon ID
   *     description: Re-fetches the manifest for every addon in this account matching `stremioAddonId` and updates it in place. Useful for addon developers so a call to SlickSync on deploy propagates a manifest change immediately, instead of waiting for the next scheduled sync.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [stremioAddonId]
   *             properties:
   *               stremioAddonId: { type: string, example: 'com.stremio.addon.id' }
   *     responses:
   *       200:
   *         description: Reload result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message: { type: string }
   *                 reloaded: { type: integer }
   *                 total: { type: integer }
   *                 diffs:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *                       diffs:
   *                         type: object
   *                         properties:
   *                           addedResources: { type: array, items: { type: string } }
   *                           removedResources: { type: array, items: { type: string } }
   *                           addedCatalogs: { type: array, items: { type: string } }
   *                           removedCatalogs: { type: array, items: { type: string } }
   *       400:
   *         description: stremioAddonId is required
   *       401:
   *         description: Missing or invalid API key
   *       404:
   *         description: No addons found matching that stremioAddonId in this account
   */
  // POST /ext/addons/reload
  router.post('/addons/reload', async (req, res) => {
    try {
      const { stremioAddonId } = req.body || {}
      if (!stremioAddonId) return res.status(400).json({ message: 'stremioAddonId is required' })
      const addons = await prisma.addon.findMany({ where: { accountId: req.appAccountId, stremioAddonId }, select: { id: true, name: true } })
      if (!addons || addons.length === 0) return res.status(404).json({ message: 'No addons found' })
      const { reloadAddon } = require('./addons')
      const { decrypt, encrypt, getDecryptedManifestUrl, filterManifestByResources, filterManifestByCatalogs, manifestHash } = reloadDeps
      let reloaded = 0
      const diffsByAddon = []
      for (const a of addons) {
        try {
          const r = await reloadAddon(
            prisma,
            getAccountId,
            a.id,
            req,
            { filterManifestByResources, filterManifestByCatalogs, encrypt, decrypt, getDecryptedManifestUrl, manifestHash, silent: false }
          )
          reloaded++
          if (r?.diffs && (r.diffs.addedResources?.length || r.diffs.removedResources?.length || r.diffs.addedCatalogs?.length || r.diffs.removedCatalogs?.length)) {
            diffsByAddon.push({ id: a.id, name: a.name, diffs: r.diffs })
          }
        } catch {}
      }
      return res.json({ message: 'Addons reloaded', reloaded, total: addons.length, diffs: diffsByAddon })
    } catch (e) {
      return res.status(500).json({ message: 'Failed to reload addon', error: e?.message })
    }
  })

  /**
   * @openapi
   * /addons/sync:
   *   post:
   *     summary: Reload addons by Stremio addon ID, then sync affected groups
   *     description: Same manifest reload as /addons/reload, then syncs every group that contains one of the matching addons out to its users' own accounts - so an addon update propagates all the way to end users in one call.
   *     parameters:
   *       - in: header
   *         name: Source
   *         schema: { type: string }
   *         description: Source label shown on the Discord sync notification, if one is configured (also accepted as X-Sync-Source or X-App-Name).
   *       - in: header
   *         name: Source-Logo
   *         schema: { type: string }
   *         description: Logo URL for the Discord notification (also accepted as X-Source-Logo).
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [stremioAddonId]
   *             properties:
   *               stremioAddonId: { type: string, example: 'com.stremio.addon.id' }
   *     responses:
   *       200:
   *         description: Reload + sync result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message: { type: string }
   *                 reloaded: { type: integer }
   *                 groupsSynced: { type: integer }
   *                 totalUsersSynced: { type: integer }
   *                 diffs: { type: array, items: { type: object } }
   *       400:
   *         description: stremioAddonId is required
   *       401:
   *         description: Missing or invalid API key
   *       404:
   *         description: No addons found matching that stremioAddonId in this account
   */
  // POST /ext/addons/sync
  // Reload all addons in this account that share the given stremioAddonId,
  // then sync all groups that contain any of those addons (no reload during sync)
  router.post('/addons/sync', async (req, res) => {
    try {
      const { stremioAddonId } = req.body || {}
      if (!stremioAddonId) return res.status(400).json({ message: 'stremioAddonId is required' })

      // Find all matching addons for this account
      const addons = await prisma.addon.findMany({ where: { accountId: req.appAccountId, stremioAddonId }, select: { id: true, name: true } })
      if (!addons || addons.length === 0) return res.status(404).json({ message: 'No addons found for this stremioAddonId' })

      // Reload each addon using the shared helper
      const { reloadAddon } = require('./addons')
      const { decrypt, encrypt, getDecryptedManifestUrl, filterManifestByResources, filterManifestByCatalogs, manifestHash } = reloadDeps
      let reloaded = 0
      const diffsByAddon = []
      for (const a of addons) {
        try {
          const r = await reloadAddon(
            prisma,
            getAccountId,
            a.id,
            req,
            { filterManifestByResources, filterManifestByCatalogs, encrypt, decrypt, getDecryptedManifestUrl, manifestHash, silent: false }
          )
          reloaded++
          if (r?.diffs && (r.diffs.addedResources?.length || r.diffs.removedResources?.length || r.diffs.addedCatalogs?.length || r.diffs.removedCatalogs?.length)) {
            diffsByAddon.push({ id: a.id, name: a.name, diffs: r.diffs })
          }
        } catch {}
      }

      // Find all groups (account-scoped) that contain any of these addon IDs
      const addonIds = addons.map(a => a.id)
      const groups = await prisma.group.findMany({
        where: {
          accountId: req.appAccountId,
          addons: { some: { addonId: { in: addonIds } } }
        },
        select: { id: true, userIds: true }
      })
      const groupIds = groups.map(g => g.id)

      // Resolve unsafe from account config (DB-backed)
      let unsafe = false
      try {
        const acc = await prisma.appAccount.findUnique({ where: { id: req.appAccountId }, select: { sync: true } })
        let cfg = acc?.sync
        if (cfg && typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
        if (cfg && typeof cfg.safe === 'boolean') unsafe = !cfg.safe
      } catch {}

      // Sync those groups WITHOUT reload: use exported syncGroupUsers helper with x-sync-mode=normal
      let groupsSynced = 0
      let totalUsersSynced = 0
      const allReloadDiffs = []
      for (const gid of groupIds) {
        try {
          const reqLike = { appAccountId: req.appAccountId, headers: { 'x-sync-mode': 'normal' }, body: { unsafe } }
          const r = await syncGroupUsers(prisma, getAccountId, scopedWhere, reloadDeps.decrypt, gid, reqLike)
          if (r && !r.error) {
            groupsSynced++
            totalUsersSynced += r?.syncedUsers || 0
            if (Array.isArray(r.reloadDiffs) && r.reloadDiffs.length) {
              allReloadDiffs.push(...r.reloadDiffs)
            }
          }
        } catch {}
      }

      // Count total users across all attempted groups
      let totalUsers = 0
      const allUserIds = new Set()
      for (const g of groups) {
        if (g.userIds) {
          try {
            const userIds = Array.isArray(g.userIds) ? g.userIds : JSON.parse(g.userIds || '[]')
            if (Array.isArray(userIds)) {
              userIds.forEach(id => allUserIds.add(id))
            }
          } catch {}
        }
      }
      totalUsers = allUserIds.size

      // Count total addons from all attempted groups
      let totalAddons = 0
      if (groupIds.length > 0) {
        try {
          const groupAddons = await prisma.groupAddon.findMany({
            where: { groupId: { in: groupIds } },
            select: { addonId: true }
          })
          totalAddons = new Set(groupAddons.map(ga => ga.addonId)).size
        } catch {}
      }

      // Send webhook notification
      try {
        const account = await prisma.appAccount.findUnique({ where: { id: req.appAccountId }, select: { sync: true } })
        let syncCfg = account?.sync
        if (syncCfg && typeof syncCfg === 'string') { try { syncCfg = JSON.parse(syncCfg) } catch { syncCfg = null } }
        const webhookUrl = syncCfg?.webhookUrl
        
        if (webhookUrl && (groupIds.length > 0 || diffsByAddon.length > 0)) {
          const syncSource = req.headers['source'] || req.headers['x-sync-source'] || req.headers['x-app-name'] || null
          const sourceLogo = req.headers['source-logo'] || req.headers['x-source-logo'] || null
          const sourceLabel = syncSource || null
          
          await sendSyncNotification(webhookUrl, {
            groupsCount: groups.length,
            usersCount: totalUsers,
            syncMode: 'normal', // addons/sync always uses normal mode
            diffs: diffsByAddon,
            sourceLabel: sourceLabel,
            sourceLogo: sourceLogo
          })
        }
        // Mirror to phone push (self-gates on notifyOnSync; no webhook needed).
        if (groupIds.length > 0 || diffsByAddon.length > 0) {
          const { notifyPushForType } = require('../utils/pushNotifications')
          await notifyPushForType(prisma, req.appAccountId, 'notifyOnSync', {
            title: 'Sync complete',
            body: `${groups.length} group${groups.length !== 1 ? 's' : ''}, ${totalUsers} user${totalUsers !== 1 ? 's' : ''} synced`,
            icon: '/android-chrome-192x192.png',
            url: '/activity',
          })
        }
      } catch {}

      return res.json({ message: 'Reload and sync completed', reloaded, groupsSynced, totalUsersSynced, diffs: diffsByAddon })
    } catch (e) {
      return res.status(500).json({ message: 'Failed to reload and sync by stremioAddonId', error: e?.message })
    }
  })

  /**
   * @openapi
   * /groups/sync:
   *   post:
   *     summary: Sync all groups in this account
   *     description: Pushes every group's current addon configuration out to its users' own accounts, regardless of which addon changed. Heavier than /addons/sync - use that instead when you know the specific stremioAddonId that changed.
   *     parameters:
   *       - in: header
   *         name: Source
   *         schema: { type: string }
   *         description: Source label shown on the Discord sync notification, if one is configured (also accepted as X-Sync-Source or X-App-Name).
   *       - in: header
   *         name: Source-Logo
   *         schema: { type: string }
   *         description: Logo URL for the Discord notification (also accepted as X-Source-Logo).
   *     responses:
   *       200:
   *         description: Sync result
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message: { type: string }
   *                 ok: { type: integer, description: 'Groups synced without error' }
   *                 fail: { type: integer }
   *                 totalSynced: { type: integer, description: 'Users successfully synced across all groups' }
   *                 totalFailed: { type: integer }
   *       401:
   *         description: Missing or invalid API key
   */
  // POST /ext/groups/sync
  router.post('/groups/sync', async (req, res) => {
    try {
      const groups = await prisma.group.findMany({ where: { accountId: req.appAccountId }, select: { id: true, name: true, userIds: true } })
      let totalSynced = 0
      let totalFailed = 0
      const attemptedGroupIds = groups.map(g => g.id)
      
      // Count total users across all attempted groups
      let totalUsers = 0
      const allUserIds = new Set()
      for (const g of groups) {
        if (g.userIds) {
          try {
            const userIds = Array.isArray(g.userIds) ? g.userIds : JSON.parse(g.userIds || '[]')
            if (Array.isArray(userIds)) {
              userIds.forEach(id => allUserIds.add(id))
            }
          } catch {}
        }
      }
      totalUsers = allUserIds.size
      
      // Get sync mode from account config
      let syncMode = 'normal'
      try {
        const account = await prisma.appAccount.findUnique({ where: { id: req.appAccountId }, select: { sync: true } })
        let syncCfg = account?.sync
        if (syncCfg && typeof syncCfg === 'string') { try { syncCfg = JSON.parse(syncCfg) } catch { syncCfg = null } }
        if (syncCfg && syncCfg.mode === 'advanced') syncMode = 'advanced'
      } catch {}
      
      const allReloadDiffs = []
      for (const g of groups) {
        try {
          const r = await syncGroupUsers(prisma, getAccountId, scopedWhere, reloadDeps.decrypt, g.id, req)
          if (r && !r.error) {
            totalSynced += r.syncedUsers || 0
            totalFailed += r.failedUsers || 0
            if (Array.isArray(r.reloadDiffs) && r.reloadDiffs.length) {
              allReloadDiffs.push(...r.reloadDiffs)
            }
          } else {
            console.error(`Failed to sync group ${g.id}:`, r?.error || 'Unknown error')
            totalFailed++
          }
        } catch (e) {
          console.error(`Error syncing group ${g.id}:`, e?.message || e)
          totalFailed++
        }
      }
      
      // Count total addons from all attempted groups (even if some failed)
      let totalAddons = 0
      if (attemptedGroupIds.length > 0) {
        try {
          const groupAddons = await prisma.groupAddon.findMany({
            where: { groupId: { in: attemptedGroupIds } },
            select: { addonId: true }
          })
          totalAddons = new Set(groupAddons.map(ga => ga.addonId)).size
        } catch {}
      }
      
      // Send webhook notification
      try {
        const account = await prisma.appAccount.findUnique({ where: { id: req.appAccountId }, select: { sync: true } })
        let syncCfg = account?.sync
        if (syncCfg && typeof syncCfg === 'string') { try { syncCfg = JSON.parse(syncCfg) } catch { syncCfg = null } }
        const webhookUrl = syncCfg?.webhookUrl
        
        if (webhookUrl && groups.length > 0) {
          const syncSource = req.headers['source'] || req.headers['x-sync-source'] || req.headers['x-app-name'] || null
          const sourceLogo = req.headers['source-logo'] || req.headers['x-source-logo'] || null
          const sourceLabel = syncSource || null
          
          await sendSyncNotification(webhookUrl, {
            groupsCount: groups.length,
            usersCount: totalUsers,
            syncMode: syncMode,
            diffs: allReloadDiffs,
            sourceLabel: sourceLabel,
            sourceLogo: sourceLogo
          })
        }
        // Mirror to phone push (self-gates on notifyOnSync; no webhook needed).
        if (groups.length > 0) {
          const { notifyPushForType } = require('../utils/pushNotifications')
          await notifyPushForType(prisma, req.appAccountId, 'notifyOnSync', {
            title: 'Sync complete',
            body: `${groups.length} group${groups.length !== 1 ? 's' : ''}, ${totalUsers} user${totalUsers !== 1 ? 's' : ''} synced`,
            icon: '/android-chrome-192x192.png',
            url: '/activity',
          })
        }
      } catch {}
      
      const ok = Math.max(0, groups.length - totalFailed)
      return res.json({ message: 'Sync triggered', ok, fail: totalFailed, totalSynced, totalFailed })
    } catch (e) {
      return res.status(500).json({ message: 'Failed to sync all groups', error: e?.message })
    }
  })

  return router
}


