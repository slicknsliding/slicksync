-- CreateIndex
-- The open-viewings read lists every active session across accounts; the existing indexes all start with accountId.
CREATE INDEX IF NOT EXISTS "watch_sessions_isActive_idx" ON "watch_sessions"("isActive");
