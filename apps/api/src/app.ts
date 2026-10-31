import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { PrismaClient } from '@office/db';
import type { Config } from './config.js';
import { HttpError } from './lib/errors.js';
import { registerPrisma } from './plugins/prisma.js';
import { registerAuth } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { agentRoutes } from './routes/agents.js';

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

  return app;
}
