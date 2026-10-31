import { afterAll, describe, expect, it } from 'vitest';
import { createPrisma } from './index.js';

const prisma = createPrisma(process.env.DATABASE_URL_TEST!);
const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

afterAll(() => prisma.$disconnect());

describe('db schema', () => {
  it('migrated schema accepts an agent with a version and enforces (agentId, version) uniqueness', async () => {
    const agent = await prisma.agent.create({
      data: { name: 'A', slug: `a-${uid}`, role: 'dev', versions: { create: { version: 1, config: {} } } },
    });
    await expect(
      prisma.agentVersion.create({ data: { agentId: agent.id, version: 1, config: {} } }),
    ).rejects.toThrow();
  });

  it('rejects duplicate (sessionId, seq) on SessionEvent', async () => {
    const project = await prisma.project.create({ data: { name: 'P', slug: `p-${uid}`, repoPath: '/tmp/p' } });
    const agent = await prisma.agent.create({
      data: { name: 'B', slug: `b-${uid}`, role: 'dev', versions: { create: { version: 1, config: {} } } },
    });
    const [version] = await prisma.agentVersion.findMany({ where: { agentId: agent.id } });
    const task = await prisma.task.create({ data: { projectId: project.id, agentId: agent.id, title: 't' } });
    const run = await prisma.taskRun.create({ data: { taskId: task.id, agentVersionId: version!.id } });
    const session = await prisma.agentSession.create({
      data: { runId: run.id, agentId: agent.id, projectId: project.id, model: 'm', status: 'running', startedAt: new Date() },
    });
    const ev = { sessionId: session.id, seq: 1, type: 'agent.text', ts: new Date(), payload: {} };
    await prisma.sessionEvent.create({ data: ev });
    await expect(prisma.sessionEvent.create({ data: ev })).rejects.toThrow();
  });
});
