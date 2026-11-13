-- Owner, 2026-11-13: finished work goes into the project's folder from now on. New projects get the setting when they
-- are made; this gives it to the ones that exist, unless a project carries a choice of its own.
UPDATE "Project"
SET "settings" = "settings" || '{"integrateWhenDone": true}'::jsonb
WHERE "isSystem" = false AND NOT ("settings" ? 'integrateWhenDone');
