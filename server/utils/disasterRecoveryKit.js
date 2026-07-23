// A regular config backup (backup.js) covers Users/Groups/Addons - it does
// NOT cover Vault, because Vault secrets are encrypted under this instance's
// own ENCRYPTION_KEY, and a backup file sitting next to a lost VPS is
// useless without that key. This kit is the actual disaster-recovery
// answer: it bundles the same config export PLUS every Vault secret,
// re-encrypted under a passphrase chosen at export time instead of this
// instance's key - so the bundle is self-contained and portable to a
// brand-new instance with its own fresh ENCRYPTION_KEY.
//
// Deliberately a manual, on-demand export (not scheduled like config
// backups) - the decrypted bundle inside is real, usable access to every
// credential in Vault, protected only as strongly as the passphrase picked
// for it, so it shouldn't be generated on a timer and forgotten about the
// way a routine backup is.

const crypto = require('crypto');
const { scryptKey, aesGcmEncrypt, aesGcmDecrypt } = require('./encryption');

const MIN_PASSPHRASE_LENGTH = 12;

async function buildKit(prisma, accountId, passphrase, req, { decrypt }) {
  if (!passphrase || String(passphrase).length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }

  // Reuse the exact same export the regular config backup uses - one
  // source of truth for what "the config" contains, same internal-fetch
  // pattern backup.js already relies on.
  const baseUrl = `http://localhost:${process.env.PORT || 4000}`;
  const configRsp = await fetch(`${baseUrl}/api/public-auth/config-export`, {
    headers: req.headers?.cookie ? { cookie: req.headers.cookie } : {},
  });
  if (!configRsp.ok) throw new Error('Failed to build config export');
  const config = await configRsp.json();

  const entries = await prisma.vaultEntry.findMany({ where: { accountId } });
  const vault = entries.map((entry) => {
    let secret = null;
    try { secret = decrypt(entry.encryptedSecret, req); } catch { secret = null; }
    const { encryptedSecret, id, accountId: _acc, ...rest } = entry;
    return { ...rest, secret };
  });

  const bundle = {
    exportedAt: new Date().toISOString(),
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION || process.env.APP_VERSION || null,
    config,
    vault,
  };

  const salt = crypto.randomBytes(16);
  const key = await scryptKey(passphrase, salt);
  const payload = aesGcmEncrypt(key, JSON.stringify(bundle));

  return {
    salt: salt.toString('base64'),
    payload,
    exportedAt: bundle.exportedAt,
    counts: {
      users: config.users?.length || 0,
      groups: config.groups?.length || 0,
      addons: config.addons?.length || 0,
      vaultEntries: vault.length,
    },
  };
}

async function restoreKit(prisma, accountId, passphrase, kit, req, { encrypt }) {
  if (!passphrase) throw new Error('Passphrase is required');
  if (!kit || !kit.salt || !kit.payload) throw new Error('Invalid recovery kit file');

  const salt = Buffer.from(kit.salt, 'base64');
  const key = await scryptKey(passphrase, salt);
  let bundle;
  try {
    bundle = JSON.parse(aesGcmDecrypt(key, kit.payload));
  } catch {
    throw new Error('Wrong passphrase, or the file is corrupted');
  }

  // Import config via the same battle-tested handler restore-from-backup uses.
  const baseUrl = `http://localhost:${process.env.PORT || 4000}`;
  const importRsp = await fetch(`${baseUrl}/api/public-auth/config-import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(req.headers?.cookie ? { cookie: req.headers.cookie } : {}),
    },
    body: JSON.stringify({ jsonData: JSON.stringify(bundle.config) }),
  });
  if (!importRsp.ok) {
    const result = await importRsp.json().catch(() => ({}));
    throw new Error(result?.message || 'Config import failed');
  }

  // Vault: re-encrypt every secret under THIS instance's own current key,
  // not the kit's passphrase-derived one - the bundle being portable is the
  // whole point, Vault shouldn't end up permanently encrypted with a
  // one-off recovery passphrase.
  let restoredVaultCount = 0;
  for (const entry of (bundle.vault || [])) {
    try {
      const { secret, ...rest } = entry;
      if (!secret) continue;
      await prisma.vaultEntry.create({
        data: { ...rest, accountId, encryptedSecret: encrypt(secret, req) },
      });
      restoredVaultCount++;
    } catch (e) {
      console.warn('[DisasterRecoveryKit] Failed to restore a vault entry:', e?.message);
    }
  }

  return {
    restoredVaultCount,
    counts: {
      users: bundle.config?.users?.length || 0,
      groups: bundle.config?.groups?.length || 0,
      addons: bundle.config?.addons?.length || 0,
    },
  };
}

module.exports = { buildKit, restoreKit, MIN_PASSPHRASE_LENGTH };
