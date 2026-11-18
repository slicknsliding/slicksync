-- AlterTable
-- The last day an account was used (day only, never a time) for the Superadmin panel.
-- IF NOT EXISTS: db push may already have added it on an instance that booted this schema first.
ALTER TABLE IF EXISTS "app_accounts" ADD COLUMN IF NOT EXISTS "lastActiveDay" TEXT;

-- CreateTable
-- Superadmin alert switches and small state.
CREATE TABLE IF NOT EXISTS "superadmin_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "superadmin_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
-- Alerts raised for the operator: counts and short ids only.
CREATE TABLE IF NOT EXISTS "superadmin_alerts" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "shortId" TEXT,
    "address" TEXT,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "superadmin_alerts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "superadmin_alerts_createdAt_idx" ON "superadmin_alerts"("createdAt");

-- CreateTable
-- Sign-ins to the Superadmin page, address shortened, browser family only.
CREATE TABLE IF NOT EXISTS "superadmin_signins" (
    "id" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "address" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "superadmin_signins_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "superadmin_signins_lastAt_idx" ON "superadmin_signins"("lastAt");

-- CreateTable
-- Browsers that asked for Superadmin alerts as push notifications.
CREATE TABLE IF NOT EXISTS "superadmin_push_subscriptions" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "superadmin_push_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "superadmin_push_subscriptions_endpoint_key" ON "superadmin_push_subscriptions"("endpoint");
