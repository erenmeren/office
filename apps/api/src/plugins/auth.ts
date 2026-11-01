import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string };
  }
}

export const SESSION_COOKIE = 'office_session';
const PUBLIC_PATHS = new Set(['/health', '/auth/setup', '/auth/login', '/ws/worker']);

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    const token = request.cookies[SESSION_COOKIE];
    const session = token
      ? await app.prisma.userSession.findUnique({ where: { token }, include: { user: true } })
      : null;
    if (session && session.expiresAt > new Date()) {
      request.user = { id: session.user.id, email: session.user.email };
    }
    // /auth/me is public so it can report setupRequired
    // /git/ authenticates workers by bearer in its own route, never by cookie
    if (PUBLIC_PATHS.has(path) || path.startsWith('/git/') || (request.method === 'GET' && path === '/auth/me')) return;
    if (!request.user) return reply.code(401).send({ error: 'unauthorized' });
  });
}
