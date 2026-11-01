import type { Agent, Approval, Mission, Prisma, PrismaClient, Project, Task, TaskRun } from '@office/db';
import {
  PLAN_JSON_SCHEMA,
  PlanSchema,
  REVIEW_JSON_SCHEMA,
  ReviewDecisionSchema,
  validatePlan,
  type TaskStatus,
  type MissionStatus,
  type Plan,
  type ProjectSettings,
} from '@office/shared';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { audit } from './audit-service.js';
import { storeArtifact } from './artifact-store.js';
import { closeTask, evidenceFor, evidenceRule } from './review-service.js';
import type { EventHub, Outbox } from './event-hub.js';
import { findOrCreateConversation } from './message-service.js';
import { agentAllowed, getSettings } from './project-service.js';
import { createRun } from './run-service.js';
import { cancelLiveRuns, cancelTask, notifyCancelled, setTaskStatus, type Db } from './task-service.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';

const CHIEF_SLUG = 'chief';
const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

export function queueMissionStatus(outbox: Outbox, mission: Mission) {
  const message = {
    type: 'mission.status.changed' as const,
    mission: { id: mission.id, status: mission.status, updatedAt: mission.updatedAt.toISOString() },
  };
  outbox.push({ topic: `mission:${mission.id}`, message }, { topic: 'global', message });
}

export function queueApproval(outbox: Outbox, a: Approval) {
  const message = {
    type: 'approval.changed' as const,
    approval: {
      id: a.id,
      projectId: a.projectId,
      missionId: a.missionId,
      taskId: a.taskId,
      runId: a.runId,
      type: a.type,
      status: a.status,
      scope: a.scope,
      toolName: a.toolName,
      input: a.input,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
      decidedAt: a.decidedAt?.toISOString() ?? null,
      expiresAt: a.expiresAt?.toISOString() ?? null,
    },
  };
  if (a.missionId) outbox.push({ topic: `mission:${a.missionId}`, message });
  outbox.push({ topic: 'global', message });
}

/** Guarded mission status move: null when the mission was not in one of `from`. */
export async function moveMission(
  db: Db,
  outbox: Outbox,
  id: string,
  from: MissionStatus[],
  data: Prisma.MissionUpdateManyMutationInput & { status: MissionStatus },
) {
  const { count } = await db.mission.updateMany({ where: { id, status: { in: from } }, data });
  if (count === 0) return null;
  const mission = await db.mission.findUniqueOrThrow({ where: { id } });
  queueMissionStatus(outbox, mission);
  return mission;
}

/** Active non-system agents allowed in the project. */
async function teamOf(db: Db, projectId: string): Promise<Agent[]> {
  const agents = await db.agent.findMany({ where: { isActive: true, isSystem: false }, orderBy: { name: 'asc' } });
  const allowed = await Promise.all(agents.map((a) => agentAllowed(db, projectId, a.id)));
  return agents.filter((_, i) => allowed[i]);
}

async function validate(db: Db, projectId: string, plan: Plan) {
  const agents = await db.agent.findMany();
  const roster = await Promise.all(
    agents.map(async (a) => ({
      slug: a.slug,
      active: a.isActive,
      system: a.isSystem,
      allowed: await agentAllowed(db, projectId, a.id),
    })),
  );
  return validatePlan(plan, roster);
}

export async function createMission(
  prisma: PrismaClient,
  hub: EventHub,
  input: { projectId: string; request: string; title?: string; budgetUsd?: number },
) {
  await getSettings(prisma, input.projectId); // 404 when the project is missing
  const chief = await prisma.agent.findFirst({ where: { slug: CHIEF_SLUG, isActive: true } });
  if (!chief) throw new HttpError(404, 'no_chief');
  const title = input.title ?? input.request.slice(0, 80);
  const outbox: Outbox = [];
  const mission = await prisma.$transaction(async (tx) => {
    const team = await teamOf(tx, input.projectId);
    const conversation = await findOrCreateConversation(tx, {
      projectId: input.projectId,
      kind: 'group',
      agentIds: team.map((a) => a.id),
      includesOwner: true,
      title: `Mission: ${title}`,
    });
    return tx.mission.create({
      data: {
        projectId: input.projectId,
        title,
        request: input.request,
        budgetUsd: input.budgetUsd,
        status: 'planning',
        conversationId: conversation.id,
      },
    });
  });
  queueMissionStatus(outbox, mission);
  hub.publishAll(outbox);
  return mission;
}

export function planPrompt(mission: Mission & { project: Project }, roster: Agent[], settings: ProjectSettings) {
  return [
    `Plan this mission for the project ${mission.project.name}.`,
    `Request:\n${mission.request}`,
    `Team (slug · name · role · description):\n${roster
      .map((a) => `- ${a.slug} · ${a.name} · ${a.role} · ${a.description ?? ''}`)
      .join('\n')}`,
    [
      'Rules:',
      '- Split the work into small, verifiable tasks.',
      '- Give every task a `kind`: code, analysis or review.',
      '- Assign every task to one agent by slug from the team above.',
      '- Express order with `dependsOn` (task keys). Run tasks in parallel only when they touch disjoint areas.',
      '- Every task needs requirements and acceptance criteria.',
      "- Add `requiredConsultations` when a task depends on another agent's knowledge.",
      '- Use `approvalPoints` only for push, merge or deploy.',
      `- A task without \`budgetUsd\` gets ${settings.defaultTaskBudgetUsd} USD.`,
    ].join('\n'),
    mission.planErrors.length ? `Problems with the previous plan attempt:\n${mission.planErrors.map((e) => `- ${e}`).join('\n')}` : '',
    'Answer only with the plan JSON.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Creates the plan run for a `planning` mission without one; the scheduler assigns the returned spec. */
export async function startPlanRun(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  mission: Mission & { project: Project },
  worker: { workerId: string },
) {
  const chief = await prisma.agent.findFirst({ where: { slug: CHIEF_SLUG, isActive: true } });
  if (!chief) throw new Error('no active chief agent');
  const [roster, settings] = await Promise.all([teamOf(prisma, mission.projectId), getSettings(prisma, mission.projectId)]);
  const created = await createRun(prisma, hub, config, {
    kind: 'plan',
    agentId: chief.id,
    projectId: mission.projectId,
    missionId: mission.id,
    prompt: planPrompt(mission, roster, settings),
    readOnlyCheckout: true,
    outputFormat: { type: 'json_schema', schema: PLAN_JSON_SCHEMA },
    allowedToolsOverride: PLAN_TOOLS,
    worker,
  });
  await prisma.mission.update({ where: { id: mission.id }, data: { planRunId: created.run.id } });
  return created;
}

/** The mission's current plan run, if `run` is it and the mission still waits for it. */
async function planningMission(db: Db, run: TaskRun) {
  if (!run.missionId) return null;
  const mission = await db.mission.findUnique({ where: { id: run.missionId } });
  return mission?.status === 'planning' && mission.planRunId === run.id ? mission : null;
}

export async function planRunFailed(db: Db, outbox: Outbox, run: TaskRun, errors: string[]) {
  const mission = await planningMission(db, run);
  if (mission) await moveMission(db, outbox, mission.id, ['planning'], { status: 'plan_failed', planErrors: errors });
}

/** A lost plan run is retried once (planRunId cleared); the second loss fails the plan. */
export async function onPlanRunLost(db: Db, outbox: Outbox, run: TaskRun) {
  const mission = await planningMission(db, run);
  if (!mission) return;
  // shortcut: counts every lost plan run of the mission, also those before a replan; track per attempt if that matters
  const lost = await db.taskRun.count({ where: { missionId: mission.id, kind: 'plan', status: 'lost' } });
  if (lost >= 2) await planRunFailed(db, outbox, run, ['plan run lost twice']);
  else await db.mission.update({ where: { id: mission.id }, data: { planRunId: null } });
}

async function createPlanTasks(db: Db, mission: Mission, plan: Plan, settings: ProjectSettings) {
  const agents = await db.agent.findMany({ where: { slug: { in: plan.tasks.map((t) => t.agent) } } });
  const agentIds = new Map(agents.map((a) => [a.slug, a.id]));
  const ids = new Map<string, string>();
  for (const t of plan.tasks) {
    const task = await db.task.create({
      data: {
        projectId: mission.projectId,
        missionId: mission.id,
        agentId: agentIds.get(t.agent)!,
        key: t.key,
        title: t.title,
        description: t.description,
        kind: t.kind,
        status: 'planned',
        requirements: t.requirements,
        acceptanceCriteria: t.acceptanceCriteria,
        parallelGroup: t.parallelGroup,
        requiredConsultations: t.requiredConsultations,
        budgetUsd: t.budgetUsd ?? settings.defaultTaskBudgetUsd,
      },
    });
    ids.set(t.key, task.id);
  }
  await db.taskDependency.createMany({
    data: plan.tasks.flatMap((t) =>
      [...new Set(t.dependsOn)].map((d) => ({ taskId: ids.get(t.key)!, dependsOnId: ids.get(d)! })),
    ),
  });
}

/** Deletes the mission's `planned` tasks and their dependency rows. */
async function deletePlannedTasks(db: Db, missionId: string) {
  const ids = (await db.task.findMany({ where: { missionId, status: 'planned' }, select: { id: true } })).map((t) => t.id);
  await db.taskDependency.deleteMany({ where: { OR: [{ taskId: { in: ids } }, { dependsOnId: { in: ids } }] } });
  await db.task.deleteMany({ where: { id: { in: ids } } });
}

/** awaiting_approval -> approved; every planned task without dependencies becomes ready. */
async function approveMissionPlan(db: Db, outbox: Outbox, missionId: string) {
  const mission = await moveMission(db, outbox, missionId, ['awaiting_approval'], { status: 'approved' });
  if (!mission) throw new HttpError(409, 'invalid_transition');
  const roots = await db.task.findMany({ where: { missionId, status: 'planned', dependencies: { none: {} } } });
  for (const t of roots) await setTaskStatus(db, outbox, t.id, 'ready');
  return mission;
}

export async function onPlanRunFinished(prisma: PrismaClient, hub: EventHub, run: TaskRun) {
  const outbox: Outbox = [];
  try {
    await prisma.$transaction(async (tx) => {
      const mission = await planningMission(tx, run);
      if (!mission) return;
      const parsed = PlanSchema.safeParse(run.structuredOutput);
      if (!parsed.success) {
        const errors =
          run.structuredOutput == null
            ? ['plan run returned no structured output']
            : parsed.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`);
        return planRunFailed(tx, outbox, run, errors);
      }
      const plan = parsed.data;
      const result = await validate(tx, mission.projectId, plan);
      if (!result.ok) return planRunFailed(tx, outbox, run, result.errors);
      const settings = await getSettings(tx, mission.projectId);
      const moved = await moveMission(tx, outbox, mission.id, ['planning'], {
        status: 'awaiting_approval',
        plan,
        planVersion: { increment: 1 },
        planErrors: [],
      });
      // cancelled (or replanned) concurrently: write nothing under it
      if (!moved) return;
      await createPlanTasks(tx, mission, plan, settings);
      if (settings.approvalPolicy.plan === 'auto') {
        await approveMissionPlan(tx, outbox, mission.id);
        await audit(tx, { action: 'plan.approved', targetType: 'mission', targetId: mission.id, detail: { auto: true } });
      } else {
        const approval = await tx.approval.create({
          data: {
            projectId: mission.projectId,
            missionId: mission.id,
            type: 'plan',
            status: 'pending',
            reason: 'Approve the full task plan',
          },
        });
        queueApproval(outbox, approval);
      }
    });
  } catch (err) {
    // the run already succeeded; a plan that cannot be applied fails the mission instead of the worker message
    outbox.length = 0;
    await prisma.$transaction((tx) =>
      planRunFailed(tx, outbox, run, [`plan could not be applied: ${(err as Error).message}`]),
    );
  }
  hub.publishAll(outbox);
}

async function pendingPlanApproval(db: Db, approvalId: string) {
  const approval = await db.approval.findUnique({ where: { id: approvalId } });
  if (!approval) throw new HttpError(404, 'not_found');
  if (approval.type !== 'plan') throw new HttpError(409, 'unsupported_approval_type');
  if (approval.status !== 'pending' || !approval.missionId) throw new HttpError(409, 'approval_decided');
  return approval as Approval & { missionId: string };
}

async function decide(db: Db, outbox: Outbox, approvalId: string, status: 'approved' | 'denied', userId: string) {
  const { count } = await db.approval.updateMany({
    where: { id: approvalId, status: 'pending' },
    data: { status, decidedAt: new Date(), decidedByUserId: userId },
  });
  if (count === 0) throw new HttpError(409, 'approval_decided');
  queueApproval(outbox, await db.approval.findUniqueOrThrow({ where: { id: approvalId } }));
}

export async function approvePlan(prisma: PrismaClient, hub: EventHub, approvalId: string, userId: string) {
  const outbox: Outbox = [];
  const mission = await prisma.$transaction(async (tx) => {
    const approval = await pendingPlanApproval(tx, approvalId);
    await decide(tx, outbox, approvalId, 'approved', userId);
    const mission = await approveMissionPlan(tx, outbox, approval.missionId);
    await audit(tx, { userId, action: 'plan.approved', targetType: 'mission', targetId: mission.id, detail: { approvalId } });
    return mission;
  });
  hub.publishAll(outbox);
  return mission;
}

export async function rejectPlan(prisma: PrismaClient, hub: EventHub, approvalId: string, userId: string) {
  const outbox: Outbox = [];
  const mission = await prisma.$transaction(async (tx) => {
    const approval = await pendingPlanApproval(tx, approvalId);
    await decide(tx, outbox, approvalId, 'denied', userId);
    const mission = await moveMission(tx, outbox, approval.missionId, ['awaiting_approval'], { status: 'cancelled' });
    if (!mission) throw new HttpError(409, 'invalid_transition');
    const tasks = await tx.task.findMany({ where: { missionId: mission.id, status: 'planned' } });
    for (const t of tasks) await setTaskStatus(tx, outbox, t.id, 'cancelled');
    await audit(tx, { userId, action: 'plan.rejected', targetType: 'mission', targetId: mission.id, detail: { approvalId } });
    return mission;
  });
  hub.publishAll(outbox);
  return mission;
}

export async function editPlan(prisma: PrismaClient, hub: EventHub, missionId: string, plan: Plan, userId: string) {
  const outbox: Outbox = [];
  const mission = await prisma.$transaction(async (tx) => {
    const current = await tx.mission.findUnique({ where: { id: missionId } });
    if (!current) throw new HttpError(404, 'not_found');
    if (current.status !== 'awaiting_approval') throw new HttpError(409, 'plan_locked');
    const result = await validate(tx, current.projectId, plan);
    if (!result.ok) throw new HttpError(400, 'invalid_plan', result.errors.join('; '));
    // guarded so an approval or replan that committed after the read wins
    const { count } = await tx.mission.updateMany({
      where: { id: missionId, status: 'awaiting_approval' },
      data: { plan, planVersion: { increment: 1 } },
    });
    if (count === 0) throw new HttpError(409, 'plan_locked');
    await deletePlannedTasks(tx, missionId);
    await createPlanTasks(tx, current, plan, await getSettings(tx, current.projectId));
    const mission = await tx.mission.findUniqueOrThrow({ where: { id: missionId } });
    queueMissionStatus(outbox, mission);
    await audit(tx, { userId, action: 'plan.edited', targetType: 'mission', targetId: missionId, detail: { planVersion: mission.planVersion } });
    return mission;
  });
  hub.publishAll(outbox);
  return mission;
}

/** plan_failed or awaiting_approval -> planning: the scheduler starts a new plan run with the errors and note. */
export async function replan(prisma: PrismaClient, hub: EventHub, missionId: string, note: string | undefined, userId: string) {
  const outbox: Outbox = [];
  const mission = await prisma.$transaction(async (tx) => {
    const current = await tx.mission.findUnique({ where: { id: missionId } });
    if (!current) throw new HttpError(404, 'not_found');
    await deletePlannedTasks(tx, missionId);
    await tx.approval.deleteMany({ where: { missionId, type: 'plan', status: 'pending' } });
    const mission = await moveMission(tx, outbox, missionId, ['plan_failed', 'awaiting_approval'], {
      status: 'planning',
      planRunId: null,
      planErrors: note ? [...current.planErrors, `owner note: ${note}`] : current.planErrors,
    });
    if (!mission) throw new HttpError(409, 'invalid_transition');
    await audit(tx, { userId, action: 'plan.replan', targetType: 'mission', targetId: missionId, detail: { note: note ?? null } });
    return mission;
  });
  hub.publishAll(outbox);
  return mission;
}

const CANCELLABLE: MissionStatus[] = ['planning', 'plan_failed', 'awaiting_approval', 'approved', 'running', 'review'];
const IDLE_TASK = ['planned', 'ready', 'blocked'] as const;
const LIVE_TASK = ['queued', 'running', 'waiting_reply', 'waiting_approval'] as const;

/**
 * Open mission -> cancelled; idempotent on an already cancelled mission (the task sweep runs again).
 * In one transaction: pending approvals expire, a live plan run and every idle task are cancelled.
 * After commit, tasks with a live run go through cancelTask one by one; a failure is logged and skipped.
 */
export async function cancelMission(
  prisma: PrismaClient,
  hub: EventHub,
  gateway: WorkerGateway,
  missionId: string,
  userId: string,
  log: { error: (obj: object, msg: string) => void },
) {
  const outbox: Outbox = [];
  const { mission, planRuns } = await prisma.$transaction(async (tx) => {
    const current = await tx.mission.findUnique({ where: { id: missionId } });
    if (!current) throw new HttpError(404, 'not_found');
    let mission = current;
    if (current.status !== 'cancelled') {
      const moved = await moveMission(tx, outbox, missionId, CANCELLABLE, { status: 'cancelled' });
      if (!moved) throw new HttpError(409, 'invalid_transition');
      mission = moved;
      await audit(tx, { userId, action: 'mission.cancelled', targetType: 'mission', targetId: missionId });
    }
    const pending = await tx.approval.findMany({ where: { missionId, status: 'pending' } });
    for (const a of pending) {
      queueApproval(outbox, await tx.approval.update({ where: { id: a.id }, data: { status: 'expired', decidedAt: new Date() } }));
    }
    const planRuns = await cancelLiveRuns(tx, outbox, { missionId, kind: { in: ['plan', 'review'] } });
    const idle = await tx.task.findMany({ where: { missionId, status: { in: [...IDLE_TASK] } } });
    for (const t of idle) await setTaskStatus(tx, outbox, t.id, 'cancelled');
    return { mission, planRuns };
  });
  hub.publishAll(outbox);
  notifyCancelled(gateway, planRuns);
  const live = await prisma.task.findMany({ where: { missionId, status: { in: [...LIVE_TASK] } } });
  for (const t of live) {
    try {
      await cancelTask(prisma, hub, gateway, t.id);
    } catch (err) {
      log.error({ err, taskId: t.id, missionId }, 'cancelling mission task failed');
    }
  }
  return mission;
}

// ---- mission flow: dependencies, mission status, Chief review ----

// tasks that can still make progress without a review decision
const RUNNABLE_TASK: TaskStatus[] = ['ready', 'queued', 'running', 'waiting_reply', 'waiting_approval'];
const DEPENDENT_BLOCKERS: TaskStatus[] = ['failed', 'cancelled', 'blocked'];

export function missionBranch(mission: Pick<Mission, 'id' | 'title' | 'branch'>) {
  if (mission.branch) return mission.branch;
  const slug = mission.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `office/${slug || 'mission'}-${mission.id.slice(0, 6)}`;
}

/**
 * Called by setTaskStatus for every mission task: readies or blocks dependents, then moves the mission.
 * A mission with nothing runnable goes to `review` (the scheduler starts the Chief's review run);
 * a task becoming runnable again moves it back to `running`.
 */
export async function onTaskStatusChanged(db: Db, outbox: Outbox, task: Task) {
  if (!task.missionId) return;
  if (task.status === 'done' || DEPENDENT_BLOCKERS.includes(task.status)) {
    const dependents = await db.task.findMany({
      where: { dependencies: { some: { dependsOnId: task.id } }, status: { in: ['planned', 'blocked'] } },
      include: { dependencies: { include: { dependsOn: { select: { status: true } } } } },
    });
    for (const d of dependents) {
      if (task.status === 'done') {
        if (d.dependencies.every((x) => x.dependsOn.status === 'done')) await setTaskStatus(db, outbox, d.id, 'ready');
      } else if (d.status === 'planned') {
        await setTaskStatus(db, outbox, d.id, 'blocked');
      }
    }
  }
  const mission = await db.mission.findUnique({ where: { id: task.missionId } });
  if (!mission) return;
  const tasks = await db.task.findMany({ where: { missionId: mission.id }, select: { status: true } });
  const runnable = tasks.some((t) => RUNNABLE_TASK.includes(t.status));
  if (runnable) {
    const started = tasks.some((t) => t.status !== 'planned' && t.status !== 'ready');
    if (mission.status === 'approved' && started) await moveMission(db, outbox, mission.id, ['approved'], { status: 'running' });
    // reopened, unblocked or retried: a later review runs again
    if (mission.status === 'review' || mission.status === 'failed') {
      await moveMission(db, outbox, mission.id, ['review', 'failed'], { status: 'running', reviewRunId: null });
    }
    return;
  }
  if (mission.status === 'approved' || mission.status === 'running') {
    await moveMission(db, outbox, mission.id, ['approved', 'running'], { status: 'review', reviewRunId: null });
  } else if (mission.status === 'failed' && tasks.every((t) => t.status === 'done')) {
    await moveMission(db, outbox, mission.id, ['failed'], { status: 'done' });
  }
}

export async function reviewPrompt(db: Db, mission: Mission) {
  const tasks = await db.task.findMany({ where: { missionId: mission.id }, orderBy: { createdAt: 'asc' } });
  const lines = await Promise.all(
    tasks.map(async (t) => {
      const ev = await evidenceFor(db, t.id);
      const rule = evidenceRule(ev);
      const last = ev.runs.at(-1);
      return [
        `- ${t.key ?? t.id.slice(0, 8)} (taskId ${t.id}) · ${t.kind} · status ${t.status}`,
        `  title: ${t.title}`,
        `  acceptance: ${t.acceptanceCriteria.join('; ') || 'none'}`,
        `  runs: ${ev.runs.length}; latest: ${last ? `${last.status}, check ${last.check?.status ?? 'none'}, integration ${last.git?.integration ?? 'none'}` : 'none'}`,
        `  evidence rule: ${rule.ok ? 'met' : `not met (${rule.reason})`}`,
        t.reviewNote ? `  note: ${t.reviewNote}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }),
  );
  return [
    `Review the mission "${mission.title}".`,
    `Request:\n${mission.request}`,
    `Tasks:\n${lines.join('\n')}`,
    [
      'For every task in status review: read its evidence with get_task_evidence, inspect the mission branch read-only,',
      'then call review_task with done (only when the evidence shows the acceptance criteria are met) or reopen with a note saying what is missing.',
      'Finish with the review JSON: a mission summary and your decision for each task you reviewed.',
    ].join(' '),
  ].join('\n\n');
}

/** Creates the Chief's review run for a `review` mission without one; the scheduler assigns the returned spec. */
export async function startReviewRun(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  mission: Mission & { project: Project },
  worker: { workerId: string },
) {
  const chief = await prisma.agent.findFirst({ where: { slug: CHIEF_SLUG, isActive: true } });
  if (!chief) throw new Error('no active chief agent');
  const settings = await getSettings(prisma, mission.projectId);
  const created = await createRun(prisma, hub, config, {
    kind: 'review',
    agentId: chief.id,
    projectId: mission.projectId,
    missionId: mission.id,
    reviewOfMissionId: mission.id,
    prompt: await reviewPrompt(prisma, mission),
    readOnlyCheckout: true,
    outputFormat: { type: 'json_schema', schema: REVIEW_JSON_SCHEMA },
    allowedToolsOverride: PLAN_TOOLS,
    spec: {
      git: {
        repoPath: mission.project.repoPath,
        defaultBranch: mission.project.defaultBranch,
        missionBranch: missionBranch(mission),
        taskSlug: 'review',
        committerName: settings.committerName,
        committerEmail: settings.committerEmail,
        agentName: chief.name,
      },
    },
    worker,
  });
  await prisma.mission.updateMany({ where: { id: mission.id, reviewRunId: null }, data: { reviewRunId: created.run.id } });
  return created;
}

/** A review run that failed or was lost: retried once (reviewRunId cleared), then the mission fails. */
export async function reviewRunFailed(db: Db, outbox: Outbox, run: TaskRun) {
  if (!run.reviewOfMissionId) return;
  const mission = await db.mission.findUnique({ where: { id: run.reviewOfMissionId } });
  if (mission?.status !== 'review' || mission.reviewRunId !== run.id) return;
  const failed = await db.taskRun.count({
    where: { reviewOfMissionId: mission.id, kind: 'review', status: { in: ['failed', 'lost', 'cancelled'] } },
  });
  if (failed >= 2) {
    await moveMission(db, outbox, mission.id, ['review'], { status: 'failed', summary: `review run ${run.status}: ${run.error ?? 'no result'}` });
  } else {
    await db.mission.update({ where: { id: mission.id }, data: { reviewRunId: null } });
  }
}

/**
 * Applies the review run's structured decisions (a `done` failing the evidence rule becomes `reopen`),
 * stores the summary and a `review` artifact, then settles the mission: still runnable -> running,
 * every task done -> done, otherwise failed.
 */
export async function onReviewRunFinished(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  run: TaskRun,
  log?: { error: (obj: object, msg: string) => void },
) {
  if (!run.reviewOfMissionId) return;
  const mission = await prisma.mission.findUnique({ where: { id: run.reviewOfMissionId } });
  // cancelled, or a newer review run took over
  if (!mission || mission.status === 'cancelled' || (mission.reviewRunId && mission.reviewRunId !== run.id)) return;
  const parsed = ReviewDecisionSchema.safeParse(run.structuredOutput);
  const decisions = parsed.success ? parsed.data.tasks : [];
  const applied: string[] = [];
  for (const d of decisions) {
    const task = await prisma.task.findFirst({ where: { id: d.taskId, missionId: mission.id } });
    if (task?.status !== 'review') continue;
    try {
      try {
        await closeTask(prisma, hub, task.id, d.decision, d.note, { chief: true });
        applied.push(`${task.key ?? task.id}: ${d.decision}${d.note ? ` (${d.note})` : ''}`);
      } catch (err) {
        if (d.decision !== 'done' || !(err instanceof HttpError) || err.status !== 409 || !err.detail) throw err;
        const note = [d.note, err.detail].filter(Boolean).join(' ');
        await closeTask(prisma, hub, task.id, 'reopen', note, { chief: true });
        applied.push(`${task.key ?? task.id}: reopen (${note})`);
      }
    } catch (err) {
      log?.error({ err, taskId: task.id, runId: run.id }, 'applying review decision failed');
    }
  }
  const summary = parsed.success ? parsed.data.summary : 'review run returned no valid decision';
  await storeArtifact(prisma, config, {
    projectId: mission.projectId,
    runId: run.id,
    kind: 'review',
    name: 'mission-review.md',
    content: [summary, ...applied.map((a) => `- ${a}`)].join('\n'),
  });
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    await tx.mission.update({ where: { id: mission.id }, data: { summary } });
    const tasks = await tx.task.findMany({ where: { missionId: mission.id }, select: { status: true } });
    if (tasks.some((t) => RUNNABLE_TASK.includes(t.status))) {
      await moveMission(tx, outbox, mission.id, ['review', 'running'], { status: 'running', reviewRunId: null });
    } else {
      const done = tasks.every((t) => t.status === 'done');
      await moveMission(tx, outbox, mission.id, ['review', 'running'], { status: done ? 'done' : 'failed' });
    }
  });
  hub.publishAll(outbox);
}
