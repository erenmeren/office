import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TerminalSizeSchema } from '@office/shared';
import { HttpError } from '../lib/errors.js';
import { audit } from '../services/audit-service.js';

const Id = z.object({ id: z.string().min(1) });
const Open = z
  .object({
    projectId: z.string().min(1).optional(),
    /** a folder instead of a project (an unregistered folder from the Claude CLI list) */
    dir: z.string().min(1).optional(),
    resumeSessionId: z.string().min(1).optional(),
    cols: TerminalSizeSchema.shape.cols.default(120),
    rows: TerminalSizeSchema.shape.rows.default(32),
  })
  .refine((o) => !!o.projectId !== !!o.dir, { message: 'exactly one of projectId and dir' });

/** Office-managed manual Claude sessions: a `claude` process under a PTY on the local worker, viewed over `/ws/ui`. */
export async function terminalRoutes(app: FastifyInstance) {
  app.get('/terminals', async () => app.gateway.terminals.list());

  app.post('/terminals', async (req, reply) => {
    const body = Open.parse(req.body);
    let projectId = body.projectId ?? null;
    let dir = body.dir!;
    if (projectId) {
      const project = await app.prisma.project.findUnique({ where: { id: projectId }, select: { repoPath: true } });
      if (!project) throw new HttpError(404, 'not_found');
      dir = project.repoPath;
    } else {
      const projects = await app.prisma.project.findMany({ select: { id: true, repoPath: true } });
      projectId = projects.find((p) => dir === p.repoPath || dir.startsWith(p.repoPath + '/'))?.id ?? null;
    }
    const t = await app.gateway.terminals.open({ projectId, dir, resumeSessionId: body.resumeSessionId, cols: body.cols, rows: body.rows });
    await audit(app.prisma, { userId: req.user?.id, action: 'terminal.opened', targetType: 'terminal', targetId: t.id, detail: { dir, claudeSessionId: t.claudeSessionId, resumed: !!body.resumeSessionId } });
    return reply.code(201).send(t);
  });

  app.delete('/terminals/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const t = app.gateway.terminals.close(id);
    if (t.status !== 'exited') await audit(app.prisma, { userId: req.user?.id, action: 'terminal.closed', targetType: 'terminal', targetId: id });
    return t;
  });
}
