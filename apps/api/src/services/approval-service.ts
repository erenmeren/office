import type { AgentSession, Approval, Prisma, PrismaClient, TaskRun } from '@office/db';
import type { ApprovalDecision, ApprovalRequest, ApprovalScope } from '@office/shared';
import { redactSecrets } from '@office/runtime';
import { HttpError } from '../lib/errors.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';
import { audit } from './audit-service.js';
import type { EventHub, Outbox } from './event-hub.js';
import { approvePlan, queueApproval, rejectPlan, toApprovalView } from './mission-service.js';
import { approveBudget } from './budget-service.js';
import { getSettings } from './project-service.js';
import { setTaskStatus } from './task-service.js';

type Gateway = Pick<WorkerGateway, 'send'>;

/** What a task-scoped approval matches on: Bash by trimmed command, file tools by path, else the whole input. */
export function approvalKey(toolName: string, input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = i.file_path ?? i.notebook_path;
  const value =
    toolName === 'Bash' ? String(i.command ?? '').trim() : typeof path === 'string' ? path : JSON.stringify(input);
  return `${toolName}\n${value}`;
}

const decisionOf = (a: Approval): ApprovalDecision => ({
  requestId: a.requestId!,
  decision: a.status === 'approved' ? 'allow' : 'deny',
  ...(a.message ? { message: a.message } : {}),
});

/**
 * A worker asks to run a tool. Returns the decision to send at once (a matching task-scoped approval,
 * or a repeated requestId already decided), else null: the run and task wait for the owner.
 */
export async function requestApproval(
  prisma: PrismaClient,
  hub: EventHub,
  { run, session, request }: { run: TaskRun; session: AgentSession; request: ApprovalRequest },
): Promise<ApprovalDecision | null> {
  const input = redactSecrets(request.input) as Prisma.InputJsonValue;
  const repeat = await prisma.approval.findUnique({ where: { requestId: request.requestId } });
  if (repeat) return repeat.status === 'pending' ? null : decisionOf(repeat);
  if (run.taskId) {
    const key = approvalKey(request.toolName, input);
    const granted = await prisma.approval.findMany({
      where: { status: 'approved', scope: 'task', taskId: run.taskId, toolName: request.toolName },
    });
    if (granted.some((a) => approvalKey(a.toolName!, a.input) === key)) {
      return { requestId: request.requestId, decision: 'allow' };
    }
  }
  const { approvalTimeoutMinutes } = await getSettings(prisma, session.projectId);
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    const moved = await tx.taskRun.updateMany({ where: { id: run.id, status: 'running' }, data: { status: 'waiting_approval' } });
    // a second concurrent request finds the run already waiting
    if (moved.count === 0 && (await tx.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status !== 'waiting_approval') {
      throw new Error(`run ${run.id} is not running`);
    }
    const approval = await tx.approval.create({
      data: {
        projectId: session.projectId,
        missionId: run.missionId,
        taskId: run.taskId,
        runId: run.id,
        type: request.type,
        requestId: request.requestId,
        toolName: request.toolName,
        input,
        reason: request.reason,
        expiresAt: new Date(Date.now() + approvalTimeoutMinutes * 60_000),
      },
    });
    if (moved.count) {
      await tx.agentSession.update({ where: { id: session.id }, data: { status: 'waiting_approval' } });
      outbox.push({ topic: `run:${run.id}`, message: { type: 'run.status.changed', runId: run.id, status: 'waiting_approval' } });
      if (run.kind === 'task' && run.taskId) {
        const task = await tx.task.findUniqueOrThrow({ where: { id: run.taskId } });
        if (task.status === 'running') await setTaskStatus(tx, outbox, task.id, 'waiting_approval');
      }
    }
    queueApproval(outbox, approval);
  });
  hub.publishAll(outbox);
  return null;
}

/** waiting_approval -> running for the run (and its task) once no request of the run is pending. */
async function resumeFromApproval(prisma: PrismaClient, hub: EventHub, runId: string) {
  const outbox: Outbox = [];
  await prisma.$transaction(async (tx) => {
    if (await tx.approval.count({ where: { runId, status: 'pending' } })) return;
    const { count } = await tx.taskRun.updateMany({ where: { id: runId, status: 'waiting_approval' }, data: { status: 'running' } });
    if (count === 0) return;
    await tx.agentSession.updateMany({ where: { runId }, data: { status: 'running' } });
    outbox.push({ topic: `run:${runId}`, message: { type: 'run.status.changed', runId, status: 'running' } });
    const run = await tx.taskRun.findUniqueOrThrow({ where: { id: runId }, include: { task: true } });
    if (run.kind === 'task' && run.task?.status === 'waiting_approval') await setTaskStatus(tx, outbox, run.task.id, 'running');
  });
  hub.publishAll(outbox);
}

/**
 * Sends a decided approval to its run's worker and resumes the run. 'ended' when the run no longer waits;
 * 'offline' when the worker is not connected (the run keeps waiting; the worker's next hello re-sends it).
 */
async function deliver(prisma: PrismaClient, hub: EventHub, gateway: Gateway, a: Approval) {
  const run = a.runId ? await prisma.taskRun.findUnique({ where: { id: a.runId } }) : null;
  if (!run || run.status !== 'waiting_approval' || !run.workerId) return 'ended';
  if (!gateway.send(run.workerId, { type: 'approval.result', runId: run.id, decision: decisionOf(a) })) return 'offline';
  await resumeFromApproval(prisma, hub, run.id);
  return 'sent';
}

/** Owner decision on any approval: plan and budget approvals keep their own flow. */
export async function decideApproval(
  prisma: PrismaClient,
  hub: EventHub,
  gateway: Gateway,
  approvalId: string,
  d: { decision: 'allow' | 'deny'; scope: ApprovalScope; userId: string; message?: string },
) {
  const current = await prisma.approval.findUnique({ where: { id: approvalId } });
  if (!current) throw new HttpError(404, 'not_found');
  if (current.status !== 'pending') throw new HttpError(409, 'already_decided');
  if (current.type === 'plan') {
    return d.decision === 'allow'
      ? approvePlan(prisma, hub, approvalId, d.userId)
      : rejectPlan(prisma, hub, approvalId, d.userId);
  }
  if (current.type === 'budget_exceeded' && d.decision === 'allow') return approveBudget(prisma, hub, approvalId, d.userId);

  const outbox: Outbox = [];
  const approval = await prisma.$transaction(async (tx) => {
    const { count } = await tx.approval.updateMany({
      where: { id: approvalId, status: 'pending' },
      data: {
        status: d.decision === 'allow' ? 'approved' : 'denied',
        decidedAt: new Date(),
        decidedByUserId: d.userId,
        scope: d.scope,
        message: d.message,
      },
    });
    if (count === 0) throw new HttpError(409, 'already_decided');
    const a = await tx.approval.findUniqueOrThrow({ where: { id: approvalId } });
    await audit(tx, {
      userId: d.userId,
      action: 'approval.decided',
      targetType: 'approval',
      targetId: approvalId,
      detail: { decision: d.decision, scope: d.scope, type: a.type, toolName: a.toolName },
    });
    queueApproval(outbox, a);
    return a;
  });
  hub.publishAll(outbox);
  if (approval.runId && (await deliver(prisma, hub, gateway, approval)) === 'ended') throw new HttpError(409, 'run_ended');
  return toApprovalView(approval);
}

/** Scheduler phase: pending tool approvals past expiresAt are denied by policy. */
export async function expireApprovals(prisma: PrismaClient, hub: EventHub, gateway: Gateway, now = new Date()) {
  const due = await prisma.approval.findMany({ where: { status: 'pending', runId: { not: null }, expiresAt: { lt: now } } });
  for (const a of due) {
    const { approvalTimeoutMinutes } = await getSettings(prisma, a.projectId);
    const outbox: Outbox = [];
    const expired = await prisma.$transaction(async (tx) => {
      const { count } = await tx.approval.updateMany({
        where: { id: a.id, status: 'pending' },
        data: { status: 'expired', decidedAt: now, message: `No decision within ${approvalTimeoutMinutes} minutes; denied by policy.` },
      });
      if (count === 0) return null;
      const e = await tx.approval.findUniqueOrThrow({ where: { id: a.id } });
      await audit(tx, { action: 'approval.expired', targetType: 'approval', targetId: a.id, detail: { type: e.type, toolName: e.toolName } });
      queueApproval(outbox, e);
      return e;
    });
    hub.publishAll(outbox);
    if (expired) await deliver(prisma, hub, gateway, expired);
  }
}

/** On a worker's hello: re-sends decisions its waiting runs never received. */
export async function resendDecisions(prisma: PrismaClient, hub: EventHub, gateway: Gateway, workerId: string) {
  // shortcut: a run with several requests also gets decisions it already received again; the worker ignores unknown requestIds
  const decided = await prisma.approval.findMany({
    where: { status: { not: 'pending' }, requestId: { not: null }, run: { workerId, status: 'waiting_approval' } },
    orderBy: { createdAt: 'asc' },
  });
  for (const a of decided) await deliver(prisma, hub, gateway, a);
}

/** Expires the pending approvals of runs that ended (cancelled, lost, finished). Call inside the ending transaction. */
export async function expireRunApprovals(tx: Prisma.TransactionClient, outbox: Outbox, runIds: string[], message: string) {
  const pending = await tx.approval.findMany({ where: { runId: { in: runIds }, status: 'pending' } });
  for (const a of pending) {
    queueApproval(outbox, await tx.approval.update({ where: { id: a.id }, data: { status: 'expired', decidedAt: new Date(), message } }));
  }
}
