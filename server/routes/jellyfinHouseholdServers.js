const express = require('express');
const { mountSignInSteps, describeProbe, sendError } = require('../utils/jellyfinConnect');
const jfAuth = require('../providers/jellyfinAuth');
const servers = require('../utils/jellyfinHouseholdServers');
const { serverDisplayName } = require('../utils/jellyfinServerCollections');

// Jellyfin servers on the Addons page, given to groups like an addon - see
// utils/jellyfinHouseholdServers.js. Mounted under /api/jellyfin/household-servers.
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();
  const accountOf = (req) => getAccountId(req) || 'default';

  // Checking an address: what the server calls itself fills in the display name.
  router.post('/check', async (req, res) => {
    try {
      const probe = await jfAuth.probeServer(req.body?.serverUrl);
      const display = jfAuth.displayServer(probe.serverUrl);
      res.json({ ...describeProbe(probe), suggestedName: serverDisplayName(probe.serverName, display) });
    } catch (error) {
      sendError(res, error, 'Could not reach the server');
    }
  });

  // POST /quick-connect and /quick-connect-status for the administrator's sign-in.
  mountSignInSteps(router);

  router.get('/', async (req, res) => {
    try {
      res.json({ servers: await servers.listServers(prisma, accountOf(req)) });
    } catch (error) {
      sendError(res, error, 'Could not load the Jellyfin servers');
    }
  });

  router.post('/', async (req, res) => {
    try {
      const b = req.body || {};
      const server = await servers.addServer(prisma, accountOf(req), {
        url: b.serverUrl,
        name: b.name,
        groupIds: b.groupIds,
        auth: { method: b.method, apiKey: b.apiKey, username: b.username, password: b.password, secret: b.secret, device: b.device },
      });
      const changes = [];
      for (const groupId of server.groupIds) changes.push(...await servers.syncForGroup(prisma, accountOf(req), groupId).catch(() => []));
      res.json({ id: server.id, name: server.name, changes });
    } catch (error) {
      sendError(res, error, 'Could not add the server');
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const b = req.body || {};
      const server = await servers.updateServer(prisma, accountOf(req), String(req.params.id), { name: b.name, groupIds: b.groupIds });
      res.json({ id: server.id, name: server.name, groupIds: server.groupIds });
    } catch (error) {
      sendError(res, error, 'Could not change the server');
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await servers.removeServer(prisma, accountOf(req), String(req.params.id));
      res.json({ removed: true });
    } catch (error) {
      sendError(res, error, 'Could not remove the server');
    }
  });

  router.post('/:id/sync', async (req, res) => {
    try {
      const changes = await servers.syncServer(prisma, accountOf(req), String(req.params.id), { add: true });
      res.json({ changes });
    } catch (error) {
      sendError(res, error, 'Could not sync the server');
    }
  });

  // A person's page.
  router.get('/people/:personId', async (req, res) => {
    try {
      res.json({ servers: await servers.personServers(prisma, accountOf(req), String(req.params.personId)) });
    } catch (error) {
      sendError(res, error, 'Could not load their servers');
    }
  });

  router.post('/:id/people/:personId/quick-connect', async (req, res) => {
    try {
      res.json(await servers.approveCode(prisma, accountOf(req), String(req.params.id), String(req.params.personId), req.body?.code));
    } catch (error) {
      sendError(res, error, 'Could not approve the code');
    }
  });

  router.post('/:id/people/:personId/password', async (req, res) => {
    try {
      res.json(await servers.revealPassword(prisma, accountOf(req), String(req.params.id), String(req.params.personId)));
    } catch (error) {
      sendError(res, error, 'Could not read the password');
    }
  });

  return router;
};
