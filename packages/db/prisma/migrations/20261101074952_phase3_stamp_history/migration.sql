-- Runs that finished before Phase 3 are never summarized: stamp them so the summary scheduler skips them.
-- The cutoff is the phase3_messaging_memory migration time (20261101055619, UTC).
UPDATE "TaskRun" SET "summarizedAt" = now()
WHERE "summarizedAt" IS NULL
  AND "kind" = 'task'
  AND "status" IN ('succeeded', 'failed')
  AND "createdAt" < '2026-11-01 05:56:19+00';
