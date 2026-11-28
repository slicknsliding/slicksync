-- AlterTable
-- Vault: a monthly or yearly entry can renew itself when its date passes.
-- IF NOT EXISTS: db push may already have added it on an instance that booted this schema first.
ALTER TABLE IF EXISTS "vault_entries" ADD COLUMN IF NOT EXISTS "autoRenew" BOOLEAN NOT NULL DEFAULT false;
