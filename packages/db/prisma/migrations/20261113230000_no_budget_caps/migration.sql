-- Owner, 2026-11-13: agents must not stop because of a budget. A run is capped only where the owner sets a cap.
-- The caps that exist were never the owner's: 0.1 to 3 USD a run from the agent templates, 5 USD a task from the old
-- project default, and what the Chief guessed for each task of a plan. All become "no cap"; the mission and daily
-- budgets stay as they are.
UPDATE "AgentVersion" v
SET "config" = jsonb_set(v."config", '{maxBudgetUsd}', '0')
FROM "Agent" a
WHERE a."currentVersionId" = v."id" AND (v."config" ->> 'maxBudgetUsd')::float > 0;

UPDATE "Project"
SET "settings" = jsonb_set("settings", '{defaultTaskBudgetUsd}', '0')
WHERE "settings" ? 'defaultTaskBudgetUsd';

UPDATE "Task"
SET "budgetUsd" = NULL
WHERE "budgetUsd" IS NOT NULL AND "status" NOT IN ('done', 'failed', 'cancelled');
