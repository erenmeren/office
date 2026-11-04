import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';
import { isUnderRoot } from '../lib/paths.js';
import { audit } from '../services/audit-service.js';

const Id = z.object({ id: z.string().min(1) });
const WorkerQ = z.object({ workerId: z.string().min(1).optional() });

/** A session's project: the local repository that holds `cwd`, or a remote worker's clone `<home>/repos/<projectId>`. */
export function projectOf(cwd: string, projects: { id: string; repoPath: string }[], local: boolean): string | null {
  if (local) return projects.find((p) => isUnderRoot(cwd, p.repoPath))?.id ?? null;
  return projects.find((p) => cwd.includes(`/repos/${p.id}`))?.id ?? null;
}

/** The machine's Claude Code sessions outside Office, read through the local worker (never from the API's disk). */
export async function claudeSessionRoutes(app: FastifyInstance) {
  // every connected worker with workspace roots is asked; no worker at all is a normal state (`unavailable`), not an error
  app.get('/claude-sessions', async () => {
    const workers = app.gateway.sessionWorkers();
    if (workers.length === 0) return { sessions: [], unavailable: 'no_local_worker' };
    const [names, projects, answers] = await Promise.all([
      app.prisma.worker.findMany({ where: { id: { in: workers.map((w) => w.workerId) } }, select: { id: true, name: true } }),
      app.prisma.project.findMany({ select: { id: true, repoPath: true } }),
      Promise.allSettled(workers.map((w) => app.gateway.requestSessions({ kind: 'list', limit: 200 }, w.workerId))),
    ]);
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const sessions: (SessionRow & { workerId: string; workerName: string; projectId: string | null })[] = [];
    const failed: string[] = [];
    workers.forEach((w, i) => {
      const a = answers[i]!;
      if (a.status !== 'fulfilled' || a.value.kind !== 'list') return failed.push(nameOf.get(w.workerId) ?? w.workerId);
      for (const s of a.value.sessions) sessions.push({ ...s, workerId: w.workerId, workerName: nameOf.get(w.workerId) ?? w.workerId, projectId: projectOf(s.cwd, projects, w.local) });
    });
    const office = await app.prisma.agentSession.findMany({ where: { sdkSessionId: { in: sessions.map((s) => s.sessionId) } }, select: { sdkSessionId: true } });
    const ours = new Set(office.map((s) => s.sdkSessionId));
    return { sessions: sessions.filter((s) => !ours.has(s.sessionId)), ...(failed.length ? { unavailable: `worker_failed:${failed.join(',')}` } : {}) };
  });

  app.get('/claude-sessions/:id/messages', async (req) => {
    const { id } = Id.parse(req.params);
    const q = z
      .object({ dir: z.string().min(1), offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(500).default(200), ...WorkerQ.shape })
      .parse(req.query);
    const { workerId, ...rest } = q;
    return app.gateway.requestSessions({ kind: 'messages', sessionId: id, ...rest }, workerId);
  });

  /** `claude --bg <prompt>` in a project's repository or a folder: a background session the list shows with its state. */
  app.post('/claude-sessions/background', async (req, reply) => {
    const body = z
      .object({ projectId: z.string().min(1).optional(), dir: z.string().min(1).optional(), prompt: z.string().min(1).max(20_000), ...WorkerQ.shape })
      .refine((o) => !!o.projectId !== !!o.dir, { message: 'exactly one of projectId and dir' })
      .parse(req.body);
    let dir = body.dir!;
    if (body.projectId) {
      const project = await app.prisma.project.findUnique({ where: { id: body.projectId }, select: { repoPath: true } });
      if (!project) throw new HttpError(404, 'not_found');
      dir = project.repoPath;
    }
    const r = await app.gateway.requestSessions({ kind: 'background', action: 'start', dir, prompt: body.prompt }, body.workerId);
    if (r.kind !== 'background') throw new HttpError(502, 'bad_worker_answer');
    await audit(app.prisma, { userId: req.user?.id, action: 'background.started', targetType: 'claude_session', targetId: r.id ?? 'unknown', detail: { dir, prompt: body.prompt.slice(0, 500) } });
    return reply.code(201).send(r);
  });

  app.post('/claude-sessions/background/:id/:action', async (req) => {
    const { id, action } = z.object({ id: z.string().min(1).max(64), action: z.enum(['stop', 'rm']) }).parse(req.params);
    const { workerId } = WorkerQ.parse(req.body ?? {});
    const r = await app.gateway.requestSessions({ kind: 'background', action, id }, workerId);
    await audit(app.prisma, { userId: req.user?.id, action: `background.${action === 'rm' ? 'removed' : 'stopped'}`, targetType: 'claude_session', targetId: id });
    return r;
  });

  app.post('/claude-sessions/:id/open', async (req) => {
    const { id } = Id.parse(req.params);
    const { dir, workerId } = z.object({ dir: z.string().min(1), ...WorkerQ.shape }).parse(req.body);
    return app.gateway.requestSessions({ kind: 'open', sessionId: id, dir }, workerId);
  });
}

type SessionRow = { sessionId: string; cwd: string };
