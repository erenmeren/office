import type { FastifyInstance } from 'fastify';
import { activeRunCount } from '../services/run-service.js';

export async function healthRoutes(app: FastifyInstance) {
  // activeRuns lets the desktop app keep the machine awake while agents work; a database outage must not fail liveness
  app.get('/health', async () => ({ ok: true, activeRuns: await activeRunCount(app.prisma).catch(() => 0) }));
}
