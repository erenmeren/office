import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest, RunSpec } from '@office/shared';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until, type FakeWorker } from './fake-worker.js';

async function setup() {
  const t = await makeApp();
  const cookie = await t.login();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });
  const projectId = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json().id as string;
  const agentId = (
    await req('POST', '/agents', {
      name: 'Dev', slug: 'dev', role: 'dev', config: { systemPrompt: 's', model: 'sonnet', allowedTools: ['Bash'] },
    })
  ).json().id as string;
  const workers: FakeWorker[] = [];
  const connect = async (opts: { enrollToken?: string; credential?: string; activeRunIds?: string[] }) => {
    const w = await connectFakeWorker(t.app, { ...opts, name: 'w', capacity: 1, allowedRoots: ['/tmp/office-ws'] });
    workers.push(w);
    return w;
  };
  const flush = async (w: FakeWorker) => {
    w.send({ type: 'bogus' });
    await w.waitFor('error');
  };
  const run = (id: string) => t.prisma.taskRun.findUniqueOrThrow({ where: { id } });
  const task = (id: string) => t.prisma.task.findUniqueOrThrow({ where: { id } });
  /** A connected worker running a standalone task. */
  const running = async () => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const w = await connect({ enrollToken });
    const created = (await req('POST', '/tasks', { projectId, agentId, title: 'T', description: 'd' })).json();
    await t.app.scheduler.tick();
    const spec = (await w.waitFor('run.assign')).spec;
    w.send({ type: 'run.accepted', runId: spec.runId });
    await until(async () => (await run(spec.runId)).status === 'running', 'run running');
    return { w, spec, taskId: created.id as string };
  };
  let n = 0;
  const ask = async (w: FakeWorker, spec: RunSpec, input: Record<string, unknown>, extra: Partial<ApprovalRequest> = {}) => {
    const request: ApprovalRequest = {
      requestId: `r${++n}`, toolName: 'Bash', input, type: 'destructive_command', reason: 'rm -rf', ...extra,
    };
    w.send({ type: 'approval.request', runId: spec.runId, sessionId: spec.sessionId, request });
    await flush(w);
    return request;
  };
  const pending = (runId: string) => t.prisma.approval.findMany({ where: { runId, status: 'pending' } });
  const close = async () => {
    for (const w of workers) await w.close();
    await t.close();
  };
  return { t, req, projectId, connect, flush, run, task, running, ask, pending, close };
}

describe('tool approvals', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => s.close());

  it('request -> pending + waiting_approval; approve -> allow, running, audit; second approve 409', async () => {
    s = await setup();
    const { w, spec, taskId } = await s.running();
    const seen: unknown[] = [];
    s.t.app.hub.subscribe('global', (m) => seen.push(m));
    const before = Date.now();
    const request = await s.ask(w, spec, { command: 'rm -rf build' });

    const [a] = await s.pending(spec.runId);
    expect(a).toMatchObject({ requestId: request.requestId, toolName: 'Bash', type: 'destructive_command', taskId, runId: spec.runId });
    expect(a!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
    expect((await s.run(spec.runId)).status).toBe('waiting_approval');
    expect((await s.task(taskId)).status).toBe('waiting_approval');
    expect(seen).toContainEqual(expect.objectContaining({ type: 'approval.changed', approval: expect.objectContaining({ id: a!.id, status: 'pending' }) }));

    const view = await s.req('GET', `/approvals/${a!.id}`);
    expect(view.json()).toMatchObject({ id: a!.id, status: 'pending', toolName: 'Bash' });
    expect((await s.req('GET', `/approvals?projectId=${s.projectId}&status=pending`)).json()).toHaveLength(1);

    expect((await s.req('POST', `/approvals/${a!.id}/approve`, {})).statusCode).toBe(200);
    const result = await w.waitFor('approval.result');
    expect(result).toEqual({ type: 'approval.result', runId: spec.runId, decision: { requestId: request.requestId, decision: 'allow' } });
    expect((await s.run(spec.runId)).status).toBe('running');
    expect((await s.task(taskId)).status).toBe('running');
    expect(await s.t.prisma.auditLog.findFirst({ where: { action: 'approval.decided', targetId: a!.id } })).toMatchObject({
      detail: { decision: 'allow', scope: 'once', type: 'destructive_command', toolName: 'Bash' },
    });

    const again = await s.req('POST', `/approvals/${a!.id}/approve`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'already_decided' });
  });

  it('scope task auto-allows an identical request; a different command asks again; deny sends deny', async () => {
    s = await setup();
    const { w, spec } = await s.running();
    await s.ask(w, spec, { command: 'git push origin x' }, { type: 'git_push' });
    const [a] = await s.pending(spec.runId);
    await s.req('POST', `/approvals/${a!.id}/approve`, { scope: 'task' });
    await w.waitFor('approval.result');

    const same = await s.ask(w, spec, { command: '  git push origin x ' }, { type: 'git_push' });
    expect(await w.waitFor('approval.result')).toMatchObject({ decision: { requestId: same.requestId, decision: 'allow' } });
    expect(await s.t.prisma.approval.count()).toBe(1);
    expect((await s.run(spec.runId)).status).toBe('running');

    const other = await s.ask(w, spec, { command: 'git push --force origin x' }, { type: 'git_push' });
    const [b] = await s.pending(spec.runId);
    expect(b!.requestId).toBe(other.requestId);
    expect((await s.req('POST', `/approvals/${b!.id}/deny`, { message: 'no force' })).statusCode).toBe(200);
    expect(await w.waitFor('approval.result')).toMatchObject({ decision: { requestId: other.requestId, decision: 'deny', message: 'no force' } });
    expect((await s.t.prisma.approval.findUniqueOrThrow({ where: { id: b!.id } })).status).toBe('denied');
  });

  it('timeout -> expired, deny with the policy message, running; approving it afterwards 409', async () => {
    s = await setup();
    const { w, spec } = await s.running();
    await s.req('PUT', `/projects/${s.projectId}/settings`, { approvalTimeoutMinutes: 5 });
    const request = await s.ask(w, spec, { command: 'rm -rf /tmp/x' });
    const [a] = await s.pending(spec.runId);
    await s.t.prisma.approval.update({ where: { id: a!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await s.t.app.scheduler.tick();

    expect(await w.waitFor('approval.result')).toEqual({
      type: 'approval.result',
      runId: spec.runId,
      decision: { requestId: request.requestId, decision: 'deny', message: 'No decision within 5 minutes; denied by policy.' },
    });
    expect((await s.t.prisma.approval.findUniqueOrThrow({ where: { id: a!.id } })).status).toBe('expired');
    expect((await s.run(spec.runId)).status).toBe('running');
    expect(await s.t.prisma.auditLog.count({ where: { action: 'approval.expired', targetId: a!.id } })).toBe(1);
    expect((await s.req('POST', `/approvals/${a!.id}/approve`, {})).statusCode).toBe(409);
  });

  it('cancelling the task while waiting -> run cancelled, approval expired, worker told to cancel', async () => {
    s = await setup();
    const { w, spec, taskId } = await s.running();
    await s.ask(w, spec, { command: 'rm -rf x' });
    const [a] = await s.pending(spec.runId);
    expect((await s.req('POST', `/tasks/${taskId}/cancel`)).statusCode).toBe(200);
    expect((await s.run(spec.runId)).status).toBe('cancelled');
    expect(await s.t.prisma.approval.findUniqueOrThrow({ where: { id: a!.id } })).toMatchObject({ status: 'expired', message: 'run cancelled' });
    expect((await w.waitFor('run.cancel')).runId).toBe(spec.runId);
    expect(await s.t.prisma.auditLog.findFirst({ where: { action: 'approval.expired', targetId: a!.id } })).toMatchObject({
      userId: null,
      detail: { reason: 'run cancelled' },
    });
    const res = await s.req('POST', `/approvals/${a!.id}/approve`, {});
    expect(res.statusCode).toBe(409);
  });

  it('a second request sent right after the first decision arrives is decided and delivered too', async () => {
    s = await setup();
    const { w, spec } = await s.running();
    const first = await s.ask(w, spec, { command: 'rm -rf a' });
    const [a] = await s.pending(spec.runId);
    await s.req('POST', `/approvals/${a!.id}/approve`, {});
    expect((await w.waitFor('approval.result')).decision.requestId).toBe(first.requestId);
    const second = await s.ask(w, spec, { command: 'rm -rf b' });
    const [b] = await s.pending(spec.runId);
    expect(b!.requestId).toBe(second.requestId);
    expect((await s.run(spec.runId)).status).toBe('waiting_approval');
    await s.req('POST', `/approvals/${b!.id}/deny`, {});
    expect(await w.waitFor('approval.result')).toMatchObject({ decision: { requestId: second.requestId, decision: 'deny' } });
    expect((await s.t.prisma.approval.findMany({ where: { runId: spec.runId } })).map((x) => x.status).sort()).toEqual(['approved', 'denied']);
    expect((await s.run(spec.runId)).status).toBe('running');
  });

  it('a request for a run the worker does not lease -> error, no row', async () => {
    s = await setup();
    const { w, spec } = await s.running();
    w.send({
      type: 'approval.request', runId: 'nope', sessionId: spec.sessionId,
      request: { requestId: 'x', toolName: 'Bash', input: { command: 'ls' }, type: 'destructive_command', reason: 'r' },
    });
    expect((await w.waitFor('error')).message).toMatch(/lease/);
    expect(await s.t.prisma.approval.count()).toBe(0);
  });

  it('a decision made while the worker is offline is re-sent on reconnect', async () => {
    s = await setup();
    const { w, spec } = await s.running();
    const request = await s.ask(w, spec, { command: 'rm -rf x' });
    const [a] = await s.pending(spec.runId);
    await w.close();
    await until(async () => (await s.t.prisma.worker.findUniqueOrThrow({ where: { id: w.workerId! } })).status === 'offline', 'offline');
    expect((await s.req('POST', `/approvals/${a!.id}/approve`, {})).statusCode).toBe(200);
    expect((await s.run(spec.runId)).status).toBe('waiting_approval');

    const w2 = await s.connect({ credential: w.credential, activeRunIds: [spec.runId] });
    expect(await w2.waitFor('approval.result')).toMatchObject({ runId: spec.runId, decision: { requestId: request.requestId, decision: 'allow' } });
    await until(async () => (await s.run(spec.runId)).status === 'running', 'run running');
  });

  it('two requests: first delivered, second decided offline -> delivered on reconnect, run running', async () => {
    s = await setup();
    const { w, spec } = await s.running();
    const r1 = await s.ask(w, spec, { command: 'rm -rf a' });
    const r2 = await s.ask(w, spec, { command: 'rm -rf b' });
    const [a1, a2] = await s.t.prisma.approval.findMany({ where: { runId: spec.runId }, orderBy: { createdAt: 'asc' } });
    expect((await s.req('POST', `/approvals/${a1!.id}/approve`, {})).json()).toMatchObject({ delivered: true });
    expect((await w.waitFor('approval.result')).decision.requestId).toBe(r1.requestId);
    expect((await s.run(spec.runId)).status).toBe('waiting_approval');
    await w.close();
    await until(async () => (await s.t.prisma.worker.findUniqueOrThrow({ where: { id: w.workerId! } })).status === 'offline', 'offline');
    const res = await s.req('POST', `/approvals/${a2!.id}/approve`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: false, deliveredAt: null });

    const w2 = await s.connect({ credential: w.credential, activeRunIds: [spec.runId] });
    expect((await w2.waitFor('approval.result')).decision.requestId).toBe(r2.requestId);
    await until(async () => (await s.run(spec.runId)).status === 'running', 'run running');
    const rows = await s.t.prisma.approval.findMany({ where: { runId: spec.runId } });
    expect(rows.every((x) => x.deliveredAt)).toBe(true);
    expect(w2.received.filter((m) => m.type === 'approval.result')).toHaveLength(1);
  });

  it('two pending requests decided concurrently -> both delivered, no 409', async () => {
    s = await setup();
    const { w, spec } = await s.running();
    await s.ask(w, spec, { command: 'rm -rf a' });
    await s.ask(w, spec, { command: 'rm -rf b' });
    const [a1, a2] = await s.pending(spec.runId);
    const res = await Promise.all([
      s.req('POST', `/approvals/${a1!.id}/approve`, {}),
      s.req('POST', `/approvals/${a2!.id}/deny`, {}),
    ]);
    expect(res.map((r) => r.statusCode)).toEqual([200, 200]);
    await w.waitFor('approval.result');
    await w.waitFor('approval.result');
    expect((await s.t.prisma.approval.findMany({ where: { runId: spec.runId } })).every((x) => x.deliveredAt)).toBe(true);
    expect((await s.run(spec.runId)).status).toBe('running');
  });

  it("a waiting run's lease is renewed by heartbeat; when it expires the run is lost and the approval expired", async () => {
    s = await setup();
    const { w, spec, taskId } = await s.running();
    await s.ask(w, spec, { command: 'rm -rf x' });
    const [a] = await s.pending(spec.runId);
    const soon = new Date(Date.now() + 1000);
    await s.t.prisma.taskRun.update({ where: { id: spec.runId }, data: { leaseExpiresAt: soon } });
    w.send({ type: 'heartbeat', capacity: 1, activeRunIds: [spec.runId] });
    await s.flush(w);
    expect((await s.run(spec.runId)).leaseExpiresAt!.getTime()).toBeGreaterThan(soon.getTime());

    await s.t.prisma.taskRun.update({ where: { id: spec.runId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await s.t.app.scheduler.tick();
    expect((await s.run(spec.runId)).status).toBe('lost');
    expect(await s.t.prisma.approval.findUniqueOrThrow({ where: { id: a!.id } })).toMatchObject({ status: 'expired', message: 'lease lost' });
    expect((await s.task(taskId)).status).not.toBe('waiting_approval');
  });
});
