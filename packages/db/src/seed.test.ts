import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { createPrisma } from './index.js';
import { seed } from './seed.js';

const prisma = createPrisma(process.env.DATABASE_URL_TEST!);
afterAll(() => prisma.$disconnect());

const templatesDir = fileURLToPath(new URL('../../../templates', import.meta.url));
const slugs = ['chief', 'architect', 'developer', 'designer', 'qa-engineer', 'security-engineer'];

it('seed is idempotent: second run reports exists and adds no rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-seed-'));
  await seed(prisma, root);
  expect(existsSync(join(root, 'office-sandbox', '.git'))).toBe(true);
  // scoped to the seeded names: other test files write to the same database in parallel
  const agentVersion = { agentVersion: { agent: { slug: { in: slugs } } } };
  const count = async () => [
    await prisma.project.count({ where: { slug: 'office-sandbox' } }),
    await prisma.agent.count({ where: { slug: { in: slugs } } }),
    await prisma.agentVersion.count({ where: { agent: { slug: { in: slugs } } } }),
    await prisma.agentSkill.count({ where: agentVersion }),
    await prisma.agentSubagent.count({ where: agentVersion }),
  ];
  const before = await count();
  const second = await seed(prisma, root);
  expect(second.every((l) => l.includes(' exists '))).toBe(true);
  expect(second).toHaveLength(1 + 7 + 1 + 6);
  expect(await count()).toEqual(before);
});

it('seeds the default team with subagents', async () => {
  await seed(prisma, mkdtempSync(join(tmpdir(), 'office-seed-')));
  for (const slug of slugs) {
    const agent = await prisma.agent.findUniqueOrThrow({ where: { slug } });
    expect(agent.currentVersionId).not.toBeNull();
  }
  const designer = await prisma.agent.findUniqueOrThrow({ where: { slug: 'designer' } });
  expect(await prisma.agentSubagent.count({ where: { agentVersionId: designer.currentVersionId! } })).toBe(3);
});

it('pins the template skills that are in the library and skips the rest, for subagents too', async () => {
  const id = Date.now().toString(36);
  const [have, missing, slug] = [`seed-have-${id}`, `seed-missing-${id}`, `seed-agent-${id}`];
  const skill = await prisma.skill.create({ data: { name: have, description: 'd', source: 'local', status: 'approved' } });
  const v = await prisma.skillVersion.create({ data: { skillId: skill.id, version: 1, files: { 'SKILL.md': 'x' }, checksum: 'c' } });
  await prisma.skill.update({ where: { id: skill.id }, data: { currentVersionId: v.id } });
  const dir = mkdtempSync(join(tmpdir(), 'office-templates-'));
  mkdirSync(join(dir, 'agents'));
  cpSync(join(templatesDir, 'agents', 'office-summarizer.json'), join(dir, 'agents', 'office-summarizer.json'));
  const config = {
    systemPrompt: 'p', model: 'sonnet', allowedTools: ['Read'],
    skills: [{ skill: have, mode: 'eager' }, { skill: missing }],
    subagents: [{ name: 'helper', description: 'd', prompt: 'p', tools: ['Read'], skills: [have, missing] }],
  };
  writeFileSync(join(dir, 'agents', 'a.json'), JSON.stringify({ name: slug, slug, role: 'developer', description: 'd', config }));

  const log = await seed(prisma, mkdtempSync(join(tmpdir(), 'office-seed-')), dir);
  expect(log).toContain(`agent ${slug}: skill ${missing} is not in the library, not pinned`);
  const agent = await prisma.agent.findUniqueOrThrow({ where: { slug } });
  const pins = await prisma.agentSkill.findMany({ where: { agentVersionId: agent.currentVersionId! }, include: { skill: true } });
  expect(pins.map((p) => [p.skill.name, p.mode])).toEqual([[have, 'eager']]);
  const sub = await prisma.agentSubagent.findFirstOrThrow({ where: { agentVersionId: agent.currentVersionId! } });
  expect((sub.definition as { skills: string[] }).skills).toEqual([have]);
});

it('seeds the system summarizer agent; team agents are not system', async () => {
  await seed(prisma, mkdtempSync(join(tmpdir(), 'office-seed-')));
  const sum = await prisma.agent.findUniqueOrThrow({ where: { slug: 'office-summarizer' } });
  expect(sum.isSystem).toBe(true);
  expect(sum.currentVersionId).not.toBeNull();
  for (const slug of slugs) expect((await prisma.agent.findUniqueOrThrow({ where: { slug } })).isSystem).toBe(false);
});

it('seeds project agents for non-system agents and sandbox settings, idempotently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-seed-'));
  await seed(prisma, root);
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: 'office-sandbox' } });
  const nonSystem = slugs.length;
  const count = () => prisma.projectAgent.count({ where: { projectId: project.id, agent: { slug: { in: slugs } } } });
  expect(await count()).toBe(nonSystem);
  expect((project.settings as { checkCommand?: string }).checkCommand).toBe('node --test');
  await seed(prisma, root);
  expect(await count()).toBe(nonSystem);
});
