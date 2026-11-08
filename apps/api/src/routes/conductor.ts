import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { conductorHome } from '../services/conductor-service.js';
import { conversationView } from '../services/message-service.js';

export async function conductorRoutes(app: FastifyInstance, opts: { config: Config }) {
  /** The Conductor's conversation and the missions it opened; `agent: null` until the conductor agent is seeded. */
  app.get('/conductor', async () => {
    const { project, agent, conversation } = await conductorHome(app.prisma, opts.config);
    const missions = conversation
      ? await app.prisma.mission.findMany({
          where: { conductorConversationId: conversation.id },
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
      projectId: project.id,
      agent,
      conversation: conversation && (await conversationView(app.prisma, conversation.id)),
      missions: missions.map(({ tasks, approvals, ...m }) => {
        const taskCounts: Record<string, number> = {};
        for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
        return { ...m, taskCounts, pendingApprovals: approvals.map((a) => a.type) };
      }),
    };
  });
}
