import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentConfigInputSchema, AgentConfigSchema, SubagentDefinitionSchema } from '@office/shared';
import { config } from 'dotenv';
import { createPrisma, type PrismaClient } from './index.js';

type AgentTemplate = {
  name: string;
  slug: string;
  role: string;
  description: string;
  isSystem?: boolean;
  config: Record<string, unknown> & {
    skills?: { skill: string; mode?: string }[];
    subagents?: (Record<string, unknown> | { template: string })[];
  };
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Idempotent by project slug and agent slug. Returns the lines it would print. Office ships no skills of its own: an agent
 * template names skills of the owner's Claude setup, and only those already in the library (approved) are pinned.
 */
export async function seed(
  prisma: PrismaClient,
  workspaceRoot: string,
  templatesDir = fileURLToPath(new URL('../../../templates', import.meta.url)),
): Promise<string[]> {
  const log: string[] = [];
  const repoPath = join(workspaceRoot, 'office-sandbox');
  if (!existsSync(join(repoPath, '.git'))) {
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
    log.push(`git repo initialised at ${repoPath}`);
  }

  const project = await prisma.project.findUnique({ where: { slug: 'office-sandbox' } });
  if (project) {
    log.push(`project office-sandbox exists ${project.id}`);
  } else {
    const created = await prisma.project.create({
      data: { name: 'Office Sandbox', slug: 'office-sandbox', repoPath },
    });
    log.push(`project office-sandbox created ${created.id}`);
  }

  const agentsDir = join(templatesDir, 'agents');
  const teamSlugs: string[] = [];
  for (const file of readdirSync(agentsDir).filter((f) => f.endsWith('.json')).sort()) {
    const t = readJson(join(agentsDir, file)) as AgentTemplate;
    if (!t.isSystem) teamSlugs.push(t.slug);
    const existing = await prisma.agent.findUnique({ where: { slug: t.slug } });
    if (existing) {
      log.push(`agent ${t.slug} exists ${existing.id}`);
      continue;
    }
    const pins = [];
    for (const { skill: skillName, mode } of t.config.skills ?? []) {
      const skill = await prisma.skill.findUnique({ where: { name: skillName } });
      if (!skill?.currentVersionId || skill.status !== 'approved') {
        log.push(`agent ${t.slug}: skill ${skillName} is not in the library, not pinned`);
        continue;
      }
      pins.push({ skillId: skill.id, skillVersionId: skill.currentVersionId, mode, name: skill.name });
    }
    const names = new Set(pins.map((p) => p.name));
    // a subagent keeps only the skills its agent got pinned
    const subagents = (t.config.subagents ?? [])
      .map((s) => ('template' in s ? readJson(join(templatesDir, 'subagents', `${s.template as string}.json`)) : s) as { skills?: string[] })
      .map((s) => ({ ...s, skills: (s.skills ?? []).filter((n) => names.has(n)) }));
    const input = AgentConfigInputSchema.parse({ ...t.config, skills: pins, subagents });
    const created = await prisma.$transaction(async (tx) => {
      const a = await tx.agent.create({
        data: { name: t.name, slug: t.slug, role: t.role, description: t.description, isSystem: t.isSystem ?? false },
      });
      const v = await tx.agentVersion.create({
        data: { agentId: a.id, version: 1, config: AgentConfigSchema.parse(input) },
      });
      for (const p of input.skills) {
        await tx.agentSkill.create({
          data: { agentVersionId: v.id, skillId: p.skillId, skillVersionId: p.skillVersionId!, mode: p.mode },
        });
      }
      for (const s of input.subagents) {
        await tx.agentSubagent.create({
          data: { agentVersionId: v.id, name: s.name, definition: SubagentDefinitionSchema.parse(s) },
        });
      }
      return tx.agent.update({ where: { id: a.id }, data: { currentVersionId: v.id } });
    });
    log.push(`agent ${t.slug} created ${created.id}`);
  }

  const sandbox = await prisma.project.findUniqueOrThrow({ where: { slug: 'office-sandbox' } });
  if (Object.keys(sandbox.settings as object).length === 0) {
    await prisma.project.update({
      where: { id: sandbox.id },
      data: { settings: { checkCommand: 'node --test', envFile: '.env.local', envTemplate: [] } },
    });
    log.push('project office-sandbox settings set');
  } else {
    log.push('project office-sandbox settings exists ' + sandbox.id);
  }
  const team = await prisma.agent.findMany({ where: { slug: { in: teamSlugs } }, select: { id: true, slug: true } });
  for (const a of team) {
    const where = { projectId_agentId: { projectId: sandbox.id, agentId: a.id } };
    const link = await prisma.projectAgent.findUnique({ where });
    if (link) {
      log.push(`project agent ${a.slug} exists ${link.id}`);
    } else {
      const c = await prisma.projectAgent.create({ data: { projectId: sandbox.id, agentId: a.id } });
      log.push(`project agent ${a.slug} created ${c.id}`);
    }
  }
  return log;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
  const root = process.env.OFFICE_WORKSPACE_ROOTS?.split(':')[0]?.trim();
  if (!root || !process.env.DATABASE_URL) throw new Error('DATABASE_URL and OFFICE_WORKSPACE_ROOTS must be set');
  const prisma = createPrisma(process.env.DATABASE_URL);
  try {
    for (const line of await seed(prisma, root)) console.log(line);
  } finally {
    await prisma.$disconnect();
  }
}
