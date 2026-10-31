import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { InvalidTransitionError, SkillValidationError } from '@office/shared';
import type { PrismaClient } from '@office/db';
import type { Config } from './config.js';
import { HttpError } from './lib/errors.js';
import { registerPrisma } from './plugins/prisma.js';
import { registerAuth } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { agentRoutes } from './routes/agents.js';
import { skillRoutes } from './routes/skills.js';
import { taskRoutes } from './routes/tasks.js';
import { runRoutes } from './routes/runs.js';
import { workerRoutes } from './routes/workers.js';
import { EventHub } from './services/event-hub.js';
import { Scheduler } from './services/scheduler.js';
import { WorkerGateway } from './ws/worker-gateway.js';
import { UiGateway } from './ws/ui-gateway.js';

declare module 'fastify' {
  interface FastifyInstance {
    hub: EventHub;
    gateway: WorkerGateway;
    scheduler: Scheduler;
  }
}

export { loadConfig } from './config.js';
export type { Config } from './config.js';

export async function buildApp(
  config: Config,
  deps: { prisma?: PrismaClient; logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_error', details: err.issues });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof SkillValidationError) {
      return reply.code(400).send({ error: 'invalid_skill', code: err.code, message: err.message });
    }
    if (err instanceof InvalidTransitionError) return reply.code(409).send({ error: 'invalid_transition' });
    // Prisma unique-constraint violation (concurrent duplicates)
    if ((err as { code?: string }).code === 'P2002') return reply.code(409).send({ error: 'conflict' });
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: status === 500 ? 'internal_error' : err.message });
  });

  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(websocket);
  registerPrisma(app, config.databaseUrl, deps.prisma);
  registerAuth(app);

  await app.register(healthRoutes);
  await app.register(authRoutes, { cookieSecure: config.cookieSecure });
  await app.register(projectRoutes);
  await app.register(agentRoutes);
  await app.register(skillRoutes, { config });

  const hub = new EventHub();
  const gateway = new WorkerGateway(app.prisma, hub, config, app.log);
  const scheduler = new Scheduler(app.prisma, hub, gateway, config, app.log);
  app.decorate('hub', hub);
  app.decorate('gateway', gateway);
  app.decorate('scheduler', scheduler);
  gateway.register(app);
  new UiGateway(app.prisma, hub, app.log).register(app, config.webOrigin);
  await app.register(taskRoutes);
  await app.register(runRoutes);
  await app.register(workerRoutes);
  app.addHook('onReady', async () => scheduler.start());
  app.addHook('onClose', async () => scheduler.stop());

  return app;
}
