import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConversationKindSchema } from '@office/shared';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import type { Outbox } from '../services/event-hub.js';
import {
  conversationView,
  findOrCreateConversation,
  listConversations,
  MessageError,
  queueMessageCreated,
  sendMessage,
  toMessageView,
} from '../services/message-service.js';

const CreateConversation = z
  .object({
    projectId: z.string().min(1),
    kind: z.enum(['direct', 'group', 'human']),
    agentIds: z.array(z.string().min(1)).min(1),
    title: z.string().min(1).optional(),
  })
  .refine((v) => v.kind !== 'direct' || new Set(v.agentIds).size === 2, 'direct needs two agents')
  .refine((v) => v.kind !== 'human' || v.agentIds.length === 1, 'human needs one agent');

const OwnerMessage = z.object({
  type: z.enum(['message', 'question']),
  body: z.string().min(1),
  recipientAgentIds: z.array(z.string().min(1)).optional(),
});

export async function conversationRoutes(app: FastifyInstance, opts: { config: Config }) {
  app.get('/conversations', async (req) => {
    const q = z.object({ projectId: z.string().min(1), kind: ConversationKindSchema.optional() }).parse(req.query);
    return listConversations(app.prisma, q);
  });

  app.post('/conversations', async (req, reply) => {
    const data = CreateConversation.parse(req.body);
    if (!(await app.prisma.project.findUnique({ where: { id: data.projectId } }))) throw new HttpError(404, 'not_found');
    const ids = [...new Set(data.agentIds)];
    if ((await app.prisma.agent.count({ where: { id: { in: ids }, isSystem: false } })) !== ids.length) {
      throw new MessageError('unknown_recipient', 'unknown agent');
    }
    const conv = await findOrCreateConversation(app.prisma, {
      projectId: data.projectId,
      kind: data.kind,
      agentIds: ids,
      includesOwner: data.kind === 'human',
      title: data.title ?? data.kind,
    });
    return reply.code(201).send(await conversationView(app.prisma, conv.id));
  });

  app.get('/conversations/:id', async (req) => {
    const { id } = req.params as { id: string };
    const view = await conversationView(app.prisma, id);
    const messages = await app.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      include: { deliveries: true },
    });
    return { ...view, messages: messages.map(toMessageView) };
  });

  app.post('/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = OwnerMessage.parse(req.body);
    const conv = await app.prisma.conversation.findUnique({ where: { id } });
    if (!conv) throw new HttpError(404, 'not_found');
    const outbox: Outbox = [];
    const view = await app.prisma.$transaction(async (tx) => {
      const { message, deliveries } = await sendMessage(tx, opts.config.messageLimits, {
        projectId: conv.projectId,
        conversationId: id,
        type: data.type,
        body: data.body,
        senderUserId: req.user!.id,
        recipientAgentIds: data.recipientAgentIds ?? conv.agentIds,
      });
      const v = toMessageView({ ...message, deliveries });
      queueMessageCreated(outbox, v);
      return v;
    });
    app.hub.publishAll(outbox);
    return reply.code(201).send(view);
  });

  app.get('/messages/search', async (req) => {
    const { projectId, q } = z.object({ projectId: z.string().min(1), q: z.string().min(1) }).parse(req.query);
    const rows = await app.prisma.message.findMany({
      where: { projectId, body: { contains: q, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { deliveries: true },
    });
    return rows.map(toMessageView);
  });
}
