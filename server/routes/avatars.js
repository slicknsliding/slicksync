const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AVATAR_DIR = path.join(process.cwd(), 'data', 'avatars');

function ensureAvatarDir() {
  if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// The one place a picture file is written and removed, so the admin upload below
// and a person's own (routes/publicLibrary.js) cannot drift apart.
const UPLOADED = /^\/uploads\/avatars\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:jpg|png|gif|webp))$/i;

function saveAvatarFile(buffer, mimetype) {
  ensureAvatarDir();
  const filename = `${crypto.randomUUID()}${EXT_BY_MIME[mimetype] || '.jpg'}`;
  fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);
  return `/uploads/avatars/${filename}`;
}

/** Best-effort: removes the file behind an /uploads/avatars/<uuid>.<ext> address; anything else is left alone. */
function removeAvatarFile(url) {
  const m = UPLOADED.exec(String(url || ''));
  if (!m) return false;
  try {
    fs.unlinkSync(path.join(AVATAR_DIR, m[1]));
    return true;
  } catch {
    return false;
  }
}

// What a file really is, from its first bytes: the type the browser declares
// is whatever the sender says.
const MIME_BY_FORMAT = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

// Uploads per account per hour, so one account cannot fill the disk.
const UPLOADS_PER_HOUR = 60;
const uploadsByAccount = new Map(); // accountId -> timestamps in the last hour
function uploadAllowed(accountId) {
  const now = Date.now();
  const recent = (uploadsByAccount.get(accountId) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= UPLOADS_PER_HOUR) { uploadsByAccount.set(accountId, recent); return false; }
  recent.push(now);
  uploadsByAccount.set(accountId, recent);
  return true;
}

module.exports = ({ imageUpload, prisma }) => {
  const router = express.Router();

  // POST /api/avatars/upload - accepts a single image file (field name "avatar"),
  // saves it under data/avatars/, and returns the URL to store as avatarUrl.
  // Used for both user and group pictures — the caller decides where to save the returned URL.
  router.post('/upload', imageUpload.single('avatar'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided (expected field name "avatar")' });
      }
      const mimetype = MIME_BY_FORMAT[require('../utils/imageEncoder').sniffFormat(req.file.buffer)];
      if (!mimetype) return res.status(400).json({ error: 'That isn’t a JPEG, PNG, GIF or WEBP picture' });
      if (!uploadAllowed(req.appAccountId || 'default')) return res.status(429).json({ error: 'That’s a lot of pictures - try again in a while' });

      res.status(201).json({ url: saveAvatarFile(req.file.buffer, mimetype) });
    } catch (error) {
      console.error('Error uploading avatar:', error);
      res.status(500).json({ error: 'Failed to upload image' });
    }
  });

  // DELETE /api/avatars/:filename - remove a previously uploaded avatar file
  // (best-effort cleanup when a user/group switches to a different image or reverts to a color)
  router.delete('/:filename', async (req, res) => {
    try {
      const filename = req.params.filename;
      // Guard against path traversal — only allow the exact filename pattern we generate
      if (!/^[a-f0-9-]+\.(jpg|png|gif|webp)$/i.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }
      // A picture another account still shows is not this account's to remove.
      if (prisma) {
        const address = `/uploads/avatars/${filename}`;
        const others = { avatarUrl: address, NOT: { accountId: req.appAccountId || 'default' } };
        const inUse = (await prisma.user.count({ where: others })) + (await prisma.group.count({ where: others }))
          + (await prisma.appAccount.count({ where: { avatarUrl: address, NOT: { id: req.appAccountId || 'default' } } }));
        if (inUse) return res.status(403).json({ error: 'That picture is not yours to remove' });
      }
      const filepath = path.join(AVATAR_DIR, filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting avatar:', error);
      res.status(500).json({ error: 'Failed to delete image' });
    }
  });

  return router;
};

module.exports.AVATAR_DIR = AVATAR_DIR;
module.exports.saveAvatarFile = saveAvatarFile;
module.exports.removeAvatarFile = removeAvatarFile;
module.exports.UPLOADED_AVATAR = UPLOADED;
