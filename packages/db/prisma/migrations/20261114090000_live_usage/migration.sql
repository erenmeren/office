-- Owner, 2026-11-14: "prices do not update live". A run's cost was recorded only when it ended. The worker now reports
-- the cost of the running leg; it is kept in one row per leg, which the leg's result takes over.
ALTER TABLE "UsageRecord" ADD COLUMN "live" BOOLEAN NOT NULL DEFAULT false;
