-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "currentVersionId" TEXT,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillVersion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "skillId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "files" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'owner',

    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentVersionId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "skillVersionId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,

    CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSubagent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,

    CONSTRAINT "AgentSubagent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubagentRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT NOT NULL,
    "toolUseId" TEXT NOT NULL,
    "subagentType" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "SubagentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_name_key" ON "Skill"("name");

-- CreateIndex
CREATE INDEX "SkillVersion_skillId_idx" ON "SkillVersion"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillVersion_skillId_version_key" ON "SkillVersion"("skillId", "version");

-- CreateIndex
CREATE INDEX "AgentSkill_agentVersionId_idx" ON "AgentSkill"("agentVersionId");

-- CreateIndex
CREATE INDEX "AgentSkill_skillId_idx" ON "AgentSkill"("skillId");

-- CreateIndex
CREATE INDEX "AgentSkill_skillVersionId_idx" ON "AgentSkill"("skillVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_agentVersionId_skillId_key" ON "AgentSkill"("agentVersionId", "skillId");

-- CreateIndex
CREATE INDEX "AgentSubagent_agentVersionId_idx" ON "AgentSubagent"("agentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSubagent_agentVersionId_name_key" ON "AgentSubagent"("agentVersionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SubagentRun_toolUseId_key" ON "SubagentRun"("toolUseId");

-- CreateIndex
CREATE INDEX "SubagentRun_sessionId_idx" ON "SubagentRun"("sessionId");

-- AddForeignKey
ALTER TABLE "SkillVersion" ADD CONSTRAINT "SkillVersion_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "AgentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_skillVersionId_fkey" FOREIGN KEY ("skillVersionId") REFERENCES "SkillVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSubagent" ADD CONSTRAINT "AgentSubagent_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "AgentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubagentRun" ADD CONSTRAINT "SubagentRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
