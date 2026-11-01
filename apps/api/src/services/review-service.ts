import type { PrismaClient, Task } from '@office/db';
import { HttpError } from '../lib/errors.js';
import { audit } from './audit-service.js';
import type { EventHub, Outbox } from './event-hub.js';
import { setTaskStatus, type Db } from './task-service.js';

export type Evidence = Awaited<ReturnType<typeof evidenceFor>>;

/** Everything the platform recorded for a task: its runs (git, check, summaries, messages), artifacts and memory. */
export async function evidenceFor(db: Db, taskId: string) {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (!task) throw new HttpError(404, 'not_found');
  const runs = await db.taskRun.findMany({
    where: { taskId, kind: 'task' },
    orderBy: { createdAt: 'asc' },
    include: { checkResult: true, session: { select: { id: true } } },
  });
  const [summaries, artifacts, memoryCount] = await Promise.all([
    db.memoryEntry.findMany({ where: { taskId, type: 'task_summary' }, select: { id: true, runId: true } }),
    db.artifact.findMany({ where: { taskId }, select: { id: true, kind: true, name: true, runId: true } }),
    db.memoryEntry.count({ where: { taskId, status: { not: 'rejected' } } }),
  ]);
  return {
    task,
    runs: await Promise.all(
      runs.map(async (r) => ({
        id: r.id,
        status: r.status,
        git: r.headCommit
          ? { branch: r.branch, baseCommit: r.baseCommit, headCommit: r.headCommit, integration: r.integration }
          : null,
        check: r.checkResult ? { status: r.checkResult.status, exitCode: r.checkResult.exitCode } : null,
        summaryIds: summaries.filter((m) => m.runId === r.id).map((m) => m.id),
        messageCount: r.session ? await db.message.count({ where: { senderSessionId: r.session.id } }) : 0,
      })),
    ),
    artifacts,
    memoryCount,
  };
}

/**
 * §8.2: code -> the latest succeeded run committed changes and its check passed;
 * analysis -> an artifact or a memory entry for the task; review -> a `review` artifact.
 */
export function evidenceRule(e: Pick<Evidence, 'task' | 'runs' | 'artifacts' | 'memoryCount'>): { ok: boolean; reason?: string } {
  if (e.task.kind === 'code') {
    const last = e.runs.filter((r) => r.status === 'succeeded').at(-1);
    if (!last) return { ok: false, reason: 'no succeeded run' };
    // shortcut: filesChanged is not stored; a head commit past the base stands for it
    if (!last.git || last.git.headCommit === last.git.baseCommit) return { ok: false, reason: 'the latest succeeded run changed no files' };
    if (last.git.integration !== 'fast_forwarded') return { ok: false, reason: 'commits not integrated' };
    if (last.check?.status !== 'passed') return { ok: false, reason: `check ${last.check?.status ?? 'missing'} on the latest succeeded run` };
    return { ok: true };
  }
  if (e.task.kind === 'analysis') {
    return e.artifacts.some((a) => a.kind !== 'check_output') || e.memoryCount > 0
      ? { ok: true }
      : { ok: false, reason: 'no artifact or memory entry for the task' };
  }
  return e.artifacts.some((a) => a.kind === 'review') ? { ok: true } : { ok: false, reason: 'no review artifact for the task' };
}

type Consultation = { agent: string; topic: string };

/** Each required consultant got a `question` from the task's agent in the task's conversation, and replied. */
export async function consultationsSatisfied(db: Db, task: Task): Promise<{ ok: boolean; missing: Consultation[] }> {
  const required = (Array.isArray(task.requiredConsultations) ? task.requiredConsultations : []) as Consultation[];
  const missing: Consultation[] = [];
  for (const c of required) {
    const consultant = await db.agent.findUnique({ where: { slug: c.agent } });
    const questions = consultant
      ? await db.message.findMany({
          where: {
            type: 'question',
            senderAgentId: task.agentId,
            conversation: { taskId: task.id },
            deliveries: { some: { recipientAgentId: consultant.id } },
          },
          select: { id: true },
        })
      : [];
    const answered =
      questions.length > 0 &&
      (await db.message.count({ where: { type: 'reply', inReplyToId: { in: questions.map((q) => q.id) } } })) > 0;
    if (!answered) missing.push(c);
  }
  return { ok: missing.length === 0, missing };
}

/** `runId`: the Chief's review run deciding through review_task. */
export type CloseBy = { chief?: true; runId?: string; userId?: string; override?: boolean };

/**
 * review -> done or review -> ready (reopen). `done` needs the evidence rule and the required consultations
 * unless the owner overrides. Throws 409 `evidence_missing` / `consultation_missing` with the reason as detail.
 */
export async function closeTask(
  prisma: PrismaClient,
  hub: EventHub,
  taskId: string,
  decision: 'done' | 'reopen',
  note: string | undefined,
  by: CloseBy,
) {
  const outbox: Outbox = [];
  const task = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) throw new HttpError(404, 'not_found');
    if (task.status !== 'review') throw new HttpError(409, 'invalid_transition', `task is ${task.status}, not review`);
    if (decision === 'done' && !by.override) {
      const rule = evidenceRule(await evidenceFor(tx, taskId));
      if (!rule.ok) throw new HttpError(409, 'evidence_missing', rule.reason);
      const c = await consultationsSatisfied(tx, task);
      if (!c.ok) {
        throw new HttpError(409, 'consultation_missing', `missing consultation: ${c.missing.map((m) => `${m.agent} (${m.topic})`).join(', ')}`);
      }
    }
    if (note || decision === 'reopen') await tx.task.update({ where: { id: taskId }, data: { reviewNote: note || 'reopened' } });
    const updated = await setTaskStatus(tx, outbox, taskId, decision === 'done' ? 'done' : 'ready');
    await audit(tx, {
      userId: by.userId,
      action: by.override ? 'task.override' : 'task.reviewed',
      targetType: 'task',
      targetId: taskId,
      detail: { decision, note: note ?? null, by: by.chief ? 'chief' : 'owner', runId: by.runId ?? null },
    });
    return updated;
  });
  hub.publishAll(outbox);
  return task;
}
