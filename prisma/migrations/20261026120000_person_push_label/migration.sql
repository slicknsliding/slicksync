-- AlterTable
-- IF EXISTS: this table is created by `prisma db push` after migrate deploy, not by the init migration, so a first boot has no table to alter yet and db push adds the column itself.
ALTER TABLE IF EXISTS "person_push_subscriptions" ADD COLUMN IF NOT EXISTS "label" TEXT;
