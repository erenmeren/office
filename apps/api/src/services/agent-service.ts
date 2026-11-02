import type { AgentVersion, Prisma, PrismaClient } from '@office/db';
import {
  AgentConfigSchema,
  SubagentDefinitionSchema,
  type AgentConfigInput,
  type SkillFiles,
  type SkillMode,
  type SubagentDefinition,
} from '@office/shared';
import { HttpError } from '../lib/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Creates an immutable agent version with its skill pins and subagents. Validates everything before writing. */
export async function createAgentVersion(
  tx: Prisma.TransactionClient,
  agentId: string,
  version: number,
  input: AgentConfigInput,
): Promise<AgentVersion> {
  const pins = [];
  for (const pin of input.skills) {
    const skill = await tx.skill.findUnique({ where: { id: pin.skillId } });
    if (!skill) throw new HttpError(404, 'skill_not_found');
    if (skill.status !== 'approved') throw new HttpError(409, 'skill_not_approved');
    const skillVersionId = pin.skillVersionId ?? skill.currentVersionId;
    const sv = skillVersionId ? await tx.skillVersion.findUnique({ where: { id: skillVersionId } }) : null;
    if (!sv || sv.skillId !== skill.id) throw new HttpError(400, 'skill_version_mismatch');
    pins.push({ skillId: skill.id, skillVersionId: sv.id, mode: pin.mode, name: skill.name });
  }
  const names = new Set(pins.map((p) => p.name));
  if (input.subagents.some((s) => s.skills.some((n) => !names.has(n)))) {
    throw new HttpError(400, 'subagent_skill_unknown');
  }

  const v = await tx.agentVersion.create({ data: { agentId, version, config: AgentConfigSchema.parse(input) } });
  for (const { skillId, skillVersionId, mode } of pins) {
    await tx.agentSkill.create({ data: { agentVersionId: v.id, skillId, skillVersionId, mode } });
  }
  for (const s of input.subagents) {
    await tx.agentSubagent.create({
      data: { agentVersionId: v.id, name: s.name, definition: SubagentDefinitionSchema.parse(s) },
    });
  }
  return v;
}

const bySkillName = { orderBy: { skill: { name: 'asc' } } } as const;
const subagentsOf = async (prisma: Db, agentVersionId: string): Promise<SubagentDefinition[]> =>
  (await prisma.agentSubagent.findMany({ where: { agentVersionId }, orderBy: { name: 'asc' } })).map((s) =>
    SubagentDefinitionSchema.parse(s.definition),
  );

/** A version with its config, pinned skill versions (with files, ordered by skill name) and subagents. */
export async function loadVersion(prisma: Db, versionId: string) {
  const version = await prisma.agentVersion.findUniqueOrThrow({ where: { id: versionId } });
  const pins = await prisma.agentSkill.findMany({
    where: { agentVersionId: versionId },
    include: { skill: { select: { name: true, status: true } }, skillVersion: true },
    ...bySkillName,
  });
  return {
    version,
    config: AgentConfigSchema.parse(version.config),
    // a disabled skill stays pinned (the version is immutable) but is not materialized
    skills: pins.filter((p) => p.skill.status !== 'disabled').map((p) => ({
      skillId: p.skillId,
      skillVersionId: p.skillVersionId,
      name: p.skill.name,
      version: p.skillVersion.version,
      checksum: p.skillVersion.checksum,
      mode: p.mode as SkillMode,
      files: p.skillVersion.files as SkillFiles,
    })),
    subagents: await subagentsOf(prisma, versionId),
  };
}

/** The API shape of a version: pins without files. */
export async function versionView(prisma: Db, version: AgentVersion) {
  const pins = await prisma.agentSkill.findMany({
    where: { agentVersionId: version.id },
    include: { skill: { select: { name: true } }, skillVersion: { select: { version: true } } },
    ...bySkillName,
  });
  return {
    id: version.id,
    version: version.version,
    createdAt: version.createdAt,
    config: version.config,
    skills: pins.map((p) => ({
      skillId: p.skillId,
      skillVersionId: p.skillVersionId,
      name: p.skill.name,
      version: p.skillVersion.version,
      mode: p.mode,
    })),
    subagents: await subagentsOf(prisma, version.id),
  };
}
