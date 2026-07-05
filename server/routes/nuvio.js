const express = require('express');
const { validateNuvioCredentials, refreshNuvioToken, parseJwtPayload, startNuvioTvLogin, pollNuvioTvLogin, exchangeNuvioTvLogin } = require('../providers/nuvioAuth');

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Verify that a refresh token's JWT sub claim matches the claimed nuvioUserId.
 * Returns the refresh result (with new tokens) on success, throws on mismatch.
 */
async function verifyNuvioIdentity(claimedUserId, refreshTokenValue) {
  if (!refreshTokenValue) {
    const err = new Error('Refresh token is required for OAuth authentication');
    err.status = 400;
    throw err;
  }
  const result = await refreshNuvioToken(refreshTokenValue);
  const payload = parseJwtPayload(result.access_token);
  if (!payload || payload.sub !== claimedUserId) {
    const err = new Error('Token does not match the claimed user identity');
    err.status = 403;
    throw err;
  }
  return result;
}

// In-memory cap on pending OAuth sessions per IP to prevent anonymous Supabase user spam
const pendingOAuthSessions = new Map();
const OAUTH_SESSION_CAP = 3;
const OAUTH_SESSION_TTL_MS = 5 * 60 * 1000;

module.exports = ({ prisma, getAccountId, encrypt, decrypt }) => {
  const router = express.Router();

  // Validate Nuvio credentials
  router.post('/validate', async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ valid: false, error: 'Email and password are required' });
      }

      const result = await validateNuvioCredentials(email, password);
      res.json({
        valid: true,
        user: {
          id: result.user.id,
          email: result.user.email
        }
      });
    } catch (error) {
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('invalid login') || msg.includes('invalid email') || msg.includes('wrong password')) {
        res.json({ valid: false, error: 'Invalid email or password' });
      } else {
        console.error('Nuvio validation error:', error?.message);
        res.json({ valid: false, error: 'Failed to validate credentials' });
      }
    }
  });

  // Connect a user to Nuvio (store encrypted refresh token)
  router.post('/connect', async (req, res) => {
    try {
      const { userId, email, password, refreshToken: oauthRefreshToken } = req.body;
      const oauthNuvioUserId = req.body.providerUserId;

      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      let nuvioUserId, nuvioEmail, refreshToken;

      if (oauthNuvioUserId && oauthRefreshToken) {
        // OAuth reconnection — verify token matches claimed identity
        if (!UUID_V4_RE.test(oauthNuvioUserId)) {
          return res.status(400).json({ error: 'Invalid user ID format' });
        }
        const verified = await verifyNuvioIdentity(oauthNuvioUserId, oauthRefreshToken);
        nuvioUserId = oauthNuvioUserId;
        nuvioEmail = email;
        refreshToken = verified.refresh_token || oauthRefreshToken;
      } else if (email && password) {
        // Credentials reconnection
        const result = await validateNuvioCredentials(email, password);
        nuvioUserId = result.user.id;
        nuvioEmail = result.user.email;
        refreshToken = result.tokens.refreshToken;
      } else {
        return res.status(400).json({ error: 'Either email+password or OAuth tokens are required' });
      }

      const encryptedRefreshToken = encrypt(refreshToken, req);

      await prisma.user.update({
        where: { id: userId, accountId: getAccountId(req) },
        data: {
          providerType: 'nuvio',
          nuvioRefreshToken: encryptedRefreshToken,
          nuvioUserId,
          email: nuvioEmail || email,
          stremioAuthKey: null,
          isActive: true
        }
      });

      res.json({
        success: true,
        user: {
          id: nuvioUserId,
          email: nuvioEmail || email
        }
      });
    } catch (error) {
      console.error('Nuvio connect error:', error.message);
      if (error.status === 400 || error.status === 403) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to connect to Nuvio' });
    }
  });

  // Connect via credentials or OAuth (validate + optionally create user)
  router.post('/connect-authkey', async (req, res) => {
    try {
      const { email, password, username, groupName, colorIndex, create, refreshToken: oauthRefreshToken } = req.body;
      const oauthNuvioUserId = req.body.providerUserId;

      let nuvioUserId;
      let nuvioEmail;
      let refreshToken;

      if (oauthNuvioUserId && !password) {
        // OAuth path — verify token matches claimed identity
        if (!UUID_V4_RE.test(oauthNuvioUserId)) {
          return res.status(400).json({ error: 'Invalid user ID format' });
        }
        const verified = await verifyNuvioIdentity(oauthNuvioUserId, oauthRefreshToken);
        nuvioUserId = oauthNuvioUserId;
        nuvioEmail = email;
        refreshToken = verified.refresh_token || oauthRefreshToken;
      } else {
        // Credentials path — validate with Nuvio
        if (!email || !password) {
          return res.status(400).json({ error: 'Email and password are required' });
        }
        const result = await validateNuvioCredentials(email, password);
        nuvioUserId = result.user.id;
        nuvioEmail = result.user.email;
        refreshToken = result.tokens.refreshToken;
      }

      if (!create) {
        return res.json({
          success: true,
          user: { id: nuvioUserId, email: nuvioEmail },
          providerType: 'nuvio',
          providerUserId: nuvioUserId
        });
      }

      // Create user in DB
      const accountId = getAccountId(req);
      const normalizedEmail = nuvioEmail?.toLowerCase?.() || email.toLowerCase();

      // Check if user already exists (scoped to provider type)
      const existingUser = await prisma.user.findFirst({
        where: { accountId, email: normalizedEmail, providerType: 'nuvio' }
      });
      if (existingUser) {
        return res.status(409).json({ message: 'User already exists' });
      }

      // Determine username
      let finalUsername = username || normalizedEmail.split('@')[0];
      let baseUsername = finalUsername;
      let attempt = 0;
      while (await prisma.user.findFirst({ where: { accountId, username: finalUsername } })) {
        attempt++;
        if (attempt > 100) {
          return res.status(409).json({ error: 'Unable to generate unique username. Please specify a different username.' });
        }
        finalUsername = `${baseUsername}${attempt}`;
      }

      // Encrypt refresh token (null for OAuth-only users until first provider use)
      const encryptedRefreshToken = refreshToken ? encrypt(refreshToken, req) : null;

      // Find or create group
      let groupId = null;
      if (groupName) {
        const group = await prisma.group.findFirst({ where: { accountId, name: groupName } });
        groupId = group?.id || null;
      }

      // Create user
      const newUser = await prisma.user.create({
        data: {
          accountId,
          username: finalUsername,
          email: normalizedEmail,
          providerType: 'nuvio',
          nuvioRefreshToken: encryptedRefreshToken,
          nuvioUserId,
          isActive: true,
          colorIndex: colorIndex || 0,
        }
      });

      // Add to group if specified
      if (groupId) {
        const group = await prisma.group.findUnique({ where: { id: groupId }, select: { userIds: true } });
        const currentIds = typeof group?.userIds === 'string' ? JSON.parse(group.userIds) : (group?.userIds || []);
        if (!currentIds.includes(newUser.id)) {
          currentIds.push(newUser.id);
          await prisma.group.update({ where: { id: groupId }, data: { userIds: JSON.stringify(currentIds) } });
        }
      }

      res.json({
        success: true,
        user: { id: newUser.id, username: finalUsername, email: normalizedEmail },
        providerType: 'nuvio',
        providerUserId: nuvioUserId
      });
    } catch (error) {
      console.error('Nuvio connect-authkey error:', error.message);
      if (error.status === 400 || error.status === 403) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to validate Nuvio credentials' });
    }
  });

  // --- Nuvio OAuth (TV Login) Flow ---

  // Start a new Nuvio OAuth session
  router.post('/start-oauth', async (req, res) => {
    try {
      // Cap pending sessions per IP to prevent anonymous Supabase user spam
      const ip = req.ip;
      const currentSessions = pendingOAuthSessions.get(ip) || 0;
      if (currentSessions >= OAUTH_SESSION_CAP) {
        return res.status(429).json({ error: 'Too many pending OAuth sessions. Please complete or wait for existing sessions to expire.' });
      }

      const result = await startNuvioTvLogin()
      pendingOAuthSessions.set(ip, currentSessions + 1);
      setTimeout(() => {
        const c = pendingOAuthSessions.get(ip) || 0;
        if (c <= 1) pendingOAuthSessions.delete(ip);
        else pendingOAuthSessions.set(ip, c - 1);
      }, OAUTH_SESSION_TTL_MS);
      res.json(result)
    } catch (error) {
      console.error('Nuvio start-oauth error:', error?.message)
      res.status(500).json({ error: 'Failed to start Nuvio OAuth' })
    }
  })

  // Poll an existing Nuvio OAuth session
  router.post('/poll-oauth', async (req, res) => {
    try {
      const { code, deviceNonce, anonToken } = req.body
      if (!code || !deviceNonce || !anonToken) {
        return res.status(400).json({ error: 'code, deviceNonce, and anonToken are required' })
      }
      const result = await pollNuvioTvLogin(code, deviceNonce, anonToken)
      res.json(result)
    } catch (error) {
      console.error('Nuvio poll-oauth error:', error?.message)
      res.status(500).json({ error: 'Failed to poll Nuvio OAuth' })
    }
  })

  // Exchange approved OAuth session for tokens
  router.post('/exchange-oauth', async (req, res) => {
    try {
      const { code, deviceNonce, anonToken } = req.body
      if (!code || !deviceNonce || !anonToken) {
        return res.status(400).json({ error: 'code, deviceNonce, and anonToken are required' })
      }
      const result = await exchangeNuvioTvLogin(code, deviceNonce, anonToken)
      // Release one pending session slot for this IP
      const ip = req.ip;
      const c = pendingOAuthSessions.get(ip) || 0;
      if (c <= 1) pendingOAuthSessions.delete(ip);
      else pendingOAuthSessions.set(ip, c - 1);
      res.json({
        success: true,
        user: result.user,
        refreshToken: result.refreshToken
      })
    } catch (error) {
      console.error('Nuvio exchange-oauth error:', error?.message)
      res.status(500).json({ error: 'Failed to exchange Nuvio OAuth' })
    }
  })

  return router;
};
