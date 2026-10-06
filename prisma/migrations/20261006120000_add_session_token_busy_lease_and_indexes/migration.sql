-- Session identity, busy leases, and query indexes.
--
-- This migration is written to be safe against a database that still holds
-- in-flight rows: a deploy invalidates every live session anyway (clients hold
-- tokens issued by the previous code), so the correct behaviour is to retire
-- stale coordination state rather than fail the deploy.

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('request', 'accept', 'decline', 'offer', 'answer', 'ice', 'end');

-- DropIndex (superseded by the composite [toId, createdAt] index below)
DROP INDEX "Signal_toId_idx";

-- AlterTable
-- busyAt turns `busy` from a latch into a lease that /api/poll can reclaim.
ALTER TABLE "Presence" ADD COLUMN "busyAt" TIMESTAMP(3);

-- tokenHash is added nullable, backfilled, then tightened: adding a NOT NULL
-- column directly would fail if any presence row survived.
ALTER TABLE "Presence" ADD COLUMN "tokenHash" TEXT;

-- Pre-existing rows get an unguessable placeholder hash rather than a NULL.
-- They therefore cannot present a matching token and are effectively logged
-- out, which is the intended outcome of a deploy.
UPDATE "Presence"
SET "tokenHash" = md5(random()::text || id || clock_timestamp()::text)
WHERE "tokenHash" IS NULL;

ALTER TABLE "Presence" ALTER COLUMN "tokenHash" SET NOT NULL;

-- Reshape Signal.type onto the enum.
-- Signals are transient (TTL 60s) and unrecoverable by design, so clearing the
-- table first keeps the type change total rather than conditional.
DELETE FROM "Signal";

ALTER TABLE "Signal" DROP COLUMN "type",
ADD COLUMN     "type" "SignalType" NOT NULL;

-- CreateIndex
-- Identity lookup: every mutating request resolves its caller through this.
CREATE UNIQUE INDEX "Presence_tokenHash_key" ON "Presence"("tokenHash");

-- CreateIndex
-- Expired-busy-lease sweep in /api/poll.
CREATE INDEX "Presence_busy_busyAt_idx" ON "Presence"("busy", "busyAt");

-- CreateIndex
-- Inbox read in /api/poll: recipient filter, oldest-first.
CREATE INDEX "Signal_toId_createdAt_idx" ON "Signal"("toId", "createdAt");

-- CreateIndex
-- /api/leave scans by sender as well as recipient; previously a seq scan.
CREATE INDEX "Signal_fromId_idx" ON "Signal"("fromId");

-- CreateIndex
-- Orphan reaper in /api/poll scans by age across the whole table; previously
-- a full table scan on every poll from every connected client.
CREATE INDEX "Signal_createdAt_idx" ON "Signal"("createdAt");
