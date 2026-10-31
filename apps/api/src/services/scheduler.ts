import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@office/db';
import type { Config } from '../config.js';
import { isUnderRoot } from '../lib/paths.js';
import type { WorkerGateway } from '../ws/worker-gateway.js';
import type { EventHub } from './event-hub.js';
import { createRunForTask, expireLeases } from './run-service.js';

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

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
        if (workerId) this.gateway.releaseRun(workerId, runId);
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
        const worker = this.gateway
          .onlineWorkers()
          .find(
            (w) => w.capacity - w.activeRuns > 0 && w.allowedRoots.some((r) => isUnderRoot(task.project.repoPath, r)),
          );
        if (!worker) continue;
        const { spec } = await createRunForTask(this.prisma, this.hub, task, worker, this.config);
        this.gateway.send(worker.workerId, { type: 'run.assign', spec });
      } catch (err) {
        this.log.error({ err, taskId: task.id }, 'scheduling task failed');
      }
    }
  }
}
