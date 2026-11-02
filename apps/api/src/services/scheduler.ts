import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@office/db';
import { ProjectSettingsSchema, type RunSpec } from '@office/shared';
import type { Config } from '../config.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';
import type { EventHub } from './event-hub.js';
import { pendingWakeDeliveries } from './message-service.js';
import { abandonRun, createRun, createRunForTask, expireLeases, failWaitingRun, resumeRun } from './run-service.js';
import { summaryPrompt } from './summary-prompt.js';
import { startPlanRun, startReviewRun } from './mission-service.js';
import { gate, missionGate, requestBudgetApproval } from './budget-service.js';
import { getSettings } from './project-service.js';
import { expireApprovals } from './approval-service.js';

const SUMMARIZER_SLUG = 'office-summarizer';
const WAKE_PROMPT = 'You have new messages. Read your inbox and answer.';
const PARKED_LOG_MS = 60_000;

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  // ready tasks already warned about having no eligible worker
  private warnedNoWorker = new Set<string>();
  private warnedNoSummarizer = false;
  // ready tasks already logged as blocked, with the reason logged
  private loggedBlocked = new Map<string, string>();
  // waiting_reply runs parked for their pinned worker, with when that was last logged
  private loggedParked = new Map<string, number>();

  constructor(
    private prisma: PrismaClient,
    private hub: EventHub,
    private gateway: WorkerGateway,
    private config: Config,
    private log: FastifyBaseLogger,
  ) {}

  /** `schedulerIntervalMs: 0` means "do not start the timer" (tests call tick() directly). */
  start() {
    if (this.config.schedulerIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.tick(), this.config.schedulerIntervalMs);
    }
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Overlapping calls share the tick already in flight. */
  tick(): Promise<void> {
    this.inFlight ??= this.run().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async run() {
    try {
      for (const { runId, workerId } of await expireLeases(this.prisma, this.hub)) {
        if (!workerId) continue;
        // the worker may still be executing it; it must stop touching the repo
        this.gateway.send(workerId, { type: 'run.cancel', runId });
        this.gateway.releaseRun(workerId, runId);
      }
    } catch (err) {
      this.log.error({ err }, 'expireLeases failed');
    }
    try {
      await this.planMissions();
    } catch (err) {
      this.log.error({ err }, 'planning missions failed');
    }
    try {
      await this.resumeWaiting();
    } catch (err) {
      this.log.error({ err }, 'resuming waiting runs failed');
    }
    try {
      await this.assignReadyTasks();
    } catch (err) {
      this.log.error({ err }, 'scheduler could not list ready tasks');
    }
    try {
      await this.wakeAgents();
    } catch (err) {
      this.log.error({ err }, 'waking agents failed');
    }
    try {
      await this.summarize();
    } catch (err) {
      this.log.error({ err }, 'enqueuing summary runs failed');
    }
    try {
      await expireApprovals(this.prisma, this.hub, this.gateway);
    } catch (err) {
      this.log.error({ err }, 'expiring approvals failed');
    }
    try {
      await this.reviewMissions();
    } catch (err) {
      this.log.error({ err }, 'starting mission reviews failed');
    }
  }

  /** Ready tasks, by priority, that pass the agent/project gates and find a worker. */
  private async assignReadyTasks() {
    const tasks = await this.prisma.task.findMany({
      where: { status: 'ready' },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: { project: true, agent: true },
    });
    for (const task of tasks) {
      try {
        const verdict = await gate(this.prisma, await getSettings(this.prisma, task.projectId), task, task.agent);
        if (!verdict.ok) {
          if (this.loggedBlocked.get(task.id) !== verdict.reason) {
            this.loggedBlocked.set(task.id, verdict.reason);
            this.log.info({ taskId: task.id, reason: verdict.reason }, 'ready task held back');
          }
          if (verdict.budgetExceeded && task.missionId) {
            await requestBudgetApproval(this.prisma, this.hub, task.missionId, `${verdict.reason}; approve to continue`);
          }
          continue;
        }
        this.loggedBlocked.delete(task.id);
        // only a mission run carries git, so only it can go to a worker that clones
        const worker = this.pickWorker(task.project, { needsRepoAccess: task.missionId ? 'any' : 'local' });
        if (!worker) {
          if (!this.warnedNoWorker.has(task.id)) {
            this.warnedNoWorker.add(task.id);
            this.log.warn({ taskId: task.id, repoPath: task.project.repoPath }, 'ready task has no eligible worker online');
          }
          continue;
        }
        this.warnedNoWorker.delete(task.id);
        const { spec } = await createRunForTask(this.prisma, this.hub, task, worker, this.config);
        await this.assign(worker.workerId, spec);
      } catch (err) {
        this.log.error({ err, taskId: task.id }, 'scheduling task failed');
      }
    }
  }

  /** Each `review` mission without a review run gets one for the Chief. */
  private async reviewMissions() {
    const missions = await this.prisma.mission.findMany({
      where: { status: 'review', reviewRunId: null },
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const mission of missions) {
      try {
        if (!(await this.missionMayRun(mission))) continue;
        const worker = this.pickWorker(mission.project, { needsRepoAccess: 'any' });
        if (!worker) continue;
        const { spec } = await startReviewRun(this.prisma, this.hub, this.config, mission, worker);
        await this.assign(worker.workerId, spec);
      } catch (err) {
        this.log.error({ err, missionId: mission.id }, 'starting review run failed');
      }
    }
  }

  /** Each `planning` mission without a plan run gets one for the Chief. */
  private async planMissions() {
    const missions = await this.prisma.mission.findMany({
      where: { status: 'planning', planRunId: null },
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const mission of missions) {
      try {
        if (!(await this.missionMayRun(mission))) continue;
        const worker = this.pickWorker(mission.project, { needsRepoAccess: 'any' });
        if (!worker) continue;
        const { spec } = await startPlanRun(this.prisma, this.hub, this.config, mission, worker);
        await this.assign(worker.workerId, spec);
      } catch (err) {
        this.log.error({ err, missionId: mission.id }, 'starting plan run failed');
      }
    }
  }

  /** Budget gate for a Chief plan or review run; a spent daily budget raises the approval like a task would. */
  private async missionMayRun(mission: { id: string; projectId: string; budgetUsd: number | null }) {
    const verdict = await missionGate(this.prisma, await getSettings(this.prisma, mission.projectId), mission);
    if (verdict.ok) {
      this.loggedBlocked.delete(mission.id);
      return true;
    }
    if (this.loggedBlocked.get(mission.id) !== verdict.reason) {
      this.loggedBlocked.set(mission.id, verdict.reason);
      this.log.info({ missionId: mission.id, reason: verdict.reason }, 'mission run held back');
    }
    if (verdict.budgetExceeded) await requestBudgetApproval(this.prisma, this.hub, mission.id, `${verdict.reason}; approve to continue`);
    return false;
  }

  /**
   * A worker with a free slot and repo access: allowedRoots covering the repo on the API's machine (local), or
   * for `needsRepoAccess: 'any'` (mission runs with git) one that clones. Mission runs also need every required
   * tag; local-only runs (chat, inbox, summary, non-mission tasks) ignore tags. Local first, then fewest active runs.
   */
  private pickWorker(project: { repoPath: string; settings: unknown }, opts: { needsRepoAccess: 'local' | 'any' }) {
    const { requiredWorkerTags } = ProjectSettingsSchema.parse(project.settings ?? {});
    return this.gateway
      .onlineWorkers()
      .map((w) => ({ w, local: w.local(project.repoPath) }))
      .filter(
        ({ w, local }) =>
          w.capacity - w.activeRuns > 0 &&
          (opts.needsRepoAccess === 'local' || requiredWorkerTags.every((t) => w.tags.includes(t))) &&
          (local || (opts.needsRepoAccess === 'any' && w.canClone)),
      )
      .sort((a, b) => Number(b.local) - Number(a.local) || a.w.activeRuns - b.w.activeRuns)[0]?.w;
  }

  private async assign(workerId: string, spec: RunSpec) {
    if (this.gateway.send(workerId, { type: 'run.assign', spec })) return true;
    this.log.warn({ runId: spec.runId, workerId }, 'run.assign not delivered; run released');
    await abandonRun(this.prisma, this.hub, spec.runId);
    return false;
  }

  /**
   * waiting_reply runs whose reply arrived or whose wait timed out go back to their own worker (the SDK session
   * lives there). Without a free slot on it they stay parked; with it offline at the timeout they fail.
   */
  private async resumeWaiting() {
    const cutoff = new Date(Date.now() - this.config.replyTimeoutMinutes * 60_000);
    const waiting = await this.prisma.taskRun.findMany({ where: { status: 'waiting_reply' } });
    const ids = new Set(waiting.map((r) => r.id));
    for (const id of this.loggedParked.keys()) if (!ids.has(id)) this.loggedParked.delete(id);
    for (const run of waiting) {
      try {
        const waited = run.waitingForMessageId ? await this.prisma.message.findUnique({ where: { id: run.waitingForMessageId } }) : null;
        // an owner-authored waited message is an interrupt: it stands for its own reply
        const reply = waited?.senderUserId
          ? waited
          : run.waitingForMessageId
            ? await this.prisma.message.findFirst({
                where: { type: 'reply', inReplyToId: run.waitingForMessageId },
                orderBy: { createdAt: 'asc' },
              })
            : null;
        const timedOut = !!run.waitingSince && run.waitingSince < cutoff;
        if (!reply && !timedOut) continue;
        const pinned = this.gateway.onlineWorkers().find((w) => w.workerId === run.workerId);
        if (!pinned && timedOut) {
          await failWaitingRun(this.prisma, this.hub, run.id, 'pinned worker offline at resume');
          continue;
        }
        if (!pinned || pinned.capacity - pinned.activeRuns <= 0) {
          if (Date.now() - (this.loggedParked.get(run.id) ?? 0) >= PARKED_LOG_MS) {
            this.loggedParked.set(run.id, Date.now());
            this.log.debug({ runId: run.id, workerId: run.workerId }, 'waiting run parked until its worker has a free slot');
          }
          continue;
        }
        const worker = pinned;
        let sender = 'owner';
        if (reply?.senderAgentId) {
          sender = (await this.prisma.agent.findUnique({ where: { id: reply.senderAgentId } }))?.slug ?? 'unknown';
        }
        await resumeRun(
          this.prisma,
          this.hub,
          this.config,
          this.gateway,
          run.id,
          reply
            ? { reason: 'reply', reply: { id: reply.id, body: reply.body, sender }, worker }
            : { reason: 'timeout', worker },
          this.log,
        );
      } catch (err) {
        this.log.error({ err, runId: run.id }, 'resuming run failed');
      }
    }
  }

  /**
   * An idle agent with pending wake mail gets an inbox run, or a chat run for an owner (`human`) conversation.
   * Delivery status is left to read_inbox; instead each delivery allows at most two wake runs created after it
   * (one retry after a lost, failed or unread attempt). Untried deliveries go first, then the oldest.
   */
  private async wakeAgents() {
    for (const wake of await pendingWakeDeliveries(this.prisma)) {
      try {
        const agent = await this.prisma.agent.findUnique({ where: { id: wake.agentId } });
        if (!agent || agent.isSystem || !agent.isActive) continue;
        const scope = { agentId: wake.agentId, projectId: wake.projectId };
        const busy = await this.prisma.taskRun.count({
          where: { ...scope, status: { in: ['queued', 'running', 'waiting_reply', 'waiting_approval'] } },
        });
        if (busy) continue;
        // shortcut: one count per pending delivery; fine for small inboxes, batch it if inboxes grow large
        const tried = await Promise.all(
          wake.deliveries.map(async (d) => {
            const human = d.conversationKind === 'human';
            const attempts = await this.prisma.taskRun.count({
              where: {
                ...scope,
                createdAt: { gt: d.createdAt },
                // an inbox run covers agent mail; owner mail is answered by a chat run in its conversation
                ...(human ? { kind: 'chat', conversationId: d.conversationId } : { kind: 'inbox' }),
              },
            });
            return { d, human, attempts };
          }),
        );
        const next = tried
          .filter((x) => x.attempts < 2)
          .sort((x, y) => x.attempts - y.attempts || x.d.createdAt.getTime() - y.d.createdAt.getTime())[0];
        if (!next) continue;
        const [project, conversation] = await Promise.all([
          this.prisma.project.findUniqueOrThrow({ where: { id: wake.projectId } }),
          this.prisma.conversation.findUniqueOrThrow({ where: { id: next.d.conversationId } }),
        ]);
        const worker = this.pickWorker(project, { needsRepoAccess: 'local' });
        if (!worker) continue;
        const { spec } = await createRun(this.prisma, this.hub, this.config, {
          kind: next.human ? 'chat' : 'inbox',
          ...scope,
          conversationId: conversation.id,
          resumeSdkSessionId: next.human ? (conversation.sdkSessionId ?? undefined) : undefined,
          prompt: WAKE_PROMPT,
          worker,
        });
        await this.assign(worker.workerId, spec);
      } catch (err) {
        this.log.error({ err, agentId: wake.agentId }, 'waking agent failed');
      }
    }
  }

  /** Each finished task run gets one summary run for the hidden summarizer agent. */
  private async summarize() {
    const due = await this.prisma.taskRun.findMany({
      where: { kind: 'task', status: { in: ['succeeded', 'failed'] }, summarizedAt: null },
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    });
    if (due.length === 0) return;
    const summarizer = await this.prisma.agent.findUnique({ where: { slug: SUMMARIZER_SLUG } });
    if (!summarizer?.currentVersionId || !summarizer.isActive) {
      // left unsummarized so they are picked up once the summarizer is seeded
      if (!this.warnedNoSummarizer) {
        this.warnedNoSummarizer = true;
        this.log.warn({ slug: SUMMARIZER_SLUG }, 'no active summarizer agent; finished runs wait for one');
      }
      return;
    }
    for (const run of due) {
      try {
        const worker = this.pickWorker(run.project, { needsRepoAccess: 'local' });
        if (!worker) continue;
        // claim first so a concurrent scheduler cannot enqueue a second summary
        const { count } = await this.prisma.taskRun.updateMany({
          where: { id: run.id, summarizedAt: null },
          data: { summarizedAt: new Date() },
        });
        if (count === 0) continue;
        let spec: RunSpec;
        try {
          ({ spec } = await createRun(this.prisma, this.hub, this.config, {
            kind: 'summary',
            agentId: summarizer.id,
            projectId: run.projectId,
            taskId: run.taskId ?? undefined,
            summaryOfRunId: run.id,
            prompt: await summaryPrompt(this.prisma, run),
            worker,
          }));
        } catch (err) {
          await this.prisma.taskRun.update({ where: { id: run.id }, data: { summarizedAt: null } });
          throw err;
        }
        await this.assign(worker.workerId, spec);
      } catch (err) {
        this.log.error({ err, runId: run.id }, 'enqueuing summary run failed');
      }
    }
  }
}
