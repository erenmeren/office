-- (prisma drift noise about MemoryEntry.search, a generated column, removed by hand: nothing changes there)

-- CreateTable
CREATE TABLE "ManualSession" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "dir" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "claudeSessionId" TEXT NOT NULL,
    "resumedSessionId" TEXT,
    "forked" BOOLEAN NOT NULL DEFAULT false,
    "attachId" TEXT,
    "pid" INTEGER,
    "status" TEXT NOT NULL,
    "exitCode" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "exitedAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),

    CONSTRAINT "ManualSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualSession_projectId_status_idx" ON "ManualSession"("projectId", "status");

-- CreateIndex
CREATE INDEX "ManualSession_workerId_status_idx" ON "ManualSession"("workerId", "status");
