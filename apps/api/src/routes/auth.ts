import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE } from '../plugins/auth.js';
import { HttpError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

const MAX_AGE_S = 30 * 24 * 3600;

const SetupBody = z.object({ email: z.string().email(), password: z.string().min(8) });
const LoginBody = z.object({ email: z.string(), password: z.string() });

export async function authRoutes(app: FastifyInstance, opts: { cookieSecure: boolean }) {
  async function startSession(reply: FastifyReply, userId: string) {
    const token = randomBytes(32).toString('base64url');
    await app.prisma.userSession.create({
      data: { token, userId, expiresAt: new Date(Date.now() + MAX_AGE_S * 1000) },
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: opts.cookieSecure,
      maxAge: MAX_AGE_S,
    });
  }

  app.post('/auth/setup', async (req, reply) => {
    const body = SetupBody.parse(req.body);
    if ((await app.prisma.user.count()) > 0) throw new HttpError(409, 'conflict');
    const user = await app.prisma.user.create({
      data: { email: body.email, passwordHash: await hashPassword(body.password) },
    });
    await startSession(reply, user.id);
    return reply.code(201).send({ id: user.id, email: user.email });
  });

  app.post('/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const user = await app.prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      throw new HttpError(401, 'unauthorized');
    }
    await startSession(reply, user.id);
    return { id: user.id, email: user.email };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await app.prisma.userSession.deleteMany({ where: { token } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    if (req.user) return { ...req.user, setupRequired: false };
    if ((await app.prisma.user.count()) === 0) return { setupRequired: true };
    throw new HttpError(401, 'unauthorized');
  });
}
