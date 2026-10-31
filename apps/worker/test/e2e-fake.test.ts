import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import pino from 'pino';
import { buildApp, loadConfig } from '@office/api';
import { createPrisma } from '@office/db';
import { FakeAdapter, type RuntimeAdapter } from '@office/runtime';
import type { WorkerToApi } from '@office/shared';
import { WorkerConnection } from '../src/connection.js';
import { loadCredential } from '../src/credentials.js';

async function until<T>(fn: () => Promise<T> | T, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`until(${what}) timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('worker end to end with the fake runtime', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let prisma: ReturnType<typeof createPrisma>;
  let cookie: string;
  let tempRoot: string;
  let home: string;
  let port: number;
  let projectId: string;
  let agentId: string;
  const connections: WorkerConnection[] = [];

  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, payload });
  const getTask = async (id: string) => (await req('GET', `/tasks/${id}`)).json();
  const waitTask = (id: string, status: string) =>
    until(async () => {
      const t = await getTask(id);
      return t.status === status && t;
    }, `task ${status}`);
  type Hello = Extract<WorkerToApi, { type: 'hello' }>;
  type GatewayInternals = {
    conns: Map<string, { socket: WebSocket }>;
    hello: (socket: WebSocket, msg: Hello) => Promise<string | undefined>;
  };
  const gatewayInternals = () => app.gateway as unknown as GatewayInternals;
  // drops the TCP connection from the server side (client sees 1006, which is not a fatal close code)
  const dropWorkerSocket = () => {
    for (const { socket } of gatewayInternals().conns.values()) socket.terminate();
  };
  const spyHellos = () => vi.spyOn(gatewayInternals(), 'hello');
  const helloRunIds = (spy: ReturnType<typeof spyHellos>) => spy.mock.calls.map(([, msg]) => msg.activeRunIds);
  const connect = async (enrollToken?: string, adapter: RuntimeAdapter = new FakeAdapter()) => {
    const c = new WorkerConnection(
      {
        apiUrl: `ws://127.0.0.1:${port}`, home, enrollToken, workspaceRoots: [tempRoot],
        runtime: 'fake', capacity: 1, name: 'e2e',
      },
      { adapter, heartbeatMs: 200, reconnectBaseMs: 300, logger: pino({ level: 'silent' }) },
    );
    connections.push(c);
    await c.start();
    return c;
  };

  beforeEach(async () => {
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL_TEST,
      OFFICE_SCHEDULER_INTERVAL_MS: '0',
    });
    prisma = createPrisma(config.databaseUrl);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "SessionEvent","UsageRecord","AgentSession","TaskRun","Task","AgentVersion","Agent","Worker","Project","UserSession","User" CASCADE',
    );
    app = await buildApp(config, { prisma, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    const setup = await app.inject({
      method: 'POST', url: '/auth/setup', payload: { email: 'owner@example.com', password: 'password123' },
    });
    cookie = `office_session=${setup.cookies[0]!.value}`;

    tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'office-ws-')));
    home = mkdtempSync(join(tmpdir(), 'office-home-'));
    const repoPath = join(tempRoot, 'p1');
    mkdirSync(repoPath);
    projectId = (await req('POST', '/projects', { name: 'P', slug: 'p1', repoPath })).json().id;
    agentId = (
      await req('POST', '/agents', {
        name: 'A', slug: 'a', role: 'dev', config: { systemPrompt: 'be nice', model: 'sonnet', allowedTools: ['Read'] },
      })
    ).json().id;
  });

  afterEach(async () => {
    for (const c of connections.splice(0)) await c.stop();
    await app.close();
    await prisma.$disconnect();
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('enrolls, runs a task to done and records events and usage', async () => {
    const { id: workerId, enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    await connect(enrollToken);
    expect(await loadCredential(home)).toBeTruthy();

    const task = (await req('POST', '/tasks', { projectId, agentId, title: 'Fix the bug', description: 'd' })).json();
    await app.scheduler.tick();
    const done = await until(async () => {
      const t = await getTask(task.id);
      return t.status === 'done' && t;
    }, 'task done');

    const runId = done.runs[0].id;
    const events = (await req('GET', `/runs/${runId}/events`)).json() as { type: string; seq: number }[];
    expect(events[0]!.type).toBe('agent.started');
    expect(events.at(-1)!.type).toBe('agent.completed');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const run = (await req('GET', `/runs/${runId}`)).json();
    expect(run.resultText).toContain('Fix the bug');
    expect(await prisma.usageRecord.count({ where: { runId } })).toBe(1);
    expect((await prisma.worker.findUniqueOrThrow({ where: { id: workerId } })).status).toBe('online');
  });

  it('retries on a second attempt after the worker dies mid-run and reconnects', async () => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const first = await connect(enrollToken);

    const task = (await req('POST', '/tasks', { projectId, agentId, title: 'SLOW job', description: 'd' })).json();
    await app.scheduler.tick();
    const running = await until(async () => {
      const t = await getTask(task.id);
      return t.status === 'running' && t;
    }, 'task running');

    await first.stop();
    await until(() => app.gateway.onlineWorkers().length === 0, 'worker offline');
    await prisma.taskRun.update({
      where: { id: running.runs[0].id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await app.scheduler.tick();
    expect(await getTask(task.id)).toMatchObject({ status: 'ready', attempts: 1 });

    // same home: reconnects with the saved credential, the enroll token is already spent
    await connect();
    await app.scheduler.tick();
    const done = await until(async () => {
      const t = await getTask(task.id);
      return t.status === 'done' && t;
    }, 'task done');
    expect(done.attempts).toBe(2);
    expect(done.runs.map((r: { status: string }) => r.status)).toEqual(['lost', 'succeeded']);
  }, 20_000);

  it('reconnects after a dropped socket and reattaches the running run', async () => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const hellos = spyHellos();
    await connect(enrollToken);
    const task = (await req('POST', '/tasks', { projectId, agentId, title: 'SLOW reattach', description: 'd' })).json();
    await app.scheduler.tick();
    const runId = (await waitTask(task.id, 'running')).runs[0].id;

    dropWorkerSocket();
    await until(() => hellos.mock.calls.length === 2, 'second hello');
    expect(helloRunIds(hellos)).toEqual([[], [runId]]);
    const done = await waitTask(task.id, 'done');
    expect(done.attempts).toBe(1);
    expect(done.runs.map((r: { status: string }) => r.status)).toEqual(['succeeded']);
  }, 20_000);

  it('keeps a result produced while disconnected and sends it after reconnecting', async () => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const fake = new FakeAdapter();
    let finished = false;
    // the socket drops just before the run returns, so its result is produced while disconnected
    const adapter: RuntimeAdapter = {
      name: 'fake',
      run: async (spec, sink, signal) => {
        const result = await fake.run(spec, sink, signal);
        // wait until the API has stored accepted and all five events, so only the result is in flight
        await until(async () => (await prisma.sessionEvent.count({ where: { sessionId: spec.sessionId } })) === 5, 'events stored');
        dropWorkerSocket();
        await until(() => app.gateway.onlineWorkers().length === 0, 'worker offline');
        await new Promise((r) => setTimeout(r, 50));
        finished = true;
        return result;
      },
    };
    const hellos = spyHellos();
    await connect(enrollToken, adapter);
    const task = (await req('POST', '/tasks', { projectId, agentId, title: 'quick job', description: 'd' })).json();
    await app.scheduler.tick();

    await until(() => hellos.mock.calls.length === 2, 'second hello');
    expect(finished).toBe(true);
    // the run is no longer executing; its id is reported because the result is still unsent
    const runId = (await getTask(task.id)).runs[0].id;
    expect(helloRunIds(hellos)).toEqual([[], [runId]]);
    const done = await waitTask(task.id, 'done');
    expect(done.attempts).toBe(1);
    expect(done.runs.map((r: { status: string }) => r.status)).toEqual(['succeeded']);
  }, 20_000);
});
