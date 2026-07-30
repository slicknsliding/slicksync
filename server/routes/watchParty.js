const express = require('express');
const { buildCandidatePool } = require('../utils/watchParty');

// "What should we watch tonight" swipe-off. No per-device login exists in
// this app (single admin session per instance) - so each participant opens
// the SAME session link on their own phone/browser and claims a name from
// the invited list (handled client-side); this router only needs a userId on
// every vote, it doesn't care which physical device sent it.
module.exports = ({ prisma, getAccountId }) => {
  const router = express.Router();

  const parseJson = (raw, fallback) => { try { return JSON.parse(raw ?? ''); } catch { return fallback; } };

  const shapeSession = (session, votes) => {
    const participantIds = parseJson(session.participantIds, []);
    const candidates = parseJson(session.candidatesJson, []);
    const matchedItem = session.matchedItemJson ? parseJson(session.matchedItemJson, null) : null;
    // votesByItem: itemId -> Set of userIds who voted yes - lets the client
    // show "2/3 said yes" progress on a title without exposing everyone's no's.
    const yesByItem = {};
    const votedItemsByUser = {};
    for (const v of votes) {
      if (!votedItemsByUser[v.userId]) votedItemsByUser[v.userId] = [];
      votedItemsByUser[v.userId].push(v.itemId);
      if (v.vote) {
        if (!yesByItem[v.itemId]) yesByItem[v.itemId] = [];
        yesByItem[v.itemId].push(v.userId);
      }
    }
    return {
      id: session.id,
      createdBy: session.createdBy,
      participantIds,
      candidates,
      status: session.status,
      matchedItem,
      yesByItem,
      votedItemsByUser,
      createdAt: session.createdAt,
    };
  };

  // GET /api/watch-party - recent sessions for this account (to resume/find a link)
  router.get('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const sessions = await prisma.watchPartySession.findMany({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      res.json(sessions.map((s) => ({
        id: s.id,
        status: s.status,
        participantIds: parseJson(s.participantIds, []),
        matchedItem: s.matchedItemJson ? parseJson(s.matchedItemJson, null) : null,
        createdAt: s.createdAt,
      })));
    } catch (e) {
      console.error('Error listing watch party sessions:', e);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // POST /api/watch-party - create a session. { createdBy, participantIds }
  router.post('/', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const { createdBy, participantIds } = req.body || {};
      const ids = Array.isArray(participantIds) ? [...new Set(participantIds.filter(Boolean))] : [];
      if (!createdBy || ids.length < 2) {
        return res.status(400).json({ error: 'createdBy and at least 2 participantIds are required' });
      }
      const candidates = await buildCandidatePool(prisma, accountId, ids);
      if (candidates.length === 0) {
        return res.status(422).json({ error: 'Could not build a candidate pool right now - try again shortly' });
      }
      const session = await prisma.watchPartySession.create({
        data: { accountId, createdBy, participantIds: JSON.stringify(ids), candidatesJson: JSON.stringify(candidates) },
      });
      res.status(201).json(shapeSession(session, []));
    } catch (e) {
      console.error('Error creating watch party session:', e);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // GET /api/watch-party/:id - full session state
  router.get('/:id', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const session = await prisma.watchPartySession.findFirst({ where: { id: req.params.id, accountId } });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const votes = await prisma.watchPartyVote.findMany({ where: { sessionId: session.id } });
      res.json(shapeSession(session, votes));
    } catch (e) {
      console.error('Error fetching watch party session:', e);
      res.status(500).json({ error: 'Failed to fetch session' });
    }
  });

  // POST /api/watch-party/:id/vote - { userId, itemId, vote: boolean }
  // Returns { matched, item? } - matched is true the instant every invited
  // participant has a yes vote recorded for this exact item.
  router.post('/:id/vote', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const session = await prisma.watchPartySession.findFirst({ where: { id: req.params.id, accountId } });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.status !== 'active') return res.json({ matched: session.status === 'matched', item: session.matchedItemJson ? parseJson(session.matchedItemJson, null) : null });

      const { userId, itemId, vote } = req.body || {};
      if (!userId || !itemId || typeof vote !== 'boolean') {
        return res.status(400).json({ error: 'userId, itemId, and a boolean vote are required' });
      }
      const participantIds = parseJson(session.participantIds, []);
      if (!participantIds.includes(userId)) return res.status(403).json({ error: 'Not a participant in this session' });

      await prisma.watchPartyVote.upsert({
        where: { sessionId_userId_itemId: { sessionId: session.id, userId, itemId } },
        create: { sessionId: session.id, userId, itemId, vote },
        update: { vote },
      });

      if (vote) {
        const yesVotes = await prisma.watchPartyVote.findMany({
          where: { sessionId: session.id, itemId, vote: true },
          select: { userId: true },
        });
        const yesUserIds = new Set(yesVotes.map((v) => v.userId));
        const isUnanimous = participantIds.every((id) => yesUserIds.has(id));
        if (isUnanimous) {
          const candidates = parseJson(session.candidatesJson, []);
          const item = candidates.find((c) => c.id === itemId) || { id: itemId };
          await prisma.watchPartySession.update({
            where: { id: session.id },
            data: { status: 'matched', matchedItemJson: JSON.stringify(item) },
          });
          return res.json({ matched: true, item });
        }
      }
      res.json({ matched: false });
    } catch (e) {
      console.error('Error recording watch party vote:', e);
      res.status(500).json({ error: 'Failed to record vote' });
    }
  });

  // POST /api/watch-party/:id/end - creator gives up / calls it off early
  router.post('/:id/end', async (req, res) => {
    try {
      const accountId = getAccountId(req) || 'default';
      const session = await prisma.watchPartySession.findFirst({ where: { id: req.params.id, accountId } });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      await prisma.watchPartySession.update({ where: { id: session.id }, data: { status: 'ended' } });
      res.json({ success: true });
    } catch (e) {
      console.error('Error ending watch party session:', e);
      res.status(500).json({ error: 'Failed to end session' });
    }
  });

  return router;
};
