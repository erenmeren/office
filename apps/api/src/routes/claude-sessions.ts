import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { isUnderRoot } from '../lib/paths.js';

const Id = z.object({ id: z.string().min(1) });

/** The machine's Claude Code sessions outside Office, read through the local worker (never from the API's disk). */
export async function claudeSessionRoutes(app: FastifyInstance) {
  // no local worker is a normal state, not an error: an empty list with `unavailable` set, so the UI stays quiet
  app.get('/claude-sessions', async () => {
    let sessions: SessionRow[];
    try {
      ({ sessions } = (await app.gateway.requestSessions({ kind: 'list', limit: 200 })) as { sessions: SessionRow[] });
    } catch (err) {
      if (err instanceof HttpError && err.status >= 502) return { sessions: [], unavailable: err.code };
      throw err;
    }
    const [projects, office] = await Promise.all([
      app.prisma.project.findMany({ select: { id: true, repoPath: true } }),
      app.prisma.agentSession.findMany({ where: { sdkSessionId: { in: sessions.map((s) => s.sessionId) } }, select: { sdkSessionId: true } }),
    ]);
    const ours = new Set(office.map((s) => s.sdkSessionId));
    return {
      sessions: sessions
        .filter((s) => !ours.has(s.sessionId))
        .map((s) => ({ ...s, projectId: projects.find((p) => isUnderRoot(s.cwd, p.repoPath))?.id ?? null })),
    };
  });

  app.get('/claude-sessions/:id/messages', async (req) => {
    const { id } = Id.parse(req.params);
    const q = z
      .object({ dir: z.string().min(1), offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query);
    return app.gateway.requestSessions({ kind: 'messages', sessionId: id, ...q });
  });

  app.post('/claude-sessions/:id/open', async (req) => {
    const { id } = Id.parse(req.params);
    const { dir } = z.object({ dir: z.string().min(1) }).parse(req.body);
    return app.gateway.requestSessions({ kind: 'open', sessionId: id, dir });
  });
}

type SessionRow = { sessionId: string; cwd: string };
