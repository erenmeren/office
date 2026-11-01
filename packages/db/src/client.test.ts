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

  it('a created worker defaults to no tags and canClone false', async () => {
    const w = await prisma.worker.create({ data: { name: `w-${uid}`, allowedRoots: [] } });
    expect(w).toMatchObject({ tags: [], canClone: false });
  });

  it('rejects duplicate (sessionId, seq) on SessionEvent', async () => {
    const project = await prisma.project.create({ data: { name: 'P', slug: `p-${uid}`, repoPath: '/tmp/p' } });
    const agent = await prisma.agent.create({
      data: { name: 'B', slug: `b-${uid}`, role: 'dev', versions: { create: { version: 1, config: {} } } },
    });
    const [version] = await prisma.agentVersion.findMany({ where: { agentId: agent.id } });
    const task = await prisma.task.create({ data: { projectId: project.id, agentId: agent.id, title: 't' } });
    const run = await prisma.taskRun.create({ data: { taskId: task.id, agentId: agent.id, projectId: project.id, agentVersionId: version!.id } });
    const session = await prisma.agentSession.create({
      data: { runId: run.id, agentId: agent.id, projectId: project.id, model: 'm', status: 'running', startedAt: new Date() },
    });
    const ev = { sessionId: session.id, seq: 1, type: 'agent.text', ts: new Date(), payload: {} };
    await prisma.sessionEvent.create({ data: ev });
    await expect(prisma.sessionEvent.create({ data: ev })).rejects.toThrow();
  });

  it('enforces unique skill name, unique (skillId, version) and unique SubagentRun.toolUseId', async () => {
    const name = `s-${uid}`;
    const skill = await prisma.skill.create({ data: { name, description: 'd', source: 'owner' } });
    await expect(prisma.skill.create({ data: { name, description: 'd', source: 'owner' } })).rejects.toThrow();

    const v = { skillId: skill.id, version: 1, files: {}, checksum: 'c' };
    await prisma.skillVersion.create({ data: v });
    await expect(prisma.skillVersion.create({ data: v })).rejects.toThrow();

    const project = await prisma.project.create({ data: { name: 'P', slug: `pt-${uid}`, repoPath: '/tmp/p' } });
    const agent = await prisma.agent.create({
      data: { name: 'C', slug: `c-${uid}`, role: 'dev', versions: { create: { version: 1, config: {} } } },
    });
    const [av] = await prisma.agentVersion.findMany({ where: { agentId: agent.id } });
    const task = await prisma.task.create({ data: { projectId: project.id, agentId: agent.id, title: 't' } });
    const run = await prisma.taskRun.create({ data: { taskId: task.id, agentId: agent.id, projectId: project.id, agentVersionId: av!.id } });
    const session = await prisma.agentSession.create({
      data: { runId: run.id, agentId: agent.id, projectId: project.id, model: 'm', status: 'running', startedAt: new Date() },
    });
    const sr = { sessionId: session.id, toolUseId: `tu-${uid}`, startedAt: new Date() };
    await prisma.subagentRun.create({ data: sr });
    await expect(prisma.subagentRun.create({ data: sr })).rejects.toThrow();
  });

  it('an AgentSkill cannot reference a SkillVersion of another skill without an FK failure on delete', async () => {
    const skill = await prisma.skill.create({ data: { name: `s1-${uid}`, description: 'd', source: 'owner' } });
    const sv = await prisma.skillVersion.create({ data: { skillId: skill.id, version: 1, files: {}, checksum: 'c' } });
    const agent = await prisma.agent.create({
      data: { name: 'D', slug: `d-${uid}`, role: 'dev', versions: { create: { version: 1, config: {} } } },
    });
    const [av] = await prisma.agentVersion.findMany({ where: { agentId: agent.id } });
    await prisma.agentSkill.create({
      data: { agentVersionId: av!.id, skillId: skill.id, skillVersionId: sv.id, mode: 'auto' },
    });
    await expect(prisma.skillVersion.delete({ where: { id: sv.id } })).rejects.toThrow();
  });
});
