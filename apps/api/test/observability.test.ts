import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficeEvent } from '@office/shared';
import { loadConfig } from '../src/app.js';
import { spentToday, utcMidnight } from '../src/services/budget-service.js';
import { appendEvent } from '../src/services/event-store.js';
import { createRunForTask } from '../src/services/run-service.js';
import { recordSubagentEvent } from '../src/services/subagent-service.js';
import { makeApp } from './helpers.js';

type Spec = { runId: string; sessionId: string; agentId: string; projectId: string };

describe('observability read models', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let p: string;
  let q: string;
  let agentId: string;
  let r1: Spec;
  let r2: Spec;
  let approvalId: string;
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } });
  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  let seq = 0;
  const ev = (s: Spec, type: OfficeEvent['type'], payload: Record<string, unknown>, ts: Date): OfficeEvent => ({
    type, seq: ++seq, ts: ts.toISOString(), sessionId: s.sessionId, runId: s.runId, agentId: s.agentId, projectId: s.projectId, payload,
  });
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(utcMidnight().getTime() - 3600_000);

  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
    p = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json().id;
    q = (await req('POST', '/projects', { name: 'Q', slug: 'q', repoPath: '/tmp/office-ws/q' })).json().id;
    const workerId = (await req('POST', '/workers', { name: 'w1' })).json().id;
    agentId = (
      await req('POST', '/agents', {
        name: 'Ada', slug: 'ada', role: 'dev', config: { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'] },
      })
    ).json().id;
    const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL_TEST });
    const t1 = await t.prisma.task.create({ data: { projectId: p, agentId, title: 'Build login' } });
    await t.prisma.task.create({ data: { projectId: p, agentId, title: 'Next up' } });
    const t2 = await t.prisma.task.create({ data: { projectId: q, agentId, title: 'Other' } });
    r1 = (await createRunForTask(t.prisma, t.app.hub, t1, { workerId, local: () => true }, config)).spec;
    r2 = (await createRunForTask(t.prisma, t.app.hub, t2, { workerId, local: () => true }, config)).spec;
    await t.prisma.taskRun.update({ where: { id: r1.runId }, data: { status: 'running', startedAt: new Date(), costUsd: 2 } });
    await t.prisma.task.update({ where: { id: t1.id }, data: { status: 'running' } });
    await t.prisma.taskRun.update({
      where: { id: r2.runId },
      data: { status: 'succeeded', startedAt: new Date(Date.now() - 5000), finishedAt: new Date(), costUsd: 10, headCommit: 'abc123' },
    });

    const base = Date.now() - 60_000;
    const at = (i: number) => new Date(base + i * 1000);
    const events = [
      ev(r1, 'agent.text', { text: 'starting' }, at(0)),
      ev(r1, 'agent.command.executed', { command: 'ls' }, at(1)),
      ev(r1, 'agent.file.changed', { path: 'a.ts' }, at(2)),
      ev(r1, 'agent.file.changed', { path: 'a.ts' }, at(3)),
      ev(r1, 'agent.subagent.spawned', { toolUseId: 'tu-1', subagentType: 'helper', description: 'look' }, at(4)),
      ev(r1, 'agent.command.executed', { command: 'pnpm test', parentToolUseId: 'tu-1' }, at(5)),
      ev(r1, 'agent.file.changed', { path: 'b.ts', parentToolUseId: 'tu-1' }, at(6)),
      ev(r2, 'agent.text', { text: 'other project' }, at(7)),
    ];
    for (const e of events) {
      await appendEvent(t.prisma, e);
      await recordSubagentEvent(t.prisma, e);
    }

    const usage = (s: Spec, costUsd: number, createdAt: Date) =>
      t.prisma.usageRecord.create({
        data: { runId: s.runId, projectId: s.projectId, agentId: s.agentId, model: 'sonnet', inputTokens: 100, outputTokens: 10, costUsd, createdAt },
      });
    await usage(r1, 1.5, new Date());
    await usage(r1, 0.5, new Date());
    await usage(r1, 2, yesterday);
    await usage(r2, 10, new Date());

    approvalId = (
      await t.prisma.approval.create({
        data: { projectId: p, taskId: t1.id, runId: r1.runId, type: 'destructive_command', toolName: 'Bash', reason: 'rm -rf dist' },
      })
    ).id;
    await t.prisma.skill.create({ data: { name: 'imported', description: 'd', source: 'import' } });
  });
  afterAll(() => t.close());

  it('costs by day sum to the usage records and end with today', async () => {
    const res = await get(`/projects/${p}/costs?days=7&groupBy=day`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalUsd).toBeCloseTo(4);
    expect(body.buckets).toHaveLength(7);
    expect(body.buckets.at(-1)).toMatchObject({ key: today, costUsd: 2, inputTokens: 200, outputTokens: 20 });
    expect(body.buckets.at(-2)).toMatchObject({ key: yesterday.toISOString().slice(0, 10), costUsd: 2 });
    expect((await get(`/projects/nope/costs`)).statusCode).toBe(404);
  });

  it('costs by agent label buckets with agent names', async () => {
    const body = (await get(`/projects/${p}/costs?days=7&groupBy=agent`)).json();
    expect(body.buckets).toEqual([{ key: agentId, label: 'Ada', costUsd: 4, inputTokens: 300, outputTokens: 30 }]);
    const task = (await get(`/projects/${p}/costs?days=7&groupBy=task`)).json();
    expect(task.buckets).toEqual([expect.objectContaining({ label: 'Build login', costUsd: 4 })]);
  });

  it('overview counts running sessions, awaiting approval and cost today like the budget service', async () => {
    const body = (await get(`/projects/${p}/overview`)).json();
    expect(body).toMatchObject({
      agentsTotal: 1, agentsAvailable: 0, runningSessions: 1, maxConcurrentRuns: 2, pendingTasks: 1, awaitingApproval: 1, dailyBudgetUsd: 50,
    });
    expect(body.costTodayUsd).toBe(await spentToday(t.prisma, { projectId: p }));
    expect(body.team).toEqual([
      { agentId, name: 'Ada', role: 'dev', status: 'running', currentWork: 'Build login', workerName: 'w1', costTodayUsd: 2 },
    ]);
    expect(body.attention.map((a: { kind: string }) => a.kind).sort()).toEqual(['approval', 'skill_review']);
    expect(body.attention.find((a: { kind: string }) => a.kind === 'approval')).toMatchObject({ id: approvalId, detail: 'rm -rf dist' });
  });

  it('activity returns only this project events, newest first, with a one-line detail', async () => {
    const rows = (await get(`/projects/${p}/activity?limit=50`)).json();
    expect(rows).toHaveLength(7);
    expect(rows.every((r: { runId: string }) => r.runId === r1.runId)).toBe(true);
    expect(rows[0]).toMatchObject({ type: 'agent.file.changed', agentName: 'Ada', detail: 'changed b.ts' });
    expect(rows.at(-1)).toMatchObject({ type: 'agent.text', detail: 'starting' });
    const page = (await get(`/projects/${p}/activity?limit=2&beforeSeqId=${rows[1].id}`)).json();
    expect(page.map((r: { id: string }) => r.id)).toEqual([rows[2].id, rows[3].id]);
  });

  it('sessions lists live runs with command and file counts and nested subagents', async () => {
    const live = (await get(`/sessions?projectId=${p}&status=live`)).json();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      runId: r1.runId, sessionId: r1.sessionId, agentName: 'Ada', kind: 'task', status: 'running', taskTitle: 'Build login',
      workerName: 'w1', costUsd: 2, commands: 2, files: 2,
    });
    expect(live[0].subagents).toEqual([
      expect.objectContaining({ subagentType: 'helper', description: 'look', status: 'running', commands: 1, files: 1 }),
    ]);
    expect((await get(`/sessions?projectId=${q}&status=live`)).json()).toEqual([]);
    expect((await get(`/sessions?projectId=${q}&status=all`)).json()).toHaveLength(1);
    expect((await get(`/sessions`)).statusCode).toBe(400);
  });

  it('sessions/:runId exposes usage, skills snapshot, commands and files', async () => {
    const res = await get(`/sessions/${r1.runId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      runId: r1.runId, model: 'sonnet', agentVersion: 1, usage: { inputTokens: 300, outputTokens: 30 }, skills: [],
      approval: { id: approvalId, status: 'pending' },
    });
    expect(body.maxBudgetUsd).toBeGreaterThan(0);
    expect(body.commands.map((c: { command: string }) => c.command)).toEqual(['ls', 'pnpm test']);
    expect(body.files).toEqual([{ path: 'a.ts' }, { path: 'b.ts', bySubagent: 'tu-1' }]);
    expect(body).not.toHaveProperty('contextPack');
    expect((await get(`/sessions/nope`)).statusCode).toBe(404);
  });

  it('agents/:id/runs lists past runs with cost and head commit', async () => {
    const mission = await t.prisma.mission.create({ data: { projectId: q, title: 'M', request: 'r', status: 'running' } });
    const agent = await t.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    await t.prisma.taskRun.create({
      data: { kind: 'plan', agentId, projectId: q, missionId: mission.id, agentVersionId: agent.currentVersionId!, status: 'succeeded' },
    });
    const rows = (await get(`/agents/${agentId}/runs?limit=20`)).json();
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { runId: string }) => r.runId === r2.runId)).toEqual({
      runId: r2.runId, taskKey: null, taskTitle: 'Other', status: 'succeeded', durationMs: expect.any(Number), costUsd: 10, headCommit: 'abc123',
    });
  });

  it('sessions/:runId reports the budget stored on the run at creation', async () => {
    const r = (await req('POST', '/projects', { name: 'R', slug: 'r', repoPath: '/tmp/office-ws/r' })).json().id;
    expect((await t.app.inject({ method: 'PUT', url: `/projects/${r}/settings`, headers: { cookie }, payload: { defaultTaskBudgetUsd: 2 } })).statusCode).toBe(200);
    const big = (
      await req('POST', '/agents', {
        name: 'Big', slug: 'big', role: 'dev', config: { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'], maxBudgetUsd: 10 },
      })
    ).json().id;
    const workerId = (await t.prisma.worker.findFirstOrThrow()).id;
    const mission = await t.prisma.mission.create({ data: { projectId: r, title: 'M', request: 'r', status: 'running' } });
    const task = await t.prisma.task.create({ data: { projectId: r, agentId: big, missionId: mission.id, key: 'T1', title: 'code it', kind: 'code' } });
    const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL_TEST });
    const run = (await createRunForTask(t.prisma, t.app.hub, task, { workerId, local: () => true }, config)).spec;
    expect(run.maxBudgetUsd).toBe(2);
    expect((await get(`/sessions/${run.runId}`)).json()).toMatchObject({ maxBudgetUsd: 2, taskKey: 'T1' });
  });

  it('audit filters by action and since and pages with before', async () => {
    const at = (m: number) => new Date(Date.now() - m * 60_000);
    for (const [action, m] of [['x.done', 30], ['x.done', 20], ['x.done', 10], ['y.other', 5]] as const) {
      await t.prisma.auditLog.create({ data: { action, targetType: 'task', targetId: 't', createdAt: at(m) } });
    }
    const all = (await get(`/audit?action=x.done`)).json();
    expect(all).toHaveLength(3);
    const since = (await get(`/audit?action=x.done&since=${at(25).toISOString()}`)).json();
    expect(since).toHaveLength(2);
    const page = (await get(`/audit?action=x.done&limit=1&before=${all[0].createdAt}`)).json();
    expect(page.map((r: { id: string }) => r.id)).toEqual([all[1].id]);
  });
});
