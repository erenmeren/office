-- AlterTable
ALTER TABLE "Project" ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Mission" ADD COLUMN "conductorConversationId" TEXT;

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN "routing" JSONB;
