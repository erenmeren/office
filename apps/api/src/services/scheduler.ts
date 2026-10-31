import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@office/db';
import type { Config } from '../config.js';
import { isUnderRoot } from '../lib/paths.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';
import type { EventHub } from './event-hub.js';
import { abandonRun, createRunForTask, expireLeases } from './run-service.js';

// worker roots are real paths, so compare the repo's real path too (resolve only if it does not exist here)
function realOrResolved(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  // ready tasks already warned about having no eligible worker
  private warnedNoWorker = new Set<string>();

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
    let tasks;
    try {
      tasks = await this.prisma.task.findMany({
        where: { status: 'ready' },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        include: { project: true },
      });
    } catch (err) {
      this.log.error({ err }, 'scheduler could not list ready tasks');
      return;
    }
    for (const task of tasks) {
      try {
        const repoPath = realOrResolved(task.project.repoPath);
        const worker = this.gateway
          .onlineWorkers()
          .find((w) => w.capacity - w.activeRuns > 0 && w.allowedRoots.some((r) => isUnderRoot(repoPath, r)));
        if (!worker) {
          if (!this.warnedNoWorker.has(task.id)) {
            this.warnedNoWorker.add(task.id);
            this.log.warn({ taskId: task.id, repoPath }, 'ready task has no eligible worker online');
          }
          continue;
        }
        this.warnedNoWorker.delete(task.id);
        const { spec } = await createRunForTask(this.prisma, this.hub, task, worker, this.config);
        if (!this.gateway.send(worker.workerId, { type: 'run.assign', spec })) {
          this.log.warn({ taskId: task.id, runId: spec.runId, workerId: worker.workerId }, 'run.assign not delivered; run released');
          await abandonRun(this.prisma, this.hub, spec.runId);
        }
      } catch (err) {
        this.log.error({ err, taskId: task.id }, 'scheduling task failed');
      }
    }
  }
}
