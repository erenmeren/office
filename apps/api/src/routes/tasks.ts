import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { cancelTask, createTask, retryTask } from '../services/task-service.js';
import { closeTask } from '../services/review-service.js';

const Note = z.object({ note: z.string().min(1).max(2000).optional() });

const CreateTask = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  priority: z.number().int().optional(),
});

export async function taskRoutes(app: FastifyInstance) {
  app.get('/tasks', async (req) => {
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.query);
    return app.prisma.task.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/tasks', async (req, reply) => {
    const data = CreateTask.parse(req.body);
    return reply.code(201).send(await createTask(app.prisma, data));
  });

  app.get('/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    const task = await app.prisma.task.findUnique({
      where: { id },
      include: {
        runs: { orderBy: { createdAt: 'asc' }, include: { session: true } },
        mission: { select: { id: true, title: true, status: true, branch: true } },
        dependencies: { select: { dependsOnId: true } },
        dependents: { select: { taskId: true } },
        checkResults: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!task) throw new HttpError(404, 'not_found');
    const { checkResults, ...rest } = task;
    const last = task.runs.filter((r) => r.kind === 'task').at(-1);
    return {
      ...rest,
      checkResult: checkResults[0] ?? null,
      git: last?.headCommit
        ? { runId: last.id, branch: last.branch, baseCommit: last.baseCommit, headCommit: last.headCommit, integration: last.integration }
        : null,
      dependencies: task.dependencies.map((d) => d.dependsOnId),
      dependents: task.dependents.map((d) => d.taskId),
    };
  });

  app.post('/tasks/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    if (!(await app.prisma.task.findUnique({ where: { id } }))) throw new HttpError(404, 'not_found');
    return cancelTask(app.prisma, app.hub, app.gateway, id);
  });

  // owner overrides: done skips the evidence rule and consultations
  for (const decision of ['done', 'reopen'] as const) {
    app.post(`/tasks/:id/${decision}`, async (req) => {
      const { id } = req.params as { id: string };
      const { note } = Note.parse(req.body ?? {});
      return closeTask(app.prisma, app.hub, id, decision, note, { userId: req.user!.id, override: true });
    });
  }

  app.post('/tasks/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    return retryTask(app.prisma, app.hub, id, req.user!.id);
  });
}
