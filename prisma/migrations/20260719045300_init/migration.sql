-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stremioAuthKey" TEXT,
    "providerType" TEXT NOT NULL DEFAULT 'stremio',
    "nuvioRefreshToken" TEXT,
    "nuvioUserId" TEXT,
    "excludedAddons" TEXT,
    "protectedAddons" TEXT,
    "colorIndex" INTEGER,
    "avatarUrl" TEXT,
    "useGravatar" BOOLEAN NOT NULL DEFAULT false,
    "accountId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "inviteCode" TEXT,
    "discordWebhookUrl" TEXT,
    "discordUserId" TEXT,
    "apiKey" TEXT,
    "activityVisibility" TEXT NOT NULL DEFAULT 'private',
    "lastSyncedAt" TIMESTAMP(3),
    "syncStatus" TEXT,
    "syncErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "colorIndex" INTEGER,
    "avatarUrl" TEXT,
    "accountId" TEXT,
    "userIds" TEXT,
    "activityVisibility" TEXT NOT NULL DEFAULT 'private',

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addons" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "manifestUrl" TEXT NOT NULL,
    "manifest" TEXT,
    "originalManifest" TEXT,
    "stremioAddonId" TEXT,
    "version" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "accountId" TEXT,
    "iconUrl" TEXT,
    "customLogo" TEXT,
    "manifestUrlHash" VARCHAR(64),
    "manifestHash" VARCHAR(64),
    "resources" TEXT,
    "catalogs" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT true,
    "lastHealthCheck" TIMESTAMP(3),
    "healthCheckError" TEXT,
    "backupAddonId" TEXT,

    CONSTRAINT "addons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_addons" (
    "id" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER,
    "groupId" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,

    CONSTRAINT "group_addons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon_health_history" (
    "id" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseTimeMs" INTEGER,

    CONSTRAINT "addon_health_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_accounts" (
    "id" TEXT NOT NULL,
    "uuid" TEXT,
    "email" TEXT,
    "passwordHash" TEXT,
    "sync" JSONB,
    "apiKeyHash" TEXT,
    "aiometadataManifestUrl" TEXT,

    CONSTRAINT "app_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT,
    "inviteCode" TEXT NOT NULL,
    "groupName" TEXT,
    "maxUses" INTEGER NOT NULL DEFAULT 0,
    "currentUses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "membershipDurationDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncOnJoin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_requests" (
    "id" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "groupName" TEXT,
    "oauthCode" TEXT,
    "oauthLink" TEXT,
    "oauthExpiresAt" TIMESTAMP(3),
    "stremioAuthKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "respondedBy" TEXT,

    CONSTRAINT "invite_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_entries" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "provider" TEXT,
    "secretLabel" TEXT NOT NULL DEFAULT 'API Key',
    "encryptedSecret" TEXT NOT NULL,
    "testType" TEXT NOT NULL DEFAULT 'manual',
    "testConfig" TEXT,
    "dashboardUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "notifyDaysBefore" INTEGER NOT NULL DEFAULT 3,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckStatus" TEXT,
    "lastCheckMessage" TEXT,
    "lastNotifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon_snapshots" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "addonsJson" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addon_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_snapshots" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "overallTimeWatched" BIGINT,
    "timeOffset" BIGINT,
    "lastWatched" TIMESTAMP(3),
    "mtime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_activity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "watchTimeSeconds" INTEGER NOT NULL,
    "itemType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episode_watch_history" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "showName" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "season" INTEGER,
    "episode" INTEGER,
    "poster" TEXT,
    "profileLabel" TEXT,
    "durationSeconds" INTEGER,
    "watchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "episode_watch_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movie_watch_history" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "poster" TEXT,
    "profileLabel" TEXT,
    "durationSeconds" INTEGER,
    "watchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movie_watch_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "videoId" TEXT,
    "itemName" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "season" INTEGER,
    "episode" INTEGER,
    "poster" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "startPosition" INTEGER,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER,
    "lastPosition" INTEGER,
    "totalDuration" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watch_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dismissed_continue_watching" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dismissed_continue_watching_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proxy_stream_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "aiostreamsUser" TEXT NOT NULL,
    "clientIp" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT,
    "displayName" TEXT,
    "posterUrl" TEXT,
    "metadataMatchedAt" TIMESTAMP(3),
    "metadataItemId" TEXT,
    "metadataItemType" TEXT,
    "linkedWatchSessionId" TEXT,
    "requestCount" INTEGER NOT NULL DEFAULT 1,
    "startTime" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proxy_stream_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_expiresAt_idx" ON "users"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_accountId_email_providerType_key" ON "users"("accountId", "email", "providerType");

-- CreateIndex
CREATE UNIQUE INDEX "users_accountId_username_key" ON "users"("accountId", "username");

-- CreateIndex
CREATE INDEX "addons_manifestUrlHash_idx" ON "addons"("manifestUrlHash");

-- CreateIndex
CREATE INDEX "addons_manifestHash_idx" ON "addons"("manifestHash");

-- CreateIndex
CREATE UNIQUE INDEX "addons_name_accountId_key" ON "addons"("name", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "group_addons_groupId_addonId_key" ON "group_addons"("groupId", "addonId");

-- CreateIndex
CREATE INDEX "addon_health_history_addonId_checkedAt_idx" ON "addon_health_history"("addonId", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "app_accounts_uuid_key" ON "app_accounts"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "app_accounts_email_key" ON "app_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_inviteCode_key" ON "invitations"("inviteCode");

-- CreateIndex
CREATE INDEX "invitations_accountId_idx" ON "invitations"("accountId");

-- CreateIndex
CREATE INDEX "invitations_inviteCode_idx" ON "invitations"("inviteCode");

-- CreateIndex
CREATE INDEX "invite_requests_invitationId_idx" ON "invite_requests"("invitationId");

-- CreateIndex
CREATE INDEX "invite_requests_accountId_idx" ON "invite_requests"("accountId");

-- CreateIndex
CREATE INDEX "invite_requests_email_idx" ON "invite_requests"("email");

-- CreateIndex
CREATE INDEX "invite_requests_status_idx" ON "invite_requests"("status");

-- CreateIndex
CREATE INDEX "vault_entries_accountId_idx" ON "vault_entries"("accountId");

-- CreateIndex
CREATE INDEX "vault_entries_accountId_category_idx" ON "vault_entries"("accountId", "category");

-- CreateIndex
CREATE INDEX "addon_snapshots_accountId_idx" ON "addon_snapshots"("accountId");

-- CreateIndex
CREATE INDEX "watch_snapshots_accountId_userId_date_idx" ON "watch_snapshots"("accountId", "userId", "date");

-- CreateIndex
CREATE INDEX "watch_snapshots_accountId_userId_itemId_idx" ON "watch_snapshots"("accountId", "userId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "watch_snapshots_accountId_userId_itemId_date_key" ON "watch_snapshots"("accountId", "userId", "itemId", "date");

-- CreateIndex
CREATE INDEX "watch_activity_accountId_userId_date_itemType_idx" ON "watch_activity"("accountId", "userId", "date", "itemType");

-- CreateIndex
CREATE INDEX "watch_activity_accountId_userId_itemId_idx" ON "watch_activity"("accountId", "userId", "itemId");

-- CreateIndex
CREATE INDEX "watch_activity_accountId_date_idx" ON "watch_activity"("accountId", "date");

-- CreateIndex
CREATE INDEX "episode_watch_history_accountId_userId_watchedAt_idx" ON "episode_watch_history"("accountId", "userId", "watchedAt");

-- CreateIndex
CREATE INDEX "episode_watch_history_accountId_userId_showId_idx" ON "episode_watch_history"("accountId", "userId", "showId");

-- CreateIndex
CREATE UNIQUE INDEX "episode_watch_history_accountId_userId_videoId_key" ON "episode_watch_history"("accountId", "userId", "videoId");

-- CreateIndex
CREATE INDEX "movie_watch_history_accountId_userId_watchedAt_idx" ON "movie_watch_history"("accountId", "userId", "watchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "movie_watch_history_accountId_userId_itemId_key" ON "movie_watch_history"("accountId", "userId", "itemId");

-- CreateIndex
CREATE INDEX "watch_sessions_accountId_userId_startTime_idx" ON "watch_sessions"("accountId", "userId", "startTime");

-- CreateIndex
CREATE INDEX "watch_sessions_accountId_userId_isActive_idx" ON "watch_sessions"("accountId", "userId", "isActive");

-- CreateIndex
CREATE INDEX "watch_sessions_accountId_isActive_idx" ON "watch_sessions"("accountId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "watch_sessions_accountId_userId_itemId_key" ON "watch_sessions"("accountId", "userId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "dismissed_continue_watching_accountId_userId_showId_key" ON "dismissed_continue_watching"("accountId", "userId", "showId");

-- CreateIndex
CREATE INDEX "proxy_stream_sessions_accountId_isActive_idx" ON "proxy_stream_sessions"("accountId", "isActive");

-- CreateIndex
CREATE INDEX "proxy_stream_sessions_accountId_aiostreamsUser_isActive_idx" ON "proxy_stream_sessions"("accountId", "aiostreamsUser", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "proxy_stream_sessions_accountId_aiostreamsUser_clientIp_url_key" ON "proxy_stream_sessions"("accountId", "aiostreamsUser", "clientIp", "url");

-- AddForeignKey
ALTER TABLE "addons" ADD CONSTRAINT "addons_backupAddonId_fkey" FOREIGN KEY ("backupAddonId") REFERENCES "addons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_addons" ADD CONSTRAINT "group_addons_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_addons" ADD CONSTRAINT "group_addons_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "addons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addon_health_history" ADD CONSTRAINT "addon_health_history_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "addons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "app_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_requests" ADD CONSTRAINT "invite_requests_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
