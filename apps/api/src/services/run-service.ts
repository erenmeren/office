import type { AgentSession, CheckResult, Prisma, PrismaClient, Task, TaskRun } from '@office/db';
import { RunSpecSchema, skillPromptSection, type OfficeEvent, type RunResult, type RunSpec } from '@office/shared';
import { redactSecrets } from '@office/runtime';
import { HttpError } from '../lib/errors.js';
import type { Config } from '../config.js';
import type { EventHub, Outbox, RunStatusChanged } from './event-hub.js';
import { loadVersion } from './agent-service.js';
import { appendEvent } from './event-store.js';
import { audit } from './audit-service.js';
import { cancelLiveRuns, notifyCancelled, setTaskStatus } from './task-service.js';
import { buildContextPack } from './context-pack.js';
import { toolsForKind } from './tool-service.js';
import {
  LIVE_TASK,
  cancelMission,
  missionBranch,
  onPlanRunFinished,
  onPlanRunLost,
  onReviewRunFinished,
  planRunFailed,
  reviewRunFailed,
} from './mission-service.js';
import { getSettings } from './project-service.js';
import { storeArtifact } from './artifact-store.js';
import { queueMessageCreated, sendMessage, toMessageView } from './message-service.js';
import { expireRunApprovals, lockRun } from './approval-service.js';
import type { OnlineWorker, WorkerGateway } from '../ws/worker-gateway.js';

export class LeaseError extends Error {
  constructor(runId: string) {
    super(`No live lease for run ${runId} on this worker`);
    this.name = 'LeaseError';
  }
}

// a waiting_approval run keeps its lease and worker slot; the worker keeps heartbeating it
const LEASED = ['queued', 'running', 'waiting_approval'] as const;
/** The chosen worker of a mission run: `local` decides between the repo path and the git endpoint. */
export type RunWorker = Pick<OnlineWorker, 'workerId' | 'local'>;

/** How a mission run's worker reaches the repo: its own checkout when local, else the API's git endpoint. */
export function repoAccess(project: { id: string; repoPath: string }, worker: RunWorker) {
  return worker.local(project.repoPath) ? { repoPath: project.repoPath } : { remote: { path: `/git/${project.id}` } };
}

// a remote worker never learns a control-plane path; it sets cwd to its own worktree
const remoteCwd = (git: RunSpec['git']) => (git?.remote ? { cwd: 'remote' } : {});

const leaseUntil = (config: Config) => new Date(Date.now() + config.leaseSeconds * 1000);

function queueRunStatus(outbox: Outbox, runId: string, status: RunStatusChanged['status']) {
  outbox.push({ topic: `run:${runId}`, message: { type: 'run.status.changed', runId, status } });
}

/** The run if `workerId` owns it with a live lease, else null. */
export function findLeasedRun(
  prisma: PrismaClient,
  runId: string,
  workerId: string,
): Promise<(TaskRun & { session: AgentSession | null; task: Task | null }) | null> {
  return prisma.taskRun.findFirst({
    where: { id: runId, workerId, status: { in: [...LEASED] }, leaseExpiresAt: { gt: new Date() } },
    include: { session: true, task: true },
  });
}

type RunKind = TaskRun['kind'];

const MESSAGING_SECTION: Partial<Record<RunKind, string>> = {
  inbox:
    'You were woken to answer your inbox. Call read_inbox, reply to each question with reply_message, then stop. Do not start new work.',
  summary: 'Call submit_summary exactly once.',
  review:
    'You are reviewing a mission. Inspect the mission branch read-only, read each task\'s evidence with get_task_evidence, decide each task in review with review_task, then answer only with the review JSON that matches the schema.',
  plan: 'You are planning a mission. Inspect the repository read-only (Read, Glob, Grep, Bash for git log and listing only; writes are blocked). Answer only with the plan JSON that matches the schema.',
};
const DEFAULT_MESSAGING_SECTION =
  'You can message teammates with the office tools (list_agents, send_message, read_inbox, …). Check read_inbox when you are blocked or when the context pack reports unread mail. Propose durable knowledge with propose_memory; the owner verifies it.';
const INBOX_TOOLS = ['Read', 'Glob', 'Grep'];

/** Everything in a run spec that depends on the agent version, kind and project, plus the context pack. */
async function specBase(
  prisma: PrismaClient,
  config: Config,
  a: { kind: RunKind; agentId: string; projectId: string; agentVersionId: string; taskText: string },
) {
  const [project, loaded, settings] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: a.projectId } }),
    loadVersion(prisma, a.agentVersionId),
    getSettings(prisma, a.projectId),
  ]);
  const { config: cfg } = loaded;
  const summary = a.kind === 'summary';
  const inbox = a.kind === 'inbox';
  const skills = summary ? [] : loaded.skills;
  const pack = summary
    ? null
    : await buildContextPack(prisma, {
        projectId: a.projectId,
        agentId: a.agentId,
        taskText: a.taskText,
        maxChars: config.contextPackMaxChars,
      });
  const systemPrompt = [
    cfg.systemPrompt,
    skillPromptSection(skills),
    MESSAGING_SECTION[a.kind] ?? DEFAULT_MESSAGING_SECTION,
    pack?.text,
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    version: loaded.version,
    model: cfg.model,
    skills,
    pack,
    spec: {
      agentId: a.agentId,
      projectId: a.projectId,
      cwd: project.repoPath,
      systemPrompt,
      model: cfg.model,
      effort: cfg.effort,
      allowedTools: summary ? [] : inbox ? cfg.allowedTools.filter((t) => INBOX_TOOLS.includes(t)) : cfg.allowedTools,
      maxTurns: inbox ? Math.min(cfg.maxTurns, 8) : cfg.maxTurns,
      maxBudgetUsd: inbox ? Math.min(cfg.maxBudgetUsd, 0.25) : cfg.maxBudgetUsd,
      maxConcurrentSubagents: cfg.maxConcurrentSubagents,
      maxSubagentDepth: cfg.maxSubagentDepth,
      kind: a.kind,
      tools: toolsForKind(a.kind),
      skills: skills.map(({ name, version, checksum, mode, files }) => ({ name, version, checksum, mode, files })),
      subagents: summary ? [] : loaded.subagents,
      // the project's approval policy gates every run kind, not only mission tasks
      approvalPolicy: settings.approvalPolicy,
      approvalTimeoutMinutes: settings.approvalTimeoutMinutes,
    },
  };
}

export interface CreateRunInput {
  kind: RunKind;
  agentId: string;
  projectId: string;
  taskId?: string;
  conversationId?: string;
  prompt: string;
  worker: { workerId: string };
  resumeSdkSessionId?: string;
  startSeq?: number;
  summaryOfRunId?: string;
  missionId?: string;
  outputFormat?: RunSpec['outputFormat'];
  readOnlyCheckout?: boolean;
  allowedToolsOverride?: string[];
  taskKind?: RunSpec['taskKind'];
  reviewOfMissionId?: string;
  /** caps the agent version's maxBudgetUsd */
  taskBudgetUsd?: number;
  /** mission run fields: git, setup/check commands, env */
  spec?: Partial<Pick<RunSpec, 'git' | 'setupCommand' | 'checkCommand' | 'checkTimeoutSeconds' | 'env'>>;
}

export async function createRun(prisma: PrismaClient, hub: EventHub, config: Config, input: CreateRunInput) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: input.agentId } });
  if (!agent.currentVersionId) throw new Error(`Agent ${agent.id} has no current version`);
  const { kind, agentId, projectId, taskId } = input;
  const base = await specBase(prisma, config, {
    kind, agentId, projectId, agentVersionId: agent.currentVersionId, taskText: input.prompt,
  });

  const maxBudgetUsd =
    input.taskBudgetUsd !== undefined ? Math.min(base.spec.maxBudgetUsd, input.taskBudgetUsd) : base.spec.maxBudgetUsd;
  const outbox: Outbox = [];
  const created = await prisma.$transaction(async (tx) => {
    const run = await tx.taskRun.create({
      data: {
        kind,
        taskId,
        agentId,
        projectId,
        conversationId: input.conversationId,
        summaryOfRunId: input.summaryOfRunId,
        missionId: input.missionId,
        reviewOfMissionId: input.reviewOfMissionId,
        agentVersionId: base.version.id,
        workerId: input.worker.workerId,
        status: 'queued',
        maxBudgetUsd,
        leaseExpiresAt: leaseUntil(config),
      },
    });
    const session = await tx.agentSession.create({
      data: {
        runId: run.id,
        agentId,
        projectId,
        model: base.model,
        status: 'starting',
        startedAt: new Date(),
        skillsSnapshot: base.skills.map(({ skillId, skillVersionId, name, version, checksum, mode }) => ({
          skillId, skillVersionId, name, version, checksum, mode,
        })),
        ...(base.pack && {
          contextPack: {
            entryIds: base.pack.entryIds,
            summaryIds: base.pack.summaryIds,
            inboxCount: base.pack.inboxCount,
            chars: base.pack.text.length,
          },
        }),
      },
    });
    if (kind === 'task' && taskId) {
      await tx.task.update({ where: { id: taskId }, data: { attempts: { increment: 1 } } });
      await setTaskStatus(tx, outbox, taskId, 'queued');
    }
    const spec = RunSpecSchema.parse({
      ...base.spec,
      ...input.spec,
      ...remoteCwd(input.spec?.git),
      maxBudgetUsd,
      ...(input.allowedToolsOverride && { allowedTools: input.allowedToolsOverride }),
      outputFormat: input.outputFormat,
      readOnlyCheckout: input.readOnlyCheckout,
      taskKind: input.taskKind,
      runId: run.id,
      sessionId: session.id,
      prompt: input.prompt,
      resumeSdkSessionId: input.resumeSdkSessionId,
      startSeq: input.startSeq ?? 0,
    });
    return { run, session, spec };
  });
  hub.publishAll(outbox);
  return created;
}

export async function createRunForTask(
  prisma: PrismaClient,
  hub: EventHub,
  task: Task,
  worker: RunWorker,
  config: Config,
) {
  const input: CreateRunInput = {
    kind: 'task',
    agentId: task.agentId,
    projectId: task.projectId,
    taskId: task.id,
    prompt: `${task.title}\n\n${task.description}`,
    worker,
  };
  if (!task.missionId) return createRun(prisma, hub, config, input);
  const fields = await missionRunFields(prisma, task as Task & { missionId: string }, worker);
  // the first run of the mission fixes its branch name
  await prisma.mission.updateMany({ where: { id: task.missionId, branch: null }, data: { branch: fields.spec.git.missionBranch } });
  return createRun(prisma, hub, config, {
    ...input,
    prompt: [
      input.prompt,
      task.requirements.length ? `Requirements:\n${task.requirements.map((r) => `- ${r}`).join('\n')}` : '',
      task.acceptanceCriteria.length ? `Acceptance criteria:\n${task.acceptanceCriteria.map((r) => `- ${r}`).join('\n')}` : '',
      task.reviewNote ? `Review note:\n${task.reviewNote}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    missionId: task.missionId,
    ...fields,
  });
}

/** The run spec fields of a mission task: worktree (git), commands, env, kind and budget. */
async function missionRunFields(prisma: PrismaClient, task: Task & { missionId: string }, worker: RunWorker) {
  const [mission, project, agent, settings] = await Promise.all([
    prisma.mission.findUniqueOrThrow({ where: { id: task.missionId } }),
    prisma.project.findUniqueOrThrow({ where: { id: task.projectId } }),
    prisma.agent.findUniqueOrThrow({ where: { id: task.agentId } }),
    getSettings(prisma, task.projectId),
  ]);
  const code = task.kind === 'code';
  return {
    taskKind: task.kind,
    readOnlyCheckout: !code,
    taskBudgetUsd: task.budgetUsd ?? settings.defaultTaskBudgetUsd,
    spec: {
      git: {
        ...repoAccess(project, worker),
        defaultBranch: project.defaultBranch,
        missionBranch: missionBranch(mission),
        taskSlug: task.key ?? task.id.slice(0, 8),
        committerName: settings.committerName,
        committerEmail: settings.committerEmail,
        agentName: agent.name,
      },
      setupCommand: settings.setupCommand,
      checkCommand: code ? settings.checkCommand : undefined,
      checkTimeoutSeconds: settings.checkTimeoutSeconds,
      env: { file: settings.envFile, vars: settings.envTemplate },
    },
  };
}

export type ResumeReason =
  | { reason: 'reply'; reply: { id: string; body: string; sender: string } }
  | { reason: 'timeout' };

/**
 * waiting_reply -> queued on `worker`: the same run and session continue, resuming the SDK session.
 * Returns false when the run is no longer waiting (cancelled, or resumed concurrently).
 * Only the run's own worker may resume it: the SDK session and worktree live there.
 */
export async function resumeRun(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  gateway: Pick<WorkerGateway, 'send'>,
  runId: string,
  opts: ResumeReason & { worker: RunWorker },
  log?: { warn: (obj: object, msg: string) => void },
) {
  const run = await prisma.taskRun.findUnique({ where: { id: runId }, include: { session: true, task: true } });
  if (!run?.session || run.status !== 'waiting_reply') return false;
  if (run.workerId !== opts.worker.workerId) throw new Error(`run ${runId} is pinned to worker ${run.workerId}`);
  const session = run.session;
  const prompt =
    opts.reason === 'reply'
      ? `Reply from ${opts.reply.sender}:\n${opts.reply.body}`
      : `No reply was received within ${config.replyTimeoutMinutes} minutes. Continue or escalate.`;
  const base = await specBase(prisma, config, {
    kind: run.kind,
    agentId: run.agentId,
    projectId: run.projectId,
    agentVersionId: run.agentVersionId,
    taskText: run.task ? `${run.task.title}\n\n${run.task.description}` : prompt,
  });
  const max = await prisma.sessionEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } });
  const seq = (max._max.seq ?? 0) + 1;
  const now = new Date();

  const { count } = await prisma.$transaction(async (tx) => {
    const res = await tx.taskRun.updateMany({
      where: { id: runId, status: 'waiting_reply' },
      data: {
        status: 'queued',
        workerId: opts.worker.workerId,
        leaseExpiresAt: leaseUntil(config),
        waitingSince: null,
        waitingForMessageId: null,
      },
    });
    if (res.count) {
      await tx.agentSession.update({ where: { id: session.id }, data: { status: 'queued' } });
      // the reply reaches the agent as its resume prompt
      if (opts.reason === 'reply') {
        await tx.messageDelivery.updateMany({
          where: { messageId: opts.reply.id, recipientAgentId: run.agentId },
          data: { status: 'acknowledged', acknowledgedAt: now },
        });
      }
    }
    return res;
  });
  if (count === 0) return false;

  const event: OfficeEvent = {
    type: 'agent.resumed',
    seq,
    ts: now.toISOString(),
    sessionId: session.id,
    runId,
    agentId: run.agentId,
    projectId: run.projectId,
    payload: opts.reason === 'reply' ? { reason: 'reply', messageId: opts.reply.id } : { reason: 'timeout' },
  };
  await appendEvent(prisma, event, hub);
  hub.publish(`run:${runId}`, { type: 'run.status.changed', runId, status: 'queued' });

  // a mission task keeps its worktree, commands and budget across the resume
  const mission =
    run.kind === 'task' && run.task?.missionId
      ? await missionRunFields(prisma, run.task as Task & { missionId: string }, opts.worker)
      : null;
  // the worker numbers its next event startSeq + 1, after agent.resumed
  const spec = RunSpecSchema.parse({
    ...base.spec,
    ...(mission && {
      ...mission.spec,
      taskKind: mission.taskKind,
      readOnlyCheckout: mission.readOnlyCheckout,
      maxBudgetUsd: Math.min(base.spec.maxBudgetUsd, mission.taskBudgetUsd),
      ...remoteCwd(mission.spec.git),
    }),
    runId,
    sessionId: session.id,
    prompt,
    resumeSdkSessionId: session.sdkSessionId ?? undefined,
    startSeq: seq,
  });
  if (!gateway.send(opts.worker.workerId, { type: 'run.assign', spec })) {
    log?.warn({ runId, workerId: opts.worker.workerId }, 'resume run.assign not delivered; run waits again');
    await prisma.$transaction(async (tx) => {
      const back = await tx.taskRun.updateMany({
        where: { id: runId, status: 'queued' },
        data: {
          status: 'waiting_reply',
          leaseExpiresAt: null,
          waitingSince: run.waitingSince,
          waitingForMessageId: run.waitingForMessageId,
        },
      });
      if (back.count) await tx.agentSession.update({ where: { id: session.id }, data: { status: 'waiting_reply' } });
    });
    return false;
  }
  return true;
}

/**
 * waiting_reply -> failed when the run cannot resume (its pinned worker is offline at the reply timeout).
 * Its task is retried per maxAttempts; the retry is a new run with a fresh SDK session.
 */
export async function failWaitingRun(prisma: PrismaClient, hub: EventHub, runId: string, error: string) {
  const now = new Date();
  const outbox: Outbox = [];
  const failed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.taskRun.updateMany({
      where: { id: runId, status: 'waiting_reply' },
      data: { status: 'failed', finishedAt: now, error },
    });
    if (count === 0) return false;
    await tx.agentSession.updateMany({ where: { runId }, data: { status: 'failed', endedAt: now } });
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId }, include: { task: true, mission: true } });
    if (run.kind === 'task' && run.task) {
      if (run.task.status === 'waiting_reply') await setTaskStatus(tx, outbox, run.task.id, 'running');
      const next = run.mission?.status === 'cancelled' ? 'cancelled' : run.task.attempts < run.task.maxAttempts ? 'ready' : 'failed';
      await setTaskStatus(tx, outbox, run.task.id, next);
    }
    queueRunStatus(outbox, runId, 'failed');
    return true;
  });
  hub.publishAll(outbox);
  return failed;
}

/**
 * queued -> running, guarded on the lease and decided on in-transaction state. If a concurrent
 * accept already moved the run to running this is a no-op; any other state loses the lease.
 */
async function acceptRunInTx(tx: Prisma.TransactionClient, outbox: Outbox, runId: string, workerId: string, now: Date) {
  const { count } = await tx.taskRun.updateMany({
    where: { id: runId, workerId, status: 'queued', leaseExpiresAt: { gt: now } },
    data: { status: 'running', startedAt: now },
  });
  if (count === 0) {
    if ((await tx.taskRun.findUnique({ where: { id: runId } }))?.status === 'running') return;
    throw new LeaseError(runId);
  }
  await tx.agentSession.updateMany({ where: { runId }, data: { status: 'running' } });
  const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId }, include: { task: true } });
  if (run.kind === 'task' && run.task && run.task.status !== 'running') await setTaskStatus(tx, outbox, run.task.id, 'running');
  queueRunStatus(outbox, runId, 'running');
}

/** A queued run whose assignment never reached the worker: lost, and its task is ready again without using an attempt. */
export async function abandonRun(prisma: PrismaClient, hub: EventHub, runId: string) {
  const now = new Date();
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.taskRun.updateMany({
      where: { id: runId, status: 'queued' },
      data: { status: 'lost', finishedAt: now, error: 'assignment not delivered to the worker' },
    });
    if (count === 0) return;
    await tx.agentSession.updateMany({ where: { runId }, data: { status: 'lost', endedAt: now } });
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.kind === 'task' && run.taskId) {
      await tx.task.update({ where: { id: run.taskId }, data: { attempts: { decrement: 1 } } });
      await setTaskStatus(tx, outbox, run.taskId, 'ready');
    }
    // let the scheduler summarize that run again
    if (run.summaryOfRunId) await tx.taskRun.update({ where: { id: run.summaryOfRunId }, data: { summarizedAt: null } });
    if (run.kind === 'plan') await onPlanRunLost(tx, outbox, run);
    // an undelivered review run is simply started again
    if (run.kind === 'review' && run.reviewOfMissionId) {
      await tx.mission.updateMany({ where: { id: run.reviewOfMissionId, reviewRunId: runId }, data: { reviewRunId: null } });
    }
    queueRunStatus(outbox, runId, 'lost');
  });
  hub.publishAll(outbox);
}

/**
 * Owner stops a live run (409 run_not_live otherwise). A mission task returns to ready without using an attempt
 * (or is cancelled with `cancelTaskToo`); a plan/review run is handled like a lost one.
 */
export async function cancelRun(
  prisma: PrismaClient, hub: EventHub, gateway: WorkerGateway, runId: string, userId: string, cancelTaskToo: boolean,
  log: { error: (obj: object, msg: string) => void },
) {
  const outbox: Outbox = [];
  const cancelled = await prisma.$transaction(async (tx) => {
    const [run] = await cancelLiveRuns(tx, outbox, { id: runId });
    if (!run) return null;
    await audit(tx, {
      userId, action: 'run.cancelled', targetType: 'run', targetId: runId,
      detail: { by: userId, ...(run.taskId ? { taskId: run.taskId } : {}), ...(run.missionId ? { missionId: run.missionId } : {}) },
    });
    if (run.kind === 'task' && run.taskId) {
      const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId } });
      if ((LIVE_TASK as readonly string[]).includes(task.status)) {
        const mission = task.missionId ? await tx.mission.findUnique({ where: { id: task.missionId } }) : null;
        // a task of a stopped mission must not go ready; the attempt is given back like in abandonRun
        const stopped = mission && !['approved', 'running', 'review'].includes(mission.status);
        if (task.status === 'waiting_reply' || task.status === 'waiting_approval') await setTaskStatus(tx, outbox, task.id, 'running');
        const to = cancelTaskToo || stopped ? 'cancelled' : 'ready';
        if (to === 'ready') await tx.task.update({ where: { id: task.id }, data: { attempts: { decrement: 1 } } });
        await setTaskStatus(tx, outbox, task.id, to);
      }
    }
    // let the scheduler summarize that run again
    if (run.summaryOfRunId) await tx.taskRun.update({ where: { id: run.summaryOfRunId }, data: { summarizedAt: null } });
    // a cancelled review run keeps reviewRunId on purpose: no new review starts, the owner decides the tasks
    return run;
  });
  if (!cancelled) throw new HttpError(409, 'run_not_live');
  hub.publishAll(outbox);
  notifyCancelled(gateway, [cancelled]);
  // an owner-cancelled plan run stops the mission; cancelMission is a no-op when it is already over
  if (cancelled.kind === 'plan' && cancelled.missionId) {
    await cancelMission(prisma, hub, gateway, cancelled.missionId, userId, log).catch((err: unknown) => {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    });
  }
  return { id: runId, status: 'cancelled' as const };
}

export async function markRunning(prisma: PrismaClient, hub: EventHub, runId: string, workerId: string) {
  const run = await findLeasedRun(prisma, runId, workerId);
  if (!run) throw new LeaseError(runId);
  const outbox: Outbox = [];
  await prisma.$transaction((tx) => acceptRunInTx(tx, outbox, runId, workerId, new Date()));
  hub.publishAll(outbox);
}

export async function renewLeases(prisma: PrismaClient, workerId: string, runIds: string[], config: Config) {
  await prisma.taskRun.updateMany({
    where: { id: { in: runIds }, workerId, status: { in: [...LEASED] } },
    data: { leaseExpiresAt: leaseUntil(config) },
  });
}

type Log = { error: (obj: object, msg: string) => void };

export async function completeRun(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  { runId, workerId, result }: { runId: string; workerId: string; result: RunResult },
  log?: Log,
) {
  const run = await findLeasedRun(prisma, runId, workerId);
  if (!run || !run.session) throw new LeaseError(runId);
  const r = redactSecrets(result);
  const suspended = r.status === 'suspended';
  const status = r.status === 'suspended' ? 'waiting_reply' : r.status;
  const now = new Date();
  const outbox: Outbox = [];
  const check = await prisma.$transaction(async (tx) => {
    // run.accepted never reached us (e.g. socket dropped): accept implicitly so the result is not lost
    if (run.status === 'queued') await acceptRunInTx(tx, outbox, runId, workerId, now);
    // locked so a concurrent approval request cannot leave a pending row on the finished run
    if ((await lockRun(tx, runId)) === 'waiting_approval') {
      // the run ended while asking: its open requests expire and the task leaves waiting_approval
      await expireRunApprovals(tx, outbox, [runId], 'run finished');
      const task = run.kind === 'task' && run.taskId ? await tx.task.findUniqueOrThrow({ where: { id: run.taskId } }) : null;
      if (task?.status === 'waiting_approval') await setTaskStatus(tx, outbox, task.id, 'running');
    }
    // guarded again here so a lease expiring between the check and the write still loses
    const { count } = await tx.taskRun.updateMany({
      where: { id: runId, status: { in: [...LEASED] }, leaseExpiresAt: { gt: now } },
      data: suspended
        ? // parked without a lease: the worker slot is free; workerId stays for the record
          { status, waitingSince: now, leaseExpiresAt: null, costUsd: { increment: r.usage.costUsd } }
        : {
            status,
            resultText: r.resultText,
            error: r.error,
            finishedAt: now,
            costUsd: { increment: r.usage.costUsd },
            // Prisma rejects a raw null for a Json column
            structuredOutput: (r.structuredOutput ?? undefined) as Prisma.InputJsonValue | undefined,
          },
    });
    if (count === 0) throw new LeaseError(runId);
    await tx.agentSession.update({
      where: { id: run.session!.id },
      data: { status, sdkSessionId: r.sdkSessionId, ...(suspended ? {} : { endedAt: now }) },
    });
    await tx.usageRecord.create({
      data: {
        runId,
        projectId: run.session!.projectId,
        agentId: run.session!.agentId,
        model: run.session!.model,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        costUsd: r.usage.costUsd,
      },
    });
    if (run.kind === 'chat' && run.conversationId && r.sdkSessionId) {
      await tx.conversation.update({ where: { id: run.conversationId }, data: { sdkSessionId: r.sdkSessionId } });
    }
    let check: CheckResult | null = null;
    if (run.kind === 'task' && run.taskId && run.missionId) {
      // a suspended run reports git and check only when it finishes
      if (!suspended) check = await recordMissionRun(tx, config, run as TaskRun & { taskId: string }, r);
      const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId } });
      if (status === 'succeeded') {
        // the Chief's review (or the owner) decides done
        await setTaskStatus(tx, outbox, task.id, 'review');
      } else if (status === 'failed') {
        // a mission cancelled while the run was live gets no retry
        const mission = await tx.mission.findUniqueOrThrow({ where: { id: run.missionId } });
        const next = mission.status === 'cancelled' ? 'cancelled' : task.attempts < task.maxAttempts ? 'ready' : 'failed';
        await setTaskStatus(tx, outbox, task.id, next);
      } else {
        await setTaskStatus(tx, outbox, task.id, status);
      }
    } else if (run.kind === 'task' && run.taskId) {
      if (status === 'succeeded') {
        // tasks outside a mission have no reviewer: they close on success
        await setTaskStatus(tx, outbox, run.taskId, 'review');
        await setTaskStatus(tx, outbox, run.taskId, 'done');
      } else {
        await setTaskStatus(tx, outbox, run.taskId, status);
      }
    }
    if (run.kind === 'plan' && (status === 'failed' || status === 'cancelled')) {
      await planRunFailed(tx, outbox, run, [r.error ?? `plan run ${status}`]);
    }
    if (run.kind === 'review' && (status === 'failed' || status === 'cancelled')) {
      await reviewRunFailed(tx, outbox, { ...run, status, error: r.error ?? null });
    }
    queueRunStatus(outbox, runId, status);
    return check;
  });
  hub.publishAll(outbox);
  const finished = { ...run, status: status as TaskRun['status'], structuredOutput: (r.structuredOutput ?? null) as TaskRun['structuredOutput'] };
  if (run.kind === 'plan' && status === 'succeeded') await onPlanRunFinished(prisma, hub, finished);
  if (run.kind === 'review' && status === 'succeeded') {
    try {
      await onReviewRunFinished(prisma, hub, config, finished, log);
    } catch (err) {
      // counts as a failed review run: retried once, then the mission fails (never an unbounded loop of paid runs)
      log?.error({ err, runId }, 'applying the review run failed');
      const error = `review apply failed: ${(err as Error).message}`;
      const failOutbox: Outbox = [];
      await prisma.$transaction(async (tx) => {
        await tx.taskRun.update({ where: { id: runId }, data: { error } });
        await reviewRunFailed(tx, failOutbox, { ...finished, error });
      });
      hub.publishAll(failOutbox);
    }
  }
  if (run.kind === 'task' && run.missionId && (status === 'succeeded' || status === 'failed')) {
    // the run's result already committed; a failed notification must not fail the worker message
    try {
      if (check) await emitCheckEvent(prisma, hub, run.session, check);
      await notifyChief(prisma, hub, config, run as TaskRun & { taskId: string; missionId: string }, status, check, r);
    } catch (err) {
      log?.error({ err, runId }, 'mission run notification failed');
    }
  }
}

/** Stores the git summary (run + GitWorkspace), the check (CheckResult + artifact) and an analysis/review result artifact. */
async function recordMissionRun(tx: Prisma.TransactionClient, config: Config, run: TaskRun & { taskId: string }, r: RunResult) {
  const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId }, include: { project: true } });
  if (r.git) {
    const { branch, baseCommit, headCommit, integration, worktreePath } = r.git;
    await tx.taskRun.update({ where: { id: run.id }, data: { branch, baseCommit, headCommit, integration, worktreePath } });
    await tx.gitWorkspace.create({
      data: { runId: run.id, repoPath: task.project.repoPath, worktreePath: worktreePath ?? '', branch, baseCommit, headCommit },
    });
    if (integration === 'needs_integration') await tx.task.update({ where: { id: task.id }, data: { reviewNote: 'needs integration' } });
  }
  if (r.status === 'succeeded' && r.resultText && task.kind !== 'code') {
    await storeArtifact(tx, config, {
      projectId: task.projectId, runId: run.id, taskId: task.id, kind: task.kind, name: `${task.kind}.md`, content: r.resultText,
    });
  }
  if (!r.check) return null;
  const artifact = await storeArtifact(tx, config, {
    projectId: task.projectId, runId: run.id, taskId: task.id, kind: 'check_output', name: 'check.txt', content: r.check.output,
  });
  const { command, status, exitCode, durationMs } = r.check;
  return tx.checkResult.create({
    data: { runId: run.id, taskId: task.id, command, status, exitCode, durationMs, artifactId: artifact.id },
  });
}

/** The server-side agent.check.completed event, numbered after the session's last event. */
async function emitCheckEvent(prisma: PrismaClient, hub: EventHub, session: AgentSession, check: CheckResult) {
  const max = await prisma.sessionEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } });
  const event: OfficeEvent = {
    type: 'agent.check.completed',
    seq: (max._max.seq ?? 0) + 1,
    ts: new Date().toISOString(),
    sessionId: session.id,
    runId: check.runId,
    agentId: session.agentId,
    projectId: session.projectId,
    payload: {
      checkResultId: check.id,
      command: check.command,
      status: check.status,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      artifactId: check.artifactId,
    },
  };
  await appendEvent(prisma, event, hub);
}

/** A plain `message` (never wakes) to the Chief in the mission conversation. */
async function notifyChief(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  run: TaskRun & { taskId: string; missionId: string },
  status: string,
  check: CheckResult | null,
  r: RunResult,
) {
  const [task, mission, chief] = await Promise.all([
    prisma.task.findUniqueOrThrow({ where: { id: run.taskId } }),
    prisma.mission.findUniqueOrThrow({ where: { id: run.missionId } }),
    prisma.agent.findFirst({ where: { slug: 'chief', isActive: true } }),
  ]);
  if (!mission.conversationId) return;
  const { message, deliveries } = await sendMessage(prisma, config.messageLimits, {
    projectId: task.projectId,
    conversationId: mission.conversationId,
    type: 'message',
    body: `Task ${task.key ?? task.id.slice(0, 8)} finished: ${status}. Check: ${check?.status ?? 'none'}. Integration: ${r.git?.integration ?? 'none'}.`,
    senderAgentId: task.agentId,
    taskId: task.id,
    recipientAgentIds: chief && chief.id !== task.agentId ? [chief.id] : [],
  });
  const outbox: Outbox = [];
  queueMessageCreated(outbox, toMessageView({ ...message, deliveries }));
  hub.publishAll(outbox);
}

/** Marks every expired leased run `lost` and requeues or fails its task. Returns the lost runs. */
export async function expireLeases(prisma: PrismaClient, hub: EventHub, now = new Date()) {
  const expired = await prisma.taskRun.findMany({
    where: { status: { in: [...LEASED] }, leaseExpiresAt: { lt: now } },
    include: { session: true },
  });
  const lost: Array<{ runId: string; workerId: string | null }> = [];
  for (const run of expired) {
    const outbox: Outbox = [];
    let retried = false;
    const changed = await prisma.$transaction(async (tx) => {
      // re-check inside the transaction so a concurrent result or renewal wins
      const { count } = await tx.taskRun.updateMany({
        where: { id: run.id, status: { in: [...LEASED] }, leaseExpiresAt: { lt: now } },
        data: { status: 'lost', finishedAt: now },
      });
      if (count === 0) return false;
      if (run.session) {
        await tx.agentSession.update({ where: { id: run.session.id }, data: { status: 'lost', endedAt: now } });
      }
      await expireRunApprovals(tx, outbox, [run.id], 'lease lost');
      if (run.kind === 'task' && run.taskId) {
        const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId } });
        // a resumed run lost before accept (waiting_reply) or a run lost while asking: neither can go to ready
        if (task.status === 'waiting_reply' || task.status === 'waiting_approval') await setTaskStatus(tx, outbox, task.id, 'running');
        retried = task.attempts < task.maxAttempts;
        await setTaskStatus(tx, outbox, task.id, retried ? 'ready' : 'failed');
      }
      if (run.kind === 'plan') await onPlanRunLost(tx, outbox, run);
      if (run.kind === 'review') await reviewRunFailed(tx, outbox, { ...run, status: 'lost' });
      queueRunStatus(outbox, run.id, 'lost');
      return true;
    });
    if (!changed) continue;
    hub.publishAll(outbox);
    lost.push({ runId: run.id, workerId: run.workerId });
    if (run.session) {
      const max = await prisma.sessionEvent.aggregate({ where: { sessionId: run.session.id }, _max: { seq: true } });
      const event: OfficeEvent = {
        type: 'run.lease.lost',
        seq: (max._max.seq ?? 0) + 1,
        ts: now.toISOString(),
        sessionId: run.session.id,
        runId: run.id,
        agentId: run.session.agentId,
        projectId: run.session.projectId,
        payload: { workerId: run.workerId, retried },
      };
      await appendEvent(prisma, event, hub);
    }
  }
  return lost;
}
