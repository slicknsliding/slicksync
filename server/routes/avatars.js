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

      ensureAvatarDir();
      const ext = EXT_BY_MIME[req.file.mimetype] || '.jpg';
      const filename = `${crypto.randomUUID()}${ext}`;
      const filepath = path.join(AVATAR_DIR, filename);

      fs.writeFileSync(filepath, req.file.buffer);

      res.status(201).json({ url: `/uploads/avatars/${filename}` });
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
