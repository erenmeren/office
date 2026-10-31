import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficeEvent } from '@office/shared';
import { loadConfig } from '../src/app.js';
import { createRunForTask } from '../src/services/run-service.js';
import { recordSubagentEvent } from '../src/services/subagent-service.js';
import { makeApp } from './helpers.js';

describe('subagent runs', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let spec: { runId: string; sessionId: string; agentId: string; projectId: string };
  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
    const projectId = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json().id;
    const workerId = (await req('POST', '/workers', { name: 'w' })).json().id;
    const agentId = (
      await req('POST', '/agents', {
        name: 'A', slug: 'a', role: 'dev', config: { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'] },
      })
    ).json().id;
    const task = await t.prisma.task.create({ data: { projectId, agentId, title: 'T' } });
    const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL_TEST });
    spec = (await createRunForTask(t.prisma, t.app.hub, task, { workerId }, config)).spec;
  });
  afterAll(() => t.close());

  let seq = 0;
  const ev = (type: OfficeEvent['type'], payload: Record<string, unknown>, ts = new Date()): OfficeEvent => ({
    type, seq: ++seq, ts: ts.toISOString(), sessionId: spec.sessionId, runId: spec.runId,
    agentId: spec.agentId, projectId: spec.projectId, payload,
  });

  it('records spawned and completed subagents idempotently and lists them per run', async () => {
    const t0 = new Date(Date.now() - 60_000);
    await recordSubagentEvent(t.prisma, ev('agent.subagent.spawned', { toolUseId: 'tu-1', subagentType: 'helper', description: 'look' }, t0));
    let rows = await t.prisma.subagentRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: spec.sessionId, toolUseId: 'tu-1', subagentType: 'helper', description: 'look', status: 'running', startedAt: t0 });

    await recordSubagentEvent(t.prisma, ev('agent.subagent.spawned', { toolUseId: 'tu-1', subagentType: 'other' }));
    rows = await t.prisma.subagentRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subagentType).toBe('helper');

    const t1 = new Date();
    await recordSubagentEvent(t.prisma, ev('agent.subagent.completed', { toolUseId: 'tu-1', status: 'completed', summary: 'found it' }, t1));
    const done = await t.prisma.subagentRun.findUniqueOrThrow({ where: { toolUseId: 'tu-1' } });
    expect(done).toMatchObject({ status: 'completed', summary: 'found it', endedAt: t1 });

    await recordSubagentEvent(t.prisma, ev('agent.subagent.spawned', { subagentType: 'no-id' }));
    await recordSubagentEvent(t.prisma, ev('agent.text', { text: 'hi', toolUseId: 'tu-x' }));
    await expect(
      recordSubagentEvent(t.prisma, ev('agent.subagent.completed', { toolUseId: 'unknown', status: 'completed' })),
    ).resolves.toBeUndefined();
    expect(await t.prisma.subagentRun.count()).toBe(1);

    await recordSubagentEvent(t.prisma, ev('agent.subagent.spawned', { toolUseId: 'tu-2', subagentType: 'helper' }));
    const listed = await req('GET', `/runs/${spec.runId}/subagents`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((r: { toolUseId: string }) => r.toolUseId)).toEqual(['tu-1', 'tu-2']);
    expect((await req('GET', '/runs/nope/subagents')).statusCode).toBe(404);
  });
});
