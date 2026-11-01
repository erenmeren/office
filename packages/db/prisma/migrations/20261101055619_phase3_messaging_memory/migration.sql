CREATE EXTENSION IF NOT EXISTS vector;

/*
  Warnings:

  - Added the required column `agentId` to the `TaskRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `projectId` to the `TaskRun` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('direct', 'group', 'task', 'human');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('message', 'question', 'reply', 'handoff', 'help_request', 'escalation', 'artifact');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'delivered', 'acknowledged');

-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('decision', 'convention', 'api_contract', 'known_issue', 'lesson', 'task_summary');

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('project', 'agent_project', 'agent');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('proposed', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "MemorySourceKind" AS ENUM ('event', 'message', 'commit', 'file', 'run', 'task');

-- DropForeignKey
ALTER TABLE "TaskRun" DROP CONSTRAINT "TaskRun_taskId_fkey";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN     "contextPack" JSONB;

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "summarizedAt" TIMESTAMP(3),
ADD COLUMN     "summaryOfRunId" TEXT,
ADD COLUMN     "waitingForMessageId" TEXT,
ADD COLUMN     "waitingSince" TIMESTAMP(3),
ALTER COLUMN "taskId" DROP NOT NULL;

-- Backfill, then enforce NOT NULL
UPDATE "TaskRun" r SET "agentId" = t."agentId", "projectId" = t."projectId" FROM "Task" t WHERE r."taskId" = t.id;
ALTER TABLE "TaskRun" ALTER COLUMN "agentId" SET NOT NULL, ALTER COLUMN "projectId" SET NOT NULL;

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "taskId" TEXT,
    "agentIds" TEXT[],
    "includesOwner" BOOLEAN NOT NULL DEFAULT false,
    "sdkSessionId" TEXT,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "MessageType" NOT NULL,
    "body" TEXT NOT NULL,
    "senderAgentId" TEXT,
    "senderUserId" TEXT,
    "senderSessionId" TEXT,
    "taskId" TEXT,
    "inReplyToId" TEXT,
    "awaitingReply" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "escalationDepth" INTEGER NOT NULL DEFAULT 0,
    "handoffChain" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageId" TEXT NOT NULL,
    "recipientAgentId" TEXT,
    "recipientUserId" TEXT,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "projectId" TEXT,
    "agentId" TEXT,
    "scope" "MemoryScope" NOT NULL,
    "type" "MemoryType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorAgentId" TEXT,
    "status" "MemoryStatus" NOT NULL DEFAULT 'proposed',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "taskId" TEXT,
    "runId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "embedding" vector(1536),
    "search" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("title",'') || ' ' || coalesce("content",''))) STORED,

    CONSTRAINT "MemoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemorySource" (
    "id" TEXT NOT NULL,
    "memoryEntryId" TEXT NOT NULL,
    "kind" "MemorySourceKind" NOT NULL,
    "ref" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "MemorySource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_projectId_updatedAt_idx" ON "Conversation"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "Conversation_taskId_idx" ON "Conversation"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_idempotencyKey_key" ON "Message"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_projectId_createdAt_idx" ON "Message"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_inReplyToId_idx" ON "Message"("inReplyToId");

-- CreateIndex
CREATE INDEX "MessageDelivery_recipientAgentId_status_idx" ON "MessageDelivery"("recipientAgentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDelivery_messageId_recipientAgentId_key" ON "MessageDelivery"("messageId", "recipientAgentId");

-- CreateIndex
CREATE INDEX "MemoryEntry_projectId_status_type_idx" ON "MemoryEntry"("projectId", "status", "type");

-- CreateIndex
CREATE INDEX "MemoryEntry_agentId_idx" ON "MemoryEntry"("agentId");

-- CreateIndex
CREATE INDEX "MemoryEntry_taskId_idx" ON "MemoryEntry"("taskId");

-- CreateIndex
CREATE INDEX "MemorySource_memoryEntryId_idx" ON "MemorySource"("memoryEntryId");

-- CreateIndex
CREATE INDEX "TaskRun_agentId_idx" ON "TaskRun"("agentId");

-- CreateIndex
CREATE INDEX "TaskRun_projectId_idx" ON "TaskRun"("projectId");

-- CreateIndex
CREATE INDEX "TaskRun_conversationId_idx" ON "TaskRun"("conversationId");

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryEntry" ADD CONSTRAINT "MemoryEntry_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "MemoryEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemorySource" ADD CONSTRAINT "MemorySource_memoryEntryId_fkey" FOREIGN KEY ("memoryEntryId") REFERENCES "MemoryEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "MemoryEntry_search_idx" ON "MemoryEntry" USING GIN ("search");
