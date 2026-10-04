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
      const { saveCollections, ownProfileIds } = require('../utils/aioCollections');
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
      if (profile && !(await ownProfileIds(prisma, accountId)).has(profile.id)) {
        // The first change makes it the profile's own - set that up in
        // AIOStreams before keeping anything, so nothing is saved that the
        // profile would never see.
        await setProfileVariant(prisma, decrypt, person, profile, true);
      }
      await saveCollections(prisma, accountId, person.id, reset ? null : req.body?.collections, profile?.id || null);
      res.json({ success: true });
    } catch (error) {
      sendError(res, error, 'Could not save the collections');
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
      res.json({ profiles, partOf, kind: person.jellyfinServerKind || null });
    } catch (error) {
      sendError(res, error, 'Could not read the household');
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
