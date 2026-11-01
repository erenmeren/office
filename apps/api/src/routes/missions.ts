import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PlanSchema } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import { audit } from '../services/audit-service.js';
import { cancelMission, createMission, editPlan, replan } from '../services/mission-service.js';

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
          include: {
            dependencies: { select: { dependsOnId: true } },
            dependents: { select: { taskId: true } },
            checkResults: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
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
      tasks: mission.tasks.map(({ dependencies, dependents, checkResults, ...t }) => ({
        ...t,
        checkResult: checkResults[0] ?? null,
        dependencies: dependencies.map((d) => d.dependsOnId),
        dependents: dependents.map((d) => d.taskId),
      })),
      planRun,
    };
  });

  // owner cap on the mission's total spend; null removes it. The scheduler's gate re-reads it every tick.
  app.put('/missions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { budgetUsd } = z.object({ budgetUsd: z.number().positive().nullable() }).parse(req.body);
    const before = await app.prisma.mission.findUnique({ where: { id } });
    if (!before) throw new HttpError(404, 'not_found');
    const mission = await app.prisma.mission.update({ where: { id }, data: { budgetUsd } });
    await audit(app.prisma, {
      userId: req.user!.id,
      action: 'mission.updated',
      targetType: 'mission',
      targetId: id,
      detail: { budgetUsd: { from: before.budgetUsd, to: budgetUsd } },
    });
    return mission;
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
    return cancelMission(app.prisma, app.hub, app.gateway, id, req.user!.id, app.log);
  });
}
