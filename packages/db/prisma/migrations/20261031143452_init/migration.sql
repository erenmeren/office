-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('planned', 'ready', 'queued', 'running', 'waiting_reply', 'waiting_approval', 'review', 'done', 'failed', 'cancelled', 'blocked');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'waiting_reply', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'lost');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('task', 'inbox', 'plan', 'review', 'summary', 'chat');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('pending', 'online', 'offline', 'revoked');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "currentVersionId" TEXT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentVersion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,

    CONSTRAINT "AgentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'pending',
    "enrollTokenHash" TEXT,
    "credentialHash" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "allowedRoots" TEXT[],
    "lastHeartbeatAt" TIMESTAMP(3),

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TaskStatus" NOT NULL DEFAULT 'ready',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taskId" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL DEFAULT 'task',
    "agentVersionId" TEXT NOT NULL,
    "workerId" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "resultText" TEXT,
    "error" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sdkSessionId" TEXT,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "skillsSnapshot" JSONB,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "SessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_token_key" ON "UserSession"("token");

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_slug_key" ON "Agent"("slug");

-- CreateIndex
CREATE INDEX "AgentVersion_agentId_idx" ON "AgentVersion"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentVersion_agentId_version_key" ON "AgentVersion"("agentId", "version");

-- CreateIndex
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");

-- CreateIndex
CREATE INDEX "Task_agentId_idx" ON "Task"("agentId");

-- CreateIndex
CREATE INDEX "TaskRun_taskId_idx" ON "TaskRun"("taskId");

-- CreateIndex
CREATE INDEX "TaskRun_agentVersionId_idx" ON "TaskRun"("agentVersionId");

-- CreateIndex
CREATE INDEX "TaskRun_workerId_idx" ON "TaskRun"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_runId_key" ON "AgentSession"("runId");

-- CreateIndex
CREATE INDEX "AgentSession_agentId_idx" ON "AgentSession"("agentId");

-- CreateIndex
CREATE INDEX "AgentSession_projectId_idx" ON "AgentSession"("projectId");

-- CreateIndex
CREATE INDEX "SessionEvent_sessionId_seq_idx" ON "SessionEvent"("sessionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SessionEvent_sessionId_seq_key" ON "SessionEvent"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "UsageRecord_runId_idx" ON "UsageRecord"("runId");

-- CreateIndex
CREATE INDEX "UsageRecord_projectId_idx" ON "UsageRecord"("projectId");

-- CreateIndex
CREATE INDEX "UsageRecord_agentId_idx" ON "UsageRecord"("agentId");

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentVersion" ADD CONSTRAINT "AgentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "AgentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
