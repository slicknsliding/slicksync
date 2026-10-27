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

module.exports = ({ imageUpload }) => {
  const router = express.Router();

  // POST /api/avatars/upload - accepts a single image file (field name "avatar"),
  // saves it under data/avatars/, and returns the URL to store as avatarUrl.
  // Used for both user and group pictures — the caller decides where to save the returned URL.
  router.post('/upload', imageUpload.single('avatar'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image file provided (expected field name "avatar")' });
      }

      res.status(201).json({ url: saveAvatarFile(req.file.buffer, req.file.mimetype) });
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
