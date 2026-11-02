import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_JSON_SCHEMA, SAMPLE_PLAN, type Plan, type RunSpec } from '@office/shared';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until, type FakeWorker } from './fake-worker.js';
import { sendMessage } from '../src/services/message-service.js';
import { expireLeases } from '../src/services/run-service.js';
import { approveBudget } from '../src/services/budget-service.js';
import { evidenceRule } from '../src/services/review-service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0.5, numTurns: 1, durationMs: 5 };

/** a -> b (code, developer), c -> d (analysis architect -> review qa), derived from SAMPLE_PLAN. */
function testPlan(): Plan {
  const [analysis, mapping, verify, typo] = (JSON.parse(JSON.stringify(SAMPLE_PLAN)) as Plan).tasks;
  return {
    summary: 'test plan',
    risks: [],
    tasks: [
      { ...typo!, key: 'a', dependsOn: [] },
      { ...mapping!, key: 'b', dependsOn: ['a'], requiredConsultations: [] },
      { ...analysis!, key: 'c', dependsOn: [] },
      { ...verify!, key: 'd', dependsOn: ['c'] },
    ],
  };
}

const git = (filesChanged: number) => ({
  branch: 'office/run-branch',
  baseCommit: 'base000',
  headCommit: filesChanged ? 'head111' : 'base000',
  commits: filesChanged ? [{ sha: 'head111', subject: 'change' }] : [],
  diffStat: `${filesChanged} files changed`,
  filesChanged,
  integration: 'fast_forwarded',
  worktreePath: '/tmp/office-worker/runs/x/repo',
});
/** The worker integrates nothing when the check fails (executor finishWorktree). */
const failedGit = (filesChanged: number) => ({ ...git(filesChanged), integration: 'none' as const });
const check = (status: 'passed' | 'failed') => ({
  command: 'pnpm test',
  status,
  exitCode: status === 'passed' ? 0 : 1,
  durationMs: 1200,
  output: `tests ${status}`,
});

async function setup() {
  const t = await makeApp();
  const cookie = await t.login();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });
  const projectId = (await req('POST', '/projects', { name: 'Maratus', slug: 'm1', repoPath: '/tmp/office-ws/m1' })).json()
    .id as string;
  await req('PUT', `/projects/${projectId}/settings`, { approvalPolicy: { plan: 'auto' }, checkCommand: 'pnpm test' });
  const ids: Record<string, string> = {};
  for (const slug of ['chief', 'architect', 'developer', 'qa-engineer']) {
    ids[slug] = (
      await req('POST', '/agents', {
        name: slug, slug, role: slug, description: `the ${slug}`,
        config: { systemPrompt: 'be nice', model: 'sonnet', allowedTools: ['Read', 'Edit', 'Write', 'Bash'] },
      })
    ).json().id as string;
  }
  const workers: FakeWorker[] = [];
  const worker = async (capacity = 1) => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w', capacity, allowedRoots: ['/tmp/office-ws'] });
    workers.push(w);
    return w;
  };
  const flush = async (w: FakeWorker) => {
    w.send({ type: 'bogus' });
    await w.waitFor('error');
  };
  const assign = async (w: FakeWorker) => {
    await t.app.scheduler.tick();
    return (await w.waitFor('run.assign')).spec;
  };
  const finish = async (w: FakeWorker, spec: RunSpec, r: Record<string, unknown>) => {
    w.send({ type: 'run.result', runId: spec.runId, sessionId: spec.sessionId, result: { usage, ...r } });
    await flush(w);
  };
  let calls = 0;
  const tool = async (w: FakeWorker, spec: RunSpec, name: string, args: object) => {
    const callId = `c${++calls}`;
    w.send({ type: 'tool.call', runId: spec.runId, sessionId: spec.sessionId, callId, name, args });
    for (;;) {
      const m = await w.waitFor('tool.result');
      if (m.callId === callId) return m.result;
    }
  };
  const mission = (id: string) => t.prisma.mission.findUniqueOrThrow({ where: { id } });
  const task = (id: string) => t.prisma.task.findUniqueOrThrow({ where: { id } });
  /** An auto-approved mission with testPlan(); the plan run used the returned worker. */
  const approved = async (capacity = 1, plan = testPlan(), budgetUsd?: number) => {
    const w = await worker(capacity);
    const res = await req('POST', '/missions', { projectId, request: 'Implement the mapping and fix the typo', budgetUsd });
    const planSpec = await assign(w);
    await finish(w, planSpec, { status: 'succeeded', structuredOutput: plan });
    const m = await until(async () => {
      const x = await mission(res.json().id);
      return x.status === 'approved' && x;
    }, 'mission approved');
    const ts = await t.prisma.task.findMany({ where: { missionId: m.id } });
    const k = Object.fromEntries(ts.map((x) => [x.key!, x.id])) as Record<'a' | 'b' | 'c' | 'd', string>;
    return { w, m, k, planSpec };
  };
  const statuses = async (missionId: string) =>
    Object.fromEntries(
      (await t.prisma.task.findMany({ where: { missionId } })).map((x) => [x.key, x.status]),
    );
  /** Runs task a (check passed or failed) and c (analysis) to review; the mission then waits for review. */
  const toReview = async (w: FakeWorker, k: Record<string, string>, aCheck: 'passed' | 'failed') => {
    const a = await assign(w);
    expect(a.taskKind).toBe('code');
    await finish(w, a, { status: 'succeeded', git: aCheck === 'passed' ? git(2) : failedGit(2), check: check(aCheck) });
    const c = await assign(w);
    expect(c.taskKind).toBe('analysis');
    await finish(w, c, { status: 'succeeded', resultText: 'The rules live in src/mapping.ts.', git: { ...git(0), integration: 'none' } });
    expect((await task(k.a!)).status).toBe('review');
    expect((await task(k.c!)).status).toBe('review');
  };
  const close = async () => {
    for (const w of workers) await w.close();
    await t.close();
  };
  return { t, req, projectId, ids, worker, flush, assign, finish, tool, mission, task, approved, statuses, toReview, close };
}

describe('orchestration', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => s.close());

  it('only roots are ready; a succeeded code run -> review with check, git, event and a Chief message; owner done readies the dependent', async () => {
    s = await setup();
    const { w, m, k } = await s.approved();
    expect(await s.statuses(m.id)).toEqual({ a: 'ready', b: 'planned', c: 'ready', d: 'planned' });

    const spec = await s.assign(w);
    expect(spec.taskKind).toBe('code');
    expect(spec.git).toMatchObject({ taskSlug: 'a', defaultBranch: 'main', repoPath: '/tmp/office-ws/m1', agentName: 'developer' });
    expect(spec.git!.missionBranch).toMatch(/^office\/implement-the-mapping-and-fix-the-typo-[0-9a-f-]{6}$/);
    expect(spec.readOnlyCheckout).toBe(false);
    expect(spec.checkCommand).toBe('pnpm test');
    expect(spec.env).toEqual({ file: '.env.local', vars: [] });
    expect(spec.maxBudgetUsd).toBe(5); // agent cap 0 (none): the project's defaultTaskBudgetUsd applies
    expect(spec.cwd).toBe('/tmp/office-ws/m1');
    expect((await s.mission(m.id))).toMatchObject({ status: 'running', branch: spec.git!.missionBranch });

    const events: unknown[] = [];
    s.t.app.hub.subscribe(`run:${spec.runId}`, (e) => events.push(e));
    await s.finish(w, spec, { status: 'succeeded', resultText: 'done', git: git(2), check: check('passed') });

    expect(await s.statuses(m.id)).toEqual({ a: 'review', b: 'planned', c: 'ready', d: 'planned' });
    const run = await s.t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run).toMatchObject({ branch: 'office/run-branch', baseCommit: 'base000', headCommit: 'head111', integration: 'fast_forwarded' });
    expect(await s.t.prisma.gitWorkspace.findUniqueOrThrow({ where: { runId: spec.runId } })).toMatchObject({
      repoPath: '/tmp/office-ws/m1', worktreePath: '/tmp/office-worker/runs/x/repo', branch: 'office/run-branch',
    });
    const cr = await s.t.prisma.checkResult.findUniqueOrThrow({ where: { runId: spec.runId } });
    expect(cr).toMatchObject({ taskId: k.a, command: 'pnpm test', status: 'passed', exitCode: 0, durationMs: 1200 });
    expect(cr.artifactId).toBeTruthy();
    expect(await s.t.prisma.artifact.findUniqueOrThrow({ where: { id: cr.artifactId! } })).toMatchObject({ kind: 'check_output', name: 'check.txt' });
    const ev = await s.t.prisma.sessionEvent.findFirstOrThrow({ where: { sessionId: spec.sessionId, type: 'agent.check.completed' } });
    expect(ev.payload).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent.check.completed' }));

    const note = await s.t.prisma.message.findFirstOrThrow({ where: { conversationId: m.conversationId!, type: 'message' }, include: { deliveries: true } });
    expect(note).toMatchObject({ senderAgentId: s.ids.developer, taskId: k.a, body: 'Task a finished: succeeded. Check: passed. Integration: fast_forwarded.' });
    expect(note.deliveries.map((d) => d.recipientAgentId)).toEqual([s.ids.chief]);

    const task = (await s.req('GET', `/tasks/${k.a}`)).json();
    expect(task.checkResult).toMatchObject({ status: 'passed' });
    expect(task.git).toMatchObject({ branch: 'office/run-branch', headCommit: 'head111', integration: 'fast_forwarded' });
    const detail = (await s.req('GET', `/missions/${m.id}`)).json();
    expect(detail.tasks.find((x: { key: string }) => x.key === 'a').checkResult).toMatchObject({ status: 'passed' });

    const res = await s.req('POST', `/tasks/${k.a}/done`, { note: 'looks good' });
    expect(res.statusCode).toBe(200);
    expect(await s.statuses(m.id)).toMatchObject({ a: 'done', b: 'ready' });
    expect(await s.t.prisma.auditLog.count({ where: { action: 'task.override', targetId: k.a } })).toBe(1);
  });

  it('a retry after a lost lease starts from the mission branch head; run.lease.lost carries workerId and retried', async () => {
    s = await setup();
    const { w, k } = await s.approved(3);
    const first = await s.assign(w);
    const gw = await s.t.prisma.gitWorkspace.create({
      data: { runId: first.runId, repoPath: '/tmp/office-ws/m1', worktreePath: '/tmp/x', branch: 'office/run-branch', baseCommit: 'b', headCommit: 'b' },
    });
    await expireLeases(s.t.prisma, s.t.app.hub, new Date(Date.now() + 3_600_000));
    expect((await s.task(k.a)).status).toBe('ready');
    const lost = await s.t.prisma.sessionEvent.findFirstOrThrow({ where: { sessionId: first.sessionId, type: 'run.lease.lost' } });
    const workerId = (await s.t.prisma.taskRun.findUniqueOrThrow({ where: { id: first.runId } })).workerId;
    expect(lost.payload).toEqual({ workerId, retried: true });
    expect((await s.req('GET', `/runs/${first.runId}`)).json()).toMatchObject({ status: 'lost', retriedByRunId: null });
    // a later non-task run on the same task is not its retry
    const { id: _id, ...base } = await s.t.prisma.taskRun.findUniqueOrThrow({ where: { id: first.runId } });
    const fake = await s.t.prisma.taskRun.create({ data: { ...base, kind: 'review', status: 'cancelled', createdAt: new Date(Date.now() + 1000) } as never });
    expect((await s.req('GET', `/runs/${first.runId}`)).json()).toMatchObject({ retriedByRunId: null });
    await s.t.prisma.taskRun.delete({ where: { id: fake.id } });

    await s.t.app.scheduler.tick();
    let second = (await w.waitFor('run.assign')).spec;
    if (second.git!.taskSlug !== 'a') second = (await w.waitFor('run.assign')).spec; // c may be assigned first
    expect(second.runId).not.toBe(first.runId);
    expect(second.git!.missionBranch).toBe(first.git!.missionBranch);
    expect((await s.req('GET', `/runs/${first.runId}`)).json()).toMatchObject({ retriedByRunId: second.runId });
    expect(await s.t.prisma.gitWorkspace.findUniqueOrThrow({ where: { id: gw.id } })).toMatchObject({ removedAt: null });
  });

  it('needs_integration -> review with a note', async () => {
    s = await setup();
    const { w, k } = await s.approved();
    const spec = await s.assign(w);
    await s.finish(w, spec, { status: 'succeeded', git: { ...git(1), integration: 'needs_integration' }, check: check('passed') });
    expect(await s.task(k.a)).toMatchObject({ status: 'review', reviewNote: 'needs integration' });
  });

  it('evidence rule: a skipped check (no checkCommand) is not a failure, a failed one is', async () => {
    s = await setup();
    const run = (status: string) => ({
      status: 'succeeded',
      git: { ...git(1), integration: 'fast_forwarded' },
      check: { status, exitCode: null },
    });
    const task = { kind: 'code' };
    const e = (status: string) => ({ task, runs: [run(status)], artifacts: [], memoryCount: 0 }) as unknown as Parameters<typeof evidenceRule>[0];
    expect(evidenceRule(e('skipped')).ok).toBe(true);
    expect(evidenceRule(e('failed'))).toEqual({ ok: false, reason: 'check failed on the latest checked run' });
  });

  it('owner failed override: review -> failed with the note, audited, dependent blocked', async () => {
    s = await setup();
    const { w, k } = await s.approved();
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: git(1), check: check('passed') });
    const res = await s.req('POST', `/tasks/${k.a}/failed`, { note: 'wrong approach' });
    expect(res.statusCode).toBe(200);
    expect(await s.task(k.a)).toMatchObject({ status: 'failed', reviewNote: 'wrong approach' });
    expect((await s.task(k.b)).status).toBe('blocked');
    const audit = await s.t.prisma.auditLog.findFirstOrThrow({ where: { action: 'task.override', targetId: k.a } });
    expect(audit.detail).toMatchObject({ decision: 'failed', by: 'owner' });
  });

  it('a failed twice -> a failed, b blocked; owner retry -> ready', async () => {
    s = await setup();
    const { w, m, k } = await s.approved();
    const first = await s.assign(w);
    expect(first.git?.taskSlug).toBe('a');
    await s.finish(w, first, { status: 'failed', error: 'boom' });
    expect((await s.task(k.a)).status).toBe('ready');
    const second = await s.assign(w);
    expect(second.git?.taskSlug).toBe('a');
    await s.finish(w, second, { status: 'failed', error: 'boom' });
    expect(await s.statuses(m.id)).toMatchObject({ a: 'failed', b: 'blocked' });
    const res = await s.req('POST', `/tasks/${k.a}/retry`);
    expect(res.statusCode).toBe(200);
    expect((await s.task(k.a)).status).toBe('ready');
    expect(await s.t.prisma.auditLog.count({ where: { action: 'task.retry', targetId: k.a } })).toBe(1);
  });

  it('project maxConcurrentRuns 1 -> one assignment per tick', async () => {
    s = await setup();
    await s.req('PUT', `/projects/${s.projectId}/settings`, { maxConcurrentRuns: 1 });
    const { w } = await s.approved(2);
    await s.t.app.scheduler.tick();
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.filter((x) => x.type === 'run.assign')).toHaveLength(2); // plan + one task
    expect(await s.t.prisma.taskRun.count({ where: { kind: 'task' } })).toBe(1);
  });

  it('agent daily budget spent -> its task is not assigned, one log line', async () => {
    s = await setup();
    const { w, k, planSpec } = await s.approved(2);
    await s.t.prisma.agent.update({ where: { id: s.ids.developer }, data: { dailyBudgetUsd: 0.01 } });
    await s.t.prisma.usageRecord.create({
      data: { runId: planSpec.runId, projectId: s.projectId, agentId: s.ids.developer, model: 'sonnet', inputTokens: 1, outputTokens: 1, costUsd: 0.02 },
    });
    const info = vi.spyOn((s.t.app.scheduler as unknown as { log: { info: (...a: unknown[]) => void } }).log, 'info');
    await s.t.app.scheduler.tick();
    await s.t.app.scheduler.tick();
    await sleep(100);
    const tasks = w.received.filter((x) => x.type === 'run.assign').slice(1);
    expect(tasks.map((x) => (x as { spec: RunSpec }).spec.git?.taskSlug)).toEqual(['c']);
    expect((await s.task(k.a)).status).toBe('ready');
    const lines = info.mock.calls.filter(([o]) => (o as { taskId?: string }).taskId === k.a);
    expect(lines).toHaveLength(1);
    expect((lines[0]![0] as { reason: string }).reason).toContain('agent daily budget');
  });

  it('project daily budget spent -> one budget_exceeded approval; approving raises the budget', async () => {
    s = await setup();
    await s.req('PUT', `/projects/${s.projectId}/settings`, { dailyBudgetUsd: 1 });
    const { w, m, planSpec } = await s.approved(2);
    await s.t.prisma.usageRecord.create({
      data: { runId: planSpec.runId, projectId: s.projectId, agentId: s.ids.chief, model: 'sonnet', inputTokens: 1, outputTokens: 1, costUsd: 1 },
    });
    await s.t.app.scheduler.tick();
    await s.t.app.scheduler.tick();
    expect(await s.t.prisma.taskRun.count({ where: { kind: 'task' } })).toBe(0);
    const approvals = await s.t.prisma.approval.findMany({ where: { missionId: m.id, type: 'budget_exceeded' } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.status).toBe('pending');
    expect((await s.req('GET', `/projects/${s.projectId}/budget`)).json()).toEqual({ spentTodayUsd: 1.5, dailyBudgetUsd: 1 });

    // changing the daily budget in settings expires the pending approval; the next tick raises a fresh one
    await s.req('PUT', `/projects/${s.projectId}/settings`, { dailyBudgetUsd: 1 });
    expect((await s.t.prisma.approval.findUniqueOrThrow({ where: { id: approvals[0]!.id } })).status).toBe('expired');
    await s.t.app.scheduler.tick();
    const fresh = await s.t.prisma.approval.findFirstOrThrow({ where: { missionId: m.id, type: 'budget_exceeded', status: 'pending' } });

    const user = await s.t.prisma.user.findFirstOrThrow();
    await approveBudget(s.t.prisma, s.t.app.hub, fresh.id, user.id);
    expect((await s.mission(m.id)).budgetUsd).toBeNull();
    expect((await s.req('GET', `/projects/${s.projectId}/budget`)).json()).toEqual({ spentTodayUsd: 1.5, dailyBudgetUsd: 2 });
    await s.assign(w);
    expect(await s.t.prisma.taskRun.count({ where: { kind: 'task' } })).toBeGreaterThan(0);
  });

  it('owner cancel of the review run keeps the mission in review and starts no new review', async () => {
    s = await setup();
    const { w, m, k } = await s.approved();
    await s.toReview(w, k, 'failed');
    const review = await s.assign(w);
    expect((await s.req('POST', `/runs/${review.runId}/cancel`)).statusCode).toBe(200);
    expect(await s.mission(m.id)).toMatchObject({ status: 'review', reviewRunId: review.runId });
    await s.t.app.scheduler.tick();
    expect(await s.t.prisma.taskRun.count({ where: { kind: 'review' } })).toBe(1);
  });

  it('a stalled mission goes to review; the Chief review run gets the review tools; a failed check is evidence_missing; structured reopen -> ready', async () => {
    s = await setup();
    const { w, m, k } = await s.approved();
    await s.toReview(w, k, 'failed');
    expect((await s.mission(m.id)).status).toBe('review');

    const review = await s.assign(w);
    expect(review).toMatchObject({ kind: 'review', agentId: s.ids.chief, readOnlyCheckout: true });
    expect(review.outputFormat).toEqual({ type: 'json_schema', schema: REVIEW_JSON_SCHEMA });
    expect(review.tools).toEqual(expect.arrayContaining(['review_task', 'get_task_evidence', 'search_memory']));
    expect(review.tools).not.toContain('send_message');
    expect(review.git?.missionBranch).toBe((await s.mission(m.id)).branch);
    expect(review.prompt).toContain(k.a);
    expect((await s.mission(m.id)).reviewRunId).toBe(review.runId);

    const evidence = await s.tool(w, review, 'get_task_evidence', { taskId: k.a });
    expect(evidence).toMatchObject({ ok: true });
    const bad = await s.tool(w, review, 'review_task', { taskId: k.a, decision: 'done', note: 'ok' });
    expect(bad).toMatchObject({ ok: false, code: 'evidence_missing' });
    expect((await s.task(k.a)).status).toBe('review');

    // the analysis stored its result as an artifact, so it may close; its dependent becomes ready
    expect(await s.tool(w, review, 'review_task', { taskId: k.c, decision: 'done', note: 'good' })).toMatchObject({ ok: true });
    expect(await s.statuses(m.id)).toMatchObject({ c: 'done', d: 'ready' });
    expect(await s.mission(m.id)).toMatchObject({ status: 'running', reviewRunId: null });

    await s.finish(w, review, {
      status: 'succeeded',
      structuredOutput: { summary: 'a needs a green check', tasks: [{ taskId: k.a, decision: 'reopen', note: 'fix the tests' }] },
    });
    expect(await s.task(k.a)).toMatchObject({ status: 'ready', reviewNote: 'fix the tests' });
    expect(await s.mission(m.id)).toMatchObject({ status: 'running', summary: 'a needs a green check' });
    expect(await s.t.prisma.artifact.count({ where: { runId: review.runId, kind: 'review' } })).toBe(1);
  });

  it('a structured done that fails the evidence rule becomes reopen; all done -> mission done', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a' || x.key === 'c');
    const { w, m, k } = await s.approved(1, plan);
    await s.toReview(w, k, 'failed');
    let review = await s.assign(w);
    await s.finish(w, review, {
      status: 'succeeded',
      structuredOutput: { summary: 'r1', tasks: [{ taskId: k.a, decision: 'done' }, { taskId: k.c, decision: 'done' }] },
    });
    expect((await s.task(k.a)).status).toBe('ready');
    expect((await s.task(k.a)).reviewNote).toContain('check');
    expect((await s.task(k.c)).status).toBe('done');
    expect((await s.mission(m.id)).status).toBe('running');

    const again = await s.assign(w);
    await s.finish(w, again, { status: 'succeeded', git: git(1), check: check('passed') });
    expect((await s.mission(m.id)).status).toBe('review');
    review = await s.assign(w);
    expect(review.kind).toBe('review');
    await s.finish(w, review, { status: 'succeeded', structuredOutput: { summary: 'all good', tasks: [{ taskId: k.a, decision: 'done' }] } });
    expect(await s.mission(m.id)).toMatchObject({ status: 'done', summary: 'all good' });
    // the verdict links to its evidence: the review run and its mission-review.md
    const view = (await s.req('GET', `/missions/${m.id}`)).json();
    const artifact = await s.t.prisma.artifact.findFirstOrThrow({ where: { runId: review.runId, name: 'mission-review.md' } });
    expect(view).toMatchObject({ status: 'done', summary: 'all good', reviewRunId: review.runId, reviewArtifactId: artifact.id, spentUsd: expect.any(Number) });
  });

  it('a mission with an undecided review task stays in review; the owner closing it finishes the mission', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a' || x.key === 'c');
    const { w, m, k } = await s.approved(1, plan);
    await s.toReview(w, k, 'passed');
    const review = await s.assign(w);
    await s.finish(w, review, { status: 'succeeded', structuredOutput: { summary: 'partial', tasks: [{ taskId: k.a, decision: 'done' }] } });
    expect((await s.task(k.a)).status).toBe('done');
    expect((await s.task(k.c)).status).toBe('review');
    expect(await s.mission(m.id)).toMatchObject({ status: 'review', reviewRunId: review.runId });
    expect((await s.req('POST', `/tasks/${k.c}/done`, {})).statusCode).toBe(200);
    expect((await s.mission(m.id)).status).toBe('done');
  });

  it.each([
    ['a failed', 'failed'],
    ['a done', 'done'],
  ] as const)('owner closing the last undecided review task settles a review mission (%s)', async (_n, aEnd) => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key !== 'b');
    plan.tasks.find((x) => x.key === 'd')!.dependsOn = [];
    const { w, m, k } = await s.approved(1, plan);
    // a, c, d are all roots; a fails twice (one retry) when it should end failed
    const runs = aEnd === 'failed' ? 4 : 3;
    for (let i = 0; i < runs; i++) {
      const r = await s.assign(w);
      const fail = aEnd === 'failed' && r.git?.taskSlug === 'a';
      const code = r.taskKind === 'code';
      await s.finish(
        w,
        r,
        fail
          ? { status: 'failed', error: 'boom' }
          : { status: 'succeeded', resultText: 'ok', git: code ? git(1) : { ...git(0), integration: 'none' }, ...(code ? { check: check('passed') } : {}) },
      );
    }
    expect((await s.task(k.a)).status).toBe(aEnd === 'failed' ? 'failed' : 'review');
    const decisions = [{ taskId: k.c, decision: 'done' as const }, ...(aEnd === 'done' ? [{ taskId: k.a, decision: 'done' as const }] : [])];
    const review = await s.assign(w);
    expect(review.kind).toBe('review');
    await s.finish(w, review, { status: 'succeeded', structuredOutput: { summary: 'partial', tasks: decisions } });
    expect((await s.task(k.d)).status).toBe('review');
    expect(await s.mission(m.id)).toMatchObject({ status: 'review', reviewRunId: review.runId });
    expect((await s.req('POST', `/tasks/${k.d}/done`, {})).statusCode).toBe(200);
    expect((await s.mission(m.id)).status).toBe(aEnd === 'failed' ? 'failed' : 'done');
  });

  it('required consultation: done needs a question to the consultant and a reply in the task conversation', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks[0]!.requiredConsultations = [{ agent: 'architect', topic: 'where the rules live' }];
    const { w, m, k } = await s.approved(1, plan);
    await s.toReview(w, k, 'passed');
    const review = await s.assign(w);
    expect(await s.tool(w, review, 'review_task', { taskId: k.a, decision: 'done' })).toMatchObject({
      ok: false, code: 'consultation_missing',
    });
    const limits = s.t.config.messageLimits;
    const { message: q } = await sendMessage(s.t.prisma, limits, {
      projectId: s.projectId, type: 'question', body: 'Where do the rules live?', senderAgentId: s.ids.developer,
      taskId: k.a, recipientAgentIds: [s.ids.architect],
    });
    expect(await s.tool(w, review, 'review_task', { taskId: k.a, decision: 'done' })).toMatchObject({ ok: false, code: 'consultation_missing' });
    await sendMessage(s.t.prisma, limits, {
      projectId: s.projectId, type: 'reply', body: 'src/mapping.ts', senderAgentId: s.ids.architect, inReplyToId: q.id, recipientAgentIds: [],
    });
    expect(await s.tool(w, review, 'review_task', { taskId: k.a, decision: 'done' })).toMatchObject({ ok: true });
    expect(await s.statuses(m.id)).toMatchObject({ a: 'done', b: 'ready' });
  });

  it('resume runs before ready tasks: a waiting run with a reply wins the only slot; the reply is acknowledged', async () => {
    s = await setup();
    const w = await s.worker();
    const mk = (agentId: string, title: string) =>
      s.req('POST', '/tasks', { projectId: s.projectId, agentId, title, description: 'd' }).then((r) => r.json().id as string);
    const devTask = await mk(s.ids.developer, 'dev work');
    const spec = await s.assign(w);
    const { message: q } = await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'question', body: 'Which db?', senderAgentId: s.ids.developer, senderSessionId: spec.sessionId,
      taskId: devTask, recipientAgentIds: [s.ids.architect], awaitReply: true,
    });
    await s.t.prisma.messageDelivery.updateMany({ where: { messageId: q.id }, data: { status: 'acknowledged' } });
    await s.t.prisma.taskRun.update({ where: { id: spec.runId }, data: { waitingForMessageId: q.id } });
    await s.finish(w, spec, { status: 'suspended', sdkSessionId: 'sdk-1' });
    const qaTask = await mk(s.ids['qa-engineer'], 'qa work');
    const { message: reply } = await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'reply', body: 'Postgres', senderAgentId: s.ids.architect, inReplyToId: q.id, recipientAgentIds: [],
    });
    const next = await s.assign(w);
    expect(next.runId).toBe(spec.runId);
    expect((await s.task(qaTask)).status).toBe('ready');
    const d = await s.t.prisma.messageDelivery.findFirstOrThrow({ where: { messageId: reply.id, recipientAgentId: s.ids.developer } });
    expect(d.status).toBe('acknowledged');
  });

  it('a resumed mission task run keeps its git spec and kind', async () => {
    s = await setup();
    const { w, k } = await s.approved();
    const spec = await s.assign(w);
    const { message: q } = await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'question', body: 'Where?', senderAgentId: s.ids.developer, senderSessionId: spec.sessionId,
      taskId: k.a, recipientAgentIds: [s.ids.architect], awaitReply: true,
    });
    await s.t.prisma.messageDelivery.updateMany({ where: { messageId: q.id }, data: { status: 'acknowledged' } });
    await s.t.prisma.taskRun.update({ where: { id: spec.runId }, data: { waitingForMessageId: q.id } });
    await s.finish(w, spec, { status: 'suspended', sdkSessionId: 'sdk-1' });
    await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'reply', body: 'here', senderAgentId: s.ids.architect, inReplyToId: q.id, recipientAgentIds: [],
    });
    const resumed = await s.assign(w);
    expect(resumed.runId).toBe(spec.runId);
    expect(resumed).toMatchObject({ taskKind: 'code', readOnlyCheckout: false, checkCommand: 'pnpm test', git: spec.git, maxBudgetUsd: 5 });
  });

  it('mission budget: spend across the mission at the cap holds its tasks and raises no approval', async () => {
    s = await setup();
    // the plan run alone costs 0.5
    const { w, m, k } = await s.approved(2, testPlan(), 0.4);
    const info = vi.spyOn((s.t.app.scheduler as unknown as { log: { info: (...a: unknown[]) => void } }).log, 'info');
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.filter((x) => x.type === 'run.assign')).toHaveLength(1);
    expect((await s.task(k.a)).status).toBe('ready');
    const line = info.mock.calls.find(([o]) => (o as { taskId?: string }).taskId === k.a);
    expect((line![0] as { reason: string }).reason).toBe('mission budget exhausted');
    expect(await s.t.prisma.approval.count({ where: { missionId: m.id } })).toBe(0);
  });

  it('an approved legacy mission-cap approval does not raise the project daily budget', async () => {
    s = await setup();
    await s.req('PUT', `/projects/${s.projectId}/settings`, { dailyBudgetUsd: 1 });
    const { m } = await s.approved(2);
    await s.t.prisma.approval.create({
      data: {
        projectId: s.projectId, missionId: m.id, type: 'budget_exceeded', status: 'approved', decidedAt: new Date(),
        reason: 'mission budget exhausted; approve to continue',
      },
    });
    expect((await s.req('GET', `/projects/${s.projectId}/budget`)).json()).toEqual({ spentTodayUsd: 0.5, dailyBudgetUsd: 1 });
  });

  it('a mission cancelled while its run is live: the failed result cancels the task and nothing is scheduled again', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a');
    const { w, m, k } = await s.approved(1, plan);
    const spec = await s.assign(w);
    // the window in cancelMission between the mission moving to cancelled and its live tasks being cancelled
    await s.t.prisma.mission.update({ where: { id: m.id }, data: { status: 'cancelled' } });
    await s.finish(w, spec, { status: 'failed', error: 'interrupted' });
    expect((await s.task(k.a)).status).toBe('cancelled');
    // a ready task of a cancelled mission is held back too
    await s.t.prisma.task.update({ where: { id: k.a }, data: { status: 'ready' } });
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(await s.t.prisma.taskRun.count({ where: { taskId: k.a } })).toBe(1);
  });

  it('a late review run does not re-apply a decision it made through review_task', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a');
    const { w, m, k } = await s.approved(2, plan);
    const first = await s.assign(w);
    await s.finish(w, first, { status: 'succeeded', git: failedGit(1), check: check('failed') });
    const review = await s.assign(w);
    expect(review.kind).toBe('review');
    expect(await s.tool(w, review, 'review_task', { taskId: k.a, decision: 'reopen', note: 'fix it' })).toMatchObject({ ok: true });
    expect(await s.mission(m.id)).toMatchObject({ status: 'running', reviewRunId: null });
    const again = await s.assign(w);
    expect(again.git?.taskSlug).toBe('a');
    await s.finish(w, again, { status: 'succeeded', git: git(1), check: check('passed') });
    expect((await s.mission(m.id)).status).toBe('review');
    await s.finish(w, review, {
      status: 'succeeded',
      structuredOutput: { summary: 'old', tasks: [{ taskId: k.a, decision: 'reopen', note: 'fix it' }] },
    });
    expect((await s.task(k.a)).status).toBe('review');
    expect((await s.mission(m.id)).status).toBe('review');
  });

  it('a failure while applying the review counts as a failed review run: one retry, then the mission fails', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a');
    const { w, m } = await s.approved(1, plan);
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: git(1), check: check('passed') });
    const review = await s.assign(w);
    const dir = s.t.config.artifactsDir;
    s.t.config.artifactsDir = '/dev/null/artifacts'; // storeArtifact fails on every call
    try {
      await s.finish(w, review, { status: 'succeeded', structuredOutput: { summary: 'x', tasks: [] } });
      expect(await s.mission(m.id)).toMatchObject({ status: 'review', reviewRunId: null });
      expect((await s.t.prisma.taskRun.findUniqueOrThrow({ where: { id: review.runId } })).error).toMatch(/^review apply failed: /);
      const next = await s.assign(w);
      expect(next.kind).toBe('review');
      expect(next.runId).not.toBe(review.runId);
      await s.finish(w, next, { status: 'succeeded', structuredOutput: { summary: 'x', tasks: [] } });
      const failed = await s.mission(m.id);
      expect(failed.status).toBe('failed');
      expect(failed.summary).toContain('review apply failed');
      await s.t.app.scheduler.tick();
      expect(await s.t.prisma.taskRun.count({ where: { kind: 'review' } })).toBe(2);
    } finally {
      s.t.config.artifactsDir = dir;
    }
  });

  it('PUT /missions/:id raises an exhausted mission cap; the next tick assigns', async () => {
    s = await setup();
    const { w, m, k, planSpec } = await s.approved(2, testPlan(), 0.01);
    await s.t.prisma.usageRecord.create({
      data: { runId: planSpec.runId, projectId: s.projectId, agentId: s.ids.chief, model: 'sonnet', inputTokens: 1, outputTokens: 1, costUsd: 0.02 },
    });
    await s.t.app.scheduler.tick();
    expect((await s.task(k.a)).status).toBe('ready');
    expect(await s.t.prisma.approval.count({ where: { missionId: m.id, type: 'budget_exceeded' } })).toBe(0);
    const res = await s.req('PUT', `/missions/${m.id}`, { budgetUsd: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json().budgetUsd).toBe(10);
    const audit = await s.t.prisma.auditLog.findFirstOrThrow({ where: { action: 'mission.updated', targetId: m.id } });
    expect(audit.detail).toEqual({ budgetUsd: { from: 0.01, to: 10 } });
    const spec = await s.assign(w);
    expect(spec.git?.taskSlug).toBe('a');
    expect((await s.req('PUT', `/missions/${m.id}`, { budgetUsd: null })).json().budgetUsd).toBeNull();
  });

  it('failed task with nothing runnable -> review -> failed; owner retry -> running, blocked dependent re-readied, final review -> done', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a' || x.key === 'b');
    const { w, m, k } = await s.approved(1, plan);
    for (let i = 0; i < 2; i++) await s.finish(w, await s.assign(w), { status: 'failed', error: 'boom' });
    expect(await s.statuses(m.id)).toEqual({ a: 'failed', b: 'blocked' });
    expect((await s.mission(m.id)).status).toBe('review');
    let review = await s.assign(w);
    expect(review.kind).toBe('review');
    await s.finish(w, review, { status: 'succeeded', structuredOutput: { summary: 'a failed', tasks: [] } });
    expect((await s.mission(m.id)).status).toBe('failed');

    expect((await s.req('POST', `/tasks/${k.a}/retry`)).statusCode).toBe(200);
    expect((await s.mission(m.id)).status).toBe('running');
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: git(1), check: check('passed') });
    expect((await s.mission(m.id)).status).toBe('review');
    review = await s.assign(w);
    expect(await s.tool(w, review, 'review_task', { taskId: k.a, decision: 'done' })).toMatchObject({ ok: true });
    expect(await s.statuses(m.id)).toEqual({ a: 'done', b: 'ready' });
    await s.finish(w, review, { status: 'succeeded', structuredOutput: { summary: 'a done', tasks: [] } });
    expect((await s.mission(m.id)).status).toBe('running');

    await s.finish(w, await s.assign(w), { status: 'succeeded', git: git(1), check: check('passed') });
    review = await s.assign(w);
    await s.finish(w, review, { status: 'succeeded', structuredOutput: { summary: 'all done', tasks: [{ taskId: k.b, decision: 'done' }] } });
    expect(await s.statuses(m.id)).toEqual({ a: 'done', b: 'done' });
    expect(await s.mission(m.id)).toMatchObject({ status: 'done', summary: 'all done' });
  });

  it('a failed review run is retried once; a second failure fails the mission', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a');
    const { w, m } = await s.approved(1, plan);
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: git(1), check: check('passed') });
    const r1 = await s.assign(w);
    await s.finish(w, r1, { status: 'failed', error: 'overloaded' });
    expect(await s.mission(m.id)).toMatchObject({ status: 'review', reviewRunId: null });
    const r2 = await s.assign(w);
    expect(r2.kind).toBe('review');
    expect(r2.runId).not.toBe(r1.runId);
    await s.finish(w, r2, { status: 'failed', error: 'overloaded' });
    expect((await s.mission(m.id)).status).toBe('failed');
  });

  it('unintegrated commits fail the code evidence rule', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a');
    const { w, k } = await s.approved(1, plan);
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: { ...git(1), integration: 'needs_integration' }, check: check('passed') });
    const review = await s.assign(w);
    expect(await s.tool(w, review, 'review_task', { taskId: k.a, decision: 'done' })).toMatchObject({
      ok: false, code: 'evidence_missing', error: 'commits not integrated',
    });
  });

  it('a failed check integrates nothing; after a reopen the fast-forwarded rerun with a passing check is done', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a');
    const { w, k } = await s.approved(1, plan);
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: failedGit(1), check: check('failed') });
    const r1 = await s.assign(w);
    expect(await s.tool(w, r1, 'review_task', { taskId: k.a, decision: 'done' })).toMatchObject({ ok: false, code: 'evidence_missing' });
    expect(await s.tool(w, r1, 'review_task', { taskId: k.a, decision: 'reopen', note: 'fix the tests' })).toMatchObject({ ok: true });
    await s.finish(w, r1, { status: 'succeeded', structuredOutput: { summary: 's', tasks: [] } });
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: git(1), check: check('passed') });
    const r2 = await s.assign(w);
    expect(r2.kind).toBe('review');
    expect(await s.tool(w, r2, 'review_task', { taskId: k.a, decision: 'done' })).toMatchObject({ ok: true, result: { status: 'done' } });
  });

  it('parallel code tasks: the later one needs integration, its fast-forwarded retry is done', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a' || x.key === 'b').map((x) => ({ ...x, dependsOn: [] }));
    const { w, k } = await s.approved(1, plan);
    const first = await s.assign(w);
    await s.finish(w, first, { status: 'succeeded', git: git(1), check: check('passed') });
    const second = await s.assign(w);
    const ks = k as Record<string, string>;
    const done = ks[first.git!.taskSlug]!;
    const later = ks[second.git!.taskSlug]!;
    expect(later).not.toBe(done);
    await s.finish(w, second, { status: 'succeeded', git: { ...git(1), integration: 'needs_integration' }, check: check('passed') });
    const r1 = await s.assign(w);
    expect(r1.kind).toBe('review');
    expect(await s.tool(w, r1, 'review_task', { taskId: done, decision: 'done' })).toMatchObject({ ok: true });
    expect(await s.tool(w, r1, 'review_task', { taskId: later, decision: 'done' })).toMatchObject({
      ok: false, code: 'evidence_missing', error: 'commits not integrated',
    });
    expect(await s.tool(w, r1, 'review_task', { taskId: later, decision: 'reopen', note: 'rebase' })).toMatchObject({ ok: true });
    await s.finish(w, r1, { status: 'succeeded', structuredOutput: { summary: 's', tasks: [] } });
    const retry = await s.assign(w);
    expect(retry.git?.taskSlug).toBe(second.git!.taskSlug);
    await s.finish(w, retry, { status: 'succeeded', git: git(1), check: check('passed') });
    const r2 = await s.assign(w);
    expect(await s.tool(w, r2, 'review_task', { taskId: later, decision: 'done' })).toMatchObject({ ok: true, result: { status: 'done' } });
  });

  it('code evidence spans runs: a rerun that changes nothing but passes the check after integrated commits is done', async () => {
    s = await setup();
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a');
    const { w, k } = await s.approved(1, plan);
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: git(1), check: check('passed') });
    const r1 = await s.assign(w);
    expect(await s.tool(w, r1, 'review_task', { taskId: k.a, decision: 'reopen', note: 'fix the tests' })).toMatchObject({ ok: true });
    await s.finish(w, r1, { status: 'succeeded', structuredOutput: { summary: 's', tasks: [] } });
    const again = await s.assign(w);
    await s.finish(w, again, { status: 'succeeded', resultText: 'x'.repeat(5000), git: { ...git(0), integration: 'none' }, check: check('passed') });
    const r2 = await s.assign(w);
    expect(r2.kind).toBe('review');
    const ev = (await s.tool(w, r2, 'get_task_evidence', { taskId: k.a })) as { ok: true; result: { runs: { resultText?: string | null }[]; rule: { ok: boolean } } };
    expect(ev.result.rule).toEqual({ ok: true });
    expect(ev.result.runs[0]!.resultText).toBeUndefined();
    expect(ev.result.runs[1]!.resultText).toHaveLength(4000);
    expect(await s.tool(w, r2, 'review_task', { taskId: k.a, decision: 'done' })).toMatchObject({ ok: true, result: { status: 'done' } });
  });

  it('a Chief reopen counts as an attempt: at maxAttempts review_task refuses reopen (logged) and accepts failed', async () => {
    s = await setup();
    await s.req('PUT', `/projects/${s.projectId}/settings`, { defaultMaxAttempts: 2 });
    const plan = testPlan();
    plan.tasks = plan.tasks.filter((x) => x.key === 'a');
    const { w, k } = await s.approved(1, plan);
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: failedGit(1), check: check('failed') });
    const r1 = await s.assign(w);
    expect(await s.tool(w, r1, 'review_task', { taskId: k.a, decision: 'reopen', note: 'again' })).toMatchObject({ ok: true });
    await s.finish(w, r1, { status: 'succeeded', structuredOutput: { summary: 's', tasks: [] } });
    await s.finish(w, await s.assign(w), { status: 'succeeded', git: failedGit(1), check: check('failed') });
    expect(await s.task(k.a)).toMatchObject({ status: 'review', attempts: 2, maxAttempts: 2 });
    const r2 = await s.assign(w);
    const warn = vi.spyOn((s.t.app.gateway as unknown as { log: { warn: (...a: unknown[]) => void } }).log, 'warn');
    expect(await s.tool(w, r2, 'review_task', { taskId: k.a, decision: 'reopen', note: 'again' })).toEqual({
      ok: false,
      code: 'max_attempts',
      error: 'task used 2 of 2 attempts and cannot be reopened; decide done or failed',
    });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ runId: r2.runId }), 'review_task reopen refused');
    expect((await s.task(k.a)).status).toBe('review');
    expect(await s.tool(w, r2, 'review_task', { taskId: k.a, decision: 'failed', note: 'out of attempts' })).toMatchObject({
      ok: true, result: { status: 'failed' },
    });
  });
});
