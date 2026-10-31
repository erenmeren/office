import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunSpec } from '@office/shared';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until, type FakeWorker } from './fake-worker.js';
import { expireLeases } from '../src/services/run-service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0.5, numTurns: 1, durationMs: 5 };

describe('scheduler', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let projectId: string;
  let agentId: string;
  let workers: FakeWorker[];
  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    workers = [];
    projectId = (await req('POST', '/projects', { name: 'P', slug: 'p1', repoPath: '/tmp/office-ws/p1' })).json().id;
    agentId = (
      await req('POST', '/agents', {
        name: 'A', slug: 'a', role: 'dev', config: { systemPrompt: 'be nice', model: 'sonnet', allowedTools: ['Read'] },
      })
    ).json().id;
  });
  afterEach(async () => {
    for (const w of workers) await w.close();
    await t.close();
  });

  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });
  const createTask = async (title = 'Fix the bug') =>
    (await req('POST', '/tasks', { projectId, agentId, title, description: 'details' })).json() as { id: string };
  const getTask = async (id: string) => (await req('GET', `/tasks/${id}`)).json();
  const worker = async (opts: { allowedRoots?: string[]; capacity?: number } = {}) => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const w = await connectFakeWorker(t.app, {
      enrollToken, name: 'w', capacity: opts.capacity ?? 1, allowedRoots: opts.allowedRoots ?? ['/tmp/office-ws'],
    });
    workers.push(w);
    return w;
  };
  const assign = async (w: FakeWorker) => {
    await t.app.scheduler.tick();
    return (await w.waitFor('run.assign')).spec;
  };
  const accept = async (w: FakeWorker, spec: RunSpec) => {
    w.send({ type: 'run.accepted', runId: spec.runId });
    await until(
      async () => (await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status === 'running',
      'run running',
    );
  };
  const event = (spec: RunSpec, seq: number, payload: Record<string, unknown> = { text: `e${seq}` }) => ({
    type: 'run.event' as const,
    event: {
      type: 'agent.text' as const, seq, ts: new Date().toISOString(), sessionId: spec.sessionId,
      runId: spec.runId, agentId: spec.agentId, projectId: spec.projectId, payload,
    },
  });
  // The gateway handles one socket's messages in order, so an `error` reply to a junk message
  // proves every earlier message from that worker was processed.
  const flush = async (w: FakeWorker) => {
    w.send({ type: 'bogus' });
    return w.waitFor('error');
  };
  const expireRun = (runId: string) =>
    t.prisma.taskRun.update({ where: { id: runId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  const succeed = (w: FakeWorker, spec: RunSpec) =>
    w.send({
      type: 'run.result', runId: spec.runId, sessionId: spec.sessionId,
      result: { status: 'succeeded', resultText: 'ok', sdkSessionId: 'sdk-1', usage },
    });

  it('assigns a ready task to an eligible worker', async () => {
    const task = await createTask();
    const w = await worker();
    const spec = await assign(w);
    expect(spec.prompt).toContain('Fix the bug');
    expect(spec).toMatchObject({ cwd: '/tmp/office-ws/p1', systemPrompt: 'be nice', model: 'sonnet', allowedTools: ['Read'] });
    const got = await getTask(task.id);
    expect(got.status).toBe('queued');
    expect(got.attempts).toBe(1);
    expect(got.runs).toHaveLength(1);
    expect(got.runs[0].leaseExpiresAt).toBeTruthy();
    expect(got.runs[0].session.id).toBe(spec.sessionId);
  });

  it('skips a worker whose allowedRoots do not cover the repo', async () => {
    const task = await createTask();
    const w = await worker({ allowedRoots: ['/tmp/other'] });
    await t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.map((m) => m.type)).toEqual(['welcome']);
    expect((await getTask(task.id)).status).toBe('ready');
  });

  it('accepts, stores events idempotently and redacted, completes', async () => {
    const task = await createTask();
    const w = await worker();
    const spec = await assign(w);
    await accept(w, spec);
    expect((await getTask(task.id)).status).toBe('running');

    for (const seq of [1, 2, 3]) w.send(event(spec, seq));
    w.send(event(spec, 2));
    const probe = await flush(w);
    const events = (await req('GET', `/runs/${spec.runId}/events?afterSeq=0`)).json();
    expect(events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3]);
    expect(events[1].payload).toEqual({ text: 'e2' });
    expect(w.received.filter((m) => m.type === 'error')).toEqual([probe]);
    expect((await req('GET', `/runs/${spec.runId}/events?afterSeq=2`)).json()).toHaveLength(1);

    w.send(event(spec, 4, { output: 'token=abcdefghijklmnop' }));
    await flush(w);
    const stored = await t.prisma.sessionEvent.findFirstOrThrow({ where: { sessionId: spec.sessionId, seq: 4 } });
    expect(stored.payload).toEqual({ output: 'token=[REDACTED]' });

    succeed(w, spec);
    await until(async () => (await getTask(task.id)).status === 'done', 'task done');
    const run = (await req('GET', `/runs/${spec.runId}`)).json();
    expect(run).toMatchObject({ status: 'succeeded', resultText: 'ok', costUsd: 0.5 });
    expect(run.session).toMatchObject({ sdkSessionId: 'sdk-1', status: 'succeeded' });
    const usageRows = await t.prisma.usageRecord.findMany({ where: { runId: spec.runId } });
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({ inputTokens: 10, outputTokens: 20, costUsd: 0.5, model: 'sonnet' });
  });

  it('loses a lease, retries, then fails after maxAttempts', async () => {
    const task = await createTask();
    const w1 = await worker();
    const spec1 = await assign(w1);
    await accept(w1, spec1);
    // the worker dies; nothing is online to take the retry
    await w1.close();
    await until(() => t.app.gateway.onlineWorkers().length === 0, 'worker gone');
    await expireRun(spec1.runId);
    await t.app.scheduler.tick();
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec1.runId } })).status).toBe('lost');
    const afterFirst = await getTask(task.id);
    expect(afterFirst).toMatchObject({ status: 'ready', attempts: 1 });
    const events = (await req('GET', `/runs/${spec1.runId}/events`)).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(['run.lease.lost']);
    expect((await t.prisma.agentSession.findUniqueOrThrow({ where: { id: spec1.sessionId } })).status).toBe('lost');

    const w2 = await connectFakeWorker(t.app, {
      credential: w1.credential, name: 'w', capacity: 1, allowedRoots: ['/tmp/office-ws'],
    });
    workers.push(w2);
    const spec2 = await assign(w2);
    await accept(w2, spec2);
    expect((await getTask(task.id)).attempts).toBe(2);
    await expireRun(spec2.runId);
    await t.app.scheduler.tick();
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec2.runId } })).status).toBe('lost');
    expect((await getTask(task.id)).status).toBe('failed');
  });

  it('rejects a result from a worker whose lease was lost', async () => {
    const task = await createTask();
    const w = await worker();
    const spec = await assign(w);
    await accept(w, spec);
    await expireRun(spec.runId);
    await expireLeases(t.prisma, t.app.hub);
    expect((await getTask(task.id)).status).toBe('ready');

    succeed(w, spec);
    const err = await w.waitFor('error');
    expect(err.message).toMatch(/lease/i);
    expect((await getTask(task.id)).status).toBe('ready');
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status).toBe('lost');
    expect(await t.prisma.usageRecord.count()).toBe(0);

    // events for a run without a live lease are dropped silently
    w.send(event(spec, 5));
    await flush(w);
    const types = (await req('GET', `/runs/${spec.runId}/events`)).json().map((e: { type: string }) => e.type);
    expect(types).toEqual(['run.lease.lost']);
  });

  it('fails a queued task whose lease is lost before accept with no attempts left', async () => {
    const task = await createTask();
    await t.prisma.task.update({ where: { id: task.id }, data: { maxAttempts: 1 } });
    const w = await worker();
    const spec = await assign(w);
    expect((await getTask(task.id)).status).toBe('queued');
    await expireRun(spec.runId);
    await t.app.scheduler.tick();
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status).toBe('lost');
    expect((await getTask(task.id)).status).toBe('failed');
  });

  it('accepts a failed result before run.accepted', async () => {
    const task = await createTask();
    const w = await worker();
    const spec = await assign(w);
    w.send({
      type: 'run.result', runId: spec.runId, sessionId: spec.sessionId,
      result: { status: 'failed', error: 'boom', usage },
    });
    await until(async () => (await getTask(task.id)).status === 'failed', 'task failed');
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status).toBe('failed');
  });

  it('accepts a succeeded result before run.accepted (implicit accept)', async () => {
    const task = await createTask();
    const w = await worker();
    const spec = await assign(w);
    w.send({
      type: 'run.result', runId: spec.runId, sessionId: spec.sessionId,
      result: { status: 'succeeded', resultText: 'ok', usage },
    });
    await until(async () => (await getTask(task.id)).status === 'done', 'task done');
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run.status).toBe('succeeded');
    expect(run.startedAt).not.toBeNull();
    expect(await t.prisma.usageRecord.count({ where: { runId: spec.runId } })).toBe(1);
  });

  it('rejects a result before run.accepted when the lease already expired', async () => {
    const task = await createTask();
    const w = await worker();
    const spec = await assign(w);
    await expireRun(spec.runId);
    succeed(w, spec);
    expect((await w.waitFor('error')).message).toMatch(/lease/i);
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run).toMatchObject({ status: 'queued', startedAt: null });
    expect((await getTask(task.id)).status).toBe('queued');
    expect(await t.prisma.usageRecord.count()).toBe(0);
    await t.app.scheduler.tick();
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status).toBe('lost');
  });

  it('a heartbeat moves the lease forward', async () => {
    await createTask();
    const w = await worker();
    const spec = await assign(w);
    await accept(w, spec);
    const soon = new Date(Date.now() + 1000);
    await t.prisma.taskRun.update({ where: { id: spec.runId }, data: { leaseExpiresAt: soon } });
    w.send({ type: 'heartbeat', capacity: 1, activeRunIds: [spec.runId] });
    await flush(w);
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run.leaseExpiresAt!.getTime()).toBeGreaterThan(soon.getTime() + 30_000);
  });

  it('a reconnecting worker reattaches its running run before the lease is expired', async () => {
    const task = await createTask();
    const w1 = await worker();
    const spec = await assign(w1);
    await accept(w1, spec);
    await w1.close();
    await until(() => t.app.gateway.onlineWorkers().length === 0, 'worker gone');
    await expireRun(spec.runId);
    const w2 = await connectFakeWorker(t.app, {
      credential: w1.credential, name: 'w', capacity: 1, allowedRoots: ['/tmp/office-ws'], activeRunIds: [spec.runId],
    });
    workers.push(w2);
    expect(t.app.gateway.onlineWorkers()[0]!.activeRuns).toBe(1);
    await t.app.scheduler.tick();
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status).toBe('running');
    expect((await getTask(task.id)).status).toBe('running');
  });

  it("rejects another worker's result for a live run", async () => {
    const task = await createTask();
    const w1 = await worker();
    const w2 = await worker();
    const spec = await assign(w1);
    await accept(w1, spec);
    succeed(w2, spec);
    const err = await w2.waitFor('error');
    expect(err.message).toMatch(/lease/i);
    expect((await getTask(task.id)).status).toBe('running');
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run).toMatchObject({ status: 'running', resultText: null, costUsd: 0 });
    expect(await t.prisma.usageRecord.count()).toBe(0);
  });

  it('cancelling a running task cancels its run and tells the worker', async () => {
    const task = await createTask();
    const w = await worker();
    const spec = await assign(w);
    await accept(w, spec);
    const res = await req('POST', `/tasks/${task.id}/cancel`);
    expect(res.json().status).toBe('cancelled');
    expect(await w.waitFor('run.cancel')).toEqual({ type: 'run.cancel', runId: spec.runId });
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status).toBe('cancelled');
    expect(t.app.gateway.onlineWorkers()[0]!.activeRuns).toBe(0);
  });

  it('respects worker capacity', async () => {
    const t1 = await createTask('first');
    const t2 = await createTask('second');
    const w = await worker({ capacity: 1 });
    const spec1 = await assign(w);
    await accept(w, spec1);
    await t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.filter((m) => m.type === 'run.assign')).toHaveLength(1);
    expect((await getTask(t2.id)).status).toBe('ready');

    succeed(w, spec1);
    await until(async () => (await getTask(t1.id)).status === 'done', 'first done');
    const spec2 = await assign(w);
    expect(spec2.prompt).toContain('second');
  });
});
