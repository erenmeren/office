import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AgentConfigInputSchema,
  AgentConfigSchema,
  SubagentDefinitionSchema,
  skillChecksum,
  validateSkillFiles,
  type SkillFiles,
} from '@office/shared';
import { config } from 'dotenv';
import { createPrisma, type PrismaClient } from './index.js';

/** Regular files only, relative POSIX paths; skips dot-directories and symlinks (same contract as the API's readSkillDir). */
export function readSkillDir(dir: string): SkillFiles {
  const files: SkillFiles = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(r);
      } else if (e.isFile()) {
        files[r] = readFileSync(join(dir, r), 'utf8');
      }
    }
  };
  walk('');
  return files;
}

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

/** Idempotent by project slug, skill name and agent slug. Returns the lines it would print. */
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

  const skillsDir = join(templatesDir, 'skills');
  const skillDirs = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const dirName of skillDirs.sort()) {
    const dir = join(skillsDir, dirName);
    const files = readSkillDir(dir);
    const { name, description } = validateSkillFiles(files, dirName);
    const existing = await prisma.skill.findUnique({ where: { name } });
    if (existing) {
      log.push(`skill ${name} exists ${existing.id}`);
      continue;
    }
    const created = await prisma.$transaction(async (tx) => {
      const skill = await tx.skill.create({
        data: { name, description, source: 'local', sourceRef: dir, status: 'approved' },
      });
      const v = await tx.skillVersion.create({
        data: { skillId: skill.id, version: 1, files, checksum: skillChecksum(files) },
      });
      return tx.skill.update({ where: { id: skill.id }, data: { currentVersionId: v.id } });
    });
    log.push(`skill ${name} created ${created.id}`);
  }

  const agentsDir = join(templatesDir, 'agents');
  for (const file of readdirSync(agentsDir).filter((f) => f.endsWith('.json')).sort()) {
    const t = readJson(join(agentsDir, file)) as AgentTemplate;
    const existing = await prisma.agent.findUnique({ where: { slug: t.slug } });
    if (existing) {
      log.push(`agent ${t.slug} exists ${existing.id}`);
      continue;
    }
    const pins = [];
    for (const { skill: skillName, mode } of t.config.skills ?? []) {
      const skill = await prisma.skill.findUnique({ where: { name: skillName } });
      if (!skill?.currentVersionId || skill.status !== 'approved') {
        throw new Error(`agent ${t.slug}: skill ${skillName} missing or not approved`);
      }
      pins.push({ skillId: skill.id, skillVersionId: skill.currentVersionId, mode, name: skill.name });
    }
    const subagents = (t.config.subagents ?? []).map((s) =>
      'template' in s ? readJson(join(templatesDir, 'subagents', `${s.template as string}.json`)) : s,
    );
    const input = AgentConfigInputSchema.parse({ ...t.config, skills: pins, subagents });
    const names = new Set(pins.map((p) => p.name));
    for (const s of input.subagents) {
      const unknown = s.skills.find((n) => !names.has(n));
      if (unknown) throw new Error(`agent ${t.slug}: subagent ${s.name} uses unpinned skill ${unknown}`);
    }
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
