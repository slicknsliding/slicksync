-- CreateIndex
-- Nearly every read of groups and addons filters by account; users already lead with accountId in their unique keys.
CREATE INDEX IF NOT EXISTS "groups_accountId_idx" ON "groups"("accountId");
CREATE INDEX IF NOT EXISTS "addons_accountId_idx" ON "addons"("accountId");
