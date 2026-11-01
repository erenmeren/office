import type { AgentSession, Prisma, PrismaClient, Task, TaskRun } from '@office/db';
import { RunSpecSchema, skillPromptSection, type OfficeEvent, type RunResult, type RunSpec } from '@office/shared';
import { redactSecrets } from '@office/runtime';
import type { Config } from '../config.js';
import type { EventHub, Outbox, RunStatusChanged } from './event-hub.js';
import { loadVersion } from './agent-service.js';
import { appendEvent } from './event-store.js';
import { setTaskStatus } from './task-service.js';
import { buildContextPack } from './context-pack.js';
import { toolsForKind } from './tool-service.js';
import { onPlanRunFinished, onPlanRunLost, planRunFailed } from './mission-service.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';

export class LeaseError extends Error {
  constructor(runId: string) {
    super(`No live lease for run ${runId} on this worker`);
    this.name = 'LeaseError';
  }
}

const LEASED = ['queued', 'running'] as const;
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
  const [project, loaded] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: a.projectId } }),
    loadVersion(prisma, a.agentVersionId),
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
}

export async function createRun(prisma: PrismaClient, hub: EventHub, config: Config, input: CreateRunInput) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: input.agentId } });
  if (!agent.currentVersionId) throw new Error(`Agent ${agent.id} has no current version`);
  const { kind, agentId, projectId, taskId } = input;
  const base = await specBase(prisma, config, {
    kind, agentId, projectId, agentVersionId: agent.currentVersionId, taskText: input.prompt,
  });

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
        agentVersionId: base.version.id,
        workerId: input.worker.workerId,
        status: 'queued',
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

export function createRunForTask(
  prisma: PrismaClient,
  hub: EventHub,
  task: Task,
  worker: { workerId: string },
  config: Config,
) {
  return createRun(prisma, hub, config, {
    kind: 'task',
    agentId: task.agentId,
    projectId: task.projectId,
    taskId: task.id,
    prompt: `${task.title}\n\n${task.description}`,
    worker,
  });
}

export type ResumeReason =
  | { reason: 'reply'; reply: { id: string; body: string; sender: string } }
  | { reason: 'timeout' };

/**
 * waiting_reply -> queued on `worker`: the same run and session continue, resuming the SDK session.
 * Returns false when the run is no longer waiting (cancelled, or resumed concurrently).
 */
export async function resumeRun(
  prisma: PrismaClient,
  hub: EventHub,
  config: Config,
  gateway: Pick<WorkerGateway, 'send'>,
  runId: string,
  opts: ResumeReason & { worker: { workerId: string } },
  log?: { warn: (obj: object, msg: string) => void },
) {
  const run = await prisma.taskRun.findUnique({ where: { id: runId }, include: { session: true, task: true } });
  if (!run?.session || run.status !== 'waiting_reply') return false;
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
    if (res.count) await tx.agentSession.update({ where: { id: session.id }, data: { status: 'queued' } });
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
  if ((await appendEvent(prisma, event)).inserted) hub.publish(`run:${runId}`, event);
  hub.publish(`run:${runId}`, { type: 'run.status.changed', runId, status: 'queued' });

  // the worker numbers its next event startSeq + 1, after agent.resumed
  const spec = RunSpecSchema.parse({
    ...base.spec,
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
    queueRunStatus(outbox, runId, 'lost');
  });
  hub.publishAll(outbox);
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

export async function completeRun(
  prisma: PrismaClient,
  hub: EventHub,
  { runId, workerId, result }: { runId: string; workerId: string; result: RunResult },
) {
  const run = await findLeasedRun(prisma, runId, workerId);
  if (!run || !run.session) throw new LeaseError(runId);
  const r = redactSecrets(result);
  const suspended = r.status === 'suspended';
  const status = r.status === 'suspended' ? 'waiting_reply' : r.status;
  const now = new Date();
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    // run.accepted never reached us (e.g. socket dropped): accept implicitly so the result is not lost
    if (run.status === 'queued') await acceptRunInTx(tx, outbox, runId, workerId, now);
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
    if (run.kind === 'task' && run.taskId) {
      if (status === 'succeeded') {
        // Phase 1 auto-closes review; the Chief takes it over in Phase 4.
        await setTaskStatus(tx, outbox, run.taskId, 'review');
        await setTaskStatus(tx, outbox, run.taskId, 'done');
      } else {
        await setTaskStatus(tx, outbox, run.taskId, status);
      }
    }
    if (run.kind === 'plan' && (status === 'failed' || status === 'cancelled')) {
      await planRunFailed(tx, outbox, run, [r.error ?? `plan run ${status}`]);
    }
    queueRunStatus(outbox, runId, status);
  });
  hub.publishAll(outbox);
  if (run.kind === 'plan' && status === 'succeeded') {
    await onPlanRunFinished(prisma, hub, { ...run, structuredOutput: (r.structuredOutput ?? null) as TaskRun['structuredOutput'] });
  }
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
      if (run.kind === 'task' && run.taskId) {
        const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId } });
        // a resumed run lost before accept: its task is still waiting_reply, which cannot go to ready
        if (task.status === 'waiting_reply') await setTaskStatus(tx, outbox, task.id, 'running');
        await setTaskStatus(tx, outbox, task.id, task.attempts < task.maxAttempts ? 'ready' : 'failed');
      }
      if (run.kind === 'plan') await onPlanRunLost(tx, outbox, run);
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
        payload: { workerId: run.workerId },
      };
      if ((await appendEvent(prisma, event)).inserted) hub.publish(`run:${run.id}`, event);
    }
  }
  return lost;
}
