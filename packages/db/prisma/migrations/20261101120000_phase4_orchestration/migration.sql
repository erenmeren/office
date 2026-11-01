-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('code', 'analysis', 'review');

-- CreateEnum
CREATE TYPE "MissionStatus" AS ENUM ('planning', 'plan_failed', 'awaiting_approval', 'approved', 'running', 'review', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('plan', 'git_push', 'merge', 'deploy', 'destructive_command', 'sensitive_path', 'budget_exceeded');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'denied', 'expired');

-- CreateEnum
CREATE TYPE "ApprovalScope" AS ENUM ('once', 'task');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('passed', 'failed', 'timeout', 'skipped');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('none', 'fast_forwarded', 'needs_integration');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "dailyBudgetUsd" DOUBLE PRECISION,
ADD COLUMN     "maxConcurrentSessions" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "acceptanceCriteria" TEXT[],
ADD COLUMN     "budgetUsd" DOUBLE PRECISION,
ADD COLUMN     "key" TEXT,
ADD COLUMN     "kind" "TaskKind" NOT NULL DEFAULT 'code',
ADD COLUMN     "missionId" TEXT,
ADD COLUMN     "parallelGroup" TEXT,
ADD COLUMN     "parentTaskId" TEXT,
ADD COLUMN     "requiredConsultations" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "requirements" TEXT[],
ADD COLUMN     "reviewNote" TEXT;

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "baseCommit" TEXT,
ADD COLUMN     "branch" TEXT,
ADD COLUMN     "headCommit" TEXT,
ADD COLUMN     "integration" "IntegrationStatus" NOT NULL DEFAULT 'none',
ADD COLUMN     "missionId" TEXT,
ADD COLUMN     "reviewOfMissionId" TEXT,
ADD COLUMN     "structuredOutput" JSONB,
ADD COLUMN     "worktreePath" TEXT;

-- CreateTable
CREATE TABLE "TaskDependency" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,

    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAgent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,

    CONSTRAINT "ProjectAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "status" "MissionStatus" NOT NULL DEFAULT 'planning',
    "branch" TEXT,
    "baseCommit" TEXT,
    "planRunId" TEXT,
    "reviewRunId" TEXT,
    "plan" JSONB,
    "planVersion" INTEGER NOT NULL DEFAULT 0,
    "planErrors" TEXT[],
    "summary" TEXT,
    "budgetUsd" DOUBLE PRECISION,
    "conversationId" TEXT,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,
    "missionId" TEXT,
    "taskId" TEXT,
    "runId" TEXT,
    "type" "ApprovalType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "scope" "ApprovalScope",
    "requestId" TEXT,
    "toolName" TEXT,
    "input" JSONB,
    "reason" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "message" TEXT,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "taskId" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'text/plain',

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,
    "taskId" TEXT,
    "command" TEXT NOT NULL,
    "status" "CheckStatus" NOT NULL,
    "exitCode" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "artifactId" TEXT,

    CONSTRAINT "CheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitWorkspace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "worktreePath" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "headCommit" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "GitWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskDependency_dependsOnId_idx" ON "TaskDependency"("dependsOnId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskDependency_taskId_dependsOnId_key" ON "TaskDependency"("taskId", "dependsOnId");

-- CreateIndex
CREATE INDEX "ProjectAgent_agentId_idx" ON "ProjectAgent"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAgent_projectId_agentId_key" ON "ProjectAgent"("projectId", "agentId");

-- CreateIndex
CREATE INDEX "Mission_projectId_status_idx" ON "Mission"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_requestId_key" ON "Approval"("requestId");

-- CreateIndex
CREATE INDEX "Approval_projectId_status_idx" ON "Approval"("projectId", "status");

-- CreateIndex
CREATE INDEX "Approval_missionId_idx" ON "Approval"("missionId");

-- CreateIndex
CREATE INDEX "Approval_taskId_idx" ON "Approval"("taskId");

-- CreateIndex
CREATE INDEX "Approval_runId_idx" ON "Approval"("runId");

-- CreateIndex
CREATE INDEX "Artifact_projectId_idx" ON "Artifact"("projectId");

-- CreateIndex
CREATE INDEX "Artifact_runId_idx" ON "Artifact"("runId");

-- CreateIndex
CREATE INDEX "Artifact_taskId_idx" ON "Artifact"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckResult_runId_key" ON "CheckResult"("runId");

-- CreateIndex
CREATE INDEX "CheckResult_taskId_idx" ON "CheckResult"("taskId");

-- CreateIndex
CREATE INDEX "CheckResult_artifactId_idx" ON "CheckResult"("artifactId");

-- CreateIndex
CREATE UNIQUE INDEX "GitWorkspace_runId_key" ON "GitWorkspace"("runId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Task_missionId_idx" ON "Task"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_missionId_key_key" ON "Task"("missionId", "key");

-- CreateIndex
CREATE INDEX "TaskRun_missionId_idx" ON "TaskRun"("missionId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgent" ADD CONSTRAINT "ProjectAgent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgent" ADD CONSTRAINT "ProjectAgent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitWorkspace" ADD CONSTRAINT "GitWorkspace_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

