-- AlterTable
-- Stremio: time played in the snapshot's video, the counter its watch time is read from.
ALTER TABLE IF EXISTS "watch_snapshots" ADD COLUMN IF NOT EXISTS "timeWatched" BIGINT;
