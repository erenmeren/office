import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createPrisma } from './index.js';
import { seed } from './seed.js';

const prisma = createPrisma(process.env.DATABASE_URL_TEST!);
afterAll(() => prisma.$disconnect());

it('seed is idempotent: second run reports exists and adds no rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'office-seed-'));
  await seed(prisma, root);
  expect(existsSync(join(root, 'office-sandbox', '.git'))).toBe(true);
  // scoped to the seeded slugs: other test files write to the same database in parallel
  const count = async () => [
    await prisma.project.count({ where: { slug: 'office-sandbox' } }),
    await prisma.agent.count({ where: { slug: 'developer' } }),
    await prisma.agentVersion.count({ where: { agent: { slug: 'developer' } } }),
  ];
  const before = await count();
  const second = await seed(prisma, root);
  expect(second.filter((l) => l.includes('exists'))).toHaveLength(2);
  expect(await count()).toEqual(before);
  const dev = await prisma.agent.findUniqueOrThrow({ where: { slug: 'developer' } });
  expect(dev.currentVersionId).not.toBeNull();
});
