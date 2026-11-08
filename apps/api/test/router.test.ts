import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunSpec } from '@office/shared';
import { resumeRun } from '../src/services/run-service.js';
import { codexUnfit, routeTask } from '../src/services/router-service.js';
import { AUTO_APPROVAL_POLICY } from '@office/shared';
import { connectFakeWorker, until, type FakeWorker } from './fake-worker.js';
import { makeApp } from './helpers.js';

const own = { runtime: 'claude' as const, model: 'opus' };

describe('routeTask', () => {
  it('no rule keeps the agent; the first matching rule wins; a rule without a model picks the runtime default', () => {
    expect(routeTask([], { kind: 'code', priority: 0 }, own)).toEqual({ ...own, reason: "agent's own runtime and model" });
    const rules = [
      { taskKind: 'verify' as const, runtime: 'claude' as const, model: 'haiku' },
      { taskKind: 'code' as const, minPriority: 5, runtime: 'codex' as const },
      { runtime: 'claude' as const },
    ];
    expect(routeTask(rules, { kind: 'verify', priority: 0 }, own)).toEqual({ runtime: 'claude', model: 'haiku', reason: 'routing rule 1 (kind verify)' });
    expect(routeTask(rules, { kind: 'code', priority: 7 }, own)).toEqual({ runtime: 'codex', model: '', reason: 'routing rule 2 (kind code, priority >= 5)' });
    // low priority code falls through to the catch-all, which keeps the agent's model on its own runtime
    expect(routeTask(rules, { kind: 'code', priority: 1 }, own)).toEqual({ runtime: 'claude', model: 'opus', reason: 'routing rule 3 (every task)' });
    expect(routeTask([{ runtime: 'claude' }], { kind: 'code', priority: 0 }, { runtime: 'codex', model: 'gpt-5-codex' })).toMatchObject({ model: 'sonnet' });
  });

  it("a rule's effort wins; without one the agent's effort stays", () => {
    const mine = { ...own, effort: 'high' as const };
    expect(routeTask([{ runtime: 'codex', effort: 'xhigh' }], { kind: 'code', priority: 0 }, mine)).toMatchObject({ runtime: 'codex', effort: 'xhigh' });
    expect(routeTask([{ runtime: 'codex' }], { kind: 'code', priority: 0 }, mine)).toMatchObject({ effort: 'high' });
    expect(routeTask([], { kind: 'code', priority: 0 }, mine)).toMatchObject({ effort: 'high' });
  });
});

describe('codexUnfit', () => {
  it('names what Codex cannot do: consultations, then a non-auto destructive or sensitive policy', () => {
    expect(codexUnfit({ requiredConsultations: [] }, AUTO_APPROVAL_POLICY)).toBeNull();
    expect(codexUnfit({ requiredConsultations: [{ agent: 'qa', topic: 't' }] }, AUTO_APPROVAL_POLICY)).toMatch('consultations');
    expect(codexUnfit({ requiredConsultations: [] }, { ...AUTO_APPROVAL_POLICY, destructive_command: 'block' })).toMatch('destructive_command policy is not auto');
  });
});

describe('model router in the scheduler', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let projectId: string;
  let agentId: string;
  const workers: FakeWorker[] = [];
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });

  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    projectId = (await req('POST', '/projects', { name: 'P', slug: 'p1', repoPath: '/tmp/office-ws/p1' })).json().id;
    agentId = (await req('POST', '/agents', { name: 'A', slug: 'a', role: 'dev', config: { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'] } })).json().id;
    await req('PUT', `/projects/${projectId}/settings`, { routing: [{ taskKind: 'code', runtime: 'codex', model: 'gpt-5-codex', effort: 'xhigh' }] });
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
    await t.close();
  });

  const worker = async (runtimes?: ('claude' | 'codex')[]) => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w', capacity: 1, allowedRoots: ['/tmp/office-ws'], runtimes });
    workers.push(w);
    return w;
  };
  const assign = async (w: FakeWorker) => {
    await req('POST', '/tasks', { projectId, agentId, title: 'Fix it', description: 'd' });
    await t.app.scheduler.tick();
    return (await w.waitFor('run.assign')).spec;
  };

  it('a matching rule sends the task to a Codex worker; the decision is stored on the run and kept on resume', async () => {
    const w = await worker(['claude', 'codex']);
    const spec = await assign(w);
    expect(spec).toMatchObject({ runtime: 'codex', model: 'gpt-5-codex', effort: 'xhigh' });
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run.routing).toEqual({ runtime: 'codex', model: 'gpt-5-codex', effort: 'xhigh', reason: 'routing rule 1 (kind code)' });

    // interrupted: the resume must go back to the same Codex thread
    w.send({ type: 'run.accepted', runId: spec.runId });
    await until(async () => (await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status === 'running', 'running');
    w.send({
      type: 'run.result', runId: spec.runId, sessionId: spec.sessionId,
      result: { status: 'suspended', sdkSessionId: 'th-1', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, numTurns: 1, durationMs: 1 } },
    });
    await until(async () => (await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status === 'waiting_reply', 'waiting');
    const { workerId } = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    await resumeRun(t.prisma, t.app.hub, t.config, t.app.gateway, spec.runId, { reason: 'timeout', worker: { workerId: workerId!, local: () => true } });
    const resumed: RunSpec = (await w.waitFor('run.assign')).spec;
    expect(resumed).toMatchObject({ runId: spec.runId, runtime: 'codex', model: 'gpt-5-codex', effort: 'xhigh', resumeSdkSessionId: 'th-1' });
  });

  it('cumulative usage (a resumed Codex thread) records only what the run had not recorded yet', async () => {
    const w = await worker(['claude', 'codex']);
    const spec = await assign(w);
    const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, costUsd: 0, numTurns: 1, durationMs: 1, cumulative: true });
    const status = async () => (await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).status;
    w.send({ type: 'run.accepted', runId: spec.runId });
    await until(async () => (await status()) === 'running', 'running');
    w.send({ type: 'run.result', runId: spec.runId, sessionId: spec.sessionId, result: { status: 'suspended', sdkSessionId: 'th-1', usage: usage(1000, 100) } });
    await until(async () => (await status()) === 'waiting_reply', 'waiting');
    await resumeRun(t.prisma, t.app.hub, t.config, t.app.gateway, spec.runId, { reason: 'timeout', worker: { workerId: (await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).workerId!, local: () => true } });
    const resumed: RunSpec = (await w.waitFor('run.assign')).spec;
    w.send({ type: 'run.accepted', runId: resumed.runId });
    await until(async () => (await status()) === 'running', 'running again');
    // the thread total of both segments
    w.send({ type: 'run.result', runId: resumed.runId, sessionId: resumed.sessionId, result: { status: 'succeeded', sdkSessionId: 'th-1', usage: usage(2500, 160) } });
    await until(async () => (await status()) === 'succeeded', 'succeeded');
    const rows = await t.prisma.usageRecord.findMany({ where: { runId: spec.runId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.inputTokens, r.outputTokens])).toEqual([[1000, 100], [1500, 60]]);
  });

  it('a rule never sends Codex a task it cannot run: gated policy or required consultations', async () => {
    const w = await worker(['claude', 'codex']);
    const settings = (await req('GET', `/projects/${projectId}/settings`)).json();
    await req('PUT', `/projects/${projectId}/settings`, { approvalPolicy: { ...settings.approvalPolicy, sensitive_path: 'ask' } });
    const spec = await assign(w);
    expect(spec).toMatchObject({ runtime: 'claude', model: 'sonnet' });
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } })).routing).toMatchObject({
      reason: "routing rule 1 (kind code) chose codex, but the project's sensitive_path policy is not auto, which Codex cannot enforce; fell back to the agent's claude",
    });
  });

  it('with no Codex worker online the run falls back to the agent runtime and says why', async () => {
    const w = await worker();
    const spec = await assign(w);
    expect(spec).toMatchObject({ runtime: 'claude', model: 'sonnet' });
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run.routing).toMatchObject({
      runtime: 'claude', reason: "routing rule 1 (kind code) chose codex, which no online worker runs; fell back to the agent's claude",
    });
  });
});
