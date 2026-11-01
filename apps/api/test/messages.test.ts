import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessageLimitsSchema } from '@office/shared';
import {
  findOrCreateConversation,
  markDelivered,
  MessageError,
  pendingWakeDeliveries,
  readInbox,
  sendMessage,
} from '../src/services/message-service.js';
import { makeApp } from './helpers.js';

const limits = MessageLimitsSchema.parse({});

describe('message bus', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let projectId: string;
  let a: string;
  let b: string;
  let sys: string;
  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
    projectId = (await t.prisma.project.create({ data: { name: 'P', slug: 'p', repoPath: '/tmp/p' } })).id;
    const mk = async (slug: string, isSystem = false) =>
      (await t.prisma.agent.create({ data: { name: slug, slug, role: 'dev', isSystem } })).id;
    a = await mk('a');
    b = await mk('b');
    sys = await mk('sys', true);
  });
  afterAll(() => t.close());

  const send = (over: Partial<Parameters<typeof sendMessage>[2]> = {}) =>
    sendMessage(t.prisma, limits, {
      projectId, type: 'message', body: 'hi', senderAgentId: a, recipientAgentIds: [b], ...over,
    });
  const err = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(MessageError);
      return (e as MessageError).code;
    }
    return 'no error';
  };

  it('owner creates a human conversation and sends a question', async () => {
    const seen: unknown[] = [];
    const off = t.app.hub.subscribe('global', (m) => seen.push(m));
    const conv = await t.app.inject({
      method: 'POST', url: '/conversations', headers: { cookie },
      payload: { projectId, kind: 'human', agentIds: [a] },
    });
    expect(conv.statusCode).toBe(201);
    const id = conv.json().id;
    const sent = await t.app.inject({
      method: 'POST', url: `/conversations/${id}/messages`, headers: { cookie },
      payload: { type: 'question', body: 'status?' },
    });
    off();
    expect(sent.statusCode).toBe(201);
    expect(sent.json().deliveries).toEqual([{ recipientAgentId: a, recipientUserId: null, status: 'pending' }]);
    const got = (await t.app.inject({ method: 'GET', url: `/conversations/${id}`, headers: { cookie } })).json();
    expect(got.messages.map((m: { body: string }) => m.body)).toEqual(['status?']);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'message.created' }));
    const other = await t.app.inject({ method: 'GET', url: '/conversations/nope', headers: { cookie } });
    expect(other.statusCode).toBe(404);
  });

  it('direct conversations are reused per pair', async () => {
    const m1 = await send();
    const m2 = await send({ senderAgentId: b, recipientAgentIds: [a] });
    expect(m1.message.conversationId).toBe(m2.message.conversationId);
  });

  it('self message, unknown recipient and system recipient are rejected', async () => {
    expect(await err(send({ recipientAgentIds: [a] }))).toBe('self_message');
    expect(await err(send({ recipientAgentIds: ['nope'] }))).toBe('unknown_recipient');
    expect(await err(send({ recipientAgentIds: [sys] }))).toBe('unknown_recipient');
  });

  it('limits', async () => {
    for (let i = 0; i < 20; i++) await send({ senderSessionId: 's-lim' });
    expect(await err(send({ senderSessionId: 's-lim' }))).toBe('limit_exceeded');

    const e1 = await send({ type: 'escalation' });
    const e2 = await send({ type: 'escalation', inReplyToId: e1.message.id });
    expect(e2.message.escalationDepth).toBe(2);
    expect(await err(send({ type: 'escalation', inReplyToId: e2.message.id }))).toBe('limit_exceeded');

    let prev = (await send({ type: 'handoff' })).message;
    for (let i = 0; i < 2; i++) prev = (await send({ type: 'handoff', inReplyToId: prev.id })).message;
    expect(prev.handoffChain).toBe(3);
    expect(await err(send({ type: 'handoff', inReplyToId: prev.id }))).toBe('limit_exceeded');
  });

  it('idempotency', async () => {
    const one = await send({ idempotencyKey: 'k1' });
    const two = await send({ idempotencyKey: 'k1' });
    expect(one.created).toBe(true);
    expect(two.created).toBe(false);
    expect(two.message.id).toBe(one.message.id);
    expect(await t.prisma.message.count({ where: { idempotencyKey: 'k1' } })).toBe(1);
  });

  it('reply must answer a message delivered to the sender', async () => {
    const q = await send({ type: 'question' });
    expect(await err(send({ type: 'reply', inReplyToId: q.message.id, recipientAgentIds: [a] }))).toBe('bad_reply');
    const r = await send({ type: 'reply', inReplyToId: q.message.id, senderAgentId: b, recipientAgentIds: [a] });
    expect(r.message.type).toBe('reply');
    expect(r.message.inReplyToId).toBe(q.message.id);
  });

  it('readInbox acknowledges and returns oldest first', async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "MessageDelivery","Message","Conversation" CASCADE');
    await send({ body: 'one' });
    await send({ body: 'two' });
    const first = await readInbox(t.prisma, { agentId: b, projectId, limit: 10 });
    expect(first.map((m) => m.body)).toEqual(['one', 'two']);
    expect(await readInbox(t.prisma, { agentId: b, projectId, limit: 10 })).toEqual([]);
    const d = await t.prisma.messageDelivery.findMany();
    expect(d.every((x) => x.status === 'acknowledged' && x.acknowledgedAt)).toBe(true);
    await markDelivered(t.prisma, d.map((x) => x.id));
  });

  it('pendingWakeDeliveries lists question but not message', async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "MessageDelivery","Message","Conversation" CASCADE');
    await send({ type: 'message' });
    expect(await pendingWakeDeliveries(t.prisma)).toEqual([]);
    const q = await send({ type: 'question' });
    expect(await pendingWakeDeliveries(t.prisma)).toEqual([
      { agentId: b, projectId, conversationId: q.message.conversationId },
    ]);
  });

  it('task conversations are one per task', async () => {
    const task = await t.prisma.task.create({ data: { projectId, agentId: a, title: 'T', status: 'ready' } });
    const base = { projectId, kind: 'task' as const, agentIds: [a], includesOwner: false, title: 'x', taskId: task.id };
    const c1 = await findOrCreateConversation(t.prisma, base);
    const c2 = await findOrCreateConversation(t.prisma, base);
    expect(c1.id).toBe(c2.id);
    expect(c1.title).toBe('T');
  });
});
