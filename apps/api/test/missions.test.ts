import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_JSON_SCHEMA, SAMPLE_PLAN, type Plan, type RunSpec } from '@office/shared';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until, type FakeWorker } from './fake-worker.js';
import { expireLeases } from '../src/services/run-service.js';

const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0.5, numTurns: 1, durationMs: 5 };
const clone = (p: Plan): Plan => JSON.parse(JSON.stringify(p)) as Plan;

async function setup() {
  const t = await makeApp();
  const cookie = await t.login();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });
  const projectId = (await req('POST', '/projects', { name: 'Maratus', slug: 'm1', repoPath: '/tmp/office-ws/m1' })).json()
    .id as string;
  const agent = async (slug: string) =>
    (
      await req('POST', '/agents', {
        name: slug, slug, role: slug, description: `the ${slug}`,
        config: { systemPrompt: 'be nice', model: 'sonnet', allowedTools: ['Read', 'Edit', 'Write', 'Bash'] },
      })
    ).json().id as string;
  const ids: Record<string, string> = {};
  for (const slug of ['chief', 'architect', 'developer', 'qa-engineer']) ids[slug] = await agent(slug);
  const workers: FakeWorker[] = [];
  const worker = async (capacity = 1) => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w', capacity, allowedRoots: ['/tmp/office-ws'] });
    workers.push(w);
    return w;
  };
  const createMission = async () => {
    const res = await req('POST', '/missions', { projectId, request: 'Implement the new mapping rules and fix the typo' });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; status: string; title: string; conversationId: string };
  };
  const assign = async (w: FakeWorker) => {
    await t.app.scheduler.tick();
    return (await w.waitFor('run.assign')).spec;
  };
  const mission = (id: string) => t.prisma.mission.findUniqueOrThrow({ where: { id } });
  const result = (w: FakeWorker, spec: RunSpec, r: Record<string, unknown>) =>
    w.send({ type: 'run.result', runId: spec.runId, sessionId: spec.sessionId, result: { usage, ...r } });
  /** A mission whose plan run returned `plan`; resolves once the mission left `planning`. */
  const planned = async (plan: unknown = SAMPLE_PLAN) => {
    const w = await worker();
    const m = await createMission();
    const spec = await assign(w);
    result(w, spec, { status: 'succeeded', structuredOutput: plan });
    const after = await until(async () => {
      const x = await mission(m.id);
      return x.status !== 'planning' && x;
    }, 'mission left planning');
    return { w, m: after, spec };
  };
  const tasks = (missionId: string) =>
    t.prisma.task.findMany({ where: { missionId }, include: { dependencies: true }, orderBy: { createdAt: 'asc' } });
  const close = async () => {
    for (const w of workers) await w.close();
    await t.close();
  };
  return { t, req, projectId, ids, worker, createMission, assign, mission, result, planned, tasks, close };
}

describe('missions', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => s.close());

  it('POST /missions creates a planning mission with a group conversation; tick assigns a read-only plan run', async () => {
    s = await setup();
    const w = await s.worker();
    const m = await s.createMission();
    expect(m.status).toBe('planning');
    expect(m.title).toBe('Implement the new mapping rules and fix the typo');
    const conv = await s.t.prisma.conversation.findUniqueOrThrow({ where: { id: m.conversationId } });
    expect(conv).toMatchObject({ kind: 'group', includesOwner: true, title: `Mission: ${m.title}` });
    expect(conv.agentIds.sort()).toEqual(Object.values(s.ids).sort());

    const spec = await s.assign(w);
    expect(spec.kind).toBe('plan');
    expect(spec.agentId).toBe(s.ids.chief);
    expect(spec.outputFormat).toEqual({ type: 'json_schema', schema: PLAN_JSON_SCHEMA });
    expect(spec.readOnlyCheckout).toBe(true);
    expect(spec.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    expect(spec.tools.sort()).toEqual(['get_project_decisions', 'get_task_history', 'list_agents', 'read_memory', 'search_memory']);
    expect(spec.systemPrompt).toContain('You are planning a mission');
    expect(spec.prompt).toContain('Implement the new mapping rules');
    expect(spec.prompt).toContain('Maratus');
    expect(spec.prompt).toContain('architect · architect · architect · the architect');
    const run = await s.t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run).toMatchObject({ kind: 'plan', taskId: null, missionId: m.id });
    expect((await s.mission(m.id)).planRunId).toBe(spec.runId);

    // a second tick does not plan the same mission again
    await s.t.app.scheduler.tick();
    expect(await s.t.prisma.taskRun.count({ where: { kind: 'plan' } })).toBe(1);
  });

  it('POST /missions without a chief agent -> 404 no_chief', async () => {
    s = await setup();
    await s.t.prisma.agent.update({ where: { id: s.ids.chief }, data: { slug: 'boss' } });
    const res = await s.req('POST', '/missions', { projectId: s.projectId, request: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_chief');
  });

  it('a valid plan -> planned tasks with dependencies, pending approval; approve readies the roots', async () => {
    s = await setup();
    const { m, spec } = await s.planned();
    expect(m).toMatchObject({ status: 'awaiting_approval', planVersion: 1, planErrors: [] });
    const run = await s.t.prisma.taskRun.findUniqueOrThrow({ where: { id: spec.runId } });
    expect(run.structuredOutput).toEqual(SAMPLE_PLAN);

    const ts = await s.tasks(m.id);
    expect(ts.map((x) => [x.key, x.status, x.agentId])).toEqual([
      ['analysis', 'planned', s.ids.architect],
      ['mapping', 'planned', s.ids.developer],
      ['verify', 'planned', s.ids['qa-engineer']],
      ['typo-fix', 'planned', s.ids.developer],
    ]);
    const byKey = Object.fromEntries(ts.map((x) => [x.key!, x]));
    expect(byKey.mapping!.dependencies.map((d) => d.dependsOnId)).toEqual([byKey.analysis!.id]);
    expect(byKey.verify!.dependencies.map((d) => d.dependsOnId)).toEqual([byKey.mapping!.id]);
    expect(byKey.mapping!.requiredConsultations).toEqual([{ agent: 'architect', topic: 'where the mapping rules live' }]);
    expect(byKey.mapping).toMatchObject({ kind: 'code', budgetUsd: 5, requirements: ['Follow the analysis'] });

    const approvals = (await s.req('GET', `/approvals?projectId=${s.projectId}&status=pending`)).json();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ type: 'plan', missionId: m.id, reason: 'Approve the full task plan' });

    const detail = (await s.req('GET', `/missions/${m.id}`)).json();
    expect(detail.planRun).toMatchObject({ id: spec.runId, status: 'succeeded', costUsd: 0.5 });
    expect(detail.tasks.find((x: { key: string }) => x.key === 'mapping').dependencies).toEqual([byKey.analysis!.id]);
    expect(detail.tasks.find((x: { key: string }) => x.key === 'analysis').dependents).toEqual([byKey.mapping!.id]);
    expect(detail.approvals).toHaveLength(1);

    const list = (await s.req('GET', `/missions?projectId=${s.projectId}`)).json();
    expect(list[0]).toMatchObject({ id: m.id, taskCounts: { planned: 4 } });

    const res = await s.req('POST', `/approvals/${approvals[0].id}/approve`);
    expect(res.statusCode).toBe(200);
    expect((await s.mission(m.id)).status).toBe('approved');
    expect((await s.tasks(m.id)).map((x) => [x.key, x.status])).toEqual([
      ['analysis', 'ready'],
      ['mapping', 'planned'],
      ['verify', 'planned'],
      ['typo-fix', 'ready'],
    ]);
    expect(await s.t.prisma.auditLog.count({ where: { action: 'plan.approved', targetId: m.id } })).toBe(1);
    // a decided approval cannot be decided again
    expect((await s.req('POST', `/approvals/${approvals[0].id}/reject`)).statusCode).toBe(409);

    const task = (await s.req('GET', `/tasks/${byKey.mapping!.id}`)).json();
    expect(task.mission).toMatchObject({ id: m.id, status: 'approved' });
    expect(task.dependencies).toEqual([byKey.analysis!.id]);
    expect(task.dependents).toEqual([byKey.verify!.id]);
  });

  it('reject -> mission and its tasks cancelled', async () => {
    s = await setup();
    const { m } = await s.planned();
    const approval = await s.t.prisma.approval.findFirstOrThrow({ where: { missionId: m.id } });
    expect((await s.req('POST', `/approvals/${approval.id}/reject`)).statusCode).toBe(200);
    expect((await s.mission(m.id)).status).toBe('cancelled');
    expect((await s.tasks(m.id)).every((x) => x.status === 'cancelled')).toBe(true);
    expect((await s.t.prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('denied');
  });

  it('a plan with a cycle -> plan_failed with the cycle error and zero tasks', async () => {
    s = await setup();
    const plan = clone(SAMPLE_PLAN);
    plan.tasks[0]!.dependsOn = ['verify'];
    const { m } = await s.planned(plan);
    expect(m.status).toBe('plan_failed');
    expect(m.planErrors.join('\n')).toContain('dependency cycle');
    expect(await s.t.prisma.task.count({ where: { missionId: m.id } })).toBe(0);
    expect(await s.t.prisma.approval.count()).toBe(0);
  });

  it('an unknown agent slug -> plan_failed', async () => {
    s = await setup();
    const plan = clone(SAMPLE_PLAN);
    plan.tasks[3]!.agent = 'ghost';
    const { m } = await s.planned(plan);
    expect(m.status).toBe('plan_failed');
    expect(m.planErrors).toContain('task typo-fix: unknown agent ghost');
  });

  it('output that does not match the schema -> plan_failed', async () => {
    s = await setup();
    const { m } = await s.planned({ summary: 'nothing' });
    expect(m.status).toBe('plan_failed');
    expect(m.planErrors.length).toBeGreaterThan(0);
  });

  it('a restricted project rejects a plan that uses an agent outside it', async () => {
    s = await setup();
    await s.req('PUT', `/projects/${s.projectId}/agents`, { agentIds: [s.ids.developer, s.ids['qa-engineer']] });
    const { m } = await s.planned();
    expect(m.status).toBe('plan_failed');
    expect(m.planErrors).toContain('task analysis: agent architect is not allowed in this project');
  });

  it('a failed plan run -> plan_failed with its error; replan queues a new plan run with the errors and note', async () => {
    s = await setup();
    const w = await s.worker();
    const m = await s.createMission();
    const spec = await s.assign(w);
    s.result(w, spec, { status: 'failed', error: 'model overloaded' });
    await until(async () => (await s.mission(m.id)).status === 'plan_failed', 'plan_failed');
    expect((await s.mission(m.id)).planErrors).toEqual(['model overloaded']);

    const res = await s.req('POST', `/missions/${m.id}/replan`, { note: 'keep it small' });
    expect(res.statusCode).toBe(200);
    expect(await s.mission(m.id)).toMatchObject({ status: 'planning', planRunId: null });
    const next = await s.assign(w);
    expect(next.kind).toBe('plan');
    expect(next.prompt).toContain('model overloaded');
    expect(next.prompt).toContain('owner note: keep it small');
  });

  it('a plan run lost once is retried; lost twice -> plan_failed', async () => {
    s = await setup();
    const w = await s.worker(2);
    const m = await s.createMission();
    const first = await s.assign(w);
    await expireLeases(s.t.prisma, s.t.app.hub, new Date(Date.now() + 3_600_000));
    expect(await s.mission(m.id)).toMatchObject({ status: 'planning', planRunId: null });
    const second = await s.assign(w);
    expect(second.runId).not.toBe(first.runId);
    await expireLeases(s.t.prisma, s.t.app.hub, new Date(Date.now() + 3_600_000));
    expect(await s.mission(m.id)).toMatchObject({ status: 'plan_failed', planErrors: ['plan run lost twice'] });
  });

  it('PUT /missions/:id/plan replaces the tasks and bumps planVersion; locked once approved', async () => {
    s = await setup();
    const { m } = await s.planned();
    const fixed = clone(SAMPLE_PLAN);
    fixed.tasks = fixed.tasks.filter((x) => x.key !== 'typo-fix');
    const res = await s.req('PUT', `/missions/${m.id}/plan`, { plan: fixed });
    expect(res.statusCode).toBe(200);
    const after = await s.mission(m.id);
    expect(after).toMatchObject({ status: 'awaiting_approval', planVersion: 2 });
    expect((await s.tasks(m.id)).map((x) => [x.key, x.status])).toEqual([
      ['analysis', 'planned'],
      ['mapping', 'planned'],
      ['verify', 'planned'],
    ]);

    const bad = clone(SAMPLE_PLAN);
    bad.tasks[0]!.dependsOn = ['verify'];
    const invalid = await s.req('PUT', `/missions/${m.id}/plan`, { plan: bad });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('invalid_plan');

    const approval = await s.t.prisma.approval.findFirstOrThrow({ where: { missionId: m.id } });
    await s.req('POST', `/approvals/${approval.id}/approve`);
    const locked = await s.req('PUT', `/missions/${m.id}/plan`, { plan: fixed });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe('plan_locked');
  });

  it("approvalPolicy.plan 'auto' -> approved immediately, roots ready, no approval row", async () => {
    s = await setup();
    await s.req('PUT', `/projects/${s.projectId}/settings`, { approvalPolicy: { plan: 'auto' } });
    const { m } = await s.planned();
    expect(m.status).toBe('approved');
    expect(await s.t.prisma.approval.count()).toBe(0);
    expect((await s.tasks(m.id)).filter((x) => x.status === 'ready').map((x) => x.key)).toEqual(['analysis', 'typo-fix']);
  });

  it('POST /missions/:id/cancel cancels the mission and its tasks', async () => {
    s = await setup();
    const { m } = await s.planned();
    const res = await s.req('POST', `/missions/${m.id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect((await s.mission(m.id)).status).toBe('cancelled');
    expect((await s.tasks(m.id)).every((x) => x.status === 'cancelled')).toBe(true);
  });
});
