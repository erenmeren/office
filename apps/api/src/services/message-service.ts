import type { Conversation, Message, MessageDelivery } from '@office/db';
import { CONDUCTOR_SLUG, WAKE_TYPES, type MessageLimits, type MessageView } from '@office/shared';
import type { Outbox } from './event-hub.js';
import type { Db } from './task-service.js';

export type MessageErrorCode =
  | 'not_found'
  | 'self_message'
  | 'limit_exceeded'
  | 'unknown_recipient'
  | 'bad_reply'
  | 'forbidden';

export class MessageError extends Error {
  constructor(
    public code: MessageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Kind = Conversation['kind'];
type MessageWithDeliveries = Message & { deliveries: MessageDelivery[] };

export function toMessageView(m: MessageWithDeliveries): MessageView {
  return {
    id: m.id,
    conversationId: m.conversationId,
    projectId: m.projectId,
    type: m.type,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    senderAgentId: m.senderAgentId,
    senderUserId: m.senderUserId,
    taskId: m.taskId,
    inReplyToId: m.inReplyToId,
    deliveries: m.deliveries.map((d) => ({
      recipientAgentId: d.recipientAgentId,
      recipientUserId: d.recipientUserId,
      status: d.status,
    })),
  };
}

/** Queue `message.created` for the conversation topic and `global`; publish after the transaction commits. */
export function queueMessageCreated(outbox: Outbox, view: MessageView): void {
  const message = { type: 'message.created' as const, topic: `conversation:${view.conversationId}`, message: view };
  outbox.push({ topic: message.topic, message }, { topic: 'global', message });
}

export async function findOrCreateConversation(
  db: Db,
  input: { projectId: string; kind: Kind; agentIds: string[]; includesOwner: boolean; title: string; taskId?: string },
): Promise<Conversation> {
  const { projectId, kind, includesOwner, title, taskId } = input;
  const agentIds = [...new Set(input.agentIds)];
  const create = (data: Partial<Conversation> = {}) =>
    db.conversation.create({ data: { projectId, kind, agentIds, includesOwner, title, taskId, ...data } });

  if (kind === 'task') {
    if (!taskId) throw new MessageError('not_found', 'task conversation needs a taskId');
    const existing = await db.conversation.findFirst({ where: { projectId, kind, taskId } });
    if (existing) return existing;
    const task = await db.task.findFirst({ where: { id: taskId, projectId } });
    if (!task) throw new MessageError('not_found', 'task not found');
    return create({ title: task.title });
  }
  if (kind === 'direct') {
    const candidates = await db.conversation.findMany({
      where: { projectId, kind, includesOwner: false, agentIds: { hasEvery: agentIds } },
    });
    const existing = candidates.find((c) => c.agentIds.length === agentIds.length);
    return existing ?? create({ includesOwner: false });
  }
  if (kind === 'human') {
    const existing = await db.conversation.findFirst({
      where: { projectId, kind, includesOwner: true, agentIds: { equals: agentIds.slice(0, 1) } },
    });
    return existing ?? create({ agentIds: agentIds.slice(0, 1), includesOwner: true });
  }
  return create();
}

export interface SendInput {
  projectId: string;
  conversationId?: string;
  kind?: Kind;
  type: Message['type'];
  body: string;
  senderAgentId?: string;
  senderUserId?: string;
  senderSessionId?: string;
  /** accepted for later tasks; not stored */
  senderRunId?: string;
  taskId?: string;
  recipientAgentIds: string[];
  recipientUser?: boolean;
  recipientUserId?: string;
  inReplyToId?: string;
  awaitReply?: boolean;
  idempotencyKey?: string;
}

type SendResult = { message: Message; deliveries: MessageDelivery[]; created: boolean };

/** Runs in its own transaction (unless the caller already passed one) so the limit check and insert are atomic. */
export function sendMessage(db: Db, limits: MessageLimits, input: SendInput): Promise<SendResult> {
  if ('$transaction' in db) return db.$transaction((tx) => sendInTx(tx, limits, input));
  return sendInTx(db, limits, input);
}

async function sendInTx(db: Db, limits: MessageLimits, input: SendInput): Promise<SendResult> {
  const { projectId, senderAgentId } = input;
  // serialize concurrent senders sharing a cap; released at commit
  for (const key of [input.senderSessionId && `s:${input.senderSessionId}`, input.taskId && `t:${input.taskId}`]) {
    if (key) await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
  }
  const withDeliveries = (id: string) => db.message.findUniqueOrThrow({ where: { id }, include: { deliveries: true } });

  if (input.idempotencyKey) {
    const existing = await db.message.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { deliveries: true },
    });
    if (existing) return { message: existing, deliveries: existing.deliveries, created: false };
  }

  let recipientAgentIds = [...new Set(input.recipientAgentIds)];
  let recipientUser = input.recipientUser ?? false;

  let parent: Message | null = null;
  if (input.inReplyToId) {
    parent = await db.message.findFirst({
      where: { id: input.inReplyToId, projectId },
      include: { deliveries: true },
    });
    if (!parent) throw new MessageError('not_found', 'inReplyTo message not found');
  }
  if (input.type === 'reply') {
    const p = parent as (Message & { deliveries: MessageDelivery[] }) | null;
    const addressed = p?.deliveries.some((d) =>
      senderAgentId ? d.recipientAgentId === senderAgentId : input.senderUserId ? d.recipientUserId !== null : false,
    );
    if (!p || !addressed) throw new MessageError('bad_reply', 'reply must answer a message delivered to the sender');
    if (recipientAgentIds.length === 0 && !recipientUser) {
      if (p.senderAgentId) recipientAgentIds = [p.senderAgentId];
      else recipientUser = true;
    }
  }

  if (senderAgentId && recipientAgentIds.includes(senderAgentId)) {
    throw new MessageError('self_message', 'an agent cannot message itself');
  }
  if (recipientAgentIds.length > 0) {
    // system agents get no mail, except the Conductor from the owner
    const found = await db.agent.count({
      where: { id: { in: recipientAgentIds }, OR: [{ isSystem: false }, ...(input.senderUserId ? [{ slug: CONDUCTOR_SLUG }] : [])] },
    });
    if (found !== recipientAgentIds.length) throw new MessageError('unknown_recipient', 'unknown recipient agent');
  }

  if (input.senderSessionId) {
    const n = await db.message.count({ where: { senderSessionId: input.senderSessionId } });
    if (n >= limits.perSession) throw new MessageError('limit_exceeded', 'per-session message limit reached');
  }
  if (input.taskId) {
    const n = await db.message.count({ where: { taskId: input.taskId } });
    if (n >= limits.perTask) throw new MessageError('limit_exceeded', 'per-task message limit reached');
  }
  const escalationDepth = input.type === 'escalation' ? (parent?.escalationDepth ?? 0) + 1 : 0;
  const handoffChain = input.type === 'handoff' ? (parent?.handoffChain ?? 0) + 1 : 0;
  if (escalationDepth > limits.escalationDepth) throw new MessageError('limit_exceeded', 'escalation depth limit reached');
  if (handoffChain > limits.handoffChain) throw new MessageError('limit_exceeded', 'handoff chain limit reached');

  let ownerId: string | null = null;
  if (recipientUser) {
    ownerId = input.recipientUserId ?? (await db.user.findFirst({ orderBy: { createdAt: 'asc' } }))?.id ?? null;
    if (!ownerId) throw new MessageError('unknown_recipient', 'no owner to deliver to');
  }

  let conversation: Conversation;
  if (input.conversationId) {
    const c = await db.conversation.findFirst({ where: { id: input.conversationId, projectId } });
    if (!c) throw new MessageError('not_found', 'conversation not found');
    conversation = c;
  } else {
    const kind: Kind = input.kind ?? (input.taskId ? 'task' : recipientUser || input.senderUserId ? 'human' : 'direct');
    const agents = [...new Set([...(senderAgentId ? [senderAgentId] : []), ...recipientAgentIds])];
    conversation = await findOrCreateConversation(db, {
      projectId,
      kind,
      agentIds: agents,
      includesOwner: kind === 'human' || recipientUser || !!input.senderUserId,
      title: kind === 'direct' ? 'Direct' : 'Conversation',
      taskId: input.taskId,
    });
  }

  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      projectId,
      type: input.type,
      body: input.body,
      senderAgentId,
      senderUserId: input.senderUserId,
      senderSessionId: input.senderSessionId,
      taskId: input.taskId,
      inReplyToId: input.inReplyToId,
      awaitingReply: input.awaitReply ?? false,
      idempotencyKey: input.idempotencyKey,
      escalationDepth,
      handoffChain,
    },
  });
  await db.messageDelivery.createMany({
    data: [
      ...recipientAgentIds.map((recipientAgentId) => ({ messageId: message.id, recipientAgentId })),
      ...(ownerId ? [{ messageId: message.id, recipientUserId: ownerId }] : []),
    ],
  });
  await db.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
  const full = await withDeliveries(message.id);
  return { message: full, deliveries: full.deliveries, created: true };
}

export async function readInbox(
  db: Db,
  input: { agentId: string; projectId: string; limit: number },
): Promise<MessageView[]> {
  const messages = await db.message.findMany({
    where: {
      projectId: input.projectId,
      deliveries: { some: { recipientAgentId: input.agentId, status: { in: ['pending', 'delivered'] } } },
    },
    orderBy: { createdAt: 'asc' },
    take: input.limit,
    include: { deliveries: true },
  });
  await db.messageDelivery.updateMany({
    where: {
      messageId: { in: messages.map((m) => m.id) },
      recipientAgentId: input.agentId,
      status: { in: ['pending', 'delivered'] },
    },
    data: { status: 'acknowledged', acknowledgedAt: new Date() },
  });
  return messages.map((m) =>
    toMessageView({
      ...m,
      deliveries: m.deliveries.map((d) => (d.recipientAgentId === input.agentId ? { ...d, status: 'acknowledged' } : d)),
    }),
  );
}

export async function markDelivered(db: Db, deliveryIds: string[]): Promise<void> {
  await db.messageDelivery.updateMany({
    where: { id: { in: deliveryIds }, status: 'pending' },
    data: { status: 'delivered', deliveredAt: new Date() },
  });
}

export type WakeDelivery = { id: string; conversationId: string; conversationKind: Kind; createdAt: Date };

/** Pending wake mail per (agent, project); `conversationId` is the oldest one's, `deliveries` lists all, oldest first. */
export async function pendingWakeDeliveries(
  db: Db,
): Promise<Array<{ agentId: string; projectId: string; conversationId: string; deliveries: WakeDelivery[] }>> {
  const rows = await db.messageDelivery.findMany({
    where: { status: 'pending', recipientAgentId: { not: null }, message: { type: { in: WAKE_TYPES } } },
    orderBy: { createdAt: 'asc' },
    include: { message: { select: { projectId: true, conversationId: true, conversation: { select: { kind: true } } } } },
  });
  const seen = new Map<string, { agentId: string; projectId: string; conversationId: string; deliveries: WakeDelivery[] }>();
  for (const r of rows) {
    const key = `${r.recipientAgentId}:${r.message.projectId}`;
    let entry = seen.get(key);
    if (!entry) {
      entry = { agentId: r.recipientAgentId!, projectId: r.message.projectId, conversationId: r.message.conversationId, deliveries: [] };
      seen.set(key, entry);
    }
    entry.deliveries.push({
      id: r.id,
      conversationId: r.message.conversationId,
      conversationKind: r.message.conversation.kind,
      createdAt: r.createdAt,
    });
  }
  return [...seen.values()];
}

export type ConversationView = Conversation & {
  lastMessage: MessageView | null;
  unreadForOwner: number;
  activeRun: { id: string; status: string } | null;
};

async function decorate(db: Db, c: Conversation): Promise<ConversationView> {
  const [last, unreadForOwner, run] = await Promise.all([
    db.message.findFirst({ where: { conversationId: c.id }, orderBy: { createdAt: 'desc' }, include: { deliveries: true } }),
    db.messageDelivery.count({
      where: { status: 'pending', recipientUserId: { not: null }, message: { conversationId: c.id } },
    }),
    db.taskRun.findFirst({
      where: { conversationId: c.id, status: { in: ['queued', 'running', 'waiting_reply'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    }),
  ]);
  return { ...c, lastMessage: last ? toMessageView(last) : null, unreadForOwner, activeRun: run };
}

export async function conversationView(db: Db, id: string): Promise<ConversationView> {
  const c = await db.conversation.findUnique({ where: { id } });
  if (!c) throw new MessageError('not_found', 'conversation not found');
  return decorate(db, c);
}

export async function listConversations(
  db: Db,
  q: { projectId: string; kind?: Kind; agentId?: string; includesOwner?: boolean },
): Promise<ConversationView[]> {
  const rows = await db.conversation.findMany({
    where: {
      projectId: q.projectId,
      kind: q.kind,
      includesOwner: q.includesOwner,
      agentIds: q.agentId ? { has: q.agentId } : undefined,
    },
    orderBy: { updatedAt: 'desc' },
  });
  return Promise.all(rows.map((c) => decorate(db, c)));
}
