// Prints a Vault backup (data/backup/vault/*.json) as plain JSON.
//
//   node scripts/vault-backup-decrypt.js data/backup/vault/latest.json > vault.json
//
// Inside the SlickSync container it finds the key by itself. Anywhere else,
// set the same key the backup was made with: VAULT_BACKUP_PASSPHRASE if the
// server had one, otherwise ENCRYPTION_KEY. Plain (older) backups are printed
// as they are. The output holds every secret in the Vault - keep it safe.

const fs = require('fs')
const path = require('path')

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: node scripts/vault-backup-decrypt.js <backup file>')
    process.exit(2)
  }
  const contents = JSON.parse(fs.readFileSync(file, 'utf8'))
  const { readBackupFile, installKeyText } = require(path.join(__dirname, '..', 'server', 'utils', 'vaultBackup'))
  let passphrase = null
  if (contents.encrypted) {
    if (contents.keyFrom === 'VAULT_BACKUP_PASSPHRASE') passphrase = process.env.VAULT_BACKUP_PASSPHRASE
    // The install key, read the way the server reads it. Only when there is
    // one to read: with neither the variable nor the key file, the key
    // module would make up a new key here instead.
    else if (process.env.ENCRYPTION_KEY || fs.existsSync(path.join(process.cwd(), 'data', 'server_secret.key'))) passphrase = installKeyText()
    if (!passphrase) {
      console.error(`This backup was made with ${contents.keyFrom}; set it and run this again.`)
      process.exit(1)
    }
  }
  const out = await readBackupFile(contents, passphrase)
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

main().catch((err) => {
  console.error(`Could not read the backup: ${err.message}. Check the key is the one the server used when it made this file.`)
  process.exit(1)
})
