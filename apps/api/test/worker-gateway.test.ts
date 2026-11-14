import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until } from './fake-worker.js';

describe('worker gateway', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(() => t.close());

  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  const enroll = async () => {
    const res = await req('POST', '/workers', { name: 'w1' });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; enrollToken: string };
  };

  it('enrolls with a token, then reconnects with the credential', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1', capacity: 2, allowedRoots: ['/tmp'] });
    const welcome = w.received[0]!;
    expect(welcome).toMatchObject({ type: 'welcome', workerId: id });
    expect(typeof w.credential).toBe('string');
    const row = await t.prisma.worker.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('online');
    expect(row.enrollTokenHash).toBeNull();
    expect(row.credentialHash).not.toBeNull();
    expect(row.capacity).toBe(2);
    expect(row.allowedRoots).toEqual(['/tmp']);

    const list = await req('GET', '/workers');
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).not.toHaveProperty('enrollTokenHash');
    expect(list.json()[0]).not.toHaveProperty('credentialHash');

    await w.close();
    await until(
      async () => (await t.prisma.worker.findUniqueOrThrow({ where: { id } })).status === 'offline',
      'worker offline',
    );

    // the enroll token is single-use
    const again = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    expect(again.received[0]!.type).toBe('error');

    const re = await connectFakeWorker(t.app, { credential: w.credential, name: 'w1' });
    expect(re.received[0]).toEqual({ type: 'welcome', workerId: id });
    await re.close();
  });

  it("GET /models: the aliases every login has until a worker is online, then what that worker's Claude login offers", async () => {
    expect((await req('GET', '/models')).json().map((m: { value: string }) => m.value)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    const { enrollToken } = await enroll();
    const models = [
      { value: 'claude-fable-5-2', label: 'Fable 5.2', description: 'For your toughest challenges' },
      { value: 'opus', label: 'Opus 5.5' },
    ];
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1', models });
    expect((await req('GET', '/models')).json()).toEqual(models);
    await w.close();
    await until(async () => (await req('GET', '/models')).json().length === 4, 'the aliases are back once the worker is gone');
  });

  it('enrollment and revocation are audited', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1', machineId: 'remote-machine-0001' });
    expect(await t.prisma.auditLog.findFirst({ where: { action: 'worker.enrolled', targetId: id } })).toMatchObject({
      targetType: 'worker', detail: { name: 'w1', machineId: 'remote-machine-0001' },
    });
    await req('DELETE', `/workers/${id}`);
    expect(await t.prisma.auditLog.count({ where: { action: 'worker.revoked', targetId: id } })).toBe(1);
    await w.close();
  });

  it('purge deletes the worker row, closes its socket and keeps its finished runs', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    const project = await t.prisma.project.create({ data: { name: 'P', slug: 'p', repoPath: '/tmp/p' } });
    const agent = await t.prisma.agent.create({ data: { name: 'dev', slug: 'dev', role: 'dev' } });
    const version = await t.prisma.agentVersion.create({ data: { agentId: agent.id, version: 1, config: {} } });
    const run = await t.prisma.taskRun.create({
      data: { agentId: agent.id, projectId: project.id, agentVersionId: version.id, status: 'running', kind: 'chat', workerId: id },
    });

    // a live run still points at the worker
    expect((await req('DELETE', `/workers/${id}?purge=true`)).json()).toMatchObject({ error: 'worker_in_use' });
    expect(await t.prisma.worker.count({ where: { id } })).toBe(1);

    await t.prisma.taskRun.update({ where: { id: run.id }, data: { status: 'succeeded' } });
    expect((await req('DELETE', `/workers/${id}?purge=true`)).statusCode).toBe(204);
    expect(await w.closed).toBe(4403);
    expect(await t.prisma.worker.count({ where: { id } })).toBe(0);
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).workerId).toBeNull();
    expect(await t.prisma.auditLog.findFirst({ where: { action: 'worker.deleted', targetId: id } })).toMatchObject({ detail: { name: 'w1' } });

    const re = await connectFakeWorker(t.app, { credential: w.credential, name: 'w1' });
    expect(re.received[0]!.type).toBe('error');
    expect((await req('DELETE', `/workers/${id}?purge=true`)).statusCode).toBe(404);
  });

  it('stores tags and canClone from hello and shows them on GET /workers with online and activeRuns', async () => {
    const { id, enrollToken } = await enroll();
    const pending = await enroll();
    const w = await connectFakeWorker(t.app, {
      enrollToken, name: 'w1', capacity: 2, tags: ['gpu', 'linux'], canClone: true, machineId: 'remote-machine-0001',
    });
    const row = await t.prisma.worker.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ tags: ['gpu', 'linux'], canClone: true, machineId: 'remote-machine-0001' });
    expect(t.app.gateway.onlineWorkers()[0]).toMatchObject({ workerId: id, tags: ['gpu', 'linux'], canClone: true });

    const list = (await req('GET', '/workers')).json() as Array<Record<string, unknown>>;
    expect(list.find((x) => x.id === id)).toMatchObject({
      name: 'w1', status: 'online', capacity: 2, allowedRoots: [], tags: ['gpu', 'linux'], canClone: true, online: true, activeRuns: 0,
      machineId: 'remote-machine-0001',
    });
    expect(list.find((x) => x.id === pending.id)).toMatchObject({ online: false, activeRuns: 0, tags: [], canClone: false });

    await w.close();
    await until(async () => !t.app.gateway.onlineWorkers().length, 'worker gone');
    const after = (await req('GET', '/workers')).json() as Array<Record<string, unknown>>;
    expect(after.find((x) => x.id === id)).toMatchObject({ online: false, activeRuns: 0 });
  });

  it('is local only on the API machine with roots covering the repo; an unidentified worker only when trusted', async () => {
    const local = async (machineId: string | null) => {
      const { id, enrollToken } = await enroll();
      const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1', allowedRoots: ['/tmp'], machineId });
      const online = t.app.gateway.onlineWorkers().find((x) => x.workerId === id)!;
      const result = [online.local('/tmp/repo'), online.local('/srv/repo')];
      await w.close();
      return result;
    };
    expect(await local(t.config.machineId)).toEqual([true, false]);
    expect(await local('another-machine')).toEqual([false, false]);
    expect(await local(null)).toEqual([false, false]);
    t.config.trustUnidentifiedWorkers = true;
    expect(await local(null)).toEqual([true, false]);
  });

  it('rejects a bad credential with an error, then closes', async () => {
    const w = await connectFakeWorker(t.app, { credential: 'nope', name: 'x' });
    expect(w.received[0]!.type).toBe('error');
    expect(await w.closed).toBe(4401);
  });

  it('closes a socket whose first message is not hello', async () => {
    const { port } = t.app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
    const messages: unknown[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    const code = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'heartbeat', capacity: 1, activeRunIds: [] }));
    expect(await code).toBe(4400);
    expect(messages).toEqual([{ type: 'error', message: expect.any(String) }]);
  });

  it('revoked worker is disconnected and cannot reconnect', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    const del = await req('DELETE', `/workers/${id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json().status).toBe('revoked');
    expect(del.json()).not.toHaveProperty('credentialHash');
    await w.closed;
    expect((await t.prisma.worker.findUniqueOrThrow({ where: { id } })).status).toBe('revoked');

    const re = await connectFakeWorker(t.app, { credential: w.credential, name: 'w1' });
    expect(re.received[0]!.type).toBe('error');
    expect(await re.closed).toBe(4401);
  });
  it('tool.call needs a live lease on the run; with one, list_agents answers', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    const project = await t.prisma.project.create({ data: { name: 'P', slug: 'p', repoPath: '/tmp/p' } });
    const agent = await t.prisma.agent.create({ data: { name: 'dev', slug: 'dev', role: 'dev' } });
    const version = await t.prisma.agentVersion.create({ data: { agentId: agent.id, version: 1, config: {} } });
    const run = await t.prisma.taskRun.create({
      data: { agentId: agent.id, projectId: project.id, agentVersionId: version.id, status: 'running', kind: 'chat' },
    });
    const session = await t.prisma.agentSession.create({
      data: { runId: run.id, agentId: agent.id, projectId: project.id, model: 'sonnet', status: 'running', startedAt: new Date() },
    });
    const call = { type: 'tool.call', runId: run.id, sessionId: session.id, name: 'list_agents', args: {} } as const;

    w.send({ ...call, callId: 'c1' });
    expect(await w.waitFor('tool.result')).toMatchObject({ callId: 'c1', result: { ok: false, code: 'no_lease' } });

    await t.prisma.taskRun.update({
      where: { id: run.id },
      data: { workerId: id, leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    w.send({ ...call, callId: 'c2' });
    expect(await w.waitFor('tool.result')).toMatchObject({
      callId: 'c2',
      result: { ok: true, result: { agents: [expect.objectContaining({ slug: 'dev' })] } },
    });
    w.send({ ...call, callId: 'c3', sessionId: 'other' });
    expect(await w.waitFor('tool.result')).toMatchObject({ callId: 'c3', result: { code: 'no_lease' } });
    await w.close();
  });

  it('tool.call replies internal_error when the lease lookup throws', async () => {
    const { enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    const orig = t.prisma.taskRun.findFirst;
    t.prisma.taskRun.findFirst = (() => Promise.reject(new Error('db down'))) as typeof orig;
    try {
      w.send({ type: 'tool.call', runId: 'r', sessionId: 's', callId: 'c9', name: 'list_agents', args: {} });
      expect(await w.waitFor('tool.result')).toMatchObject({ callId: 'c9', result: { ok: false, code: 'internal_error' } });
    } finally {
      t.prisma.taskRun.findFirst = orig;
    }
    await w.close();
  });

  it('a worker reconnecting with a run that was lost meanwhile gets run.cancel and its late result is rejected', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    await w.close();
    const other = await t.prisma.worker.create({ data: { name: 'w2', status: 'online' } });
    const project = await t.prisma.project.create({ data: { name: 'P', slug: 'p', repoPath: '/tmp/p' } });
    const agent = await t.prisma.agent.create({ data: { name: 'dev', slug: 'dev', role: 'dev' } });
    const version = await t.prisma.agentVersion.create({ data: { agentId: agent.id, version: 1, config: {} } });
    const mk = (workerId: string, status: 'lost' | 'running') =>
      t.prisma.taskRun.create({
        data: {
          agentId: agent.id, projectId: project.id, agentVersionId: version.id, kind: 'chat', workerId, status,
          leaseExpiresAt: new Date(Date.now() - 1000),
        },
      });
    const lost = await mk(id, 'lost');
    const foreign = await mk(other.id, 'running');
    await t.prisma.agentSession.create({
      data: { runId: lost.id, agentId: agent.id, projectId: project.id, model: 'sonnet', status: 'lost', startedAt: new Date() },
    });

    const re = await connectFakeWorker(t.app, { credential: w.credential, name: 'w1', activeRunIds: [lost.id, foreign.id] });
    const cancelled = [await re.waitFor('run.cancel'), await re.waitFor('run.cancel')].map((m) => m.runId).sort();
    expect(cancelled).toEqual([lost.id, foreign.id].sort());
    // neither lease was renewed for this worker
    for (const r of [lost, foreign]) {
      const row = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
    }
    re.send({
      type: 'run.result', runId: lost.id, sessionId: 'x',
      result: { status: 'succeeded', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, numTurns: 1, durationMs: 1 } },
    });
    expect(await re.waitFor('error')).toMatchObject({ message: `No live lease for run ${lost.id} on this worker` });
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: lost.id } })).status).toBe('lost');
    await re.close();
  });
  const leasedChatRun = async (workerId: string) => {
    const project = await t.prisma.project.create({ data: { name: 'P', slug: 'p', repoPath: '/tmp/p' } });
    const agent = await t.prisma.agent.create({ data: { name: 'dev', slug: 'dev', role: 'dev' } });
    const version = await t.prisma.agentVersion.create({ data: { agentId: agent.id, version: 1, config: {} } });
    const run = await t.prisma.taskRun.create({
      data: {
        agentId: agent.id, projectId: project.id, agentVersionId: version.id, status: 'running', kind: 'chat',
        workerId, leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const session = await t.prisma.agentSession.create({
      data: { runId: run.id, agentId: agent.id, projectId: project.id, model: 'sonnet', status: 'running', startedAt: new Date() },
    });
    return { run, session };
  };
  const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0.01, numTurns: 1, durationMs: 1 };

  it('acks an accepted run.result and a resend of an already-final run owned by this worker', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    const { run, session } = await leasedChatRun(id);
    const result = { type: 'run.result', runId: run.id, sessionId: session.id, result: { status: 'succeeded', usage } } as const;

    w.send(result);
    expect(await w.waitFor('run.result.ack')).toEqual({ type: 'run.result.ack', runId: run.id });
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded');

    // the ack was lost: the resend is acknowledged, not applied twice
    w.send(result);
    expect(await w.waitFor('run.result.ack')).toEqual({ type: 'run.result.ack', runId: run.id });
    expect(await t.prisma.usageRecord.count({ where: { runId: run.id } })).toBe(1);

    // a different outcome for the finished run is not a resend
    w.send({ ...result, result: { status: 'failed', usage } });
    expect(await w.waitFor('error')).toMatchObject({ message: `No live lease for run ${run.id} on this worker` });
    expect(w.received.filter((m) => m.type === 'run.result.ack')).toHaveLength(2);

    // a final run this worker never owned is rejected
    const other = await t.prisma.worker.create({ data: { name: 'w2', status: 'online' } });
    await t.prisma.taskRun.update({ where: { id: run.id }, data: { workerId: other.id } });
    w.send(result);
    expect(await w.waitFor('error')).toMatchObject({ message: `No live lease for run ${run.id} on this worker` });
    await w.close();
  });

  it('acks a stale suspended result for a run resumed on this worker without applying it', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    const { run, session } = await leasedChatRun(id);
    const suspended = {
      type: 'run.result', runId: run.id, sessionId: session.id, result: { status: 'suspended', sdkSessionId: 'sdk-1', usage },
    } as const;
    w.send(suspended);
    expect(await w.waitFor('run.result.ack')).toEqual({ type: 'run.result.ack', runId: run.id });
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('waiting_reply');

    // the reply resumed it here (queued, leased) before the lost-ack resend arrived
    await t.prisma.taskRun.update({ where: { id: run.id }, data: { status: 'queued', leaseExpiresAt: new Date(Date.now() + 60_000) } });
    w.send(suspended);
    expect(await w.waitFor('run.result.ack')).toEqual({ type: 'run.result.ack', runId: run.id });
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('queued');
    expect(await t.prisma.usageRecord.count({ where: { runId: run.id } })).toBe(1);
    await w.close();
  });

  it('answers integration.check ok only while the lease is live', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    const { run } = await leasedChatRun(id);

    w.send({ type: 'integration.check', runId: run.id });
    expect(await w.waitFor('integration.allowed')).toEqual({ type: 'integration.allowed', runId: run.id, ok: true });

    await t.prisma.taskRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    w.send({ type: 'integration.check', runId: run.id });
    expect(await w.waitFor('integration.allowed')).toEqual({ type: 'integration.allowed', runId: run.id, ok: false, reason: 'lease lost' });

    w.send({ type: 'integration.check', runId: 'unknown' });
    expect(await w.waitFor('integration.allowed')).toMatchObject({ runId: 'unknown', ok: false });
    await w.close();
  });
});
