import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { TAB_TITLE, conductorHome, openTab, projectTab } from '../services/conductor-service.js';
import { conversationView } from '../services/message-service.js';

export async function conductorRoutes(app: FastifyInstance, opts: { config: Config }) {
  /**
   * One tab of the Conductor: a project's (`?project=<id>`, its conversation is made on first use) or a new one that has
   * no project yet (`?conversation=<id>`). With the conversation come the tab's project and the missions the Conductor
   * opened there. `agent: null` until the conductor agent is seeded; without a tab named there is no conversation.
   */
  app.get('/conductor', async (req) => {
    const q = z.object({ project: z.string().optional(), conversation: z.string().optional() }).parse(req.query);
    const { project: home, agent } = await conductorHome(app.prisma, opts.config);
    const tab = q.conversation ? await app.prisma.conversation.findFirst({ where: { id: q.conversation, projectId: home.id, kind: 'human' } }) : null;
    if (q.conversation && !tab) throw new HttpError(404, 'not_found');
    const aboutId = tab ? tab.aboutProjectId : q.project;
    const project = aboutId ? await app.prisma.project.findFirst({ where: { id: aboutId, isSystem: false }, select: { id: true, slug: true, name: true } }) : null;
    if (aboutId && !project) throw new HttpError(404, 'not_found');
    const conversation = tab ?? (project && agent ? await projectTab(app.prisma, home, agent, project.id) : null);
    const missions = conversation
      ? await app.prisma.mission.findMany({
          where: project ? { projectId: project.id, conductorConversationId: { not: null } } : { conductorConversationId: conversation.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            project: { select: { id: true, slug: true, name: true } },
            tasks: { select: { status: true } },
            approvals: { where: { status: 'pending' }, select: { type: true } },
          },
        })
      : [];
    return {
      projectId: home.id,
      agent,
      project,
      conversation: conversation && (await conversationView(app.prisma, conversation.id)),
      missions: missions.map(({ tasks, approvals, ...m }) => {
        const taskCounts: Record<string, number> = {};
        for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
        return { ...m, taskCounts, pendingApprovals: approvals.map((a) => a.type) };
      }),
    };
  });

  /**
   * The talks that belong to no project and have something said in them or a name, newest first; the one
   * conversation from before the tabs is among them. A closed one is opened again from this list. `title` is the
   * name the owner gave the tab, else how the owner began.
   */
  app.get('/conductor/tabs', async () => {
    const { project: home } = await conductorHome(app.prisma, opts.config);
    const talks = await app.prisma.conversation.findMany({
      where: { projectId: home.id, kind: 'human', aboutProjectId: null, OR: [{ messages: { some: {} } }, { title: { not: TAB_TITLE } }] },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { messages: { where: { senderUserId: { not: null } }, orderBy: { createdAt: 'asc' }, take: 1, select: { body: true } } },
    });
    return talks.map((t) => ({
      id: t.id,
      createdAt: t.createdAt,
      title: t.title !== TAB_TITLE ? t.title : (t.messages[0]?.body ?? 'Conversation').replace(/\s+/g, ' ').slice(0, 60),
    }));
  });

  /** The owner names a tab that has no project. A project's tab carries its project's name (`PUT /projects/:id`). */
  app.put('/conductor/tabs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { title } = z.object({ title: z.string().trim().min(1).max(60) }).parse(req.body);
    const { project: home } = await conductorHome(app.prisma, opts.config);
    const tab = await app.prisma.conversation.findFirst({ where: { id, projectId: home.id, kind: 'human' } });
    if (!tab) throw new HttpError(404, 'not_found');
    if (tab.aboutProjectId) throw new HttpError(409, 'has_project', "this tab carries its project's name");
    await app.prisma.conversation.update({ where: { id }, data: { title } });
    return { id, title };
  });

  /** A new tab: a conversation with the Conductor that has no project yet. */
  app.post('/conductor/tabs', async (_req, reply) => {
    const { project: home, agent } = await conductorHome(app.prisma, opts.config);
    if (!agent) throw new HttpError(409, 'conductor_missing', 'the Conductor agent is not installed');
    return reply.code(201).send({ conversationId: (await openTab(app.prisma, home, agent)).id });
  });

  /** A tab was closed. A new tab nothing was said in leaves nothing behind; every other tab keeps its conversation. */
  app.delete('/conductor/tabs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { project: home } = await conductorHome(app.prisma, opts.config);
    const tab = await app.prisma.conversation.findFirst({ where: { id, projectId: home.id, kind: 'human' } });
    if (!tab) throw new HttpError(404, 'not_found');
    if (!tab.aboutProjectId && !(await app.prisma.message.count({ where: { conversationId: id } }))) {
      await app.prisma.conversation.delete({ where: { id } });
    }
    return reply.code(204).send();
  });
}
