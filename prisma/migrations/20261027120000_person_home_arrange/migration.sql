-- AlterTable
-- How a person arranged their own Home (section order, folded, hidden).
ALTER TABLE IF EXISTS "users" ADD COLUMN IF NOT EXISTS "homeArrangeJson" TEXT;
