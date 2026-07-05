// Anti-lockout encryption key management.
//
// Problem this solves: previously, if ENCRYPTION_KEY was unset, the app fell back to a
// hardcoded default string baked into the source. If you later set a real ENCRYPTION_KEY,
// any data encrypted under the old default becomes unreadable. This module instead:
//   1. Auto-generates a random 32-byte key on first boot if ENCRYPTION_KEY is unset, and
//      persists it to disk so it survives container restarts (not volume wipes).
//   2. If ENCRYPTION_KEY is set in env but differs from a previously persisted key,
//      keeps the old key around as a decrypt-only fallback so existing data doesn't
//      become unreadable — new data is encrypted under the new env key.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = path.join(process.cwd(), 'data', 'server_secret.key');

function ensureDataDir() {
  const dir = path.dirname(KEY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeToBuffer(raw) {
  if (!raw) return null;
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 44) {
      const b = Buffer.from(raw, 'base64');
      if (b.length >= 32) return b.subarray(0, 32);
    }
  } catch {}
  return Buffer.from(String(raw).padEnd(32, '0').slice(0, 32), 'utf8');
}

function readPersistedKey() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (raw) return Buffer.from(raw, 'base64');
    }
  } catch (err) {
    console.error('[keyManager] failed to read persisted key:', err.message);
  }
  return null;
}

function persistKey(buf) {
  try {
    ensureDataDir();
    fs.writeFileSync(KEY_FILE, buf.toString('base64'), { mode: 0o600 });
  } catch (err) {
    console.error('[keyManager] failed to persist key:', err.message);
  }
}

function resolveKeys() {
  const envRaw = process.env.ENCRYPTION_KEY || '';
  const persisted = readPersistedKey();

  let current;
  const fallbacks = [];

  if (envRaw) {
    current = normalizeToBuffer(envRaw);
    if (persisted && !persisted.equals(current)) {
      fallbacks.push(persisted);
      console.warn(
        '[keyManager] ENCRYPTION_KEY differs from the previously persisted key. ' +
        'Using the env key for new data; keeping the old key as a decrypt-only fallback ' +
        'so existing data stays readable.'
      );
    }
  } else if (persisted) {
    current = persisted;
  } else {
    current = crypto.randomBytes(32);
    persistKey(current);
    console.warn(
      '[keyManager] No ENCRYPTION_KEY set in env — generated and persisted a new key at ' +
      KEY_FILE + '. Set ENCRYPTION_KEY in your .env to pin this key across fresh volumes ' +
      '(e.g. `openssl rand -base64 32`), or back up ' + KEY_FILE + ' alongside your database.'
    );
  }

  return { current, fallbacks };
}

const { current, fallbacks } = resolveKeys();

module.exports = {
  KEY_FILE,
  ENCRYPTION_KEY: current,
  ENCRYPTION_KEY_FALLBACKS: fallbacks
};
