import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from 'dotenv';
import { createPrisma, type PrismaClient } from './index.js';

const DEVELOPER_CONFIG = {
  systemPrompt: [
    'You are the developer of a small software team. You receive one task at a time and work inside the project repository you are given, making the code or file changes the task asks for.',
    'Inspect before changing: read the relevant files and the current state of the repository before you edit anything. When you finish, report what you did: the files you changed, the commands you ran and their results.',
  ].join('\n\n'),
  model: 'sonnet',
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
  maxTurns: 30,
  maxBudgetUsd: 1,
};

/** Idempotent by slug. Returns the lines it would print. */
export async function seed(prisma: PrismaClient, workspaceRoot: string): Promise<string[]> {
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

  const agent = await prisma.agent.findUnique({ where: { slug: 'developer' } });
  if (agent) {
    log.push(`agent developer exists ${agent.id}`);
  } else {
    const created = await prisma.$transaction(async (tx) => {
      const a = await tx.agent.create({ data: { name: 'Developer', slug: 'developer', role: 'developer' } });
      const v = await tx.agentVersion.create({ data: { agentId: a.id, version: 1, config: DEVELOPER_CONFIG } });
      return tx.agent.update({ where: { id: a.id }, data: { currentVersionId: v.id } });
    });
    log.push(`agent developer created ${created.id}`);
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
