import type { Prisma } from '@office/db';
import { summarizeEvent, type OfficeEvent } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import { dailyLimit, runningCount, spentToday, utcMidnight } from './budget-service.js';
import { getSettings, projectAgents } from './project-service.js';
import type { Db } from './task-service.js';

const DAY = 86_400_000;
const LIVE_SESSION = ['running', 'waiting_reply', 'waiting_approval'] as const;
const PENDING_TASK = ['ready', 'queued', 'blocked'] as const;
const COMMAND = 'agent.command.executed';
const FILE = 'agent.file.changed';

export type CostGroup = 'day' | 'agent' | 'mission' | 'task';
type Bucket = { key: string; label: string; costUsd: number; inputTokens: number; outputTokens: number };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const payload = (e: { payload: Prisma.JsonValue }) => (e.payload ?? {}) as Record<string, unknown>;

/** UsageRecord cost of the last `days` UTC days (today included, partial), grouped. */
export async function projectCosts(db: Db, projectId: string, days: number, groupBy: CostGroup) {
  await getSettings(db, projectId); // 404 for an unknown project
  const since = new Date(utcMidnight().getTime() - (days - 1) * DAY);
  // shortcut: aggregates in memory, fine for a single owner's volume; move to SQL GROUP BY if usage grows large
  const rows = await db.usageRecord.findMany({
    where: { projectId, createdAt: { gte: since } },
    select: {
      costUsd: true, inputTokens: true, outputTokens: true, createdAt: true,
      agent: { select: { id: true, name: true } },
      run: { select: { mission: { select: { id: true, title: true } }, task: { select: { id: true, title: true } } } },
    },
  });
  const buckets = new Map<string, Bucket>();
  if (groupBy === 'day') {
    for (let i = 0; i < days; i++) {
      const key = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
      buckets.set(key, { key, label: key, costUsd: 0, inputTokens: 0, outputTokens: 0 });
    }
  }
  let totalUsd = 0;
  for (const r of rows) {
    const [key, label] =
      groupBy === 'day' ? [r.createdAt.toISOString().slice(0, 10), r.createdAt.toISOString().slice(0, 10)]
      : groupBy === 'agent' ? [r.agent.id, r.agent.name]
      : groupBy === 'mission' ? [r.run.mission?.id ?? 'none', r.run.mission?.title ?? 'No mission']
      : [r.run.task?.id ?? 'none', r.run.task?.title ?? 'No task'];
    const b = buckets.get(key) ?? { key, label, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    b.costUsd += r.costUsd;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    buckets.set(key, b);
    totalUsd += r.costUsd;
  }
  const list = [...buckets.values()];
  return { totalUsd, buckets: groupBy === 'day' ? list : list.sort((a, b) => b.costUsd - a.costUsd) };
}

export async function projectOverview(db: Db, projectId: string) {
  const settings = await getSettings(db, projectId);
  let agents = (await projectAgents(db, projectId)).filter((a) => a.isActive && !a.isSystem);
  // no ProjectAgent rows: every active agent may work here (agentAllowed)
  if (agents.length === 0) agents = await db.agent.findMany({ where: { isActive: true, isSystem: false }, orderBy: { name: 'asc' } });
  const [live, spent, runningSessions, pendingTasks, approvals, skills, costTodayUsd, dailyBudgetUsd] = await Promise.all([
    db.taskRun.findMany({
      where: { projectId, status: { in: ['queued', ...LIVE_SESSION] } },
      orderBy: { createdAt: 'asc' },
      select: { agentId: true, kind: true, status: true, task: { select: { title: true } }, worker: { select: { name: true } } },
    }),
    db.usageRecord.groupBy({ by: ['agentId'], where: { projectId, createdAt: { gte: utcMidnight() } }, _sum: { costUsd: true } }),
    runningCount(db, { projectId }),
    db.task.count({ where: { projectId, status: { in: [...PENDING_TASK] } } }),
    db.approval.findMany({ where: { projectId, status: 'pending' }, orderBy: { createdAt: 'desc' } }),
    db.skill.findMany({ where: { status: 'pending_review' }, orderBy: { createdAt: 'desc' } }),
    spentToday(db, { projectId }),
    dailyLimit(db, settings, projectId),
  ]);
  const team = agents.map((a) => {
    const runs = live.filter((r) => r.agentId === a.id);
    const current = runs.find((r) => r.status === 'waiting_approval') ?? runs[0];
    return {
      agentId: a.id,
      name: a.name,
      role: a.role,
      status: !current ? 'idle' : current.status === 'waiting_approval' ? 'needs_approval' : 'running',
      currentWork: current ? (current.task?.title ?? current.kind) : null,
      workerName: current?.worker?.name ?? null,
      costTodayUsd: spent.find((s) => s.agentId === a.id)?._sum.costUsd ?? 0,
    };
  });
  const attention = [
    ...approvals.map((a) => ({
      kind: 'approval' as const, id: a.id, title: a.toolName ? `${a.type}: ${a.toolName}` : a.type, detail: a.reason, createdAt: a.createdAt,
    })),
    // skills are global; a pending review needs the owner whatever project they are looking at
    ...skills.map((s) => ({ kind: 'skill_review' as const, id: s.id, title: s.name, detail: s.description, createdAt: s.createdAt })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return {
    agentsAvailable: team.filter((m) => m.status === 'idle').length,
    agentsTotal: team.length,
    runningSessions,
    maxConcurrentRuns: settings.maxConcurrentRuns,
    pendingTasks,
    awaitingApproval: approvals.length,
    costTodayUsd,
    dailyBudgetUsd,
    team,
    attention,
  };
}

/** Latest stored events of the project's runs, newest first; `beforeSeqId` is the id of the last row of the previous page. */
export async function projectActivity(db: Db, projectId: string, limit: number, beforeSeqId?: string) {
  await getSettings(db, projectId);
  const rows = await db.sessionEvent.findMany({
    where: { session: { projectId } },
    orderBy: [{ ts: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(beforeSeqId && { cursor: { id: beforeSeqId }, skip: 1 }),
    include: {
      session: { select: { runId: true, agentId: true, agent: { select: { name: true } }, run: { select: { task: { select: { key: true } } } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    // matches the live `project:` event, so the UI can merge stored and live rows
    key: `${r.sessionId}:${r.seq}`,
    ts: r.ts,
    type: r.type,
    agentId: r.session.agentId,
    agentName: r.session.agent.name,
    runId: r.session.runId,
    taskKey: r.session.run.task?.key ?? null,
    detail: summarizeEvent({
      type: r.type as OfficeEvent['type'], seq: r.seq, ts: r.ts.toISOString(), sessionId: r.sessionId,
      runId: r.session.runId, agentId: r.session.agentId, projectId, payload: payload(r),
    }),
  }));
}

const runInclude = {
  session: { include: { subagentRuns: { orderBy: { startedAt: 'asc' } } } },
  agent: { select: { name: true } },
  task: { select: { key: true, title: true } },
  worker: { select: { name: true } },
} satisfies Prisma.TaskRunInclude;
type RunRow = Prisma.TaskRunGetPayload<{ include: typeof runInclude }>;
type EventRow = { sessionId: string; seq: number; ts: Date; type: string; payload: Prisma.JsonValue };

const activityEvents = (db: Db, sessionIds: string[]): Promise<EventRow[]> =>
  db.sessionEvent.findMany({
    where: { sessionId: { in: sessionIds }, type: { in: [COMMAND, FILE] } },
    orderBy: { seq: 'asc' },
    select: { sessionId: true, seq: true, ts: true, type: true, payload: true },
  });

// events from inside a subagent carry its tool-use id as parentToolUseId (stamped by the Claude adapter)
function counts(events: EventRow[], parent?: string) {
  const mine = parent === undefined ? events : events.filter((e) => payload(e).parentToolUseId === parent);
  const paths = new Set(mine.filter((e) => e.type === FILE).map((e) => str(payload(e).path)).filter(Boolean));
  return { commands: mine.filter((e) => e.type === COMMAND).length, files: paths.size };
}

function sessionItem(run: RunRow, all: EventRow[]) {
  const events = run.session ? all.filter((e) => e.sessionId === run.session!.id) : [];
  return {
    runId: run.id,
    sessionId: run.session?.id ?? null,
    agentId: run.agentId,
    agentName: run.agent.name,
    kind: run.kind,
    status: run.status,
    taskId: run.taskId,
    taskKey: run.task?.key ?? null,
    taskTitle: run.task?.title ?? null,
    workerName: run.worker?.name ?? null,
    startedAt: run.startedAt ?? run.session?.startedAt ?? null,
    costUsd: run.costUsd,
    ...counts(events),
    subagents: (run.session?.subagentRuns ?? []).map((s) => ({
      id: s.id, toolUseId: s.toolUseId, subagentType: s.subagentType, description: s.description, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt,
      ...counts(events, s.toolUseId),
    })),
  };
}

export async function listSessions(db: Db, projectId: string, status: 'live' | 'all') {
  await getSettings(db, projectId);
  const runs = await db.taskRun.findMany({
    where: { projectId, session: { isNot: null }, ...(status === 'live' && { status: { in: [...LIVE_SESSION] } }) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: runInclude,
  });
  // shortcut: loads every command/file event of up to 100 sessions to count them; move counts to SQL if status=all gets slow
  const events = await activityEvents(db, runs.map((r) => r.session!.id));
  return runs.map((r) => sessionItem(r, events));
}

export async function sessionDetail(db: Db, runId: string) {
  const run = await db.taskRun.findUnique({ where: { id: runId }, include: { ...runInclude, agentVersion: { select: { version: true } } } });
  if (!run) throw new HttpError(404, 'not_found');
  const [events, usage, approval] = await Promise.all([
    run.session ? activityEvents(db, [run.session.id]) : Promise.resolve([]),
    db.usageRecord.aggregate({ where: { runId }, _sum: { inputTokens: true, outputTokens: true } }),
    db.approval.findFirst({ where: { runId, status: 'pending' }, orderBy: { createdAt: 'desc' } }),
  ]);
  const files = new Map<string, { path: string; adds?: number; dels?: number; bySubagent?: string }>();
  for (const e of events.filter((e) => e.type === FILE)) {
    const p = payload(e);
    const path = str(p.path);
    if (!path) continue;
    const f = files.get(path) ?? { path };
    if (num(p.adds) !== undefined) f.adds = (f.adds ?? 0) + num(p.adds)!;
    if (num(p.dels) !== undefined) f.dels = (f.dels ?? 0) + num(p.dels)!;
    const parent = str(p.parentToolUseId);
    if (parent && !f.bySubagent) f.bySubagent = parent;
    files.set(path, f);
  }
  return {
    ...sessionItem(run, events),
    projectId: run.projectId,
    finishedAt: run.finishedAt,
    model: run.session?.model ?? null,
    agentVersion: run.agentVersion.version,
    // runs created before phase 6 did not store their budget
    maxBudgetUsd: run.maxBudgetUsd,
    usage: { inputTokens: usage._sum.inputTokens ?? 0, outputTokens: usage._sum.outputTokens ?? 0 },
    commands: events
      .filter((e) => e.type === COMMAND)
      .map((e) => {
        const p = payload(e);
        return { seq: e.seq, ts: e.ts, command: str(p.command) ?? null, exitCode: num(p.exitCode), durationMs: num(p.durationMs), bySubagent: str(p.parentToolUseId) };
      }),
    files: [...files.values()],
    skills: run.session?.skillsSnapshot ?? [],
    approval,
  };
}

/** An agent's task runs (mission tasks included) across projects, newest first; plan, review, inbox and chat runs are left out. */
export async function agentRuns(db: Db, agentId: string, limit: number) {
  if (!(await db.agent.findUnique({ where: { id: agentId }, select: { id: true } }))) throw new HttpError(404, 'not_found');
  const runs = await db.taskRun.findMany({
    where: { agentId, kind: 'task' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { task: { select: { key: true, title: true } } },
  });
  return runs.map((r) => ({
    runId: r.id,
    taskKey: r.task?.key ?? null,
    taskTitle: r.task?.title ?? null,
    status: r.status,
    durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    costUsd: r.costUsd,
    headCommit: r.headCommit,
  }));
}
