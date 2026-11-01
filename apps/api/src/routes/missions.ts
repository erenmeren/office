import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalStatusSchema, canTransitionTask, PlanSchema } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import {
  approvePlan,
  cancelMission,
  createMission,
  editPlan,
  rejectPlan,
  replan,
} from '../services/mission-service.js';
import { cancelTask } from '../services/task-service.js';

const CreateMission = z.object({
  projectId: z.string().min(1),
  request: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  budgetUsd: z.number().positive().optional(),
});

export async function missionRoutes(app: FastifyInstance) {
  app.post('/missions', async (req, reply) => {
    const data = CreateMission.parse(req.body);
    return reply.code(201).send(await createMission(app.prisma, app.hub, data));
  });

  app.get('/missions', async (req) => {
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.query);
    const missions = await app.prisma.mission.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { tasks: { select: { status: true } } },
    });
    return missions.map(({ tasks, ...m }) => {
      const taskCounts: Record<string, number> = {};
      for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
      return { ...m, taskCounts };
    });
  });

  app.get('/missions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const mission = await app.prisma.mission.findUnique({
      where: { id },
      include: {
        tasks: {
          orderBy: { createdAt: 'asc' },
          include: { dependencies: { select: { dependsOnId: true } }, dependents: { select: { taskId: true } } },
        },
        approvals: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!mission) throw new HttpError(404, 'not_found');
    const planRun = mission.planRunId
      ? await app.prisma.taskRun.findUnique({
          where: { id: mission.planRunId },
          select: { id: true, status: true, costUsd: true, error: true },
        })
      : null;
    return {
      ...mission,
      tasks: mission.tasks.map(({ dependencies, dependents, ...t }) => ({
        ...t,
        dependencies: dependencies.map((d) => d.dependsOnId),
        dependents: dependents.map((d) => d.taskId),
      })),
      planRun,
    };
  });

  app.put('/missions/:id/plan', async (req) => {
    const { id } = req.params as { id: string };
    const { plan } = z.object({ plan: PlanSchema }).parse(req.body);
    return editPlan(app.prisma, app.hub, id, plan, req.user!.id);
  });

  app.post('/missions/:id/replan', async (req) => {
    const { id } = req.params as { id: string };
    const { note } = z.object({ note: z.string().min(1).max(2000).optional() }).parse(req.body ?? {});
    return replan(app.prisma, app.hub, id, note, req.user!.id);
  });

  app.post('/missions/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const { mission, planRun } = await cancelMission(app.prisma, app.hub, id, req.user!.id);
    if (planRun?.workerId) {
      app.gateway.send(planRun.workerId, { type: 'run.cancel', runId: planRun.id });
      app.gateway.releaseRun(planRun.workerId, planRun.id);
    }
    const tasks = await app.prisma.task.findMany({ where: { missionId: id } });
    for (const t of tasks) {
      if (canTransitionTask(t.status, 'cancelled')) await cancelTask(app.prisma, app.hub, app.gateway, t.id);
    }
    return mission;
  });

  app.get('/approvals', async (req) => {
    const { projectId, status } = z
      .object({ projectId: z.string().optional(), status: ApprovalStatusSchema.optional() })
      .parse(req.query);
    return app.prisma.approval.findMany({ where: { projectId, status }, orderBy: { createdAt: 'desc' } });
  });

  app.post('/approvals/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    return approvePlan(app.prisma, app.hub, id, req.user!.id);
  });

  app.post('/approvals/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    return rejectPlan(app.prisma, app.hub, id, req.user!.id);
  });
}
