const express = require('express');
const { signInFromBody, rememberSignIn, jellyfinFields, findJellyfinUser, mountSignInSteps, sendError } = require('../utils/jellyfinConnect');
const { serverKindLabel } = require('../providers/jellyfinAuth');
const household = require('../utils/jellyfinProfiles');

// Admin side of Jellyfin-compatible servers: Add User and reconnecting a
// person whose sign-in stopped working. See utils/jellyfinConnect.js for the
// sign-in itself, shared with the public sign-in pages and invitations.
module.exports = ({ prisma, getAccountId, encrypt, decrypt, assignUserToGroup }) => {
  const router = express.Router();

  // POST /probe, /quick-connect, /quick-connect-status
  mountSignInSteps(router);

  // Sign in and either add a new person or reconnect an existing one.
  router.post('/connect', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const { probe, login } = await signInFromBody(req.body);
      if (!req.body?.quickConnectSecret && typeof req.body?.password === 'string') {
        reqPassword.set(login, { password: req.body.password, loginName: String(req.body.jellyfinUsername || '') });
      }
      // Whoever already holds this login keeps working (see rememberSignIn).
      await rememberSignIn(prisma, encrypt, probe, login);
      const fields = jellyfinFields(probe, login, encrypt, req);
      const { identityEmail } = require('../providers/jellyfinAuth');
      const email = identityEmail(probe.serverUrl, login.userId);

      // Reconnect: the person keeps everything, only the sign-in changes.
      if (req.body?.userId) {
        const target = await prisma.user.findFirst({ where: { id: String(req.body.userId), accountId } });
        if (!target) return res.status(404).json({ error: 'User not found' });
        const other = await findJellyfinUser(prisma, accountId, login, probe);
        if (other && other.id !== target.id) {
          return res.status(409).json({ error: `That server user is already added as ${other.username}` });
        }
        const updated = await prisma.user.update({
          where: { id: target.id },
          data: {
            ...fields,
            email,
            stremioAuthKey: null,
            nuvioRefreshToken: null,
            nuvioUserId: null,
            isActive: true,
            providerConnectionError: null,
            providerConnectionErrorAt: null,
          },
        });
        const profiles = await bringHousehold(updated, probe, login);
        return res.json({ success: true, user: { id: target.id, username: target.username, email }, providerType: 'jellyfin', household: profiles });
      }

      const existing = await findJellyfinUser(prisma, accountId, login, probe);
      if (existing) {
        return res.status(409).json({ error: `${login.userName || 'That user'} is already added as ${existing.username}` });
      }

      const wanted = String(req.body?.username || login.userName || 'jellyfin-user').trim() || 'jellyfin-user';
      let finalUsername = wanted;
      for (let attempt = 1; await prisma.user.findFirst({ where: { accountId, username: finalUsername } }); attempt++) {
        if (attempt > 100) return res.status(409).json({ error: 'Pick a different name for this person' });
        finalUsername = `${wanted}${attempt}`;
      }

      const created = await prisma.user.create({
        data: {
          accountId,
          username: finalUsername,
          email,
          ...fields,
          isActive: true,
          colorIndex: Number.isInteger(req.body?.colorIndex) ? req.body.colorIndex : 0,
        },
      });

      const groupName = String(req.body?.groupName || '').trim();
      if (groupName && typeof assignUserToGroup === 'function') {
        try {
          let group = await prisma.group.findFirst({ where: { accountId, name: groupName } });
          if (!group) group = await prisma.group.create({ data: { accountId, name: groupName, description: `Group created for ${finalUsername}` } });
          await assignUserToGroup(prisma, created.id, group.id, req);
        } catch (e) {
          console.warn('[Jellyfin] Could not add the new person to their group:', e?.message);
        }
      }

      // Someone added on their own who was a profile of another person here
      // is read as themselves from now on, not twice.
      await claimProfileForPerson(created, probe, login);
      const profiles = await bringHousehold(created, probe, login);

      res.json({
        success: true,
        user: { id: created.id, username: finalUsername, email },
        providerType: 'jellyfin',
        server: { kind: probe.kind, label: serverKindLabel(probe.kind), name: probe.serverName },
        household: profiles,
      });
    } catch (error) {
      sendError(res, error, 'Could not sign in to the server');
    }
  });

  // Everyone else on an AIOStreams or AIOMetadata configuration comes along
  // as this person's profiles, signed in with the password just typed (never
  // stored). A Quick Connect sign-in has no password, so they are listed and
  // the person page asks for it once.
  async function bringHousehold(person, probe, login) {
    if (!household.hasHousehold(probe.kind)) return [];
    const typed = reqPassword.get(login) || {};
    // Read-only watch for outside changes (utils/aiostreamsConfig.js).
    await require('../utils/aiostreamsConfig').rememberConfigAccess(prisma, encrypt, person, {
      probe, typedLogin: typed.loginName || null, password: typed.password ?? null,
    });
    try {
      const found = await household.signInHousehold({
        probe,
        login,
        password: typed.password ?? null,
        typedLogin: typed.loginName || null,
      });
      await household.saveHousehold(prisma, encrypt, person, found);
      return household.describeHousehold(prisma, person.id);
    } catch (e) {
      console.warn('[Jellyfin] Could not bring in the household:', e?.message);
      return [];
    }
  }

  async function claimProfileForPerson(person, probe, login) {
    const owners = await prisma.user.findMany({
      where: { accountId: person.accountId, providerType: 'jellyfin', jellyfinServerUrl: probe.serverUrl, id: { not: person.id } },
      select: { id: true },
    });
    if (!owners.length) return;
    await prisma.jellyfinProfile.updateMany({
      where: { ownerUserId: { in: owners.map((o) => o.id) }, jellyfinUserId: login.userId, ownUserId: null },
      data: { ownUserId: person.id },
    });
  }

  // The password reaches bringHousehold without riding on the login object
  // that gets passed around and logged.
  const reqPassword = new WeakMap();

  async function loadProfile(req, res) {
    const profile = await prisma.jellyfinProfile.findFirst({ where: { id: String(req.params.profileId), accountId: getAccountId(req) } });
    if (!profile) { res.status(404).json({ error: 'Profile not found' }); return null; }
    const owner = await prisma.user.findFirst({ where: { id: profile.ownerUserId, accountId: getAccountId(req) } });
    if (!owner) { res.status(404).json({ error: 'Person not found' }); return null; }
    return { profile, owner };
  }

  // The AIOStreams Collections page: SlickSync's catalogs as collections in
  // AIOStreams' apps, per AIOStreams account (utils/aioCollections.js).

  // A person whose collections can be arranged: someone who signs in with
  // AIOStreams. Stremio and Nuvio people are managed elsewhere (Nuvio
  // Collections), even with the AIOStreams watch history link on.
  async function collectionsPerson(accountId, userId) {
    if (!userId) return null;
    return prisma.user.findFirst({
      where: { id: String(userId), accountId, providerType: 'jellyfin', jellyfinServerKind: 'aiostreams' },
      select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, aioConfigId: true, aioConfigPassword: true, watchStateEnabled: true, traxToken: true },
    });
  }

  // One of that person's household profiles, when the page is on a profile.
  // A profile can have collections of its own; until it does, it sees its
  // login's (utils/aioProfileVariants.js sets that up in AIOStreams).
  async function collectionsProfile(person, profileId) {
    if (!profileId) return null;
    const profile = await prisma.jellyfinProfile.findFirst({ where: { id: String(profileId), ownerUserId: person.id }, select: { id: true, name: true } });
    if (!profile) throw Object.assign(new Error('That profile is not on this AIOStreams account'), { status: 404 });
    return profile;
  }

  router.get('/collections/accounts', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const people = await prisma.user.findMany({
        where: { accountId, isActive: true, providerType: 'jellyfin', jellyfinServerKind: 'aiostreams' },
        select: { id: true, username: true, email: true, avatarUrl: true, colorIndex: true, watchStateEnabled: true, traxToken: true, aioConfigPassword: true },
        orderBy: { username: 'asc' },
      });
      const profiles = people.length
        ? await prisma.jellyfinProfile.findMany({ where: { ownerUserId: { in: people.map((p) => p.id) } }, select: { id: true, ownerUserId: true, name: true }, orderBy: { name: 'asc' } })
        : [];
      const own = await require('../utils/aioCollections').ownProfileIds(prisma, accountId);
      res.json({
        accounts: people.map((p) => ({
          id: p.id,
          name: p.username,
          email: p.email || null,
          avatarUrl: p.avatarUrl || null,
          colorIndex: p.colorIndex ?? null,
          linked: !!(p.watchStateEnabled && p.traxToken),
          // Giving a profile its own collections means a change in AIOStreams,
          // which needs the configuration password SlickSync kept.
          canSplit: !!p.aioConfigPassword,
          profiles: profiles.filter((x) => x.ownerUserId === p.id).map((x) => ({ id: x.id, name: x.name, own: own.has(x.id) })),
        })),
      });
    } catch (error) {
      sendError(res, error, 'Could not read the AIOStreams accounts');
    }
  });

  router.get('/collections', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const person = await collectionsPerson(accountId, req.query.userId);
      if (!person) return res.status(404).json({ error: 'Pick an AIOStreams account' });
      const profile = await collectionsProfile(person, req.query.profileId);
      const { loadCollections, membersOf, coverOf, ownProfileIds } = require('../utils/aioCollections');
      const { configured, collections, lists } = await loadCollections(prisma, accountId, person.id, profile?.id || null);
      res.json({
        configured,
        profile: profile ? { id: profile.id, name: profile.name, own: (await ownProfileIds(prisma, accountId)).has(profile.id) } : null,
        linked: !!(person.watchStateEnabled && person.traxToken),
        collections: collections.map((c) => {
          const members = membersOf(c, lists);
          // When the cover is just the first title's poster, which title -
          // so the page can show that poster the way its poster cards do.
          const ownCover = c.coverUrl || lists.find((l) => l.id === c.catalogIds[0])?.coverImageUrl;
          const coverTitleId = ownCover ? null : members.find((m) => m.poster)?.id || null;
          return { ...c, titles: members.length, cover: coverOf(c, lists, members), coverTitleId };
        }),
        catalogs: lists.map((l) => {
          let items = [];
          try { items = JSON.parse(l.itemsJson || '[]').filter((i) => /^tt\d+$/.test(String(i?.id || ''))); } catch {}
          // Same fallback a collection's cover uses: the first title's poster.
          const poster = items.find((i) => i?.poster)?.poster || null;
          return { id: l.id, name: l.name, titles: items.length, cover: l.coverImageUrl || poster };
        }),
      });
    } catch (error) {
      sendError(res, error, 'Could not read the collections');
    }
  });

  router.put('/collections', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const person = await collectionsPerson(accountId, req.body?.userId);
      if (!person) return res.status(404).json({ error: 'Pick an AIOStreams account' });
      const profile = await collectionsProfile(person, req.body?.profileId);
      const { saveCollections } = require('../utils/aioCollections');
      const { setProfileVariant } = require('../utils/aioProfileVariants');
      const reset = req.body?.reset === true;
      if (profile && reset) {
        // Back to the login's collections. The variant goes too; if AIOStreams
        // can't be reached, the profile's link already falls back to the login's.
        await saveCollections(prisma, accountId, person.id, null, profile.id);
        try { await setProfileVariant(prisma, decrypt, person, profile, false); }
        catch (e) { console.warn('[Collections] could not remove the profile variant:', e?.message); }
        return res.json({ success: true });
      }
      await saveArrangement(accountId, person, profile, reset ? null : req.body?.collections);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, 'Could not save the collections');
    }
  });

  // Keep an arrangement for an account or one of its profiles. A profile's
  // first arrangement makes it the profile's own - that is set up in
  // AIOStreams before anything is kept, so nothing is saved that the profile
  // would never see.
  async function saveArrangement(accountId, person, profile, collections) {
    const { saveCollections, ownProfileIds } = require('../utils/aioCollections');
    if (profile && collections !== null && !(await ownProfileIds(prisma, accountId)).has(profile.id)) {
      await require('../utils/aioProfileVariants').setProfileVariant(prisma, decrypt, person, profile, true);
    }
    await saveCollections(prisma, accountId, person.id, collections, profile?.id || null);
  }

  // Export (and share codes, made from the same thing in the browser): the
  // collections with the catalogs they hold, titles included.
  router.get('/collections/export', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const person = await collectionsPerson(accountId, req.query.userId);
      if (!person) return res.status(404).json({ error: 'Pick an AIOStreams account' });
      const profile = await collectionsProfile(person, req.query.profileId);
      res.json(await require('../utils/aioCollections').exportCollections(prisma, accountId, person.id, profile?.id || null));
    } catch (error) {
      sendError(res, error, 'Could not export the collections');
    }
  });

  // Import a file or share code: its collections are added after the ones
  // already here (or replace them with mode 'replace'); catalogs it needs
  // are found here or made.
  router.post('/collections/import', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const person = await collectionsPerson(accountId, req.body?.userId);
      if (!person) return res.status(404).json({ error: 'Pick an AIOStreams account' });
      const profile = await collectionsProfile(person, req.body?.profileId);
      const aio = require('../utils/aioCollections');
      const imported = await aio.importCollections(prisma, accountId, req.body?.payload);
      const current = req.body?.mode === 'replace'
        ? []
        : (await aio.loadCollections(prisma, accountId, person.id, profile?.id || null)).collections;
      await saveArrangement(accountId, person, profile, [...current, ...imported.collections]);
      res.json({ added: imported.collections.length, catalogsCreated: imported.catalogsCreated, catalogsReused: imported.catalogsReused });
    } catch (error) {
      sendError(res, error, 'Could not import the collections');
    }
  });

  // Jellyfin Collections page: SlickSync catalogs as real collections on the
  // household's own Jellyfin servers (utils/jellyfinServerCollections.js).
  const serverCollections = require('../utils/jellyfinServerCollections');

  async function collectionsServer(accountId, key) {
    const servers = await serverCollections.serversFor(prisma, accountId);
    const server = servers.find((s) => s.key === String(key || ''));
    if (!server) throw Object.assign(new Error('That Jellyfin server is not one anyone here signs in to'), { status: 404 });
    return server;
  }

  router.get('/server-collections/servers', async (req, res) => {
    try {
      const servers = await serverCollections.serversFor(prisma, getAccountId(req));
      const { jfRequest } = require('../providers/jellyfinAuth');
      res.json({
        servers: await Promise.all(servers.map(async (s) => {
          let name = null;
          try { name = (await jfRequest(s.url, '/System/Info/Public', { timeoutMs: 5000 }))?.ServerName || null; } catch {}
          return { key: s.key, name: serverCollections.serverDisplayName(name, s.address), address: s.address, people: s.people.map((p) => ({ id: p.id, username: p.username })) };
        })),
      });
    } catch (error) {
      sendError(res, error, 'Could not read the Jellyfin servers');
    }
  });

  router.get('/server-collections', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const server = await collectionsServer(accountId, req.query.server);
      res.json(await serverCollections.describeServer(prisma, decrypt, accountId, server));
    } catch (error) {
      sendError(res, error, 'Could not read the Jellyfin collections');
    }
  });

  router.put('/server-collections', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const server = await collectionsServer(accountId, req.body?.server);
      const catalogId = String(req.body?.catalogId || '');
      const list = await prisma.customList.findFirst({ where: { id: catalogId, accountId }, select: { id: true } });
      if (!list) return res.status(404).json({ error: 'Catalog not found' });
      await serverCollections.setCatalog(prisma, decrypt, accountId, server, list.id, req.body?.on === true);
      res.json(await serverCollections.describeServer(prisma, decrypt, accountId, server));
    } catch (error) {
      sendError(res, error, 'Could not change the Jellyfin collection');
    }
  });

  router.post('/server-collections/sync', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const server = await collectionsServer(accountId, req.body?.server);
      await serverCollections.syncServer(prisma, decrypt, accountId, server);
      res.json(await serverCollections.describeServer(prisma, decrypt, accountId, server));
    } catch (error) {
      sendError(res, error, 'Could not sync the Jellyfin collections');
    }
  });

  // Opt-in: Vault key changes also update this AIOStreams person's debrid
  // keys inside their configuration (utils/aioServiceKeys.js).
  router.get('/users/:id/aio-rotate-keys', async (req, res) => {
    try {
      res.json(await require('../utils/aioServiceKeys').statusFor(prisma, getAccountId(req), req.params.id));
    } catch (error) {
      sendError(res, error, 'Could not read that setting');
    }
  });

  router.put('/users/:id/aio-rotate-keys', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const keys = require('../utils/aioServiceKeys');
      const status = await keys.statusFor(prisma, accountId, req.params.id);
      if (!status.available) return res.status(404).json({ error: 'Not an AIOStreams person' });
      await keys.setEnabled(prisma, accountId, String(req.params.id), req.body?.enabled === true);
      res.json(await keys.statusFor(prisma, accountId, req.params.id));
    } catch (error) {
      sendError(res, error, 'Could not change that setting');
    }
  });

  // A Jellyfin person's age limit on their server (utils/jellyfinParental.js).
  // What AIOStreams itself says about this person's configuration, and a
  // one-off "test this title" search (utils/aioHealth.js). Read-only.
  router.get('/users/:id/aio-health', async (req, res) => {
    try {
      res.json(await require('../utils/aioHealth').healthFor(prisma, decrypt, getAccountId(req), String(req.params.id), { range: req.query.range === '7d' ? '7d' : '24h' }));
    } catch (error) {
      sendError(res, error, 'Could not read AIOStreams');
    }
  });

  router.post('/users/:id/aio-test-search', async (req, res) => {
    try {
      res.json(await require('../utils/aioHealth').testSearch(prisma, decrypt, getAccountId(req), String(req.params.id), { type: req.body?.type, id: req.body?.id }));
    } catch (error) {
      sendError(res, error, 'Could not run the search');
    }
  });

  // Every version of their AIOStreams configuration SlickSync has seen, and
  // putting one back (utils/aioConfigHistory.js).
  router.get('/users/:id/aio-history', async (req, res) => {
    try {
      res.json(await require('../utils/aioConfigHistory').historyFor(prisma, getAccountId(req), String(req.params.id)));
    } catch (error) {
      sendError(res, error, 'Could not read the configuration history');
    }
  });

  router.post('/users/:id/aio-history/:snapshotId/restore', async (req, res) => {
    try {
      const keep = req.body?.keep || {};
      await require('../utils/aioConfigHistory').restore(prisma, decrypt, getAccountId(req), String(req.params.id), String(req.params.snapshotId), {
        keepServices: keep.services !== false,
        keepPersonas: keep.users !== false,
        keepApiKeys: keep.apiKeys !== false,
      });
      res.json(await require('../utils/aioConfigHistory').historyFor(prisma, getAccountId(req), String(req.params.id)));
    } catch (error) {
      sendError(res, error, 'Could not put that version back');
    }
  });

  router.get('/users/:id/age-limit', async (req, res) => {
    try {
      res.json(await require('../utils/jellyfinParental').getAgeLimit(prisma, decrypt, getAccountId(req), req.params.id));
    } catch (error) {
      sendError(res, error, 'Could not read the age limit');
    }
  });

  router.put('/users/:id/age-limit', async (req, res) => {
    try {
      res.json(await require('../utils/jellyfinParental').setAgeLimit(prisma, decrypt, getAccountId(req), req.params.id, {
        value: req.body?.value ?? null,
        blockUnrated: typeof req.body?.blockUnrated === 'boolean' ? req.body.blockUnrated : undefined,
      }));
    } catch (error) {
      sendError(res, error, 'Could not set the age limit');
    }
  });

  // Real Jellyfin servers an invitation can make accounts on: those where
  // someone here signs in as an administrator (utils/jellyfinInviteAccounts.js).
  router.get('/invite-servers', async (req, res) => {
    try {
      res.json({ servers: await require('../utils/jellyfinInviteAccounts').inviteServers(prisma, decrypt, getAccountId(req)) });
    } catch (error) {
      sendError(res, error, 'Could not read the Jellyfin servers');
    }
  });

  // Whether what this person finishes elsewhere is marked played on their
  // real Jellyfin server (utils/jellyfinMarkPlayed.js), and switching it.
  router.get('/users/:id/mark-played', async (req, res) => {
    try {
      res.json(await require('../utils/jellyfinMarkPlayed').statusFor(prisma, getAccountId(req), String(req.params.id)));
    } catch (error) {
      sendError(res, error, 'Could not read that setting');
    }
  });

  router.put('/users/:id/mark-played', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const person = await prisma.user.findFirst({ where: { id: String(req.params.id), accountId }, select: { id: true } });
      if (!person) return res.status(404).json({ error: 'Person not found' });
      const mp = require('../utils/jellyfinMarkPlayed');
      await mp.setEnabled(prisma, accountId, person.id, req.body?.enabled === true);
      res.json(await mp.statusFor(prisma, accountId, person.id));
    } catch (error) {
      sendError(res, error, 'Could not change that setting');
    }
  });

  // What is signed in as someone on a real Jellyfin server, and signing a
  // device out (utils/jellyfinDevices.js).
  router.get('/users/:id/devices', async (req, res) => {
    try {
      res.json(await require('../utils/jellyfinDevices').listDevices(prisma, decrypt, getAccountId(req), req.params.id));
    } catch (error) {
      sendError(res, error, 'Could not read the signed-in devices');
    }
  });

  router.delete('/users/:id/devices/:deviceId', async (req, res) => {
    try {
      res.json(await require('../utils/jellyfinDevices').signOutDevice(prisma, decrypt, getAccountId(req), req.params.id, req.params.deviceId));
    } catch (error) {
      sendError(res, error, 'Could not sign that device out');
    }
  });

  // Sign a TV (or any Jellyfin app) in with the Quick Connect code it shows,
  // as this person or one of their household profiles: SlickSync approves the
  // code with that sign-in, and the server signs the device in as them.
  // AIOStreams and Jellyfin both sign the device in as whoever approved it.
  router.post('/users/:id/quick-connect', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const person = await prisma.user.findFirst({
        where: { id: String(req.params.id), accountId, providerType: 'jellyfin' },
        select: { id: true, username: true, accountId: true, jellyfinServerUrl: true, jellyfinUserId: true, jellyfinToken: true },
      });
      if (!person || !person.jellyfinServerUrl) return res.status(404).json({ error: 'Person not found' });
      const code = String(req.body?.code || '').replace(/\D/g, '');
      if (code.length < 4 || code.length > 10) return res.status(400).json({ error: 'Type the code the TV shows' });

      let token = person.jellyfinToken;
      let who = person.username;
      if (req.body?.profileId) {
        const profile = await prisma.jellyfinProfile.findFirst({ where: { id: String(req.body.profileId), ownerUserId: person.id }, select: { name: true, token: true, needsPin: true } });
        if (!profile) return res.status(404).json({ error: 'That profile is not in this household' });
        if (!profile.token) {
          return res.status(409).json({ error: `Sign ${profile.name} in on SlickSync first${profile.needsPin ? ' with their PIN' : ''} (Users page -> household)` });
        }
        token = profile.token;
        who = profile.name;
      }
      if (!token) return res.status(409).json({ error: `Reconnect ${person.username} first` });

      const { jfRequest, deviceIdFor } = require('../providers/jellyfinAuth');
      let approved;
      try {
        approved = await jfRequest(person.jellyfinServerUrl, `/QuickConnect/Authorize?code=${encodeURIComponent(code)}`, {
          method: 'POST',
          token: decrypt(token, { appAccountId: person.accountId || 'default' }),
          deviceId: deviceIdFor(person.jellyfinServerUrl, person.jellyfinUserId),
        });
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          return res.status(400).json({ error: 'The server turned it down - Quick Connect may be off on it, or that code is for another server' });
        }
        // Jellyfin answers an unknown or expired code with a bare 404.
        if (e.status === 404 || e.status === 400) {
          return res.status(400).json({ error: "That code didn't work - codes change every few minutes, so check the TV and try again" });
        }
        throw e;
      }
      if (approved !== true) {
        return res.status(400).json({ error: "That code didn't work - codes change every few minutes, so check the TV and try again" });
      }
      res.json({ success: true, who });
    } catch (error) {
      sendError(res, error, 'Could not sign the device in');
    }
  });

  // A person's household, and - for someone separated out of one - whose it is.
  router.get('/users/:id/household', async (req, res) => {
    try {
      const accountId = getAccountId(req);
      const person = await prisma.user.findFirst({ where: { id: String(req.params.id), accountId }, select: { id: true, providerType: true, jellyfinServerKind: true } });
      if (!person) return res.status(404).json({ error: 'User not found' });
      const profiles = person.providerType === 'jellyfin' ? await household.describeHousehold(prisma, person.id) : [];
      const membership = await prisma.jellyfinProfile.findFirst({ where: { ownUserId: person.id, accountId } });
      let partOf = null;
      if (membership) {
        const owner = await prisma.user.findFirst({ where: { id: membership.ownerUserId, accountId }, select: { id: true, username: true } });
        if (owner) partOf = { profileId: membership.id, name: membership.name, owner };
      }
      const full = await prisma.user.findFirst({ where: { id: person.id }, select: { providerType: true, jellyfinServerKind: true, aioConfigId: true, aioConfigPassword: true } });
      // Household users can be added, and PINs changed, here (utils/aioHousehold.js).
      res.json({ profiles, partOf, kind: person.jellyfinServerKind || null, canManage: require('../utils/aioHousehold').canManage(full) });
    } catch (error) {
      sendError(res, error, 'Could not read the household');
    }
  });

  // Add a household user to their AIOStreams configuration (utils/aioHousehold.js).
  router.post('/users/:id/household', async (req, res) => {
    try {
      const owner = await prisma.user.findFirst({ where: { id: String(req.params.id), accountId: getAccountId(req) } });
      if (!owner) return res.status(404).json({ error: 'User not found' });
      const result = await require('../utils/aioHousehold').addPersona(prisma, decrypt, encrypt, owner, {
        name: req.body?.name, pin: req.body?.pin ?? null, history: req.body?.history,
      });
      res.json({ success: true, ...result, profiles: await household.describeHousehold(prisma, owner.id) });
    } catch (error) {
      sendError(res, error, 'Could not add the household user');
    }
  });

  // Change or remove a household user's PIN.
  router.post('/household/:profileId/pin', async (req, res) => {
    try {
      const found = await loadProfile(req, res);
      if (!found) return;
      const result = await require('../utils/aioHousehold').setPersonaPin(prisma, decrypt, encrypt, found.owner, found.profile, req.body?.pin ?? null);
      res.json({ success: true, ...result, profiles: await household.describeHousehold(prisma, found.owner.id) });
    } catch (error) {
      sendError(res, error, 'Could not change the PIN');
    }
  });

  router.post('/household/:profileId/track', async (req, res) => {
    try {
      const found = await loadProfile(req, res);
      if (!found) return;
      await household.setTracked(prisma, found.profile, req.body?.tracked !== false);
      res.json({ success: true, profiles: await household.describeHousehold(prisma, found.owner.id) });
    } catch (error) {
      sendError(res, error, 'Could not change that profile');
    }
  });

  router.post('/household/:profileId/sign-in', async (req, res) => {
    try {
      const found = await loadProfile(req, res);
      if (!found) return;
      await household.signInProfile(prisma, encrypt, { ...found, password: String(req.body?.password ?? ''), pin: req.body?.pin ? String(req.body.pin) : null });
      res.json({ success: true, profiles: await household.describeHousehold(prisma, found.owner.id) });
    } catch (error) {
      sendError(res, error, 'Could not sign that profile in');
    }
  });

  router.post('/household/:profileId/separate', async (req, res) => {
    try {
      const found = await loadProfile(req, res);
      if (!found) return;
      const result = await household.separateProfile(prisma, found);
      res.json({ success: true, ...result, profiles: await household.describeHousehold(prisma, found.owner.id) });
    } catch (error) {
      sendError(res, error, 'Could not separate that profile');
    }
  });

  router.post('/household/:profileId/merge-back', async (req, res) => {
    try {
      const found = await loadProfile(req, res);
      if (!found) return;
      const result = await household.mergeProfileBack(prisma, found);
      res.json({ success: true, ...result, profiles: await household.describeHousehold(prisma, found.owner.id) });
    } catch (error) {
      sendError(res, error, 'Could not merge that profile back');
    }
  });

  return router;
};
