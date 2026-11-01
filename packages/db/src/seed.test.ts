import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkillFiles } from '@office/shared';
import { afterAll, expect, it } from 'vitest';
import { createPrisma } from './index.js';
import { readSkillDir, seed } from './seed.js';

const prisma = createPrisma(process.env.DATABASE_URL_TEST!);
afterAll(() => prisma.$disconnect());

const templatesDir = fileURLToPath(new URL('../../../templates', import.meta.url));
const skillNames = readdirSync(join(templatesDir, 'skills'));
const slugs = ['chief', 'architect', 'developer', 'designer', 'qa-engineer'];

it('every shipped skill template is valid and named after its directory', () => {
  expect(skillNames).toHaveLength(12);
  for (const name of skillNames) {
    expect(validateSkillFiles(readSkillDir(join(templatesDir, 'skills', name))).name).toBe(name);
  }
});

it('seed is idempotent: second run reports exists and adds no rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-seed-'));
  await seed(prisma, root);
  expect(existsSync(join(root, 'office-sandbox', '.git'))).toBe(true);
  // scoped to the seeded names: other test files write to the same database in parallel
  const agentVersion = { agentVersion: { agent: { slug: { in: slugs } } } };
  const count = async () => [
    await prisma.project.count({ where: { slug: 'office-sandbox' } }),
    await prisma.skill.count({ where: { name: { in: skillNames } } }),
    await prisma.skillVersion.count({ where: { skill: { name: { in: skillNames } } } }),
    await prisma.agent.count({ where: { slug: { in: slugs } } }),
    await prisma.agentVersion.count({ where: { agent: { slug: { in: slugs } } } }),
    await prisma.agentSkill.count({ where: agentVersion }),
    await prisma.agentSubagent.count({ where: agentVersion }),
  ];
  const before = await count();
  const second = await seed(prisma, root);
  expect(second.every((l) => l.includes(' exists '))).toBe(true);
  expect(second).toHaveLength(1 + 12 + 6);
  expect(await count()).toEqual(before);
});

it('seeds approved skills and the default team with pins and subagents', async () => {
  await seed(prisma, mkdtempSync(join(tmpdir(), 'office-seed-')));
  expect(await prisma.skill.count({ where: { status: 'approved' } })).toBeGreaterThanOrEqual(12);
  for (const slug of slugs) {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { slug } });
    expect(agent.currentVersionId).not.toBeNull();
  }
  const designer = await prisma.agent.findUniqueOrThrow({ where: { slug: 'designer' } });
  const pins = await prisma.agentSkill.findMany({
    where: { agentVersionId: designer.currentVersionId! },
    include: { skill: true },
  });
  expect(pins).toHaveLength(6);
  expect(pins.find((p) => p.skill.name === 'frontend-design')?.mode).toBe('eager');
  expect(await prisma.agentSubagent.count({ where: { agentVersionId: designer.currentVersionId! } })).toBe(3);
});

it('seeds the system summarizer agent; team agents are not system', async () => {
  await seed(prisma, mkdtempSync(join(tmpdir(), 'office-seed-')));
  const sum = await prisma.agent.findUniqueOrThrow({ where: { slug: 'office-summarizer' } });
  expect(sum.isSystem).toBe(true);
  expect(sum.currentVersionId).not.toBeNull();
  for (const slug of slugs) expect((await prisma.agent.findUniqueOrThrow({ where: { slug } })).isSystem).toBe(false);
});
