-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "aboutProjectId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_aboutProjectId_idx" ON "Conversation"("aboutProjectId");
