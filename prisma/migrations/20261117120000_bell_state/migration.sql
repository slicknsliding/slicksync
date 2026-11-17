-- AlterTable
-- A cleared notification a timed check owns is hidden, not deleted, so the check doesn't raise it again.
-- IF EXISTS: this table is created by `prisma db push` after migrate deploy, not by the init migration, so a first boot has no table to alter yet and db push adds the column itself.
ALTER TABLE IF EXISTS "notifications" ADD COLUMN IF NOT EXISTS "dismissedAt" TIMESTAMP(3);

-- CreateTable
-- The bell's cleared / dismissed / read state per account, shared by every device.
CREATE TABLE IF NOT EXISTS "bell_state" (
    "accountId" TEXT NOT NULL,
    "clearedBefore" TIMESTAMP(3),
    "dismissed" TEXT NOT NULL DEFAULT '[]',
    "readIds" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bell_state_pkey" PRIMARY KEY ("accountId")
);
