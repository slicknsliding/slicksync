const express = require('express');
const { publicMessage } = require('../utils/publicError');
const { isOutage, OUTAGE_ANSWER } = require('../utils/outage');
const { recentlyWatchedGroups, latestProfileLabel } = require('../utils/memberHome');
const { buildStremioLinks, buildNuvioAppUrl } = require('../utils/appLinks');
const jwt = require('jsonwebtoken');
const { StremioAPIClient } = require('stremio-api-client');
const { validateStremioAuthKey } = require('../utils/stremio');
const { startNuvioTvLogin, pollNuvioTvLogin, exchangeNuvioTvLogin, isTokenExpired } = require('../providers/nuvioAuth');
const { makeCreateProvider } = require('../providers');
const { encrypt, decrypt } = require('../utils/encryption');
const { canonicalizeManifestUrl } = require('../utils/validation');
const { getAccountDateString, resolveAccountTimezone } = require('../utils/dateUtils');

/**
 * Public Library Router - Allows users to access their library via OAuth
 * without requiring account authentication. Addons added are marked as protected.
 */
module.exports = ({ prisma, DEFAULT_ACCOUNT_ID, encrypt, decrypt, getCachedLibrary, setCachedLibrary, JWT_SECRET }) => {
  const { findLatestEpisode } = require('../utils/libraryHelpers')
  const { getShares, getGroupMembers } = require('../utils/sharesManager')
  const { getAccountId } = require('../utils/helpers')
  const createProvider = makeCreateProvider({ prisma, encrypt, getAccountId })
  const { imageUpload } = require('../utils/helpers/multer')
  const { saveAvatarFile, removeAvatarFile, UPLOADED_AVATAR } = require('./avatars')
  const router = express.Router();

  // Helper to get existing user from Stremio auth (does NOT create new users)
  // Signing in on their own page with a login that works fixes a sign-in
  // SlickSync held that had stopped working - the same as a Reconnect, without
  // the household needing their password. Clear the problem at once and say
  // they're connected again, as the activity monitor would a minute later.
  async function healedBySignIn(userId) {
    try {
      const before = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, accountId: true, providerType: true, jellyfinServerUrl: true, jellyfinServerKind: true, providerConnectionError: true, providerConnectionErrorAt: true },
      });
      if (!before?.providerConnectionErrorAt) return;
      await prisma.user.update({ where: { id: userId }, data: { providerConnectionError: null, providerConnectionErrorAt: null } });
      await require('../utils/connectionAlerts').onConnectionRecovered(prisma, before.accountId || DEFAULT_ACCOUNT_ID, before);
    } catch (e) {
      console.warn('[publicLibrary] could not clear a fixed sign-in:', e?.message);
    }
  }

  // `targetId`, when the request is about one particular person, narrows the
  // lookup to that person: the same Stremio email can belong to people in more
  // than one household, and a key proves "this Stremio account", not which of
  // their rows. Without it the first match wins, which is only right for a
  // sign-in that has no person yet.
  async function getPublicUser(authKey, req, targetId = null) {
    try {
      // Validate auth key
      const validation = await validateStremioAuthKey(authKey);
      if (!validation || !validation.user) {
        throw new Error('Invalid or expired Stremio auth key');
      }

      const stremioUser = validation.user;
      const stremioEmail = stremioUser.email || null;

      // Try to find existing user by email (search across all accounts first to get the user's accountId).
      // Must scope to providerType: 'stremio' - email is only unique per (email, providerType), by design,
      // so the same person can have both a Stremio and a Nuvio user row sharing one email. Without this,
      // findFirst can non-deterministically resolve a Stremio login to the Nuvio row instead (or vice versa
      // in a household where two different people share an email pattern), logging someone into the wrong
      // account entirely. The Nuvio registration path (server/routes/nuvio.js) already scopes by
      // providerType correctly - this call site predates that field and was never updated to match.
      let user = null
      if (stremioEmail) {
        user = await prisma.user.findFirst({
          where: {
            ...(targetId ? { id: targetId } : {}),
            email: stremioEmail.toLowerCase(),
            providerType: 'stremio',
            isActive: true  // Only find active users
          },
          select: {
            id: true,
            username: true,
            email: true,
            accountId: true,  // Include accountId to use for group lookup
            stremioAuthKey: true,
            isActive: true,
            protectedAddons: true
          }
        });
      }

      // If user not found, throw error
      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      // Check if user is active (double check even though we filtered)
      if (!user.isActive) {
        throw new Error('USER_NOT_ACTIVE');
      }

      // Check if user belongs to at least one active group
      // Check across all accounts (not just user's accountId) to handle cases where
      // user's accountId might be 'default' but groups are in other accounts
      const groups = await prisma.group.findMany({
        where: {
          isActive: true
        },
        select: {
          id: true,
          userIds: true,
          accountId: true
        }
      });

      // Find groups that contain this user (same logic as getGroupMembers)
      const userGroups = groups.filter(group => {
        if (!group.userIds) return false
        try {
          const userIds = JSON.parse(group.userIds)
          return Array.isArray(userIds) && userIds.includes(user.id)
        } catch (e) {
          console.error(`[getPublicUser] Error parsing userIds for group ${group.id}:`, e)
          return false
        }
      })

      if (userGroups.length === 0) {
        const userAccountId = user.accountId || DEFAULT_ACCOUNT_ID;
        console.error(`[getPublicUser] User ${user.id} not found in any active group. User accountId: ${userAccountId}, Total groups checked: ${groups.length}`)
        throw new Error('USER_NOT_IN_GROUP');
      }

      // Use the user's accountId for encryption/decryption
      const userAccountId = user.accountId || DEFAULT_ACCOUNT_ID;

      // Check if found user's auth key matches
      if (user.stremioAuthKey) {
        try {
          // Create a mock request for decrypt (needs accountId)
          const mockReq = { appAccountId: userAccountId };
          const storedAuthKey = decrypt(user.stremioAuthKey, mockReq);
          if (storedAuthKey === authKey) {
            // User exists, is active, and auth key matches
            return user;
          }
        } catch (e) {
          // Decryption failed, might be different encryption or user
          // Still allow login if user exists (auth key might have been updated)
        }
      }

      // If user exists but auth key doesn't match, update it
      const mockReq = { appAccountId: userAccountId };
      const encryptedAuthKey = encrypt(authKey, mockReq);
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          stremioAuthKey: encryptedAuthKey,
          isActive: true  // Ensure user is active
        },
        select: {
          id: true,
          username: true,
          email: true,
          stremioAuthKey: true,
          isActive: true,
          protectedAddons: true
        }
      });
      await healedBySignIn(user.id);
      return user;
    } catch (error) {
      console.error('Error in getPublicUser:', error);
      throw error;
    }
  }

  // Nuvio's identity proof shape is different from Stremio's - a single
  // authKey Stremio re-validates identically on every call vs. a refresh
  // token that Nuvio ROTATES on use. Proving identity (a fresh OAuth exchange,
  // or the caller's signed portal session) happens at each call site below; this
  // helper is the shared DB-side half - same USER_NOT_FOUND/USER_NOT_ACTIVE/
  // USER_NOT_IN_GROUP sentinels and the same self-healing re-persist pattern
  // getPublicUser uses for a rotated Stremio authKey, just keyed on
  // nuvioUserId + providerType:'nuvio' instead.
  //
  // `targetId` narrows it to one person, as in getPublicUser: one Nuvio account
  // can be added in more than one household.
  async function getPublicUserNuvio(nuvioUserId, refreshTokenToStore, req, targetId = null) {
    try {
      if (!nuvioUserId) {
        throw new Error('Invalid or expired Nuvio session');
      }

      let user = await prisma.user.findFirst({
        where: {
          ...(targetId ? { id: targetId } : {}),
          nuvioUserId,
          providerType: 'nuvio',
          isActive: true
        },
        select: {
          id: true,
          username: true,
          email: true,
          accountId: true,
          nuvioRefreshToken: true,
          isActive: true,
          protectedAddons: true
        }
      });

      if (!user) { throw new Error('USER_NOT_FOUND'); }
      if (!user.isActive) { throw new Error('USER_NOT_ACTIVE'); }

      const groups = await prisma.group.findMany({
        where: { isActive: true },
        select: { id: true, userIds: true, accountId: true }
      });
      const userGroups = groups.filter(group => {
        if (!group.userIds) return false
        try {
          const userIds = JSON.parse(group.userIds)
          return Array.isArray(userIds) && userIds.includes(user.id)
        } catch (e) { return false }
      })
      if (userGroups.length === 0) { throw new Error('USER_NOT_IN_GROUP'); }

      const userAccountId = user.accountId || DEFAULT_ACCOUNT_ID;
      const mockReq = { appAccountId: userAccountId };

      // Only write when the token actually changed, so a /validate-nuvio
      // poll loop isn't hitting the DB on every single call.
      if (refreshTokenToStore) {
        let storedMatches = false;
        if (user.nuvioRefreshToken) {
          try { storedMatches = decrypt(user.nuvioRefreshToken, mockReq) === refreshTokenToStore; } catch (e) { /* fall through */ }
        }
        if (!storedMatches) {
          const encryptedRefreshToken = encrypt(refreshTokenToStore, mockReq);
          user = await prisma.user.update({
            where: { id: user.id },
            data: { nuvioRefreshToken: encryptedRefreshToken, isActive: true },
            select: { id: true, username: true, email: true, nuvioRefreshToken: true, isActive: true, protectedAddons: true }
          });
          await healedBySignIn(user.id);
        }
      }

      return user;
    } catch (error) {
      console.error('Error in getPublicUserNuvio:', error);
      throw error;
    }
  }

  // Nuvio session token - issued once at /authenticate-nuvio (and reissued
  // on every /validate-nuvio), carried by the client exactly like the
  // Stremio authKey (same x-stremio-auth header/body slot, read via
  // getAuthKey below - the field name is a historical artifact of Stremio
  // being first, but it's genuinely provider-agnostic: "the caller's own
  // bearer credential, whichever provider they are"). This is what
  // verifyProviderIdentity's Nuvio branch checks below - it's the fix for a
  // real gap: Nuvio previously had NOTHING here, re-validating the TARGET
  // user's own stored refresh token against Nuvio's backend instead of
  // anything the CALLER possesses, so a bare userId (visible to other
  // household members, or an admin) was sufficient to act as anyone.
  const NUVIO_SESSION_TTL = '90d'
  function issueNuvioSessionToken(userId) {
    return jwt.sign({ sub: userId, provider: 'nuvio' }, JWT_SECRET, { expiresIn: NUVIO_SESSION_TTL })
  }
  function verifyNuvioSessionToken(token, expectedUserId) {
    let decoded
    try {
      decoded = jwt.verify(token, JWT_SECRET)
    } catch (e) {
      return false
    }
    return decoded?.provider === 'nuvio' && decoded?.sub === expectedUserId
  }

  // Jellyfin portal sessions work the same way: signing in proves the person
  // holds a working login on their server, and the session token issued then
  // is what later requests present.
  function issueJellyfinSessionToken(userId) {
    return jwt.sign({ sub: userId, provider: 'jellyfin' }, JWT_SECRET, { expiresIn: NUVIO_SESSION_TTL })
  }
  function verifyJellyfinSessionToken(token, expectedUserId) {
    let decoded
    try {
      decoded = jwt.verify(token, JWT_SECRET)
    } catch (e) {
      return false
    }
    return decoded?.provider === 'jellyfin' && decoded?.sub === expectedUserId
  }

  // The person a Jellyfin sign-in belongs to: the same server user, active,
  // and in a group - the same rules getPublicUserNuvio applies. A fresh token
  // from the sign-in replaces the stored one (the server retires the old
  // token for the same device when it issues a new one).
  //
  // Which server counts as "the same" is provenServerMatch's to say: the
  // address the person was added with, and on a household's install another
  // address only once the server stored for them accepts this sign-in's
  // token - the server id and user id in a sign-in are whatever the server at
  // a typed-in address chooses to say. So someone whose server moves to a new
  // address is reconnected by their admin before signing in here.
  async function getPublicUserJellyfin(probe, login) {
    const { provenServerMatch } = require('../utils/jellyfinConnect');
    const { restrictsPrivateAddresses, addressToKeep } = require('../providers/jellyfinAuth');
    const personSelect = { id: true, username: true, email: true, accountId: true, isActive: true, colorIndex: true, createdAt: true, expiresAt: true };
    // The same server user can be a person in more than one household (a
    // relative in two families), and the session is for one of them. The
    // oldest one that is active and in a group is the one signed in to; if
    // none of them is, the oldest says why.
    const refusal = async (person) => {
      if (!person.isActive) return 'USER_NOT_ACTIVE';
      // Groups name their members in a JSON list of ids; only the person's own
      // household's groups can hold them, so only those are looked at.
      const inGroup = await prisma.group.findFirst({
        where: { isActive: true, accountId: person.accountId || DEFAULT_ACCOUNT_ID, userIds: { contains: JSON.stringify(person.id) } },
        select: { id: true }
      });
      return inGroup ? null : 'USER_NOT_IN_GROUP';
    };
    const choose = async (people) => {
      let firstRefusal = null;
      for (const person of people) {
        const why = await refusal(person);
        if (!why) return { user: person };
        firstRefusal = firstRefusal || why;
      }
      return { why: firstRefusal };
    };
    const match = await provenServerMatch(prisma, probe, login);
    const candidates = await prisma.user.findMany({
      where: { providerType: 'jellyfin', jellyfinUserId: login.userId, ...match },
      select: personSelect,
      orderBy: { createdAt: 'asc' }
    });
    let chosen = candidates.length ? await choose(candidates) : null;
    // A household profile (utils/jellyfinProfiles.js) signs in as the person
    // it belongs to, the way a Nuvio profile does.
    if (!candidates.length) {
      const owners = await prisma.user.findMany({ where: { providerType: 'jellyfin', ...match }, select: { id: true } });
      const profiles = owners.length
        ? await prisma.jellyfinProfile.findMany({ where: { ownerUserId: { in: owners.map((o) => o.id) }, jellyfinUserId: login.userId, skip: false }, orderBy: { createdAt: 'asc' } })
        : [];
      const people = [];
      for (const profile of profiles) {
        const person = await prisma.user.findUnique({ where: { id: profile.ownUserId || profile.ownerUserId }, select: personSelect });
        // The profile's own sign-in was already kept (rememberSignIn); the
        // person's stays theirs.
        if (person) people.push({ ...person, viaProfile: true });
      }
      chosen = people.length ? await choose(people) : null;
    }
    if (!chosen) throw new Error('USER_NOT_FOUND');
    if (chosen.why) throw new Error(chosen.why);
    const user = chosen.user;
    if (user.viaProfile) return user;
    const mockReq = { appAccountId: user.accountId || DEFAULT_ACCOUNT_ID };
    await healedBySignIn(user.id);
    // Someone added under their household's address who signs in once at
    // their personal one (or the other way round) keeps the address they were
    // added with: a personal address dies when its code is renewed.
    const stored = restrictsPrivateAddresses() ? null : (await prisma.user.findUnique({ where: { id: user.id }, select: { jellyfinServerUrl: true } }))?.jellyfinServerUrl;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        jellyfinToken: encrypt(login.token, mockReq),
        // Where strangers sign in, the address stays as the admin added it,
        // even when the person typed the other scheme for it.
        ...(restrictsPrivateAddresses() ? {} : { jellyfinServerUrl: addressToKeep(stored, probe.serverUrl) }),
        jellyfinServerKind: probe.kind,
        ...(login.serverId ? { jellyfinServerId: login.serverId } : {}),
        providerConnectionError: null,
        providerConnectionErrorAt: null,
      }
    });
    return user;
  }

  // Shared identity-only gate for routes whose actual data is 100%
  // SlickSync's own DB (no live provider content call needed) - branches
  // between getPublicUser (Stremio authKey) and getPublicUserNuvio
  // (stored refresh token) so each call site doesn't hand-roll the same
  // branch. Throws with .message set to what the caller should return as
  // the error body (matches this file's existing per-route wording).
  //
  // What it returns is the person `user` is - only ever them, for every
  // provider. A route that asks "is the caller this person?" and ignores the
  // answer is still safe, because a key that belongs to someone else never
  // gets this far.
  async function verifyProviderIdentity(user, authKey, req) {
    if (user.providerType === 'jellyfin') {
      if (!authKey || !verifyJellyfinSessionToken(authKey, user.id)) {
        throw new Error('Authentication required');
      }
      const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, username: true, email: true, accountId: true, isActive: true, protectedAddons: true }
      });
      if (!row || !row.isActive) throw new Error('Authentication required');
      return row;
    }
    if (user.providerType === 'nuvio') {
      if (!authKey || !verifyNuvioSessionToken(authKey, user.id)) {
        throw new Error('Authentication required');
      }
      if (!user.nuvioRefreshToken || !user.nuvioUserId) {
        throw new Error('Authentication required');
      }
      const mockReq = { appAccountId: user.accountId || DEFAULT_ACCOUNT_ID };
      const storedRefreshToken = decrypt(user.nuvioRefreshToken, mockReq);
      const who = await getPublicUserNuvio(user.nuvioUserId, storedRefreshToken, req, user.id);
      if (!who || who.id !== user.id) throw new Error('Authentication required');
      return who;
    }
    if (!authKey) {
      throw new Error('Authentication required');
    }
    // A Stremio key proves a Stremio account, which can be this person or
    // someone who merely shares their email; only this person's row counts.
    let who;
    try {
      who = await getPublicUser(authKey, req, user.id);
    } catch (e) {
      throw new Error('Invalid auth key');
    }
    if (!who || who.id !== user.id) throw new Error('Invalid auth key');
    return who;
  }

  // Helper to get or create user from Stremio auth (kept for backward compatibility if needed elsewhere)
  async function getOrCreatePublicUser(authKey, req) {
    try {
      // First try to get existing user
      return await getPublicUser(authKey, req);
    } catch (error) {
      // If user not found, don't create - rethrow the error
      if (error.message === 'USER_NOT_FOUND') {
        throw error;
      }
      // For other errors, also rethrow
      throw error;
    }
  }

  // Generate OAuth link (admin/public-library flow)
  router.post('/generate-oauth', async (req, res) => {
    try {
      // Mirror the working implementation used in invitations public router
      let oauthCode = null;
      let oauthLink = null;
      let oauthExpiresAt = null;

      try {
        const host = req.headers.host || req.headers.origin || 'slicksync.local';
        const origin = req.headers.origin || (host.startsWith('http') ? host : `http://${host}`);

        const stremioResponse = await fetch('https://link.stremio.com/api/v2/create?type=Create', {
          headers: {
            'X-Requested-With': host,
            Origin: origin,
          },
          // Keep request minimal; Stremio ignores referrer for this endpoint
          referrerPolicy: 'no-referrer',
        });

        if (stremioResponse.ok) {
          const stremioData = await stremioResponse.json().catch(() => ({}));
          const result = stremioData?.result;
          if (result?.success && result?.code && result?.link) {
            oauthCode = result.code;
            oauthLink = result.link;
            // 5 min expiry - convert to ISO string for JSON serialization
            oauthExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          } else {
            return res.status(500).json({
              error: 'Failed to generate OAuth link - Stremio API returned invalid response',
              details: stremioData?.error?.message || 'Missing code or link in response',
            });
          }
        } else {
          const errorText = await stremioResponse.text();
          return res.status(500).json({
            error: 'Failed to generate OAuth link from Stremio',
            details: `HTTP ${stremioResponse.status}: ${errorText}`,
          });
        }
      } catch (error) {
        return res.status(500).json({
          error: 'Failed to generate OAuth link',
          details: publicMessage(error, 'Unknown error'),
        });
      }

      res.setHeader('Content-Type', 'application/json');
      res.json({
        success: true,
        code: oauthCode,
        link: oauthLink,
        expiresAt: oauthExpiresAt,
      });
    } catch (error) {
      console.error('Error generating OAuth link:', error);
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: 'Failed to generate OAuth link', message: publicMessage(error, 'Failed to generate OAuth link') });
    }
  });

  // Poll for OAuth completion (admin/public-library flow)
  router.post('/poll-oauth', async (req, res) => {
    try {
      const { code } = req.body;
      if (!code) {
        return res.status(400).json({ error: 'OAuth code is required' });
      }

      try {
        const host = req.headers.host || req.headers.origin || 'slicksync.local';
        const origin = req.headers.origin || (host.startsWith('http') ? host : `http://${host}`);

        const stremioResponse = await fetch(
          `https://link.stremio.com/api/v2/read?type=Read&code=${encodeURIComponent(code)}`,
          {
            headers: {
              'X-Requested-With': host,
              Origin: origin,
            },
            referrerPolicy: 'no-referrer',
          }
        );

        const data = await stremioResponse.json().catch(() => ({}));
        const result = data?.result;

        if (result?.success && result?.authKey) {
          return res.json({
            success: true,
            authKey: result.authKey,
          });
        }

        // Pending or no auth key yet
        if (data?.error && data.error.code && data.error.code !== 101) {
          return res.json({
            success: false,
            authKey: null,
            error: data.error.message || 'Stremio reported an error while polling OAuth',
          });
        }

        return res.json({ success: false, authKey: null });
      } catch (error) {
        console.error('Error polling OAuth from Stremio:', error);
        return res.json({
          success: false,
          authKey: null,
          error: publicMessage(error, 'Failed to poll OAuth status'),
        });
      }
    } catch (error) {
      console.error('Error polling OAuth:', error);
      res.json({ success: false, authKey: null, error: publicMessage(error, 'Something went wrong') });
    }
  });

  // The caller's credential: the header, or the body of a request that has
  // one. Never the query string - a long-lived key in a URL ends up in access
  // logs, browser history and Referer headers.
  const getAuthKey = (req) => {
    return req.headers['x-stremio-auth'] || (req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body?.authKey);
  };

  // Authenticate with OAuth and get/create user
  router.post('/authenticate', async (req, res) => {
    try {
      const authKey = getAuthKey(req);
      if (!authKey) {
        return res.status(400).json({ error: 'Auth key is required' });
      }

      const user = await getPublicUser(authKey, req);
      
      // Fetch full user details including createdAt and expiresAt
      const fullUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          username: true,
          email: true,
          colorIndex: true,
          createdAt: true,
          expiresAt: true
        }
      });
      
      // Return user info (without sensitive data)
      res.json({
        success: true,
        user: {
          id: fullUser.id,
          username: fullUser.username,
          email: fullUser.email,
          colorIndex: fullUser.colorIndex || 0,
          createdAt: fullUser.createdAt,
          expiresAt: fullUser.expiresAt
        }
      });
    } catch (error) {
      console.error('Error authenticating:', error);
      
      // Handle specific error for user not found
      if (error?.message === 'USER_NOT_FOUND') {
        return res.status(403).json({ 
          error: 'USER_NOT_FOUND',
          message: 'Your account is not registered with SlickSync. Please contact an administrator to be added to a SlickSync group first.' 
        });
      }
      
      // Handle specific error for user not active
      if (error?.message === 'USER_NOT_ACTIVE') {
        return res.status(403).json({ 
          error: 'USER_NOT_ACTIVE',
          message: 'Your account has been disabled. Please contact an administrator to reactivate your account.' 
        });
      }
      
      // Handle specific error for user not in group
      if (error?.message === 'USER_NOT_IN_GROUP') {
        return res.status(403).json({ 
          error: 'USER_NOT_IN_GROUP',
          message: 'Your account is not part of any SlickSync group. Please contact an administrator to be added to a group first.' 
        });
      }
      
      res.status(401).json({ 
        error: 'Authentication failed', 
        message: publicMessage(error, 'Invalid Stremio auth key') 
      });
    }
  });

  // Validate user session (check if user exists, is active, and is in a group)
  router.post('/validate', async (req, res) => {
    try {
      const { userId } = req.body;
      const authKey = getAuthKey(req);
      
      // The key is the proof. Answering for a bare user id would let anyone
      // with a member id sign in as them.
      if (!authKey) {
        return res.status(401).json({ error: 'Authentication required', message: 'Please sign in again' });
      }
      const authKeyToValidate = authKey;

      // Validate using getPublicUser which checks existence, active status, and group membership
      const user = await getPublicUser(authKeyToValidate, req, userId || null);
      if (userId && user.id !== userId) {
        return res.status(403).json({ error: 'Session mismatch', message: 'This Stremio session does not match this account' });
      }
      
      res.json({
        success: true,
        valid: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email
        }
      });
    } catch (error) {
      console.error('Error validating user:', error);
      if (isOutage(error)) return res.status(503).json(OUTAGE_ANSWER);
      
      // Handle specific errors
      if (error?.message === 'USER_NOT_FOUND') {
        return res.status(403).json({ 
          error: 'USER_NOT_FOUND',
          message: 'Your account is not registered with SlickSync. Please contact an administrator to be added to a SlickSync group first.' 
        });
      }
      
      if (error?.message === 'USER_NOT_ACTIVE') {
        return res.status(403).json({ 
          error: 'USER_NOT_ACTIVE',
          message: 'Your account has been disabled. Please contact an administrator to reactivate your account.' 
        });
      }
      
      if (error?.message === 'USER_NOT_IN_GROUP') {
        return res.status(403).json({ 
          error: 'USER_NOT_IN_GROUP',
          message: 'Your account is not part of any SlickSync group. Please contact an administrator to be added to a group first.' 
        });
      }
      
      res.status(401).json({
        error: 'Validation failed',
        message: publicMessage(error, 'Invalid user session')
      });
    }
  });

  // --- Nuvio login for the User self-service panel ---
  //
  // Nuvio has no single long-lived credential a client can hand over
  // directly the way Stremio's authKey works - logging in needs its own
  // start/poll/exchange device-code round trip first, same shape as the
  // admin-mode and account-level Nuvio login flows already built
  // (server/routes/nuvio.js, server/routes/publicAuth.js's /nuvio-login).
  // This is that same flow a third time, but validating against an existing
  // managed User row (via getPublicUserNuvio above) instead of creating/
  // linking an AppAccount or a managed User - mirrors how /authenticate
  // above never creates a User either, only looks one up.

  const nuvioUserOAuthSessions = new Map() // ip -> pending count
  const NUVIO_USER_OAUTH_CAP = 3
  const NUVIO_USER_OAUTH_TTL_MS = 5 * 60 * 1000

  router.post('/generate-oauth-nuvio', async (req, res) => {
    try {
      const ip = req.ip
      const current = nuvioUserOAuthSessions.get(ip) || 0
      if (current >= NUVIO_USER_OAUTH_CAP) {
        return res.status(429).json({ error: 'Too many pending Nuvio login attempts. Please wait and try again.' })
      }

      const result = await startNuvioTvLogin()
      nuvioUserOAuthSessions.set(ip, current + 1)
      setTimeout(() => {
        const c = nuvioUserOAuthSessions.get(ip) || 0
        if (c <= 1) nuvioUserOAuthSessions.delete(ip)
        else nuvioUserOAuthSessions.set(ip, c - 1)
      }, NUVIO_USER_OAUTH_TTL_MS)

      res.json({ success: true, ...result })
    } catch (error) {
      console.error('Error generating Nuvio OAuth link:', error);
      res.status(500).json({ error: 'Failed to generate Nuvio OAuth link', message: publicMessage(error, 'Failed to generate Nuvio OAuth link') });
    }
  });

  router.post('/poll-oauth-nuvio', async (req, res) => {
    try {
      const { code, deviceNonce, anonToken } = req.body || {};
      if (!code || !deviceNonce || !anonToken) {
        return res.status(400).json({ error: 'code, deviceNonce, and anonToken are required' });
      }
      const result = await pollNuvioTvLogin(code, deviceNonce, anonToken);
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('Error polling Nuvio OAuth:', error);
      res.json({ success: false, error: publicMessage(error, 'Failed to poll Nuvio login') });
    }
  });

  router.post('/authenticate-nuvio', async (req, res) => {
    try {
      const { code, deviceNonce, anonToken } = req.body || {};
      if (!code || !deviceNonce || !anonToken) {
        return res.status(400).json({ error: 'code, deviceNonce, and anonToken are required' });
      }

      let exchanged;
      try {
        exchanged = await exchangeNuvioTvLogin(code, deviceNonce, anonToken);
      } catch (err) {
        return res.status(401).json({ error: 'Authentication failed', message: publicMessage(err, 'Nuvio approval failed or expired') });
      }

      const nuvioUserId = exchanged?.user?.id;
      const refreshToken = exchanged?.refreshToken;
      if (!nuvioUserId || !refreshToken) {
        return res.status(400).json({ error: 'Nuvio account not available' });
      }

      const user = await getPublicUserNuvio(nuvioUserId, refreshToken, req);

      const fullUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, username: true, email: true, colorIndex: true, createdAt: true, expiresAt: true }
      });

      res.json({
        success: true,
        sessionToken: issueNuvioSessionToken(fullUser.id),
        user: {
          id: fullUser.id,
          username: fullUser.username,
          email: fullUser.email,
          colorIndex: fullUser.colorIndex || 0,
          createdAt: fullUser.createdAt,
          expiresAt: fullUser.expiresAt
        }
      });
    } catch (error) {
      console.error('Error authenticating with Nuvio:', error);

      if (error?.message === 'USER_NOT_FOUND') {
        return res.status(403).json({
          error: 'USER_NOT_FOUND',
          message: 'Your account is not registered with SlickSync. Please contact an administrator to be added to a SlickSync group first.'
        });
      }
      if (error?.message === 'USER_NOT_ACTIVE') {
        return res.status(403).json({
          error: 'USER_NOT_ACTIVE',
          message: 'Your account has been disabled. Please contact an administrator to reactivate your account.'
        });
      }
      if (error?.message === 'USER_NOT_IN_GROUP') {
        return res.status(403).json({
          error: 'USER_NOT_IN_GROUP',
          message: 'Your account is not part of any SlickSync group. Please contact an administrator to be added to a group first.'
        });
      }

      res.status(401).json({
        error: 'Authentication failed',
        message: publicMessage(error, 'Invalid Nuvio session')
      });
    }
  });

  // Validate a Nuvio user session (mirrors /validate) - given userId and the
  // caller's own portal session token, re-checks active/group status the same
  // way getPublicUserNuvio always does.
  router.post('/validate-nuvio', async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // This is the route a restored (page-reload) session validates
      // through, using only whatever's in localStorage - so it's the same
      // real attack surface as /delete-account etc: without this check, a
      // bare userId (planted into any browser's localStorage) was
      // sufficient to "restore" a session as anyone. Require the caller's
      // own previously-issued session token, same as every other
      // identity-sensitive Nuvio route.
      const callerToken = getAuthKey(req);
      if (!callerToken || !verifyNuvioSessionToken(callerToken, userId)) {
        return res.status(401).json({ error: 'Validation failed', message: 'Invalid or expired Nuvio session' });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { nuvioRefreshToken: true, nuvioUserId: true, accountId: true }
      });

      if (!user || !user.nuvioRefreshToken || !user.nuvioUserId) {
        return res.status(403).json({
          error: 'USER_NOT_FOUND',
          message: 'Your account is not registered with SlickSync. Please contact an administrator to be added to a SlickSync group first.'
        });
      }

      const mockReq = { appAccountId: user.accountId || DEFAULT_ACCOUNT_ID };
      const storedRefreshToken = decrypt(user.nuvioRefreshToken, mockReq);

      // The signed portal session above already proves who this is. Refreshing
      // here spent Nuvio's single-use refresh token on every page load, outside
      // the provider's shared refresh (providers/nuvio.js), so two quick
      // reloads - or a reload during a sync - left one of them holding a dead
      // token and signed the person out.
      const validatedUser = await getPublicUserNuvio(user.nuvioUserId, storedRefreshToken, req, userId);

      res.json({
        success: true,
        valid: true,
        sessionToken: issueNuvioSessionToken(validatedUser.id),
        user: { id: validatedUser.id, username: validatedUser.username, email: validatedUser.email }
      });
    } catch (error) {
      console.error('Error validating Nuvio user:', error);
      if (isOutage(error)) return res.status(503).json(OUTAGE_ANSWER);

      if (error?.message === 'USER_NOT_FOUND') {
        return res.status(403).json({
          error: 'USER_NOT_FOUND',
          message: 'Your account is not registered with SlickSync. Please contact an administrator to be added to a SlickSync group first.'
        });
      }
      if (error?.message === 'USER_NOT_ACTIVE') {
        return res.status(403).json({
          error: 'USER_NOT_ACTIVE',
          message: 'Your account has been disabled. Please contact an administrator to reactivate your account.'
        });
      }
      if (error?.message === 'USER_NOT_IN_GROUP') {
        return res.status(403).json({
          error: 'USER_NOT_IN_GROUP',
          message: 'Your account is not part of any SlickSync group. Please contact an administrator to be added to a group first.'
        });
      }

      res.status(401).json({
        error: 'Validation failed',
        message: publicMessage(error, 'Invalid Nuvio session')
      });
    }
  });

  // --- Jellyfin-compatible servers (a real Jellyfin, AIOStreams, AIOMetadata) ---

  // POST /jellyfin-probe, /jellyfin-quick-connect, /jellyfin-quick-connect-status
  require('../utils/jellyfinConnect').mountSignInSteps(router, 'jellyfin-');

  const portalAuthErrors = {
    USER_NOT_FOUND: 'Your account is not registered with SlickSync. Please contact an administrator to be added to a SlickSync group first.',
    USER_NOT_ACTIVE: 'Your account has been disabled. Please contact an administrator to reactivate your account.',
    USER_NOT_IN_GROUP: 'Your account is not part of any SlickSync group. Please contact an administrator to be added to a group first.',
  };

  router.post('/authenticate-jellyfin', async (req, res) => {
    try {
      const { signInFromBody, rememberSignIn } = require('../utils/jellyfinConnect');
      let signedIn;
      try {
        signedIn = await signInFromBody(req.body);
      } catch (err) {
        const status = err?.status === 401 ? 401 : 400;
        return res.status(status).json({ error: 'Authentication failed', message: publicMessage(err, 'Could not sign in to the server'), ...(err?.pinNeeded ? { pinNeeded: true } : {}) });
      }
      // Whoever holds this login takes the fresh token before anything can
      // turn the person away - the server has already retired the old one.
      await rememberSignIn(prisma, encrypt, signedIn.probe, signedIn.login);
      const user = await getPublicUserJellyfin(signedIn.probe, signedIn.login);
      res.json({
        success: true,
        sessionToken: issueJellyfinSessionToken(user.id),
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          colorIndex: user.colorIndex || 0,
          createdAt: user.createdAt,
          expiresAt: user.expiresAt
        }
      });
    } catch (error) {
      if (portalAuthErrors[error?.message]) {
        return res.status(403).json({ error: publicMessage(error, 'Something went wrong'), message: portalAuthErrors[error.message] });
      }
      console.error('Error authenticating with a Jellyfin server:', error?.message);
      res.status(401).json({ error: 'Authentication failed', message: 'Could not sign in' });
    }
  });

  // A restored (page-reload) session: the caller's own session token, and a
  // stored server login that still works.
  router.post('/validate-jellyfin', async (req, res) => {
    try {
      const { userId } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'User ID is required' });
      const callerToken = getAuthKey(req);
      if (!callerToken || !verifyJellyfinSessionToken(callerToken, userId)) {
        return res.status(401).json({ error: 'Validation failed', message: 'Invalid or expired session' });
      }
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, email: true, isActive: true, providerType: true, accountId: true, jellyfinServerUrl: true, jellyfinToken: true, jellyfinUserId: true }
      });
      if (!user || user.providerType !== 'jellyfin' || !user.jellyfinToken) {
        return res.status(403).json({ error: 'USER_NOT_FOUND', message: portalAuthErrors.USER_NOT_FOUND });
      }
      if (!user.isActive) return res.status(403).json({ error: 'USER_NOT_ACTIVE', message: portalAuthErrors.USER_NOT_ACTIVE });
      try {
        const { currentUser } = require('../providers/jellyfinAuth');
        const me = await currentUser(user.jellyfinServerUrl, decrypt(user.jellyfinToken, { appAccountId: user.accountId || DEFAULT_ACCOUNT_ID }));
        if (me.userId !== user.jellyfinUserId) throw Object.assign(new Error('different user'), { status: 401 });
      } catch (err) {
        // A server that is down is not a reason to sign the person out.
        if (err?.status === 401) {
          return res.status(401).json({ error: 'Validation failed', message: 'Your server sign-in has expired. Sign in again.' });
        }
      }
      res.json({
        success: true,
        valid: true,
        sessionToken: issueJellyfinSessionToken(user.id),
        user: { id: user.id, username: user.username, email: user.email }
      });
    } catch (error) {
      console.error('Error validating a Jellyfin session:', error?.message);
      if (isOutage(error)) return res.status(503).json(OUTAGE_ANSWER);
      res.status(401).json({ error: 'Validation failed', message: 'Invalid session' });
    }
  });

  // Get current user's info (including activityVisibility)
  router.get('/user-info', async (req, res) => {
    try {
      const { userId } = req.query;
      const authKey = getAuthKey(req);

      if (!userId && !authKey) {
        return res.status(400).json({ error: 'User ID or auth key is required' });
      }

      let user;
      if (userId) {
        // Real fields needed by verifyProviderIdentity's Nuvio branch,
        // fetched up front - was previously "if authKey present, treat it
        // as a Stremio key" with no regard for the target's actual
        // provider, which broke the moment Nuvio calls started sending
        // their own (non-Stremio) session token in the same slot, and
        // separately never verified anything for the no-authKey path at
        // all (a bare userId was accepted outright).
        const foundUser = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            username: true,
            email: true,
            accountId: true,
            providerType: true,
            nuvioRefreshToken: true,
            nuvioUserId: true,
            isActive: true,
            activityVisibility: true,
            colorIndex: true,
            avatarUrl: true,
            useGravatar: true,
            createdAt: true,
            expiresAt: true,
            discordWebhookUrl: true,
            notifyOnWatch: true,
            publicStatsEnabled: true,
            publicStatsSlug: true
          }
        });

        if (!foundUser) {
          return res.status(404).json({ error: 'User not found' });
        }
        if (!foundUser.isActive) {
          return res.status(403).json({ error: 'User account is disabled' });
        }

        try {
          await verifyProviderIdentity(foundUser, authKey, req);
        } catch (e) {
          return res.status(401).json({ error: publicMessage(e, 'Authentication required') });
        }

        // Check the user belongs to at least one active group. Membership,
        // not "has housemates": someone alone in their group is still in it
        // (getGroupMembers leaves the caller out, so it answered 403 for them).
        const activeGroups = await prisma.group.findMany({
          where: { accountId: foundUser.accountId, isActive: true },
          select: { userIds: true },
        });
        const inAGroup = activeGroups.some((g) => {
          try { const ids = JSON.parse(g.userIds || '[]'); return Array.isArray(ids) && ids.includes(foundUser.id); } catch { return false; }
        });
        if (!inAGroup) {
          return res.status(403).json({ error: 'User is not part of any group' });
        }

        user = foundUser;
      } else if (authKey) {
        // Legacy fallback for a caller with only a Stremio authKey and no
        // userId at all.
        const publicUser = await getPublicUser(authKey, req);
        const fullUser = await prisma.user.findUnique({
          where: { id: publicUser.id },
          select: {
            id: true,
            username: true,
            email: true,
            accountId: true,
            activityVisibility: true,
            colorIndex: true,
            avatarUrl: true,
            useGravatar: true,
            createdAt: true,
            expiresAt: true,
            discordWebhookUrl: true,
            notifyOnWatch: true,
            publicStatsEnabled: true,
            publicStatsSlug: true
          }
        });
        if (!fullUser) {
          return res.status(404).json({ error: 'User not found' });
        }
        user = fullUser;
      }

      // The groups they are in, by name, for their Settings page.
      const theirGroups = await prisma.group.findMany({
        where: { accountId: user.accountId || DEFAULT_ACCOUNT_ID, isActive: true },
        select: { name: true, userIds: true },
      });
      const groupNames = theirGroups
        .filter((g) => { try { const ids = JSON.parse(g.userIds || '[]'); return Array.isArray(ids) && ids.includes(user.id); } catch { return false; } })
        .map((g) => g.name);

      res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        groupName: groupNames.join(', ') || null,
        activityVisibility: user.activityVisibility || 'private',
        colorIndex: user.colorIndex || 0,
        avatarUrl: user.avatarUrl || null,
        // So the portal knows whether to look this person up on Gravatar.
        useGravatar: user.useGravatar === true,
        createdAt: user.createdAt,
        expiresAt: user.expiresAt,
        discordWebhookUrl: user.discordWebhookUrl || null,
        notifyOnWatch: user.notifyOnWatch !== false,
        publicStatsEnabled: user.publicStatsEnabled === true,
        publicStatsSlug: user.publicStatsSlug || null
      });
    } catch (error) {
      console.error('Error getting user info:', error);
      res.status(500).json({ error: 'Failed to get user info', message: publicMessage(error, 'Failed to get user info') });
    }
  });

  // Update activity visibility
  router.patch('/activity-visibility', async (req, res) => {
    try {
      const { userId, activityVisibility } = req.body;
      const authKey = getAuthKey(req);

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      if (!activityVisibility || !['public', 'private'].includes(activityVisibility)) {
        return res.status(400).json({ error: 'Invalid activityVisibility value. Must be "public" or "private".' });
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, accountId: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true }
      });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Validate the caller's identity (checks existence, active status, and group membership)
      const user = await verifyProviderIdentity(targetUser, authKey, req);

      // Verify the userId matches the authenticated user
      if (user.id !== userId) {
        return res.status(403).json({ error: 'Access denied: Cannot update another user\'s visibility' });
      }

      // Update the user's activity visibility
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { activityVisibility }
      });

      res.json({ 
        message: `Activity visibility set to ${activityVisibility}`,
        activityVisibility: updatedUser.activityVisibility 
      });
    } catch (error) {
      console.error('Error updating activity visibility:', error);
      
      // Handle specific errors
      if (error?.message === 'USER_NOT_FOUND') {
        return res.status(403).json({ 
          error: 'USER_NOT_FOUND',
          message: 'Your account is not registered with SlickSync.' 
        });
      }
      
      if (error?.message === 'USER_NOT_ACTIVE') {
        return res.status(403).json({ 
          error: 'USER_NOT_ACTIVE',
          message: 'Your account has been disabled.' 
        });
      }
      
      if (error?.message === 'USER_NOT_IN_GROUP') {
        return res.status(403).json({ 
          error: 'USER_NOT_IN_GROUP',
          message: 'Your account is not part of any SlickSync group.' 
        });
      }
      
      res.status(500).json({ error: 'Failed to update activity visibility', message: publicMessage(error, 'Failed to update activity visibility') });
    }
  });

  // A person's own notification settings (their Discord webhook and whether
  // their watching notifies at all). Proved the same way as activity
  // visibility, so it works on an instance with a login, where the household
  // route for this is closed to someone who only signed in as themselves.
  router.patch('/user-settings', async (req, res) => {
    try {
      const { userId } = req.body || {};
      const authKey = getAuthKey(req);
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'User ID is required' });
      }

      const updateData = {};
      if (req.body.discordWebhookUrl !== undefined) {
        const raw = req.body.discordWebhookUrl;
        if (raw !== null && typeof raw !== 'string') {
          return res.status(400).json({ error: 'discordWebhookUrl must be text or empty' });
        }
        const webhook = typeof raw === 'string' ? raw.trim() : '';
        if (webhook.length > 2048) {
          return res.status(400).json({ error: 'That webhook address is too long' });
        }
        updateData.discordWebhookUrl = webhook || null;
      }
      if (req.body.notifyOnWatch !== undefined) {
        if (typeof req.body.notifyOnWatch !== 'boolean') {
          return res.status(400).json({ error: 'notifyOnWatch must be true or false' });
        }
        updateData.notifyOnWatch = req.body.notifyOnWatch;
      }
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'Nothing to change' });
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, accountId: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true }
      });
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = await verifyProviderIdentity(targetUser, authKey, req);
      if (user.id !== userId) {
        return res.status(403).json({ error: 'Access denied: Cannot update another user\'s settings' });
      }

      const updated = await prisma.user.update({ where: { id: userId }, data: updateData });
      res.json({
        discordWebhookUrl: updated.discordWebhookUrl || null,
        notifyOnWatch: updated.notifyOnWatch !== false
      });
    } catch (error) {
      console.error('Error updating user settings:', error);
      if (/Authentication required|Invalid auth key|USER_NOT_/.test(error?.message || '')) {
        return res.status(401).json({ error: publicMessage(error, 'Please sign in again.'), message: 'Please sign in again.' });
      }
      res.status(500).json({ error: 'Failed to update settings', message: publicMessage(error, 'Failed to update settings') });
    }
  });

  // Public stats share link - same self-service identity check as
  // activity-visibility above (authKey + verifyProviderIdentity), since
  // this is a user managing their OWN share link from their own Settings
  // page, not an admin action. Distinct from activityVisibility: that only
  // ever exposes data to other members of the SAME account; this issues a
  // genuinely public, unauthenticated link (see server/routes/users.js's
  // GET /users/public-stats/:slug, which actually serves it).
  router.post('/public-stats/enable', async (req, res) => {
    try {
      const { userId } = req.body;
      const authKey = getAuthKey(req);
      if (!userId) return res.status(400).json({ error: 'User ID is required' });

      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, accountId: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true, publicStatsSlug: true }
      });
      if (!targetUser) return res.status(404).json({ error: 'User not found' });

      const user = await verifyProviderIdentity(targetUser, authKey, req);
      if (user.id !== userId) {
        return res.status(403).json({ error: 'Access denied: Cannot update another user\'s share link' });
      }

      let slug = targetUser.publicStatsSlug;
      if (!slug) {
        const { generateApiKey } = require('../utils/apiKey');
        slug = generateApiKey();
      }
      await prisma.user.update({ where: { id: userId }, data: { publicStatsEnabled: true, publicStatsSlug: slug } });
      res.json({ slug });
    } catch (error) {
      console.error('Error enabling public stats:', error);
      if (error?.message === 'USER_NOT_FOUND') return res.status(403).json({ error: 'USER_NOT_FOUND', message: 'Your account is not registered with SlickSync.' });
      if (error?.message === 'USER_NOT_ACTIVE') return res.status(403).json({ error: 'USER_NOT_ACTIVE', message: 'Your account has been disabled.' });
      if (error?.message === 'USER_NOT_IN_GROUP') return res.status(403).json({ error: 'USER_NOT_IN_GROUP', message: 'Your account is not part of any SlickSync group.' });
      res.status(500).json({ error: 'Failed to enable public stats', message: publicMessage(error, 'Failed to enable public stats') });
    }
  });

  router.post('/public-stats/disable', async (req, res) => {
    try {
      const { userId } = req.body;
      const authKey = getAuthKey(req);
      if (!userId) return res.status(400).json({ error: 'User ID is required' });

      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, accountId: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true }
      });
      if (!targetUser) return res.status(404).json({ error: 'User not found' });

      const user = await verifyProviderIdentity(targetUser, authKey, req);
      if (user.id !== userId) {
        return res.status(403).json({ error: 'Access denied: Cannot update another user\'s share link' });
      }

      await prisma.user.update({ where: { id: userId }, data: { publicStatsEnabled: false, publicStatsSlug: null } });
      res.json({ success: true });
    } catch (error) {
      console.error('Error disabling public stats:', error);
      if (error?.message === 'USER_NOT_FOUND') return res.status(403).json({ error: 'USER_NOT_FOUND', message: 'Your account is not registered with SlickSync.' });
      if (error?.message === 'USER_NOT_ACTIVE') return res.status(403).json({ error: 'USER_NOT_ACTIVE', message: 'Your account has been disabled.' });
      if (error?.message === 'USER_NOT_IN_GROUP') return res.status(403).json({ error: 'USER_NOT_IN_GROUP', message: 'Your account is not part of any SlickSync group.' });
      res.status(500).json({ error: 'Failed to disable public stats', message: publicMessage(error, 'Failed to disable public stats') });
    }
  });

  // Get user's library
  router.get('/library', async (req, res) => {
    try {
      const userId = req.query.userId || req.query.user;
      const requestingUserId = req.query.requestingUserId; // Optional: ID of user making the request
      const authKey = getAuthKey(req);
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get target user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          stremioAuthKey: true,
          providerType: true,
          nuvioRefreshToken: true,
          nuvioUserId: true,
          jellyfinServerUrl: true,
          jellyfinServerKind: true,
          jellyfinUserId: true,
          jellyfinToken: true,
          isActive: true,
          accountId: true,
          activityVisibility: true
        }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      // Who is asking is proven by their own sign-in, never taken from the
      // query string. Unproven askers see only a library its owner made public.
      const asker = requestingUserId ? await personAsking(req, requestingUserId).catch(() => null) : null;
      if (asker && asker.id !== userId) {
        const requestingUser = asker;
        if (requestingUser.accountId !== user.accountId) {
          return res.status(403).json({ error: 'Access denied: Invalid requesting user' });
        }
        
        // Check if requesting user is in the same group and target user is public
        const { getGroupMembers } = require('../utils/sharesManager');
        const groupMembers = await getGroupMembers(prisma, user.accountId, requestingUserId);
        const requestingUserInGroup = groupMembers.some(m => m.id === userId);
        
        if (!requestingUserInGroup || user.activityVisibility !== 'public') {
          return res.status(403).json({ error: 'Access denied: User library is private or you are not in the same group' });
        }
      } else if (!asker && user.activityVisibility !== 'public') {
        // Nobody proven is asking and the library is private.
        return res.status(403).json({ error: 'Access denied: User library is private' });
      }

      const { providerLabel, isProviderConnected } = require('../utils/providerInfo');
      const providerName = providerLabel(user);
      if (!isProviderConnected(user)) {
        return res.status(400).json({ error: `User not connected to ${providerName}` });
      }

      // Get library from cache or fetch
      let library = getCachedLibrary(user.accountId, user);

      // Check if cache only has removed items ( stale cache) - if so, refresh from the provider
      // Active items: !item.removed (handles false, undefined, null, 0)
      const hasActiveItems = library && Array.isArray(library) && library.some(item => !item.removed);

      console.log(`[Library Cache] User ${user.id}: cache items=${library?.length || 0}, hasActiveItems=${hasActiveItems}`)

      if (!library || !Array.isArray(library) || library.length === 0 || !hasActiveItems) {
        console.log(`[Library Cache] Refreshing from ${providerName} for user ${user.id}`)
        const mockReq = { appAccountId: user.accountId };
        const provider = createProvider(user, { decrypt, req: mockReq });
        if (!provider) {
          return res.status(400).json({ error: 'User provider credentials are invalid' });
        }
        // Nuvio's getLibrary() already returns fully-expanded, per-episode
        // items (no watched-bitfield to decode) - the expansion loop below
        // is a no-op for it (none of its Stremio-specific shape checks
        // match), so no separate code path is needed here.
        library = await provider.getLibrary();

        const activeFromProvider = Array.isArray(library) ? library.filter(item => !item.removed).length : 0
        console.log(`[Library Cache] Provider returned: total=${library?.length || 0}, active=${activeFromProvider}`)

        if (Array.isArray(library) && library.length > 0) {
          setCachedLibrary(user.accountId, user, library);
        }
      }

      // Process and expand library (similar to single user endpoint)
      const expandedLibrary = []
      const episodeItemsByShow = new Map()
      
      for (const item of library) {
        if (item.type === 'movie') {
          expandedLibrary.push(item)
          continue
        }
        
        const isEpisodeItem = item._id && item._id.includes(':') && item._id.split(':').length >= 3
        
        if (isEpisodeItem) {
          const showId = item._id.split(':')[0]
          if (!episodeItemsByShow.has(showId)) {
            episodeItemsByShow.set(showId, [])
          }
          episodeItemsByShow.get(showId).push(item)
          continue
        }
        
        if (item.type === 'series' && item.state?.watched) {
          try {
            const showId = item._id || item.id
            const metaResponse = await fetch(`https://v3-cinemeta.strem.io/meta/series/${showId}.json`)
            if (metaResponse.ok) {
              const metaData = await metaResponse.json()
              const meta = metaData.meta
              
              if (meta && meta.videos && Array.isArray(meta.videos)) {
                const videoIds = meta.videos.map(v => v.id)
                const watchedStr = item.state.watched
                
                if (watchedStr && videoIds.length > 0) {
                  const parts = watchedStr.split(':')
                  let bitfieldLength, bitfieldData
                  
                  if (parts.length >= 3) {
                    bitfieldLength = parseInt(parts[1], 10)
                    bitfieldData = parts.slice(2).join(':')
                  } else if (parts.length === 1) {
                    bitfieldLength = videoIds.length
                    bitfieldData = parts[0]
                  } else {
                    expandedLibrary.push(item)
                    continue
                  }
                  
                  if (bitfieldLength > 0 && bitfieldData) {
                    try {
                      const bitfieldBuffer = Buffer.from(bitfieldData, 'base64')
                      const watchedEpisodes = []
                      const actualLength = Math.min(videoIds.length, bitfieldLength)
                      
                      for (let i = 0; i < actualLength; i++) {
                        const byteIndex = Math.floor(i / 8)
                        const bitIndex = i % 8
                        
                        if (byteIndex < bitfieldBuffer.length) {
                          const byte = bitfieldBuffer[byteIndex]
                          const isWatched = (byte & (1 << bitIndex)) !== 0
                          
                          if (isWatched) {
                            const videoId = videoIds[i]
                            const videoIdParts = videoId.split(':')
                            if (videoIdParts.length >= 3) {
                              const season = parseInt(videoIdParts[1], 10)
                              const episode = parseInt(videoIdParts[2], 10)
                              
                              const episodeItem = {
                                ...item,
                                _id: `${item._id}:${season}:${episode}`,
                                _mtime: item._mtime,
                                _ctime: item._ctime,
                                state: {
                                  ...item.state,
                                  season: season,
                                  episode: episode,
                                  video_id: videoId
                                }
                              }
                              watchedEpisodes.push(episodeItem)
                            }
                          }
                        }
                      }
                      
                      if (watchedEpisodes.length > 0) {
                        let latestEpisode = null
                        if (item.state?.video_id) {
                          latestEpisode = watchedEpisodes.find(ep => ep.state?.video_id === item.state.video_id)
                        }
                        if (!latestEpisode) {
                          latestEpisode = watchedEpisodes[watchedEpisodes.length - 1]
                        }
                        
                        if (latestEpisode) {
                          expandedLibrary.push(latestEpisode)
                        } else {
                          expandedLibrary.push(item)
                        }
                      } else {
                        expandedLibrary.push(item)
                      }
                    } catch (bitfieldError) {
                      expandedLibrary.push(item)
                    }
                  } else {
                    expandedLibrary.push(item)
                  }
                } else {
                  expandedLibrary.push(item)
                }
              } else {
                expandedLibrary.push(item)
              }
            } else {
              expandedLibrary.push(item)
            }
          } catch (metaError) {
            expandedLibrary.push(item)
          }
        } else {
          expandedLibrary.push(item)
        }
      }

      // Process episode items: only keep the latest episode per show
      episodeItemsByShow.forEach((episodes, showId) => {
        const latestEpisode = findLatestEpisode(episodes)
        if (latestEpisode) {
          expandedLibrary.push(latestEpisode)
        }
      })

      // Return all items (both active and removed) - frontend will filter based on view type
      // This allows history view to show all watched items regardless of removed status
      const allLibrary = expandedLibrary

      console.log(`[Library API] User ${user.id}: expanded=${expandedLibrary.length}, total=${allLibrary.length}`)

      // Sort by watch date (lastWatched only)
      // IMPORTANT: Do NOT use _mtime - that's just when the library item was modified (e.g., added to library)
      allLibrary.sort((a, b) => {
        const getWatchDate = (item) => {
          if (item.state?.lastWatched) {
            const d = new Date(item.state.lastWatched)
            if (!isNaN(d.getTime())) return d.getTime()
          }
          return 0
        }

        const dateA = getWatchDate(a)
        const dateB = getWatchDate(b)

        if (dateB === dateA) return 0
        return dateB - dateA
      })

      res.json({
        library: allLibrary,
        count: allLibrary.length
      });
    } catch (error) {
      console.error('Error fetching library:', error);
      res.status(500).json({ error: 'Failed to fetch library', message: publicMessage(error, 'Failed to fetch library') });
    }
  });

  // Add an addon to Stremio and protect it
  router.post('/add-addon', async (req, res) => {
    try {
      const { userId, addonUrl, manifestData: providedManifestData } = req.body;
      const authKey = getAuthKey(req);
      
      if (!userId || !addonUrl) {
        return res.status(400).json({ 
          error: 'User ID and addon URL are required',
          message: 'User ID and addon URL are required' 
        });
      }

      // Get user
      if (!(await requireSelf(req, res, userId))) return;

      // The addon address is fetched from this server, so every install holds
      // it to a rule: an instance that serves other households may not reach
      // its own network at all, a household's own install may reach anything on
      // its network (a LAN server, a docker service) but never the link-local
      // range where a cloud host keeps its credentials. The address checked is
      // the one fetched below, with stremio:// read as https://.
      const { assertSafeUrl, safeFetch, instancePolicy } = require('../utils/safeUrl');
      const policy = instancePolicy();
      const fetchableUrl = String(addonUrl).replace(/^stremio:\/\//i, 'https://');
      try {
        await assertSafeUrl(fetchableUrl, policy);
      } catch (e) {
        // A household's browser may know a name this server cannot resolve;
        // that is only a problem if this server is the one to fetch it.
        const onlyPassedOn = policy.allowPrivate && e?.message === 'unresolvable host' && providedManifestData;
        if (!onlyPassedOn) {
          return res.status(400).json({ error: 'That addon address can’t be used', message: 'That addon address can’t be used' });
        }
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          stremioAuthKey: true,
          providerType: true,
          nuvioRefreshToken: true,
          nuvioUserId: true,
          isActive: true,
          accountId: true,
          protectedAddons: true
        }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      if (user.providerType === 'jellyfin') {
        return res.status(400).json({ error: 'NOT_SUPPORTED', message: 'Your server has no addon list for SlickSync to add to' });
      }
      const isNuvio = user.providerType === 'nuvio';
      const providerReady = isNuvio ? !!(user.nuvioRefreshToken && user.nuvioUserId) : !!user.stremioAuthKey;
      if (!providerReady) {
        return res.status(400).json({
          error: `User not connected to ${isNuvio ? 'Nuvio' : 'Stremio'}`,
          message: `User not connected to ${isNuvio ? 'Nuvio' : 'Stremio'}. Please connect your account first.`
        });
      }

      // Use provided manifest data if available (fetched client-side), otherwise fetch it server-side
      let manifest = providedManifestData;
      if (!manifest) {
        try {
          console.log(`[public-library] Fetching manifest from server: ${addonUrl}`);
          // safeFetch holds every redirect to the same rule as the address.
          const manifestResponse = await safeFetch(fetchableUrl, {
            headers: {
              'User-Agent': 'SlickSync/1.0',
              'Accept': 'application/json'
            }
          }, policy);
          if (!manifestResponse.ok) {
            console.error(`[public-library] Failed to fetch manifest: ${manifestResponse.status} ${manifestResponse.statusText}`);
            return res.status(400).json({ 
              error: `Failed to fetch manifest: ${manifestResponse.status}`, 
              message: `Failed to fetch manifest from URL. Status: ${manifestResponse.status}. Please try again or ensure the URL is accessible.` 
            });
          }
          manifest = await manifestResponse.json();
          console.log(`[public-library] Successfully fetched manifest server-side: ${manifest?.name || 'Unknown'}`);
        } catch (fetchError) {
          console.error('[public-library] Error fetching manifest:', fetchError);
          // A redirect the address rule refused reads as the address itself being refused.
          const refused = ['invalid url', 'unsupported protocol', 'blocked host', 'unresolvable host', 'too many redirects'].includes(fetchError?.message);
          return res.status(400).json({
            error: 'Failed to fetch addon manifest',
            message: refused ? 'That addon address can’t be used' : (fetchError?.message || 'Unable to fetch manifest from the provided URL. Please check the URL is correct and accessible.')
          });
        }
      } else {
        console.log(`[public-library] Using provided manifest data: ${manifest?.name || 'Unknown'}`);
      }

      // Validate manifest structure
      if (!manifest || typeof manifest !== 'object') {
        console.error('[public-library] Invalid manifest structure:', manifest);
        return res.status(400).json({ 
          error: 'Invalid manifest format', 
          message: 'The manifest is not a valid JSON object.' 
        });
      }

      // Add via the provider abstraction - both providers implement
      // getAddons()/addAddon() with the same {addons:[...]} shape, so this
      // one path works for either. The "does it already exist" dedup check
      // is provider-agnostic (just comparing transport URLs), unlike the
      // add itself which each provider's addAddon() handles its own way
      // (Stremio: addonCollectionAdd; Nuvio: an insert into its own table).
      const mockReq = { appAccountId: user.accountId };
      const provider = createProvider(user, { decrypt, req: mockReq });
      if (!provider) {
        return res.status(400).json({ error: 'User provider credentials are invalid' });
      }

      try {
        console.log(`[public-library] Getting current addon collection`);
        const { addons: rawAddons } = await provider.getAddons();
        const currentAddons = Array.isArray(rawAddons) ? rawAddons : [];

        console.log(`[public-library] Current addons count: ${currentAddons.length}`);

        // Check if addon already exists (by URL)
        const normalizedUrl = canonicalizeManifestUrl(addonUrl);
        const addonExists = currentAddons.some((a) => {
          const existingUrl = a?.transportUrl || a?.manifestUrl || a?.url;
          return existingUrl && canonicalizeManifestUrl(existingUrl) === normalizedUrl;
        });

        if (addonExists) {
          console.log(`[public-library] Addon already exists in collection`);
          // Still mark as protected even if it already exists
        } else {
          console.log(`[public-library] Adding addon via provider: ${manifest?.name || addonUrl}`);
          await provider.addAddon(addonUrl, manifest);
          console.log(`[public-library] Successfully added addon`);
        }
      } catch (providerError) {
        console.error('[public-library] Error adding addon:', providerError);
        console.error('[public-library] Provider error details:', JSON.stringify(providerError, null, 2));
        console.error('[public-library] Provider error stack:', providerError?.stack);

        let errorMessage = `Failed to add addon to ${isNuvio ? 'Nuvio' : 'Stremio'}`;
        if (providerError?.message) {
          errorMessage = providerError.message;
        } else if (providerError?.error) {
          errorMessage = typeof providerError.error === 'string' ? providerError.error : JSON.stringify(providerError.error);
        } else if (providerError?.response?.data) {
          const data = providerError.response.data;
          errorMessage = data.error || data.message || JSON.stringify(data);
        }

        return res.status(400).json({
          error: `Failed to add addon to ${isNuvio ? 'Nuvio' : 'Stremio'}`,
          message: errorMessage
        });
      }

      // Mark as protected by adding to protectedAddons
      const addonName = manifest.name || addonUrl;
      const currentProtected = user.protectedAddons ? JSON.parse(user.protectedAddons) : [];
      
      // Add to protected list if not already there
      const normalizedName = addonName.trim().toLowerCase();
      if (!currentProtected.some(name => name.trim().toLowerCase() === normalizedName)) {
        currentProtected.push(addonName);
        
        await prisma.user.update({
          where: { id: userId },
          data: {
            protectedAddons: JSON.stringify(currentProtected)
          }
        });
      }

      res.json({
        success: true,
        message: 'Addon added and marked as protected',
        addon: {
          url: addonUrl,
          name: addonName
        }
      });
    } catch (error) {
      console.error('[public-library] Error adding addon:', error);
      console.error('[public-library] Error stack:', error?.stack);
      console.error('[public-library] Error details:', JSON.stringify(error, null, 2));
      
      // Return more detailed error information
      const statusCode = error?.response?.status || error?.status || 500;
      let errorMessage = error?.response?.data?.error || error?.response?.data?.message || error?.message || 'Failed to add addon';
      
      // If it's a Stremio API error, extract more details
      if (error?.error || error?.response?.data) {
        const stremioError = error?.error || error?.response?.data;
        if (typeof stremioError === 'string') {
          errorMessage = stremioError;
        } else if (stremioError?.error) {
          errorMessage = stremioError.error;
        } else if (stremioError?.message) {
          errorMessage = stremioError.message;
        }
      }
      
      res.status(statusCode < 500 ? statusCode : 400).json({ 
        error: errorMessage, 
        message: errorMessage
      });
    }
  });

  // Get user's addons (group addons and Stremio addons)
  router.get('/addons', async (req, res) => {
    try {
      const { userId } = req.query;
      const authKey = getAuthKey(req);
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get full user data up front, so we know which provider governs
      // validation - a Nuvio user has no Stremio authKey to fall back on.
      const fullUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          stremioAuthKey: true,
          providerType: true,
          nuvioRefreshToken: true,
          nuvioUserId: true,
          isActive: true,
          accountId: true,
          excludedAddons: true,
          protectedAddons: true
        }
      });

      if (!fullUser || !fullUser.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      const userAccountId = fullUser.accountId || DEFAULT_ACCOUNT_ID;

      // Validate the CALLER's own identity - was previously falling back to
      // the target's own stored credential (Stremio authKey decrypted from
      // the DB, or Nuvio's stored refresh token) whenever the request
      // didn't supply one, which verifies the target against themselves
      // and proves nothing about who's actually calling. Nuvio always
      // sends its own session token now (see verifyProviderIdentity), so
      // this fallback is no longer needed for either provider.
      let validatedUser;
      try {
        validatedUser = await verifyProviderIdentity(fullUser, authKey, req);
      } catch (error) {
        const errorMsg = error?.message || String(error || '');
        if (errorMsg === 'USER_NOT_FOUND') {
          return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found' });
        }
        if (errorMsg === 'USER_NOT_ACTIVE') {
          return res.status(403).json({ error: 'USER_NOT_ACTIVE', message: 'User account is inactive' });
        }
        if (errorMsg === 'USER_NOT_IN_GROUP') {
          return res.status(403).json({ error: 'USER_NOT_IN_GROUP', message: 'User is not in any active group' });
        }
        if (errorMsg.includes('Invalid or expired Stremio auth key') || errorMsg.includes('Invalid or expired Nuvio session')) {
          return res.status(401).json({ error: 'INVALID_AUTH_KEY', message: errorMsg });
        }
        console.error('Error validating user in /addons:', error);
        return res.status(403).json({ error: 'Access denied', message: errorMsg });
      }

      if (!validatedUser || validatedUser.id !== userId) {
        return res.status(403).json({ error: 'Access denied', message: 'User ID mismatch' });
      }

      // Get user's groups (check across all accounts to find groups containing this user)
      const allGroups = await prisma.group.findMany({
        where: {
          isActive: true
        },
        select: {
          id: true,
          userIds: true,
          accountId: true
        }
      });

      // Find groups that contain this user
      const userGroups = allGroups.filter(group => {
        if (!group.userIds) return false
        try {
          const userIds = JSON.parse(group.userIds)
          return Array.isArray(userIds) && userIds.includes(userId)
        } catch (e) {
          return false
        }
      })

      // Get group addons from the first group the user belongs to
      let groupAddons = [];
      if (userGroups.length > 0) {
        // Get full group details with addons
        const groupWithAddons = await prisma.group.findUnique({
          where: { id: userGroups[0].id },
          include: {
            addons: {
              include: {
                addon: true
              }
            }
          }
        });

        if (groupWithAddons) {
          const { getGroupAddons } = require('../utils/helpers');
          // Create a mock request object with appAccountId for getGroupAddons
          // getGroupAddons expects req with appAccountId and getAccountId
          const mockReq = { 
            appAccountId: groupWithAddons.accountId || userAccountId,
            getAccountId: () => groupWithAddons.accountId || userAccountId
          };
          groupAddons = await getGroupAddons(prisma, groupWithAddons.id, mockReq);
        }
      }

      // Get user's current addons via the provider abstraction, with the
      // same proper error handling the old Stremio-only path had.
      let stremioAddons = [];
      try {
        const providerReq = { appAccountId: userAccountId };
        const provider = createProvider(fullUser, { decrypt, req: providerReq });
        if (provider) {
          const { addons } = await provider.getAddons();
          stremioAddons = Array.isArray(addons) ? addons : [];
        }
      } catch (providerError) {
        const errorMsg = providerError?.message || providerError?.error || String(providerError || '');
        // Check if it's a decryption error (encryption key mismatch or corrupted data)
        if (/unsupported state|unable to authenticate data|invalid encrypted data|decryption failed/i.test(errorMsg)) {
          console.error(`Error fetching addons for user ${userId}: ${errorMsg}`);
          // Return empty addons instead of failing - user needs to reconnect with correct encryption key
          stremioAddons = [];
        } else if (/session does not exist|invalid|expired|authentication/i.test(errorMsg)) {
          console.error(`Error fetching addons for user ${userId}: Session does not exist`);
          // Return empty addons instead of failing - user can reconnect later
          stremioAddons = [];
        } else {
          // For other errors, rethrow to be caught by outer catch
          throw providerError;
        }
      }

      // Parse excluded addons
      // excludedAddons is stored as JSON string in DB
      let excludedAddonIds = [];
      try {
        excludedAddonIds = fullUser.excludedAddons ? JSON.parse(fullUser.excludedAddons) : [];
      } catch {
        excludedAddonIds = [];
      }

      // Parse protected addons
      let protectedAddons = [];
      try {
        protectedAddons = fullUser.protectedAddons ? JSON.parse(fullUser.protectedAddons) : [];
      } catch {
        protectedAddons = [];
      }

      res.json({
        groupAddons: groupAddons || [],
        stremioAddons: stremioAddons || [],
        excludedAddonIds: excludedAddonIds || [],
        protectedAddons: protectedAddons || []
      });
    } catch (error) {
      console.error('Error fetching addons:', error);
      res.status(500).json({ error: 'Failed to fetch addons', message: publicMessage(error, 'Failed to fetch addons') });
    }
  });

  // Exclude addon from group
  router.post('/exclude-addon', async (req, res) => {
    try {
      const { userId, addonId } = req.body;
      
      if (!userId || !addonId) {
        return res.status(400).json({ error: 'User ID and addon ID are required' });
      }

      // Get user
      if (!(await requireSelf(req, res, userId))) return;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          accountId: true,
          excludedAddons: true
        }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Parse current excluded addons
      let currentExcluded = [];
      try {
        currentExcluded = user.excludedAddons ? JSON.parse(user.excludedAddons) : [];
      } catch {
        currentExcluded = [];
      }
      
      // Add addon ID if not already excluded
      if (!currentExcluded.includes(addonId)) {
        currentExcluded.push(addonId);
        
        await prisma.user.update({
          where: { id: userId },
          data: {
            excludedAddons: JSON.stringify(currentExcluded)
          }
        });
      }

      res.json({
        success: true,
        message: 'Addon excluded from group',
        excludedAddonIds: currentExcluded
      });
    } catch (error) {
      console.error('Error excluding addon:', error);
      res.status(500).json({ error: 'Failed to exclude addon', message: publicMessage(error, 'Failed to exclude addon') });
    }
  });

  // Remove exclusion (include addon back in group)
  router.post('/include-addon', async (req, res) => {
    try {
      const { userId, addonId } = req.body;
      
      if (!userId || !addonId) {
        return res.status(400).json({ error: 'User ID and addon ID are required' });
      }

      // Get user
      if (!(await requireSelf(req, res, userId))) return;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          accountId: true,
          excludedAddons: true
        }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Parse current excluded addons
      let currentExcluded = [];
      try {
        currentExcluded = user.excludedAddons ? JSON.parse(user.excludedAddons) : [];
      } catch {
        currentExcluded = [];
      }
      
      // Remove addon ID from excluded list
      const updatedExcluded = currentExcluded.filter(id => id !== addonId);
      
      await prisma.user.update({
        where: { id: userId },
        data: {
          excludedAddons: JSON.stringify(updatedExcluded)
        }
      });

      res.json({
        success: true,
        message: 'Addon included back in group',
        excludedAddonIds: updatedExcluded
      });
    } catch (error) {
      console.error('Error including addon:', error);
      res.status(500).json({ error: 'Failed to include addon', message: publicMessage(error, 'Failed to include addon') });
    }
  });

  // Delete library item
  router.delete('/library/:itemId', async (req, res) => {
    try {
      const { userId } = req.query;
      const { itemId } = req.params;
      const authKey = getAuthKey(req);
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      if (!(await requireSelf(req, res, userId))) return;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          stremioAuthKey: true,
          providerType: true,
          isActive: true,
          accountId: true
        }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      // Nuvio's API has no library-removal capability (createNuvioProvider's
      // removeLibraryItem is a stub returning null - see server/providers/
      // nuvio.js) - an honest "not supported" here, not a silent no-op or a
      // broken attempt at Stremio-specific removal logic below.
      if (user.providerType === 'nuvio') {
        return res.status(400).json({
          error: 'NOT_SUPPORTED',
          message: "Removing items from your library isn't supported for Nuvio accounts yet"
        });
      }

      // A Jellyfin server's library is written through its provider:
      // removing takes the title out of favourites and Continue Watching.
      const jellyfinProvider = user.providerType === 'jellyfin'
        ? createProvider(user, { decrypt, req: { appAccountId: user.accountId || DEFAULT_ACCOUNT_ID } })
        : null;
      if (user.providerType === 'jellyfin' && !jellyfinProvider) {
        return res.status(400).json({ error: 'User not connected to their server' });
      }
      if (!jellyfinProvider && !user.stremioAuthKey) {
        return res.status(400).json({ error: 'User not connected to Stremio' });
      }

      // Decrypt auth key
      const mockReq = { appAccountId: user.accountId || DEFAULT_ACCOUNT_ID };
      const authKeyPlain = jellyfinProvider ? null : decrypt(user.stremioAuthKey, mockReq);

      const { markLibraryItemRemoved } = require('../utils/libraryDelete');

      try {
        await markLibraryItemRemoved({
          ...(jellyfinProvider ? { provider: jellyfinProvider } : { authKey: authKeyPlain }),
          itemId,
          logPrefix: '[public-library]'
        });
      } catch (deleteError) {
        if (deleteError.code === 'NOT_FOUND') {
          return res.status(404).json({
            error: 'Library item not found',
            itemId: deleteError.meta?.itemId,
            totalItems: deleteError.meta?.totalItems
          });
        }
        console.error('[public-library] Error deleting library item via helper:', deleteError);
        return res.status(500).json({ error: 'Failed to delete library item', message: deleteError?.message });
      }

      // Clear the cache for this user
      const { clearCache } = require('../utils/libraryCache');
      clearCache(DEFAULT_ACCOUNT_ID, user);

      res.json({ 
        success: true,
        message: 'Library item deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting library item:', error);
      res.status(500).json({ error: 'Failed to delete library item', message: publicMessage(error, 'Failed to delete library item') });
    }
  });

  // Toggle addon protection status
  router.post('/protect-addon', async (req, res) => {
    try {
      const { userId, name } = req.body;
      const { unsafe } = req.query;
      const authKey = getAuthKey(req);
      
      if (!userId || !name) {
        return res.status(400).json({ error: 'User ID and addon name are required' });
      }

      // Default Stremio addons (name-based) in safe mode
      const { defaultAddons } = require('../utils/config');
      const normalizeName = (n) => String(n || '').trim().toLowerCase();
      const isDefaultAddon = defaultAddons.names.some((n) => normalizeName(name).includes(normalizeName(n)));
      
      if (isDefaultAddon && unsafe !== 'true') {
        return res.status(403).json({ 
          error: 'This addon is protected by default and cannot be unprotected in safe mode',
          isDefaultAddon: true
        });
      }

      // Get user
      if (!(await requireSelf(req, res, userId))) return;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          accountId: true,
          protectedAddons: true
        }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Parse current protected addons (plaintext names)
      let currentList = [];
      try {
        currentList = user.protectedAddons ? JSON.parse(user.protectedAddons) : [];
      } catch {
        currentList = [];
      }

      const targetName = name.trim();
      const targetNorm = normalizeName(targetName);
      const nextList = [...currentList];
      const idx = nextList.findIndex((n) => normalizeName(n) === targetNorm);
      
      if (idx >= 0) {
        nextList.splice(idx, 1);
      } else {
        nextList.push(targetName);
      }

      // Update user
      await prisma.user.update({
        where: { id: userId },
        data: {
          protectedAddons: JSON.stringify(nextList)
        }
      });
      
      const isProtected = nextList.findIndex((n) => normalizeName(n) === targetNorm) >= 0;
      
      res.json({ 
        message: `Addon ${isProtected ? 'protected' : 'unprotected'}`,
        protectedAddons: nextList,
        isProtected
      });
    } catch (error) {
      console.error('Error toggling protect addon:', error);
      res.status(500).json({ error: 'Failed to toggle protect addon', message: publicMessage(error, 'Failed to toggle protect addon') });
    }
  });

  // Remove addon from Stremio (for user portal - always allowed, no protection check)
  router.delete('/stremio-addons/:addonName', async (req, res) => {
    try {
      const { userId } = req.query;
      const { addonName } = req.params;
      const authKey = getAuthKey(req);
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      if (!(await requireSelf(req, res, userId))) return;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          accountId: true,
          stremioAuthKey: true,
          providerType: true,
          nuvioRefreshToken: true,
          nuvioUserId: true,
          isActive: true,
          protectedAddons: true
        }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      if (user.providerType === 'jellyfin') {
        return res.status(400).json({ error: 'NOT_SUPPORTED', message: 'Your server has no addon list for SlickSync to change' });
      }
      const isNuvio = user.providerType === 'nuvio';
      const providerReady = isNuvio ? !!(user.nuvioRefreshToken && user.nuvioUserId) : !!user.stremioAuthKey;
      if (!providerReady) {
        return res.status(400).json({ error: `User not connected to ${isNuvio ? 'Nuvio' : 'Stremio'}` });
      }

      const normalizeName = (n) => String(n || '').trim().toLowerCase();
      const targetNameNormalized = normalizeName(addonName);
      
      // First, unprotect the addon if it's in the protected list (so user can delete their own protected addons)
      let userProtectedNames = [];
      try {
        const parsed = user.protectedAddons ? JSON.parse(user.protectedAddons) : [];
        if (Array.isArray(parsed)) {
          userProtectedNames = parsed;
        }
      } catch {
        userProtectedNames = [];
      }
      
      // Remove from protected list if present
      const updatedProtectedNames = userProtectedNames.filter(n => normalizeName(n) !== targetNameNormalized);
      if (updatedProtectedNames.length !== userProtectedNames.length) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            protectedAddons: JSON.stringify(updatedProtectedNames)
          }
        });
      }

      // Remove via the provider abstraction - get-filter-set works
      // identically for both, since both implement getAddons()/setAddons()
      // with the same {addons:[...]} shape.
      const mockReq = { appAccountId: user.accountId || DEFAULT_ACCOUNT_ID };
      const provider = createProvider({ ...user }, { decrypt, req: mockReq });
      if (!provider) {
        return res.status(400).json({ error: 'User provider credentials are invalid' });
      }

      const { addons: currentAddonsRaw } = await provider.getAddons();
      const currentAddons = Array.isArray(currentAddonsRaw) ? currentAddonsRaw : [];

      // Filter out the target addon by matching name (normalized)
      const filteredAddons = currentAddons.filter((a) => {
        const aName = a?.manifest?.name || a?.transportName || a?.name || '';
        return normalizeName(aName) !== targetNameNormalized;
      });

      // Set the filtered addons
      await provider.setAddons(filteredAddons);
      await require('../utils/accountGuard').recordAssertedState(prisma, userId, user.providerType, filteredAddons);

      res.json({ message: `Addon removed from ${isNuvio ? 'Nuvio' : 'Stremio'} account successfully` });
    } catch (error) {
      console.error('Error removing addon:', error);
      res.status(500).json({ error: 'Failed to remove addon', message: publicMessage(error, 'Failed to remove addon') });
    }
  });

  // Generate/rotate user API key (user-specific, for accessing own metrics only).
  // A person who already has a key gets it back as it is; only `rotate: true`
  // replaces it, so a page that merely found no key to show cannot cut off
  // whatever already uses the one they have.
  router.post('/user-api-key', async (req, res) => {
    try {
      const { userId, rotate } = req.body;
      const authKey = getAuthKey(req);

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          accountId: true,
          isActive: true,
          apiKey: true,
          stremioAuthKey: true,
          providerType: true,
          nuvioRefreshToken: true,
          nuvioUserId: true
        }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      try {
        await verifyProviderIdentity(user, authKey, req);
      } catch (e) {
        return res.status(401).json({ error: publicMessage(e, 'Something went wrong') });
      }

      // Encrypt using user-specific key (userId + server key) - same pattern as account API keys
      const { getServerKey, aesGcmEncrypt, aesGcmDecrypt } = require('../utils/encryption');
      const serverKey = getServerKey();
      const crypto = require('crypto');
      const userKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(userId), serverKey])).digest();

      if (user.apiKey && rotate !== true) {
        try {
          return res.json({ apiKey: aesGcmDecrypt(userKey, user.apiKey) });
        } catch (e) {
          // A key that can no longer be read is no key (the GET route treats
          // it the same way), so a new one is made below.
          console.error('Failed to decrypt user API key:', e.message);
        }
      }

      // Generate new API key
      const { generateApiKey } = require('../utils/apiKey');
      const key = generateApiKey();
      const encrypted = aesGcmEncrypt(userKey, key);
      
      await prisma.user.update({
        where: { id: userId },
        data: { apiKey: encrypted }
      });
      require('../utils/apiKeyIndex').markKeysChanged();

      // Return the key
      res.json({ apiKey: key });
    } catch (error) {
      console.error('Error generating user API key:', error);
      res.status(500).json({ error: 'Failed to generate API key', message: publicMessage(error, 'Failed to generate API key') });
    }
  });

  // Get user API key (retrieve existing key)
  router.get('/user-api-key', async (req, res) => {
    try {
      const { userId } = req.query;
      const authKey = getAuthKey(req);

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          apiKey: true,
          stremioAuthKey: true,
          accountId: true,
          providerType: true,
          nuvioRefreshToken: true,
          nuvioUserId: true
        }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      try {
        await verifyProviderIdentity(user, authKey, req);
      } catch (e) {
        return res.status(401).json({ error: publicMessage(e, 'Something went wrong') });
      }

      if (!user.apiKey) {
        return res.json({ hasKey: false, apiKey: null });
      }

      // Decrypt using user-specific key (userId + server key)
      try {
        const { getServerKey, aesGcmDecrypt } = require('../utils/encryption');
        const serverKey = getServerKey();
        const crypto = require('crypto');
        const userKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(userId), serverKey])).digest();
        const decrypted = aesGcmDecrypt(userKey, user.apiKey);
        return res.json({ hasKey: true, apiKey: decrypted });
      } catch (e) {
        // If decryption fails, key might be in old format (hashed) - treat as no key
        console.error('Failed to decrypt user API key:', e.message);
        return res.json({ hasKey: false, apiKey: null });
      }
    } catch (error) {
      console.error('Error getting user API key:', error);
      res.status(500).json({ error: 'Failed to get API key', message: publicMessage(error, 'Failed to get API key') });
    }
  });

  // Check if user has an API key (legacy endpoint, kept for compatibility)
  router.get('/user-api-key-status', async (req, res) => {
    try {
      const { userId } = req.query;
      const authKey = getAuthKey(req);

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          apiKey: true,
          stremioAuthKey: true,
          accountId: true,
          providerType: true,
          nuvioRefreshToken: true,
          nuvioUserId: true
        }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      try {
        await verifyProviderIdentity(user, authKey, req);
      } catch (e) {
        return res.status(401).json({ error: publicMessage(e, 'Something went wrong') });
      }

      res.json({ hasKey: !!user.apiKey });
    } catch (error) {
      console.error('Error checking user API key status:', error);
      res.status(500).json({ error: 'Failed to check API key status', message: publicMessage(error, 'Failed to check API key status') });
    }
  });

  // Get user's activity (watch sessions and stats)
  router.get('/activity', async (req, res) => {
    try {
      const { userId, limit = 100 } = req.query;
      const authKey = getAuthKey(req);
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          email: true,
          colorIndex: true,
          accountId: true,
          isActive: true,
          stremioAuthKey: true,
          providerType: true,
          nuvioRefreshToken: true,
          nuvioUserId: true
        }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      // Auth gate here is identity-check only (the actual data below is
      // 100% SlickSync's own DB - WatchActivity, library cache - never a
      // live provider call). Routed through the shared verifyProviderIdentity
      // (fixed to actually check the caller's own credential for Nuvio too,
      // not just the target's own stored token) instead of a hand-rolled
      // copy of the same logic.
      try {
        await verifyProviderIdentity(user, authKey, req);
      } catch (e) {
        return res.status(401).json({ error: publicMessage(e, 'Invalid auth key') });
      }

      // Fetch watch activity for this user (using WatchActivity table like old slicksync)
      console.log('Fetching watch activity for user:', userId, 'account:', user.accountId);
      const watchActivities = await prisma.watchActivity.findMany({
        where: {
          userId: userId,
          accountId: user.accountId || DEFAULT_ACCOUNT_ID
        },
        orderBy: { date: 'desc' },
        take: parseInt(limit) || 100
      });
      console.log('Watch activities found:', watchActivities.length);

      // Load library cache to get item names and posters
      console.log('Loading library cache for account:', user.accountId);
      const libraryCache = getCachedLibrary(user.accountId || DEFAULT_ACCOUNT_ID, user) || [];
      console.log('Library cache items:', libraryCache.length);
      // Titles the cache doesn't hold yet are looked up, so a cold cache
      // never shows ids in place of names.
      const { portalActivityMetadata } = require('../utils/portalActivityMetadata');
      const libraryItemMap = await portalActivityMetadata(libraryCache, watchActivities);
      console.log('Library item map size:', libraryItemMap.size);

      // Helper function to extract season/episode from itemId
      function extractSeasonEpisodeFromId(itemId) {
        if (!itemId) return { season: null, episode: null };
        const parts = itemId.split(':');
        
        // Kitsu format: "kitsu:46676:1"
        if (itemId.startsWith('kitsu:') && parts.length >= 3) {
          const episodePart = parts[parts.length - 1];
          const parsedEpisode = parseInt(episodePart, 10);
          return {
            season: 1,
            episode: !isNaN(parsedEpisode) ? parsedEpisode : null
          };
        }
        
        // IMDb format: "tt8080122:4:6" (season:episode)
        if (parts.length >= 3 && parts[0].startsWith('tt')) {
          return {
            season: parseInt(parts[1], 10) || null,
            episode: parseInt(parts[2], 10) || null
          };
        }
        
        // IMDb format: "tt8080122:6" (episode only)
        if (parts.length === 2 && parts[0].startsWith('tt')) {
          return {
            season: null,
            episode: parseInt(parts[1], 10) || null
          };
        }
        
        return { season: null, episode: null };
      }

      // Fetch episode watch history for additional detail
      const episodeHistory = await prisma.episodeWatchHistory.findMany({
        where: {
          userId: userId,
          accountId: user.accountId || DEFAULT_ACCOUNT_ID
        },
        orderBy: { watchedAt: 'desc' },
        take: parseInt(limit) || 100
      });

      // Transform watch activity into activity items (like old slicksync)
      const activityItems = watchActivities.map(activity => {
        // Get item details from library cache
        const libraryItem = libraryItemMap.get(activity.itemId);
        const { season, episode } = extractSeasonEpisodeFromId(activity.itemId);
        
        // Calculate end time from date + watchTimeSeconds
        const startTime = new Date(activity.date);
        const endTime = new Date(startTime.getTime() + (activity.watchTimeSeconds * 1000));
        
        return {
          id: activity.id,
          type: 'session',
          userId: activity.userId,
          username: user.username || user.email || 'Unknown',
          userEmail: user.email,
          userColorIndex: user.colorIndex || 0,
          itemId: activity.itemId,
          videoId: activity.itemId, // Use itemId as videoId for series
          itemName: libraryItem?.name || activity.itemId,
          itemType: activity.itemType,
          season: season,
          episode: episode,
          poster: libraryItem?.poster || null,
          startTime: startTime,
          endTime: endTime,
          durationSeconds: activity.watchTimeSeconds,
          isActive: false, // Historical data, never active
          isSynthetic: false
        };
      });

      // Transform episode history into activity items (as fallback/additional data)
      const episodeItems = episodeHistory.map(history => ({
        id: history.id,
        type: 'episode',
        userId: history.userId,
        username: user.username || user.email || 'Unknown',
        userEmail: user.email,
        userColorIndex: user.colorIndex || 0,
        itemId: history.itemId,
        videoId: history.videoId,
        itemName: history.itemName,
        itemType: 'series',
        season: history.season,
        episode: history.episode,
        poster: history.poster,
        startTime: history.watchedAt,
        endTime: history.watchedAt,
        durationSeconds: history.durationSeconds || 0,
        isActive: false,
        isSynthetic: false
      }));

      // Calculate stats
      // todayStart used to be server-local midnight (new Date(now.getFullYear(),
      // now.getMonth(), now.getDate())) - the server's own process timezone
      // (UTC in Docker), not the account's configured one. WatchActivity.date
      // is written as new Date(getAccountDateString(...)) (UTC-midnight of
      // the ACCOUNT's day, per metricsProcessor.js), so comparing against a
      // server-local "today" silently missed or misattributed activity
      // whenever the two disagreed about what day it currently is - the same
      // bug class as the Activity page's "Watch Time Today" fixed earlier,
      // just computed a different way here. Building todayStart the same way
      // WatchActivity rows are keyed keeps this comparison meaningful.
      const accountTimeZone = await resolveAccountTimezone(prisma, user.accountId || DEFAULT_ACCOUNT_ID)
      const todayStart = new Date(getAccountDateString(new Date(), accountTimeZone));
      const oneWeekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Total watch time (all watch activities)
      const totalWatchTimeSeconds = watchActivities
        .reduce((sum, a) => sum + (a.watchTimeSeconds || 0), 0);

      // Watch time today
      const watchTimeTodaySeconds = watchActivities
        .filter(a => new Date(a.date) >= todayStart)
        .reduce((sum, a) => sum + (a.watchTimeSeconds || 0), 0);

      // Count movies and series from unique items
      const uniqueItems = new Map();
      watchActivities.forEach(a => {
        if (!uniqueItems.has(a.itemId)) {
          uniqueItems.set(a.itemId, a.itemType);
        }
      });
      const moviesCount = [...uniqueItems.values()].filter(t => t === 'movie').length;
      const seriesCount = [...uniqueItems.values()].filter(t => t === 'series').length;

      // Items watched this week
      const recentItemsCount = watchActivities
        .filter(a => new Date(a.date) >= oneWeekAgo)
        .length;

      // Watch time by day (last 7 days)
      const watchTimeByDay = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date(todayStart);
        date.setDate(date.getDate() - i);
        const dayStart = new Date(date);
        const dayEnd = new Date(date);
        dayEnd.setHours(23, 59, 59, 999);

        const dayActivities = watchActivities.filter(a => {
          const activityDate = new Date(a.date);
          return activityDate >= dayStart && activityDate <= dayEnd;
        });

        const daySeconds = dayActivities.reduce((sum, a) => sum + (a.watchTimeSeconds || 0), 0);
        const dayMovies = dayActivities.filter(a => a.itemType === 'movie').length;
        const daySeries = dayActivities.filter(a => a.itemType === 'series').length;

        watchTimeByDay.push({
          // date is UTC-midnight of an account-day (derived from the fixed
          // todayStart above) - explicit timeZone: 'UTC' keeps the weekday
          // label tied to that same day regardless of the server process's
          // own TZ setting, rather than relying on it happening to be UTC.
          date: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
          hours: daySeconds / 3600,
          minutes: Math.round(daySeconds / 60),
          movies: dayMovies,
          series: daySeries,
          total: dayActivities.length
        });
      }

      // === ADDITIONAL STATS FOR USER HOME ===

      // Watched today count
      const watchedTodayCount = watchActivities
        .filter(a => new Date(a.date) >= todayStart)
        .length;

      // Calculate watch streak
      let currentStreak = 0;
      let longestStreak = 0;
      let tempStreak = 0;
      const activitiesByDay = new Map();
      
      // Group activities by date
      watchActivities.forEach(a => {
        const dateKey = new Date(a.date).toISOString().split('T')[0];
        if (!activitiesByDay.has(dateKey)) {
          activitiesByDay.set(dateKey, true);
        }
      });

      // Calculate current streak (consecutive days from today going backwards)
      const checkDate = new Date(todayStart);
      while (true) {
        const dateKey = checkDate.toISOString().split('T')[0];
        if (activitiesByDay.has(dateKey)) {
          currentStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          // Allow 1 day gap only if today has no activity yet
          if (currentStreak === 0 && checkDate.getTime() === todayStart.getTime()) {
            checkDate.setDate(checkDate.getDate() - 1);
            continue;
          }
          break;
        }
      }

      // Calculate longest streak
      const sortedDates = [...activitiesByDay.keys()].sort();
      tempStreak = 0;
      for (let i = 0; i < sortedDates.length; i++) {
        if (i === 0) {
          tempStreak = 1;
        } else {
          const prevDate = new Date(sortedDates[i - 1]);
          const currDate = new Date(sortedDates[i]);
          const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / (24 * 60 * 60 * 1000));
          if (diffDays === 1) {
            tempStreak++;
          } else {
            if (tempStreak > longestStreak) longestStreak = tempStreak;
            tempStreak = 1;
          }
        }
      }
      if (tempStreak > longestStreak) longestStreak = tempStreak;

      // Average watch time per day (last 7 days with activity)
      const daysWithActivity = watchTimeByDay.filter(d => d.total > 0);
      const avgWatchTimeSeconds = daysWithActivity.length > 0
        ? daysWithActivity.reduce((sum, d) => sum + (d.hours * 3600), 0) / daysWithActivity.length
        : 0;

      // Most watched item
      const itemCounts = new Map();
      watchActivities.forEach(a => {
        const key = a.itemId;
        const libraryItem = libraryItemMap.get(a.itemId);
        if (!itemCounts.has(key)) {
          itemCounts.set(key, { 
            count: 0, 
            name: libraryItem?.name || a.itemId, 
            type: a.itemType,
            poster: libraryItem?.poster || null,
            totalDuration: 0
          });
        }
        const item = itemCounts.get(key);
        item.count++;
        item.totalDuration += (a.watchTimeSeconds || 0);
      });
      
      // The top five for their Home (mostWatched stays the first, for older pages).
      const mostWatchedList = [...itemCounts.entries()]
        .sort((a, b) => b[1].totalDuration - a[1].totalDuration)
        .slice(0, 5)
        .map(([id, data]) => ({
          id,
          name: data.name,
          type: data.type,
          poster: data.poster,
          count: data.count,
          totalDuration: data.totalDuration
        }));
      const mostWatched = mostWatchedList[0] || null;

      // Binge watches (3+ episodes of same series in one day)
      const bingeWatches = [];
      const seriesActivitiesByDay = new Map();
      
      watchActivities.filter(a => a.itemType === 'series').forEach(a => {
        const dateKey = new Date(a.date).toISOString().split('T')[0];
        const seriesKey = `${dateKey}:${a.itemId}`;
        const libraryItem = libraryItemMap.get(a.itemId);
        const { season, episode } = extractSeasonEpisodeFromId(a.itemId);
        
        if (!seriesActivitiesByDay.has(seriesKey)) {
          seriesActivitiesByDay.set(seriesKey, { 
            name: libraryItem?.name || a.itemId, 
            poster: libraryItem?.poster || null,
            episodes: [],
            totalDuration: 0,
            date: dateKey
          });
        }
        const series = seriesActivitiesByDay.get(seriesKey);
        series.episodes.push({ season, episode });
        series.totalDuration += (a.watchTimeSeconds || 0);
      });

      for (const [key, data] of seriesActivitiesByDay.entries()) {
        if (data.episodes.length >= 3) {
          bingeWatches.push({
            name: data.name,
            poster: data.poster,
            episodeCount: data.episodes.length,
            totalDuration: data.totalDuration,
            date: data.date
          });
        }
      }
      bingeWatches.sort((a, b) => b.episodeCount - a.episodeCount);

      // Now playing - query watchSession for real-time active sessions
      const activeSessions = await prisma.watchSession.findMany({
        where: {
          userId: userId,
          accountId: user.accountId || DEFAULT_ACCOUNT_ID,
          isActive: true
        },
        orderBy: { startTime: 'desc' }
      });
      
      // A Jellyfin login's live signal is its server's sessions list (added
      // below); its library-read sessions linger after a viewing stops.
      // A session whose last checkpoint sits at the end of the runtime is a
      // watch that ended, not one that is playing - the same rule the admin
      // Activity page uses (metricsBuilder.js).
      const { hasReachedEnd } = require('../utils/sessionTracker');
      // Nuvio's own save time per title (the library read), for the 5-minute
      // rule the admin Now Playing uses too (metricsBuilder nuvioOnlyCards).
      const baseOf = (id) => /^tt\d+/.exec(String(id || ''))?.[0] || String(id || '');
      const nuvioSave = (s) => {
        if (user.providerType !== 'nuvio') return undefined;
        const item = libraryCache.find(i => baseOf(i?._id || i?.id) === baseOf(s.itemId));
        const at = Date.parse(item?.state?.lastWatched || '');
        return Number.isFinite(at) ? at : (s.updatedAt ? s.updatedAt.getTime() : null);
      };
      const nowPlaying = (user.providerType === 'jellyfin' ? [] : activeSessions)
        .filter(s => !hasReachedEnd(s.lastPosition, s.totalDuration))
        .filter(s => !(Number(s.totalDuration) > 0 && Number(s.lastPosition) >= Number(s.totalDuration) * 0.92))
        .map(s => ({
        item: {
          id: s.itemId,
          name: s.itemName,
          type: s.itemType,
          poster: s.poster,
          season: s.season,
          episode: s.episode
        },
        startTime: s.startTime,
        videoId: s.videoId,
        lastPosition: s.lastPosition ?? null,
        totalDuration: s.totalDuration ?? null,
        // Resume in their app once paused - the same episode-aware links as Continue Watching.
        ...(s.itemId ? {
          stremioAppUrl: buildStremioLinks(s.itemId, s.itemType === 'series' ? 'series' : 'movie', s.season, s.episode).appUrl,
          nuvioAppUrl: buildNuvioAppUrl(s.itemType === 'series' ? 'series' : 'movie', s.itemId),
        } : {}),
        ...(nuvioSave(s) !== undefined ? { nuvioSavedAt: nuvioSave(s), ...(nuvioSave(s) != null ? { reportedAtTimestamp: nuvioSave(s) } : {}) }
          : s.updatedAt ? { reportedAtTimestamp: s.updatedAt.getTime() } : {})
      }));

      // Playing in AIOStreams' own apps - see utils/watchState.js liveViewings() -
      // or on a Jellyfin server they sign in to (utils/jellyfinLive.js).
      try {
        const { liveViewings } = require('../utils/watchState');
        const jellyfinViewings = require('../utils/jellyfinLive').liveViewings([userId]).map(v => ({ ...v, source: 'jellyfin' }));
        for (const v of [...await liveViewings(prisma, user.accountId || DEFAULT_ACCOUNT_ID, [userId]), ...jellyfinViewings]) {
          if (nowPlaying.some(np => np.item.id === v.itemId)) continue;
          nowPlaying.push({
            item: { id: v.itemId, name: v.itemName || v.itemId, type: v.itemType, poster: v.poster, season: v.season, episode: v.episode },
            startTime: v.startedAt,
            videoId: v.videoId,
            // For the cards' "Live / Paused / Last seen" line.
            source: v.source || 'aiostreams',
            ...(v.observedAt != null ? { reportedAtTimestamp: new Date(v.observedAt).getTime() } : {}),
            ...(v.paused === true ? { paused: true } : {}),
            ...(typeof v.playingUntil === 'number' ? { playingUntilTimestamp: v.playingUntil } : {})
          });
        }
      } catch (error) {
        console.warn('[PublicLibrary] Failed to read AIOStreams viewings:', error.message);
      }

      // Merge in an AIOStreams proxy-detected active stream for this user
      // (faster/more accurate start/stop detection than the WatchSession
      // pipeline above). Wrapped/unwrapped around the shared helper since
      // this route's nowPlaying entries have no `user` field (already
      // scoped to one user) unlike metricsBuilder.js's account-wide list.
      try {
        const { mergeProxyNowPlaying } = require('../utils/proxyNowPlaying');
        const wrapped = nowPlaying.map(np => ({ user: { id: userId }, ...np }));
        // Attributed among the whole household, then narrowed to this person.
        // Given only this one person to choose from, a stream that belongs to
        // someone else in the household (matched by their own AIOStreams
        // login) had nobody else to go to and showed up here as theirs.
        const household = await prisma.user.findMany({
          where: { accountId: user.accountId || DEFAULT_ACCOUNT_ID, isActive: true },
          select: { id: true, username: true, email: true, colorIndex: true, avatarUrl: true, useGravatar: true }
        });
        const merged = await mergeProxyNowPlaying(prisma, user.accountId || DEFAULT_ACCOUNT_ID, household.length ? household : [user], wrapped);
        nowPlaying.length = 0;
        nowPlaying.push(...merged.filter(m => m.user?.id === userId).map(m => ({
          item: m.item,
          startTime: m.startTime,
          videoId: m.videoId,
          // What the admin page gets too: where playback is, and whether
          // this is a live proxy stream and its timer still running.
          lastPosition: m.lastPosition ?? null,
          totalDuration: m.totalDuration ?? null,
          ...(typeof m.positionAt === 'number' ? { positionAt: m.positionAt } : {}),
          ...(typeof m.reportedAtTimestamp === 'number' ? { reportedAtTimestamp: m.reportedAtTimestamp } : {}),
          ...(m.paused === true ? { paused: true } : {}),
          ...(typeof m.playingUntilTimestamp === 'number' ? { playingUntilTimestamp: m.playingUntilTimestamp } : {}),
          ...(m.source ? { source: m.source, elapsedSeconds: m.elapsedSeconds, elapsedFrozen: m.elapsedFrozen } : {}),
          ...(m.stremioAppUrl ? { stremioAppUrl: m.stremioAppUrl } : {}),
          ...(m.nuvioAppUrl ? { nuvioAppUrl: m.nuvioAppUrl } : {}),
          ...('nuvioSavedAt' in m ? { nuvioSavedAt: m.nuvioSavedAt } : {})
        })));
      } catch (error) {
        console.warn('[PublicLibrary] Failed to merge proxy now playing:', error.message);
      }
      {
        // A card only Nuvio's own saves stand behind: 5 minutes, newest only.
        const { nuvioOnlyCards } = require('../utils/metricsBuilder');
        const keep = nuvioOnlyCards(nowPlaying, Date.now());
        nowPlaying.length = 0;
        nowPlaying.push(...keep);
      }
      try {
        // Runtime, the episode's name, and an estimate when the app hasn't said (shown only).
        const { addEstimate } = require('../utils/nowPlayingEstimate');
        for (const np of nowPlaying) addEstimate(np, np.startTime ? new Date(np.startTime).getTime() : undefined);
      } catch (error) {
        console.warn('[PublicLibrary] Failed to add Now Playing estimates:', error.message);
      }

      res.json({
        sessions: activityItems,
        episodeHistory: episodeItems,
        stats: {
          totalWatchTimeSeconds,
          totalWatchTimeHours: totalWatchTimeSeconds / 3600,
          watchTimeTodaySeconds,
          watchTimeTodayHours: watchTimeTodaySeconds / 3600,
          watchedTodayCount,
          moviesCount,
          seriesCount,
          recentItemsCount,
          totalSessions: watchActivities.length,
          currentStreak,
          longestStreak,
          avgWatchTimeSeconds,
          avgWatchTimeHours: avgWatchTimeSeconds / 3600
        },
        watchTimeByDay,
        nowPlaying,
        mostWatched,
        mostWatchedList,
        recentlyWatched: await recentlyWatchedGroups(prisma, user.accountId || DEFAULT_ACCOUNT_ID, userId),
        profileLabel: await latestProfileLabel(prisma, user.accountId || DEFAULT_ACCOUNT_ID, userId),
        bingeWatches: bingeWatches.slice(0, 5),
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          colorIndex: user.colorIndex
        }
      });
    } catch (error) {
      console.error('Error fetching user activity:', error);
      res.status(500).json({ error: 'Failed to fetch activity', message: publicMessage(error, 'Failed to fetch activity') });
    }
  });

  // Self-service data export - lets a managed user download their own watch
  // history and household watchlist as JSON, without asking an admin to run
  // the Disaster Recovery Kit (which is account-wide, not scoped to one user,
  // and admin-only). Same auth pattern as /activity and /library above.
  router.get('/export', async (req, res) => {
    try {
      const { userId } = req.query;
      const authKey = getAuthKey(req);

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, email: true, accountId: true, isActive: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      try {
        await verifyProviderIdentity(user, authKey, req);
      } catch (e) {
        return res.status(401).json({ error: publicMessage(e, 'Something went wrong') });
      }

      const accountId = user.accountId || DEFAULT_ACCOUNT_ID;

      const [movieHistory, episodeHistory, watchlist] = await Promise.all([
        prisma.movieWatchHistory.findMany({
          where: { userId, accountId },
          orderBy: { watchedAt: 'desc' },
          select: { itemId: true, itemName: true, poster: true, watchedAt: true }
        }),
        prisma.episodeWatchHistory.findMany({
          where: { userId, accountId },
          orderBy: { watchedAt: 'desc' },
          select: { showId: true, showName: true, videoId: true, season: true, episode: true, poster: true, watchedAt: true }
        }),
        // Household-wide, not per-user - Watchlist has no userId column (it's
        // a shared account list, same one Discover's "Add to Watchlist" and
        // the physical-button "surprise me" pick draw from) - included as-is
        // since it's still part of what this account's data consists of.
        prisma.watchlistItem.findMany({
          where: { accountId },
          orderBy: { addedAt: 'desc' },
          select: { itemId: true, itemType: true, name: true, poster: true, addedAt: true }
        })
      ]);

      res.json({
        exportedAt: new Date().toISOString(),
        user: { username: user.username, email: user.email },
        movieHistory,
        episodeHistory,
        watchlist
      });
    } catch (error) {
      console.error('Error exporting user data:', error);
      res.status(500).json({ error: 'Failed to export data', message: publicMessage(error, 'Failed to export data') });
    }
  });

  // Delete user API key
  router.delete('/user-api-key', async (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      if (!(await requireSelf(req, res, userId))) return;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { apiKey: null }
      });

      res.json({ message: 'API key revoked' });
    } catch (error) {
      console.error('Error revoking user API key:', error);
      res.status(500).json({ error: 'Failed to revoke API key', message: publicMessage(error, 'Failed to revoke API key') });
    }
  });

  // Self-service "delete my account" - a managed User removing only their
  // own row and the data scoped to their own userId (watch history,
  // watchlist-adjacent per-user state, group membership). Deliberately NOT
  // gated to public instance mode like Settings' admin-level delete-account
  // (that one wipes the WHOLE shared tenant, which only makes sense to
  // offer in public multi-tenant mode) - this only ever touches one user's
  // own data, which is meaningful in private mode too (e.g. a former
  // household member who no longer wants their history around). Unlike most
  // of this router's other mutations, this re-proves the live session right
  // here before doing anything irreversible, rather than trusting a bare
  // userId - same checks /validate and /validate-nuvio already do.
  router.post('/delete-account', async (req, res) => {
    try {
      const { userId, provider } = req.body || {}
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required', message: 'User ID is required' })
      }

      const user = await prisma.user.findUnique({ where: { id: userId } })
      if (!user) {
        return res.status(404).json({ error: 'User not found', message: 'User not found' })
      }

      const effectiveProvider = provider || user.providerType || 'stremio'

      if (effectiveProvider === 'jellyfin') {
        // Same proof of possession as Nuvio below: the caller's own session
        // token, issued when they signed in to their server.
        const jellyfinToken = getAuthKey(req)
        if (user.providerType !== 'jellyfin' || !jellyfinToken || !verifyJellyfinSessionToken(jellyfinToken, userId)) {
          return res.status(401).json({ error: 'Invalid or expired session', message: 'Your session has expired - please sign in again before deleting your account' })
        }
      } else if (effectiveProvider === 'nuvio') {
        // Real proof of possession, not just "does the TARGET's own stored
        // token still work upstream" (that was the bug: it verifies the
        // target user's session, not the caller's - anyone who knew a
        // userId could delete anyone's account). Caller must present their
        // own session token, issued at login/validate, proving THEY are
        // this exact user.
        const nuvioToken = getAuthKey(req)
        if (!nuvioToken || !verifyNuvioSessionToken(nuvioToken, userId)) {
          return res.status(401).json({ error: 'Invalid or expired Nuvio session', message: 'Invalid or expired Nuvio session - please sign in again before deleting your account' })
        }
        if (!user.nuvioRefreshToken || !user.nuvioUserId) {
          return res.status(403).json({ error: 'USER_NOT_FOUND', message: 'Unable to verify your Nuvio session' })
        }
      } else {
        const authKey = getAuthKey(req)
        if (!authKey) {
          return res.status(400).json({ error: 'Auth key is required', message: 'Auth key is required' })
        }
        let validated
        try {
          validated = await getPublicUser(authKey, req, userId)
        } catch {
          return res.status(401).json({ error: 'Invalid or expired Stremio session', message: 'Invalid or expired Stremio session - please sign in again before deleting your account' })
        }
        if (validated.id !== userId) {
          return res.status(403).json({ error: 'Session mismatch', message: 'This Stremio session does not match this account' })
        }
      }

      const { deleteUserCascade } = require('../utils/accountDeletion')
      await deleteUserCascade(prisma, userId)
      res.json({ deleted: true })
    } catch (error) {
      if (error?.notFound) return res.status(404).json({ error: 'User not found', message: 'User not found' })
      console.error('Error deleting user account:', error)
      res.status(500).json({ error: 'Failed to delete account', message: publicMessage(error, 'Failed to delete account') })
    }
  })

  // Sync user's addons (public endpoint)
  router.post('/sync', async (req, res) => {
    try {
      const { userId } = req.body;
      const authKey = getAuthKey(req);
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user and verify auth
      if (!(await requireSelf(req, res, userId))) return;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          username: true,
          email: true,
          accountId: true,
          isActive: true,
          stremioAuthKey: true
        }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }


      // Import syncUserAddons from users route
      const { syncUserAddons } = require('./users');
      
      // Perform sync
      const result = await syncUserAddons(prisma, userId, [], false, req, decrypt, () => user.accountId, true);
      
      if (result.success) {
        res.json({ 
          success: true, 
          message: 'Sync completed successfully',
          details: result
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: result.error || 'Sync failed',
          details: result
        });
      }
    } catch (error) {
      console.error('Error syncing user:', error);
      res.status(500).json({ error: 'Failed to sync', message: publicMessage(error, 'Failed to sync') });
    }
  });

  // Check if user is at risk (public endpoint)
  router.get('/at-risk-status', async (req, res) => {
    try {
      const { userId } = req.query;
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user with sync status info
      if (!(await requireSelf(req, res, userId))) return;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          isActive: true,
          accountId: true,
          lastSyncedAt: true,
          syncStatus: true,
          syncErrorMessage: true
        }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      // Check last activity (from watch activity)
      const lastActivity = await prisma.watchActivity.findFirst({
        where: { userId },
        orderBy: { date: 'desc' },
        select: { date: true }
      });

      const now = new Date();
      const lastActivityDate = lastActivity?.date || user.lastSyncedAt;
      const daysSinceActivity = lastActivityDate 
        ? Math.floor((now.getTime() - new Date(lastActivityDate).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      // Determine risk level
      let riskLevel = 'healthy'; // healthy, warning, critical
      let riskReason = null;

      if (user.syncStatus === 'error' || user.syncStatus === 'failed') {
        riskLevel = 'critical';
        riskReason = user.syncErrorMessage || 'Sync is failing';
      } else if (daysSinceActivity !== null) {
        if (daysSinceActivity >= 14) {
          riskLevel = 'critical';
          riskReason = `No activity for ${daysSinceActivity} days`;
        } else if (daysSinceActivity >= 7) {
          riskLevel = 'warning';
          riskReason = `No activity for ${daysSinceActivity} days`;
        }
      }

      res.json({
        userId,
        riskLevel,
        riskReason,
        lastActivity: lastActivityDate,
        daysSinceActivity,
        syncStatus: user.syncStatus,
        syncErrorMessage: user.syncErrorMessage,
        lastSyncedAt: user.lastSyncedAt
      });
    } catch (error) {
      console.error('Error checking at-risk status:', error);
      res.status(500).json({ error: 'Failed to check status', message: publicMessage(error, 'Failed to check status') });
    }
  });

  // Public endpoint: Get user shares
  router.get('/shares', async (req, res) => {
    try {
      const { userId } = req.query;
      const authKey = getAuthKey(req);
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, accountId: true, isActive: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      try {
        await verifyProviderIdentity(user, authKey, req);
      } catch (e) {
        return res.status(401).json({ error: publicMessage(e, 'Something went wrong') });
      }

      const shares = getShares(user.accountId, userId);
      res.json(shares);
    } catch (error) {
      console.error(`Failed to get shares for user ${req.query.userId}:`, error);
      res.status(500).json({ error: 'Failed to get shares', message: publicMessage(error, 'Failed to get shares') });
    }
  });

  // Public endpoint: Get user group members
  router.get('/group-members', async (req, res) => {
    try {
      const { userId } = req.query;
      const authKey = getAuthKey(req);
      
      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Get user
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, accountId: true, isActive: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true }
      });

      if (!user || !user.isActive) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      try {
        await verifyProviderIdentity(user, authKey, req);
      } catch (e) {
        return res.status(401).json({ error: publicMessage(e, 'Something went wrong') });
      }

      const groupMembers = await getGroupMembers(prisma, user.accountId, userId);
      res.json({ members: groupMembers });
    } catch (error) {
      console.error(`Failed to get group members for user ${req.query.userId}:`, error);
      res.status(500).json({ error: 'Failed to get group members', message: publicMessage(error, 'Failed to get group members') });
    }
  });

  // ---- Notifications on the person's own devices ----
  // Turned on from their own Settings page, off by default; sent by
  // utils/pushNotifications.sendPushToPerson - when their sign-in stops
  // working, and before a daily limit or bedtime pauses them. Kept apart from
  // the admin's devices (PersonPushSubscription), so the admin's push is never
  // reached or removed through here.

  /** The signed-in person asking - their app sign-in must be theirs. */
  // A route that acts on one person has to be asked by that person: their
  // own Stremio key, or the session token their Nuvio/Jellyfin sign-in got.
  // A user id alone proves nothing - member ids show up in group lists.
  async function requireSelf(req, res, userId) {
    try {
      return await personAsking(req, userId)
    } catch (e) {
      const status = e?.status || 401
      res.status(status).json({ error: publicMessage(e, 'Something went wrong'), message: publicMessage(e, 'Something went wrong') })
      return null
    }
  }

  async function personAsking(req, userId) {
    const user = userId ? await prisma.user.findUnique({
      where: { id: String(userId) },
      select: { id: true, accountId: true, isActive: true, providerType: true, nuvioRefreshToken: true, nuvioUserId: true },
    }) : null;
    if (!user || !user.isActive) throw Object.assign(new Error('User not found'), { status: 404 });
    const who = await verifyProviderIdentity(user, getAuthKey(req), req).catch(() => null);
    // A Stremio key resolves to whoever it belongs to; that has to be them.
    if (!who || (who.id && who.id !== user.id)) throw Object.assign(new Error('Authentication required'), { status: 401 });
    return user;
  }
  const pushError = (res, error, fallback) => {
    const message = error?.status ? error.message : fallback;
    res.status(error?.status || 500).json({ error: message, message });
  };

  // Whether they're paused right now (a daily limit or bedtime), for the note
  // on their own home page.
  router.get('/screen-time', async (req, res) => {
    try {
      const user = await personAsking(req, req.query.userId);
      res.json(await require('../utils/screenTime').ownStatus(prisma, user.accountId || 'default', user.id));
    } catch (error) {
      pushError(res, error, 'Could not read the daily limit');
    }
  });

  router.get('/push/status', async (req, res) => {
    try {
      const user = await personAsking(req, req.query.userId);
      const { isPushEnabled, getPublicKey } = require('../utils/pushNotifications');
      const endpoint = String(req.query.endpoint || '');
      const subscribed = endpoint
        ? !!(await prisma.personPushSubscription.findFirst({ where: { userId: user.id, endpoint }, select: { id: true } }))
        : false;
      res.json({ enabled: isPushEnabled(), publicKey: getPublicKey(), subscribed });
    } catch (error) {
      pushError(res, error, 'Could not read notifications');
    }
  });

  router.post('/push/subscribe', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId);
      const { endpoint, keys } = req.body?.subscription || {};
      if (!endpoint || !keys?.p256dh || !keys?.auth || !/^https:\/\//i.test(String(endpoint))) {
        return res.status(400).json({ error: 'Invalid subscription' });
      }
      const userAgent = req.body?.userAgent ? String(req.body.userAgent).slice(0, 300) : null;
      await prisma.personPushSubscription.upsert({
        where: { userId_endpoint: { userId: user.id, endpoint } },
        create: { accountId: user.accountId || DEFAULT_ACCOUNT_ID, userId: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent },
        update: { p256dh: keys.p256dh, auth: keys.auth, userAgent },
      });
      res.json({ success: true });
    } catch (error) {
      pushError(res, error, 'Could not turn notifications on');
    }
  });

  router.post('/push/unsubscribe', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId);
      const endpoint = String(req.body?.endpoint || '');
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      await prisma.personPushSubscription.deleteMany({ where: { userId: user.id, endpoint } });
      res.json({ success: true });
    } catch (error) {
      pushError(res, error, 'Could not turn notifications off');
    }
  });

  // ---- The person's own picture ----
  // Colour, an image link, an upload, or (Nuvio) a cover from nuvio.tv's
  // gallery. Every route proves the caller is this exact person (personAsking)
  // and only ever writes that person's row. Uploaded files are kept to one per
  // person: a new picture removes the file the old one used.

  // The colours the picker offers (client/components/ui/Avatar.tsx): the eight
  // theme shades, and the twelve fixed colours from 100.
  const validAvatarColor = (n) => Number.isInteger(n) && ((n >= 0 && n <= 7) || (n >= 100 && n <= 111));

  // What an avatarUrl may be: null (none), an http(s) address, or the person's
  // own current uploaded file. A path to someone else's file is refused - a
  // new file only arrives through /avatar/upload.
  function checkedPictureUrl(value, currentUrl) {
    if (value === null || value === '') return { url: null };
    if (typeof value !== 'string' || value.length > 2048) return { error: 'That picture address can’t be used' };
    const text = value.trim();
    if (UPLOADED_AVATAR.test(text)) return text === currentUrl ? { url: text } : { error: 'That picture address can’t be used' };
    let parsed;
    try { parsed = new URL(text); } catch { return { error: 'That picture address can’t be used' }; }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return { error: 'Use a link that starts with http:// or https://' };
    return { url: text };
  }

  // The file an old picture leaves behind goes with it - unless another row
  // still shows it.
  async function tidyOldPicture(oldUrl, newUrl, personId) {
    if (!oldUrl || oldUrl === newUrl || !UPLOADED_AVATAR.test(oldUrl)) return;
    try {
      const [otherPerson, aGroup] = await Promise.all([
        prisma.user.findFirst({ where: { avatarUrl: oldUrl, id: { not: personId } }, select: { id: true } }),
        prisma.group.findFirst({ where: { avatarUrl: oldUrl }, select: { id: true } }),
      ]);
      if (!otherPerson && !aGroup) removeAvatarFile(oldUrl);
    } catch (e) {
      console.warn('[publicLibrary] could not tidy an old picture:', e?.message);
    }
  }

  router.patch('/avatar', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId);
      const { avatarUrl, colorIndex } = req.body || {};
      if (avatarUrl === undefined && colorIndex === undefined) return res.status(400).json({ error: 'Nothing to change' });
      const current = await prisma.user.findUnique({ where: { id: user.id }, select: { avatarUrl: true, colorIndex: true } });
      const data = {};
      if (avatarUrl !== undefined) {
        const checked = checkedPictureUrl(avatarUrl, current?.avatarUrl || null);
        if (checked.error) return res.status(400).json({ error: checked.error, message: checked.error });
        data.avatarUrl = checked.url;
      }
      if (colorIndex !== undefined) {
        if (!validAvatarColor(colorIndex)) return res.status(400).json({ error: 'Pick one of the colours offered', message: 'Pick one of the colours offered' });
        data.colorIndex = colorIndex;
      }
      const saved = await prisma.user.update({ where: { id: user.id }, data, select: { avatarUrl: true, colorIndex: true } });
      await tidyOldPicture(current?.avatarUrl, saved.avatarUrl, user.id);
      res.json({ success: true, avatarUrl: saved.avatarUrl || null, colorIndex: saved.colorIndex || 0 });
    } catch (error) {
      pushError(res, error, 'Could not change your picture');
    }
  });

  // At most this many uploads an hour per person: a person cannot fill the
  // disk by uploading in a loop (each one also removes their previous file).
  const AVATAR_UPLOADS_PER_HOUR = 10;
  const avatarUploads = new Map();
  function avatarUploadAllowed(personId) {
    const now = Date.now();
    const recent = (avatarUploads.get(personId) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= AVATAR_UPLOADS_PER_HOUR) { avatarUploads.set(personId, recent); return false; }
    recent.push(now);
    avatarUploads.set(personId, recent);
    return true;
  }

  // The bytes have to be the kind of picture the type says: the declared type
  // alone is whatever the sender wrote.
  function pictureKind(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
  }

  // Upload and use in one step (the file field is "avatar"; the person's id is
  // in the address because the body is not read yet). The sign-in is checked
  // before anything is accepted, so an anonymous caller never gets a file
  // buffered.
  router.post('/avatar/upload', async (req, res) => {
    let user;
    try {
      user = await personAsking(req, req.query.userId);
    } catch (error) {
      return pushError(res, error, 'Could not change your picture');
    }
    if (!avatarUploadAllowed(user.id)) return res.status(429).json({ error: 'That’s a lot of pictures - try again in a while', message: 'That’s a lot of pictures - try again in a while' });
    imageUpload.single('avatar')(req, res, async (uploadError) => {
      try {
        if (uploadError) {
          const message = uploadError.code === 'LIMIT_FILE_SIZE' ? 'That picture is over 5 MB' : (uploadError.message || 'Could not read that picture');
          return res.status(400).json({ error: message, message });
        }
        if (!req.file) return res.status(400).json({ error: 'Choose a picture first', message: 'Choose a picture first' });
        const kind = pictureKind(req.file.buffer);
        if (!kind) return res.status(400).json({ error: 'That isn’t a JPEG, PNG, GIF or WEBP picture', message: 'That isn’t a JPEG, PNG, GIF or WEBP picture' });
        const current = await prisma.user.findUnique({ where: { id: user.id }, select: { avatarUrl: true } });
        const url = saveAvatarFile(req.file.buffer, kind);
        try {
          await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: url } });
        } catch (e) {
          removeAvatarFile(url);
          throw e;
        }
        await tidyOldPicture(current?.avatarUrl, url, user.id);
        res.status(201).json({ success: true, avatarUrl: url });
      } catch (error) {
        console.error('Error saving a picture:', error?.message);
        res.status(500).json({ error: 'Could not save that picture', message: 'Could not save that picture' });
      }
    });
  });

  // nuvio.tv's cover gallery, for a Nuvio member choosing a picture. Read-only,
  // and through the member's own Nuvio login only.
  router.get('/nuvio-covers', async (req, res) => {
    try {
      const asker = await personAsking(req, req.query.userId);
      if (asker.providerType !== 'nuvio' || !asker.nuvioUserId) return res.status(400).json({ error: 'Covers are for Nuvio sign-ins' });
      const user = await prisma.user.findFirst({ where: { id: asker.id, accountId: asker.accountId, providerType: 'nuvio' } });
      const provider = user ? createProvider(user, { decrypt, req: { appAccountId: user.accountId || DEFAULT_ACCOUNT_ID } }) : null;
      if (!provider?.getCommunityCovers) return res.status(400).json({ error: 'Covers are for Nuvio sign-ins' });
      const { sort, orientation, format, page, limit, search } = req.query;
      res.json(await provider.getCommunityCovers({
        sort: typeof sort === 'string' ? sort : undefined,
        orientation: typeof orientation === 'string' ? orientation : undefined,
        format: typeof format === 'string' ? format : undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Math.min(Number(limit) || 24, 48) : undefined,
        search: typeof search === 'string' ? search.slice(0, 100) : undefined,
      }));
    } catch (error) {
      pushError(res, error, 'Could not load covers');
    }
  });

  // ---- Switching between a Nuvio login's own profiles ----
  // One Nuvio login can be several people in SlickSync (its profiles). A
  // member signed in as one of them may move to another of the SAME login in
  // the SAME household, with no sign-out. A profile is offered only while it is
  // active, in an active group, and its login is still kept; one whose login
  // is gone is listed as needing a reconnect and cannot be chosen.

  // The caller's Nuvio login. Rows with no nuvioUserId all look alike to a
  // query on it (null matches null), so none is ever searched for.
  function nuvioLoginOf(asker) {
    if (asker.providerType !== 'nuvio') return { error: 'Profiles are for Nuvio sign-ins' };
    if (!asker.nuvioUserId) return { error: 'This sign-in has no Nuvio login to switch within' };
    return { nuvioUserId: asker.nuvioUserId };
  }

  async function profilesOfLogin(asker, nuvioUserId) {
    const rows = await prisma.user.findMany({
      where: { accountId: asker.accountId, providerType: 'nuvio', nuvioUserId, isActive: true },
      select: { id: true, username: true, nuvioProfileId: true, avatarUrl: true, colorIndex: true, nuvioRefreshToken: true },
    });
    if (!rows.length) return [];
    const groups = await prisma.group.findMany({ where: { accountId: asker.accountId || DEFAULT_ACCOUNT_ID, isActive: true }, select: { userIds: true } });
    const inGroup = new Set();
    for (const group of groups) {
      try {
        const ids = JSON.parse(group.userIds || '[]');
        if (Array.isArray(ids)) for (const id of ids) inGroup.add(id);
      } catch { /* a group with unreadable members has none */ }
    }
    return rows.filter((r) => inGroup.has(r.id)).sort((a, b) => (a.nuvioProfileId || 0) - (b.nuvioProfileId || 0));
  }

  router.get('/nuvio-profiles', async (req, res) => {
    try {
      const asker = await personAsking(req, req.query.userId);
      const login = nuvioLoginOf(asker);
      if (login.error) return res.status(400).json({ error: login.error, message: login.error });
      const profiles = await profilesOfLogin(asker, login.nuvioUserId);
      res.json({
        profiles: profiles.map((p) => ({
          id: p.id,
          name: p.username,
          profileNumber: p.nuvioProfileId || 1,
          avatarUrl: p.avatarUrl || null,
          colorIndex: p.colorIndex || 0,
          current: p.id === asker.id,
          needsReconnect: !p.nuvioRefreshToken,
        })),
      });
    } catch (error) {
      pushError(res, error, 'Could not load your profiles');
    }
  });

  router.post('/switch-nuvio-profile', async (req, res) => {
    try {
      const asker = await personAsking(req, req.body?.userId);
      const login = nuvioLoginOf(asker);
      if (login.error) return res.status(400).json({ error: login.error, message: login.error });
      const targetId = req.body?.targetId;
      if (typeof targetId !== 'string' || !targetId) return res.status(400).json({ error: 'Choose one of your profiles', message: 'Choose one of your profiles' });
      if (targetId === asker.id) return res.status(400).json({ error: 'You are already on this profile', message: 'You are already on this profile' });
      const target = (await profilesOfLogin(asker, login.nuvioUserId)).find((p) => p.id === targetId);
      if (!target) return res.status(404).json({ error: 'Profile not found', message: 'Profile not found' });
      if (!target.nuvioRefreshToken) return res.status(409).json({ error: 'This profile needs reconnecting - ask whoever runs SlickSync', message: 'This profile needs reconnecting - ask whoever runs SlickSync' });
      const full = await prisma.user.findUnique({ where: { id: target.id }, select: { id: true, username: true, email: true, colorIndex: true, avatarUrl: true, createdAt: true, expiresAt: true } });
      res.json({
        success: true,
        userId: full.id,
        sessionToken: issueNuvioSessionToken(full.id),
        user: { id: full.id, username: full.username, email: full.email, colorIndex: full.colorIndex || 0, avatarUrl: full.avatarUrl || null, createdAt: full.createdAt, expiresAt: full.expiresAt },
      });
    } catch (error) {
      pushError(res, error, 'Could not switch profiles');
    }
  });

  // ---- Continue Watching on the person's own Home ----
  // Their own row only (the history read is narrowed to them before it is
  // capped), and a dismissal that is theirs alone.

  router.get('/continue-watching', async (req, res) => {
    try {
      const user = await personAsking(req, req.query.userId);
      const { getContinueWatching } = require('../utils/continueWatching');
      const rows = await getContinueWatching(prisma, user.accountId || DEFAULT_ACCOUNT_ID, 12, { userId: user.id });
      res.json({
        items: rows.filter((r) => r.userId === user.id).map((r) => ({
          showId: r.showId,
          contentType: r.contentType,
          name: r.showName,
          poster: r.poster || null,
          background: r.background || null,
          season: r.nextEpisode?.season ?? null,
          episode: r.nextEpisode?.episode ?? null,
          episodeTitle: r.nextEpisode?.title ?? null,
          thumbnail: r.nextEpisode?.thumbnail ?? null,
          resume: r.resume === true,
          progressPercent: r.progressPercent ?? null,
          remainingMinutes: r.remainingMinutes ?? null,
          lastWatchedAt: r.lastWatchedAt,
          providerType: r.providerType,
          profileLabel: r.profileLabel || null,
          // Only Stremio and Nuvio have an address that opens their app on a
          // title; every other sign-in gets the title's page.
          appUrl: r.appUrl || null,
          webUrl: r.webUrl || null,
        })),
      });
    } catch (error) {
      pushError(res, error, 'Could not load Continue Watching');
    }
  });

  // ---- Upcoming on the person's own Home ----
  // The household's "Coming up" list narrowed to the shows this person has
  // watched (their own history), soonest first.
  router.get('/upcoming', async (req, res) => {
    try {
      const user = await personAsking(req, req.query.userId);
      const accountId = user.accountId || DEFAULT_ACCOUNT_ID;
      const { getUpcomingEpisodes } = require('../utils/episodeAlerts');
      const [all, theirs] = await Promise.all([
        getUpcomingEpisodes(prisma, accountId, 120),
        prisma.episodeWatchHistory.findMany({ where: { accountId, userId: user.id }, distinct: ['showId'], select: { showId: true } }),
      ]);
      const shows = new Set(theirs.map((r) => r.showId));
      res.json({ items: all.filter((e) => shows.has(e.showId)).slice(0, 40) });
    } catch (error) {
      pushError(res, error, 'Could not load Upcoming');
    }
  });

  // How this person arranged their own Home: section order, folded and
  // hidden. Loose JSON the client owns (it falls back to the default for
  // anything it doesn't recognise), capped so it can't bloat the row.
  router.get('/home-arrange', async (req, res) => {
    try {
      const user = await personAsking(req, req.query.userId)
      const row = await prisma.user.findUnique({ where: { id: user.id }, select: { homeArrangeJson: true } })
      let arrange = null
      try { arrange = row?.homeArrangeJson ? JSON.parse(row.homeArrangeJson) : null } catch { arrange = null }
      res.json({ arrange: arrange && typeof arrange === 'object' && !Array.isArray(arrange) ? arrange : null })
    } catch (error) {
      pushError(res, error, 'Could not read your Home arrangement')
    }
  })

  router.put('/home-arrange', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId)
      const arrange = req.body?.arrange
      if (arrange !== null && (typeof arrange !== 'object' || Array.isArray(arrange))) {
        return res.status(400).json({ error: 'arrange must be an object or null', message: 'arrange must be an object or null' })
      }
      const json = arrange ? JSON.stringify(arrange) : null
      if (json && Buffer.byteLength(json) > 16 * 1024) return res.status(413).json({ error: 'Too large', message: 'That arrangement is too large to save' })
      await prisma.user.update({ where: { id: user.id }, data: { homeArrangeJson: json } })
      res.json({ arrange: arrange || null })
    } catch (error) {
      pushError(res, error, 'Could not save your Home arrangement')
    }
  })

  router.post('/continue-watching/dismiss', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId);
      const showId = req.body?.showId;
      if (typeof showId !== 'string' || !showId || showId.length > 200) return res.status(400).json({ error: 'showId required', message: 'showId required' });
      const accountId = user.accountId || DEFAULT_ACCOUNT_ID;
      // Only a title in their own history can be removed from their row.
      const [asShow, asMovie] = await Promise.all([
        prisma.episodeWatchHistory.findFirst({ where: { accountId, userId: user.id, showId }, select: { id: true } }),
        prisma.movieWatchHistory.findFirst({ where: { accountId, userId: user.id, itemId: showId }, select: { id: true } }),
      ]);
      if (!asShow && !asMovie) return res.status(404).json({ error: 'Not in your Continue Watching', message: 'Not in your Continue Watching' });
      const { dismissContinueWatching } = require('../utils/continueWatching');
      await dismissContinueWatching(prisma, accountId, user.id, showId);
      res.json({ success: true });
    } catch (error) {
      pushError(res, error, 'Could not remove that from Continue Watching');
    }
  });

  // ---- "Resume in your app" on a Continue Watching card ----
  // What the card's app picker needs (lib/openWith.ts), for a Jellyfin or
  // AIOStreams person asking about themselves: their own server (address, kind,
  // id), their own user id there, the title's id on that server and, on a real
  // Jellyfin, the devices their own sign-in can start it on. Never a token,
  // never another person's server or devices. Shares the admin route's logic
  // (utils/openTargets.js); the admin's play-on is not reachable from here.

  // The caller's own Jellyfin-compatible sign-in, with what the provider needs
  // to act on it, or null when they have none.
  async function ownServerRow(user) {
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    if (!row || row.providerType !== 'jellyfin' || !row.jellyfinServerUrl || !row.jellyfinToken) return null;
    return row;
  }
  const ownServerProvider = (row) => createProvider(row, { decrypt, req: { appAccountId: row.accountId || DEFAULT_ACCOUNT_ID } });

  router.get('/open-targets', async (req, res) => {
    try {
      const user = await personAsking(req, req.query.userId);
      const { buildOpenTargets, validTitleId } = require('../utils/openTargets');
      const id = String(req.query.id || '');
      const type = req.query.type === 'movie' ? 'movie' : 'series';
      const row = validTitleId(id) ? await ownServerRow(user) : null;
      if (!row) return res.json({ servers: [], devices: [], tmdbId: null });
      const found = await buildOpenTargets({ rows: [row], id, type, providerFor: ownServerProvider });
      // Rebuilt field by field so nothing else on the row can ride along.
      res.json({
        servers: found.servers.map((s) => ({
          address: s.address, kind: s.kind, serverId: s.serverId, itemId: s.itemId,
          people: s.people.map((p) => ({ name: p.name, userId: p.userId })),
        })),
        devices: found.devices.map((d) => ({
          personId: user.id, credentialId: null, person: d.person, address: d.address, itemId: d.itemId,
          sessionId: d.sessionId, device: d.device, client: d.client,
        })),
        tmdbId: found.tmdbId,
      });
    } catch (error) {
      if (error?.status) return pushError(res, error, 'Could not look that up');
      console.warn('[public-library] open targets failed:', error?.message);
      res.json({ servers: [], devices: [], tmdbId: null });
    }
  });

  // Play on a device: only a device their own sign-in can control, on their
  // own real Jellyfin, with an item id of the shape that server uses.
  router.post('/open-targets/play-on', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId);
      const sessionId = String(req.body?.sessionId || '');
      const itemId = String(req.body?.itemId || '');
      if (!sessionId || !/^[A-Za-z0-9-]{8,64}$/.test(itemId)) return res.status(400).json({ error: 'Pick a device', message: 'Pick a device' });
      const row = await ownServerRow(user);
      if (!row || (row.jellyfinServerKind || 'jellyfin') !== 'jellyfin') {
        return res.status(400).json({ error: 'Only a Jellyfin server can do that', message: 'Only a Jellyfin server can do that' });
      }
      const provider = ownServerProvider(row);
      const own = await provider.controllableSessions().catch(() => []);
      if (!own.some((d) => d.id === sessionId)) return res.status(404).json({ error: 'That device is not one of yours', message: 'That device is not one of yours' });
      try {
        await provider.playOn(sessionId, itemId);
      } catch {
        return res.status(502).json({ error: 'That device did not answer - it may have closed the app', message: 'That device did not answer - it may have closed the app' });
      }
      res.json({ success: true });
    } catch (error) {
      pushError(res, error, 'Could not start that');
    }
  });

  // ---- The person's own notification devices ----
  // Listed, renamed and removed by id, always narrowed to this household and
  // this person - an id from anyone else's list matches nothing. A POST, so
  // this device's own address (which can be used to push to it) is in the
  // body and never the address bar.

  router.post('/push/devices', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId);
      const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
      const rows = await prisma.personPushSubscription.findMany({
        where: { accountId: user.accountId || DEFAULT_ACCOUNT_ID, userId: user.id },
        select: { id: true, endpoint: true, label: true, userAgent: true, lastSeenAt: true, createdAt: true },
      });
      const devices = rows
        .map((d) => ({ id: d.id, label: d.label || null, userAgent: d.userAgent || null, lastSeenAt: d.lastSeenAt || null, createdAt: d.createdAt, current: !!endpoint && d.endpoint === endpoint }))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json({ devices });
    } catch (error) {
      pushError(res, error, 'Could not list your devices');
    }
  });

  router.patch('/push/devices/:id', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId);
      const label = req.body?.label;
      if (typeof label !== 'string' || label.trim().length > 60) return res.status(400).json({ error: 'Use a name of 60 characters or fewer', message: 'Use a name of 60 characters or fewer' });
      const result = await prisma.personPushSubscription.updateMany({
        where: { id: String(req.params.id), accountId: user.accountId || DEFAULT_ACCOUNT_ID, userId: user.id },
        data: { label: label.trim() || null },
      });
      if (!result.count) return res.status(404).json({ error: 'Device not found', message: 'Device not found' });
      res.json({ success: true });
    } catch (error) {
      pushError(res, error, 'Could not rename that device');
    }
  });

  router.delete('/push/devices/:id', async (req, res) => {
    try {
      const user = await personAsking(req, req.body?.userId);
      const result = await prisma.personPushSubscription.deleteMany({
        where: { id: String(req.params.id), accountId: user.accountId || DEFAULT_ACCOUNT_ID, userId: user.id },
      });
      if (!result.count) return res.status(404).json({ error: 'Device not found', message: 'Device not found' });
      res.json({ success: true });
    } catch (error) {
      pushError(res, error, 'Could not remove that device');
    }
  });

  // ---- Importing their own watch history ----
  // The admin's per-person import (routes/users.js), asked by the person
  // themselves: the same importer (utils/historyImport.js), their own history
  // only. It fills SlickSync's history; nothing is written back to the
  // provider they sign in with. The person's id is in the address (the body is
  // a file, not read yet) and is proved before the file is accepted.
  //
  // Titles with no IMDb id are looked up with the household's OMDb key, which
  // has a small daily allowance shared by everyone, so one request may spend
  // at most this many of them (the rest are left as "couldn't resolve" and the
  // reply says so). A title looked up for the preview is remembered, so
  // importing what was previewed spends nothing more. Rows that carry an IMDb
  // id, and titles a LumiereDB answers, cost nothing.
  const HISTORY_IMPORT_LOOKUPS = 50;
  // At most this many requests (previews and imports) an hour per person.
  const HISTORY_IMPORTS_PER_HOUR = 40;
  const historyImports = new Map();
  function historyImportAllowed(personId) {
    const now = Date.now();
    const recent = (historyImports.get(personId) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= HISTORY_IMPORTS_PER_HOUR) { historyImports.set(personId, recent); return false; }
    recent.push(now);
    historyImports.set(personId, recent);
    return true;
  }

  function ownHistoryImport(dryRun) {
    return async (req, res) => {
      let user;
      try {
        user = await personAsking(req, req.query.userId);
      } catch (error) {
        return pushError(res, error, 'Could not read your file');
      }
      if (!historyImportAllowed(user.id)) {
        const message = 'That’s a lot of imports - try again in a while';
        return res.status(429).json({ error: message, message });
      }
      const { historyUpload, runHistoryImport } = require('../utils/historyImport');
      historyUpload.single('file')(req, res, async (uploadError) => {
        try {
          if (uploadError) {
            const message = uploadError.code === 'LIMIT_FILE_SIZE' ? 'That file is over 20 MB' : (uploadError.message || 'Could not read that file');
            return res.status(400).json({ error: message, message });
          }
          if (!req.file) return res.status(400).json({ error: 'Choose a file first', message: 'Choose a file first' });
          const result = await runHistoryImport({
            prisma,
            accountId: user.accountId || DEFAULT_ACCOUNT_ID,
            user,
            text: req.file.buffer.toString('utf8'),
            dryRun,
            maxLookups: HISTORY_IMPORT_LOOKUPS,
            cacheLookups: true,
          });
          res.status(result.status).json({ ...result.body, message: result.body.error });
        } catch (error) {
          console.error('Error importing a member history file:', error?.message);
          pushError(res, error, 'Could not import that file');
        }
      });
    };
  }
  router.post('/history-import/preview', ownHistoryImport(true));
  router.post('/history-import', ownHistoryImport(false));

  return router;
};
