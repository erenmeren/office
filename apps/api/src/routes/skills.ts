import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SkillFilesSchema, parseSkillFrontmatter } from '@office/shared';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { audit } from '../services/audit-service.js';
import { addSkillVersion, createSkill, deleteSkill, importGit, importLocal, importMarket, machineSkills, refreshSkill } from '../services/skill-service.js';

const CreateSkill = z.object({ name: z.string().min(1).optional(), files: SkillFilesSchema });
const ImportSkill = z.discriminatedUnion('source', [
  z.object({ source: z.literal('local'), path: z.string().min(1) }),
  z.object({
    source: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    /** find the skill by its frontmatter name instead of a path */
    name: z.string().min(1).optional(),
  }),
  z.object({ source: z.literal('market'), id: z.string().min(1) }),
]);
const MARKET_SEARCH_URL = 'https://skills.sh/api/search';
type MarketSkill = { id: string; source: string; skillId: string; name: string; installs: number };

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
  const setStatus = async (id: string, status: 'approved' | 'rejected' | 'disabled') => {
    await detail(id, false);
    await app.prisma.skill.update({ where: { id }, data: { status } });
    return detail(id, false);
  };

  app.get('/skills', async () => {
    const skills = await app.prisma.skill.findMany({ orderBy: { createdAt: 'asc' } });
    const versions = await app.prisma.skillVersion.findMany({
      where: { id: { in: skills.flatMap((s) => (s.currentVersionId ? [s.currentVersionId] : [])) } },
      select: { ...meta.select, files: true },
    });
    // agents whose current version pins the skill
    const pins = await app.prisma.agentSkill.findMany({
      where: { agentVersion: { agent: { currentVersionId: { not: null } } } },
      select: { skillId: true, agentVersion: { select: { id: true, agent: { select: { id: true, currentVersionId: true } } } } },
    });
    return skills.map((s) => {
      const v = versions.find((x) => x.id === s.currentVersionId);
      const md = (v?.files as Record<string, string> | undefined)?.['SKILL.md'];
      return {
        ...s,
        currentVersion: v ? { id: v.id, version: v.version, checksum: v.checksum, createdAt: v.createdAt } : null,
        model: (md && parseSkillFrontmatter(md).model) || null,
        usedBy: [...new Set(pins.filter((p) => p.skillId === s.id && p.agentVersion.id === p.agentVersion.agent.currentVersionId).map((p) => p.agentVersion.agent.id))],
      };
    });
  });

  /** skills.sh search, proxied so the browser never leaves localhost. */
  app.get('/skills/market', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    let res: Response;
    try {
      res = await fetch(`${MARKET_SEARCH_URL}?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new HttpError(502, 'market_unavailable');
    }
    if (!res.ok) throw new HttpError(502, 'market_unavailable', `skills.sh answered ${res.status}`);
    const body = (await res.json()) as { skills?: MarketSkill[] };
    const skills = (body.skills ?? []).map(({ id, source, skillId, name, installs }) => ({ id, source, skillId, name, installs }));
    return { skills };
  });

  app.post('/skills', async (req, reply) => {
    const body = CreateSkill.parse(req.body);
    const skill = await createSkill(app.prisma, { ...body, source: 'ui', status: 'approved' });
    return reply.code(201).send(skill);
  });

  /** The owner's Claude Code skills on the API's machine, with the Office skill each is already imported as. */
  app.get('/skills/machine', async () => machineSkills(app.prisma));

  app.post('/skills/import', async (req, reply) => {
    const body = ImportSkill.parse(req.body);
    const skill =
      body.source === 'local'
        ? await importLocal(app.prisma, opts.config, body.path)
        : body.source === 'market'
          ? await importMarket(app.prisma, opts.config, body.id)
          : await importGit(app.prisma, opts.config, body);
    await audit(app.prisma, { userId: req.user!.id, action: 'skill.imported', targetType: 'skill', targetId: skill.id, detail: { source: body.source } });
    return reply.code(201).send(skill);
  });

  app.post('/skills/:id/update', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { version, created } = await refreshSkill(app.prisma, opts.config, id);
    if (created) await audit(app.prisma, { userId: req.user!.id, action: 'skill.updated', targetType: 'skill', targetId: id, detail: { version: version.version } });
    return reply.code(created ? 201 : 200).send({ created, version: { id: version.id, version: version.version, checksum: version.checksum, createdAt: version.createdAt } });
  });

  app.delete('/skills/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteSkill(app.prisma, id);
    await audit(app.prisma, { userId: req.user!.id, action: 'skill.deleted', targetType: 'skill', targetId: id });
    return reply.code(204).send();
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
  // off: an approved skill that stays pinned but is left out of every run until enabled again
  app.post('/skills/:id/disable', async (req) => {
    const { id } = req.params as { id: string };
    const current = await detail(id, false);
    if (current.status !== 'approved') throw new HttpError(409, 'not_approved');
    const s = await setStatus(id, 'disabled');
    await audit(app.prisma, { userId: req.user!.id, action: 'skill.disabled', targetType: 'skill', targetId: id });
    return s;
  });
  app.post('/skills/:id/enable', async (req) => {
    const { id } = req.params as { id: string };
    const current = await detail(id, false);
    if (current.status !== 'disabled') throw new HttpError(409, 'not_disabled');
    const s = await setStatus(id, 'approved');
    await audit(app.prisma, { userId: req.user!.id, action: 'skill.enabled', targetType: 'skill', targetId: id });
    return s;
  });
  app.post('/skills/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const s = await setStatus(id, 'rejected');
    await audit(app.prisma, { userId: req.user!.id, action: 'skill.rejected', targetType: 'skill', targetId: id });
    return s;
  });
}
