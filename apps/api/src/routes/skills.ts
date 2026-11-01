import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SkillFilesSchema } from '@office/shared';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../services/audit-service.js';
import { addSkillVersion, createSkill, importGit, importLocal } from '../services/skill-service.js';

const CreateSkill = z.object({ name: z.string().min(1).optional(), files: SkillFilesSchema });
const ImportSkill = z.discriminatedUnion('source', [
  z.object({ source: z.literal('local'), path: z.string().min(1) }),
  z.object({ source: z.literal('git'), url: z.string().min(1), ref: z.string().min(1).optional(), path: z.string().min(1).optional() }),
]);

export async function skillRoutes(app: FastifyInstance, opts: { config: Config }) {
  const meta = { select: { id: true, version: true, checksum: true, createdAt: true } } as const;

  const detail = async (id: string, withFiles: boolean) => {
    const skill = await app.prisma.skill.findUnique({
      where: { id },
      include: { versions: { ...meta, orderBy: { version: 'asc' } } },
    });
    if (!skill) throw new HttpError(404, 'not_found');
    const currentVersion = skill.currentVersionId
      ? await app.prisma.skillVersion.findUnique({
          where: { id: skill.currentVersionId },
          ...(withFiles ? {} : meta),
        })
      : null;
    return { ...skill, currentVersion };
  };
  const setStatus = async (id: string, status: 'approved' | 'rejected') => {
    await detail(id, false);
    await app.prisma.skill.update({ where: { id }, data: { status } });
    return detail(id, false);
  };

  app.get('/skills', async () => {
    const skills = await app.prisma.skill.findMany({ orderBy: { createdAt: 'asc' } });
    const versions = await app.prisma.skillVersion.findMany({
      where: { id: { in: skills.flatMap((s) => (s.currentVersionId ? [s.currentVersionId] : [])) } },
      ...meta,
    });
    return skills.map((s) => ({ ...s, currentVersion: versions.find((v) => v.id === s.currentVersionId) ?? null }));
  });

  app.post('/skills', async (req, reply) => {
    const body = CreateSkill.parse(req.body);
    const skill = await createSkill(app.prisma, { ...body, source: 'ui', status: 'approved' });
    return reply.code(201).send(skill);
  });

  app.post('/skills/import', async (req, reply) => {
    const body = ImportSkill.parse(req.body);
    const skill =
      body.source === 'local'
        ? await importLocal(app.prisma, opts.config, body.path)
        : await importGit(app.prisma, opts.config, body);
    return reply.code(201).send(skill);
  });

  app.get('/skills/:id', async (req) => detail((req.params as { id: string }).id, true));

  app.get('/skills/:id/versions/:version', async (req) => {
    const { id, version } = req.params as { id: string; version: string };
    const n = Number(version);
    const v = Number.isInteger(n)
      ? await app.prisma.skillVersion.findUnique({ where: { skillId_version: { skillId: id, version: n } } })
      : null;
    if (!v) throw new HttpError(404, 'not_found');
    return v;
  });

  app.post('/skills/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { files } = z.object({ files: SkillFilesSchema }).parse(req.body);
    const { version, created } = await addSkillVersion(app.prisma, id, files);
    return reply.code(created ? 201 : 200).send(version);
  });

  app.post('/skills/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const s = await setStatus(id, 'approved');
    await audit(app.prisma, { userId: req.user!.id, action: 'skill.approved', targetType: 'skill', targetId: id });
    return s;
  });
  app.post('/skills/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const s = await setStatus(id, 'rejected');
    await audit(app.prisma, { userId: req.user!.id, action: 'skill.rejected', targetType: 'skill', targetId: id });
    return s;
  });
}
