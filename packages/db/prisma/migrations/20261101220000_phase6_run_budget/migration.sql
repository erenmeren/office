-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "maxBudgetUsd" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "SessionEvent_ts_id_idx" ON "SessionEvent"("ts", "id");
