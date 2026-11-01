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

  it('stores tags and canClone from hello and shows them on GET /workers with online and activeRuns', async () => {
    const { id, enrollToken } = await enroll();
    const pending = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1', capacity: 2, tags: ['gpu', 'linux'], canClone: true });
    const row = await t.prisma.worker.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ tags: ['gpu', 'linux'], canClone: true });
    expect(t.app.gateway.onlineWorkers()[0]).toMatchObject({ workerId: id, tags: ['gpu', 'linux'], canClone: true });

    const list = (await req('GET', '/workers')).json() as Array<Record<string, unknown>>;
    expect(list.find((x) => x.id === id)).toMatchObject({
      name: 'w1', status: 'online', capacity: 2, allowedRoots: [], tags: ['gpu', 'linux'], canClone: true, online: true, activeRuns: 0,
    });
    expect(list.find((x) => x.id === pending.id)).toMatchObject({ online: false, activeRuns: 0, tags: [], canClone: false });

    await w.close();
    await until(async () => !t.app.gateway.onlineWorkers().length, 'worker gone');
    const after = (await req('GET', '/workers')).json() as Array<Record<string, unknown>>;
    expect(after.find((x) => x.id === id)).toMatchObject({ online: false, activeRuns: 0 });
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
});
