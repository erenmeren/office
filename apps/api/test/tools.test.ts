import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskRun } from '@office/db';
import { sendMessage } from '../src/services/message-service.js';
import { executeTool } from '../src/services/tool-service.js';
import { makeApp } from './helpers.js';

describe('office tools', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let projectId: string;
  let otherProjectId: string;
  let a: string;
  let b: string;
  let taskId: string;
  const ids = {} as Record<string, string>;
  beforeAll(async () => {
    t = await makeApp();
    projectId = (await t.prisma.project.create({ data: { name: 'P', slug: 'p', repoPath: '/tmp/p' } })).id;
    otherProjectId = (await t.prisma.project.create({ data: { name: 'Q', slug: 'q', repoPath: '/tmp/q' } })).id;
    const mk = async (slug: string, isSystem = false) =>
      (await t.prisma.agent.create({ data: { name: slug, slug, role: 'dev', isSystem } })).id;
    a = await mk('a');
    b = await mk('b');
    ids.sys = await mk('sys', true);
    taskId = (await t.prisma.task.create({ data: { projectId, agentId: a, title: 'Do it' } })).id;
  });
  afterAll(() => t.close());

  // a leased run + session for agent `agentId`
  const ctx = async (kind: TaskRun['kind'], over: Partial<TaskRun> = {}, agentId = a) => {
    const v = await t.prisma.agentVersion.create({
      data: { agentId, version: (await t.prisma.agentVersion.count({ where: { agentId } })) + 1, config: {} },
    });
    const run = await t.prisma.taskRun.create({
      data: { agentId, projectId, kind, agentVersionId: v.id, status: 'running', taskId: kind === 'task' ? taskId : null, ...over },
    });
    const session = await t.prisma.agentSession.create({
      data: { runId: run.id, agentId, projectId, model: 'sonnet', status: 'running', startedAt: new Date() },
    });
    return { run, session };
  };
  const call = (c: Awaited<ReturnType<typeof ctx>>, name: string, args: unknown) =>
    executeTool(t.prisma, t.app.hub, t.config, c, name, args);

  it('send_message to another agent writes the message and a pending delivery; result carries messageId', async () => {
    const seen: unknown[] = [];
    const off = t.app.hub.subscribe('global', (m) => seen.push(m));
    const r = await call(await ctx('task'), 'send_message', { to: 'b', body: 'hello', type: 'question' });
    off();
    expect(r).toMatchObject({ ok: true });
    const { messageId } = (r as { result: { messageId: string } }).result;
    const m = await t.prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: { deliveries: true } });
    expect(m).toMatchObject({ senderAgentId: a, taskId, projectId, type: 'question' });
    expect(m.deliveries).toMatchObject([{ recipientAgentId: b, status: 'pending' }]);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'message.created' }));
  });

  it('unknown slug and system agent are unknown_recipient', async () => {
    const c = await ctx('task');
    expect(await call(c, 'send_message', { to: 'nope', body: 'x' })).toMatchObject({ code: 'unknown_recipient' });
    expect(await call(c, 'send_message', { to: 'sys', body: 'x' })).toMatchObject({ code: 'unknown_recipient' });
  });

  it('awaitReply suspends: result.suspend is true and the run has waitingForMessageId', async () => {
    const c = await ctx('task');
    const r = await call(c, 'send_message', { to: 'b', body: 'q?', type: 'question', awaitReply: true });
    expect(r).toMatchObject({ ok: true, suspend: true });
    const { messageId } = (r as { result: { messageId: string } }).result;
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: c.run.id } })).waitingForMessageId).toBe(messageId);
    expect((await t.prisma.message.findUniqueOrThrow({ where: { id: messageId } })).awaitingReply).toBe(true);
  });

  it('inbox run cannot awaitReply', async () => {
    const c = await ctx('inbox');
    const before = await t.prisma.message.count();
    expect(await call(c, 'send_message', { to: 'b', body: 'q?', awaitReply: true })).toMatchObject({
      ok: false,
      code: 'not_allowed',
    });
    expect(await t.prisma.message.count()).toBe(before);
  });

  it('handoff_task reassigns the task to the recipient', async () => {
    const task = await t.prisma.task.create({ data: { projectId, agentId: a, title: 'H' } });
    const c = await ctx('task', { taskId: task.id });
    expect(await call(c, 'handoff_task', { to: 'b', body: 'yours' })).toMatchObject({ ok: true });
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).agentId).toBe(b);
  });

  it('handoff ping-pong A->B->A->B: the 4th handoff is limit_exceeded (chain 3) and writes nothing', async () => {
    const task = await t.prisma.task.create({ data: { projectId, agentId: a, title: 'Ping-pong' } });
    const hand = async (from: string, to: string) => call(await ctx('task', { taskId: task.id }, from), 'handoff_task', { to, body: 'yours' });
    expect(await hand(a, 'b')).toMatchObject({ ok: true });
    expect(await hand(b, 'a')).toMatchObject({ ok: true });
    expect(await hand(a, 'b')).toMatchObject({ ok: true });
    const chains = await t.prisma.message.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' } });
    expect(chains.map((m) => m.handoffChain)).toEqual([1, 2, 3]);
    expect(chains[1]!.inReplyToId).toBe(chains[0]!.id);
    const before = await t.prisma.message.count();
    expect(await hand(b, 'a')).toMatchObject({ ok: false, code: 'limit_exceeded' });
    expect(await t.prisma.message.count()).toBe(before);
    // the rejected handoff did not reassign the task either
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).agentId).toBe(b);
  });

  it('escalation depth grows across agents; beyond depth 2 is limit_exceeded and writes nothing', async () => {
    const chief = (await t.prisma.agent.create({ data: { name: 'chief', slug: 'chief', role: 'lead' } })).id;
    const task = await t.prisma.task.create({ data: { projectId, agentId: a, title: 'Escalate' } });
    // b escalated to a (depth 1); a escalates to the chief from it -> depth 2
    const first = await sendMessage(t.prisma, t.config.messageLimits, {
      projectId, senderAgentId: b, taskId: task.id, type: 'escalation', body: 'stuck', recipientAgentIds: [a],
    });
    const r = (await call(await ctx('task', { taskId: task.id }, a), 'escalate_to_chief', { body: 'help' })) as {
      ok: true; result: { messageId: string };
    };
    expect(await t.prisma.message.findUniqueOrThrow({ where: { id: r.result.messageId } })).toMatchObject({
      escalationDepth: 2, inReplyToId: first.message.id,
    });
    // a depth-2 escalation reaches b; b escalating again would be depth 3
    await sendMessage(t.prisma, t.config.messageLimits, {
      projectId, senderAgentId: chief, taskId: task.id, type: 'escalation', body: 'deeper', recipientAgentIds: [b], inReplyToId: first.message.id,
    });
    const before = await t.prisma.message.count();
    expect(await call(await ctx('task', { taskId: task.id }, b), 'escalate_to_chief', { body: 'help' })).toMatchObject({
      ok: false, code: 'limit_exceeded',
    });
    expect(await t.prisma.message.count()).toBe(before);
  });

  it('reply_message with another project\'s message id is not_found', async () => {
    const foreign = await sendMessage(t.prisma, t.config.messageLimits, {
      projectId: otherProjectId, senderAgentId: b, type: 'question', body: 'elsewhere', recipientAgentIds: [a],
    });
    const before = await t.prisma.message.count();
    expect(await call(await ctx('task'), 'reply_message', { messageId: foreign.message.id, body: 'x' })).toMatchObject({
      ok: false, code: 'not_found',
    });
    expect(await t.prisma.message.count()).toBe(before);
  });

  it('read_inbox returns and acknowledges; reply_message answers', async () => {
    const ca = await ctx('task');
    const cb = await ctx('inbox', {}, b);
    const sent = (await call(ca, 'send_message', { to: 'b', body: 'ping', type: 'question' })) as {
      result: { messageId: string };
    };
    const inbox = (await call(cb, 'read_inbox', {})) as { result: { messages: { id: string }[] } };
    expect(inbox.result.messages.map((m) => m.id)).toContain(sent.result.messageId);
    expect(((await call(cb, 'read_inbox', {})) as { result: { messages: unknown[] } }).result.messages).toEqual([]);
    expect(await call(cb, 'reply_message', { messageId: sent.result.messageId, body: 'pong' })).toMatchObject({ ok: true });
    expect(await t.prisma.message.count({ where: { inReplyToId: sent.result.messageId, type: 'reply' } })).toBe(1);
  });

  it('list_agents lists active non-system agents', async () => {
    const r = (await call(await ctx('task'), 'list_agents', {})) as { result: { agents: { slug: string }[] } };
    const slugs = r.result.agents.map((x) => x.slug);
    expect(slugs).toEqual(expect.arrayContaining(['a', 'b']));
    expect(slugs).not.toContain('sys');
  });

  it('tool calls cannot cross projects', async () => {
    const other = await t.prisma.conversation.create({
      data: { projectId: otherProjectId, kind: 'direct', agentIds: [], title: 'x' },
    });
    const mem = await t.prisma.memoryEntry.create({
      data: { projectId: otherProjectId, scope: 'project', type: 'decision', title: 'T', content: 'C', authorType: 'user', status: 'verified' },
    });
    const c = await ctx('task');
    expect(await call(c, 'get_conversation', { conversationId: other.id })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await call(c, 'read_memory', { id: mem.id })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('read_memory hides rejected entries and other agents proposals', async () => {
    const mk = (status: 'rejected' | 'proposed', authorAgentId: string) =>
      t.prisma.memoryEntry.create({
        data: { projectId, scope: 'project', type: 'decision', title: 'T', content: 'C', authorType: 'agent', authorAgentId, status },
      });
    const c = await ctx('task');
    expect(await call(c, 'read_memory', { id: (await mk('rejected', b)).id })).toMatchObject({ code: 'not_found' });
    expect(await call(c, 'read_memory', { id: (await mk('proposed', b)).id })).toMatchObject({ code: 'not_found' });
    expect(await call(c, 'read_memory', { id: (await mk('proposed', a)).id })).toMatchObject({ ok: true });
  });

  it('propose_memory records the entry at once, with a run source: the owner is not asked (2026-11-14)', async () => {
    const c = await ctx('task');
    const r = (await call(c, 'propose_memory', {
      type: 'decision', title: 'Use X', content: 'because', sources: [{ kind: 'file', ref: 'a.ts' }],
    })) as { ok: true; result: { entryId: string; status: string } };
    expect(r.result.status).toBe('verified');
    const e = await t.prisma.memoryEntry.findUniqueOrThrow({ where: { id: r.result.entryId }, include: { sources: true } });
    expect(e).toMatchObject({ status: 'verified', authorType: 'agent', authorAgentId: a, runId: c.run.id, taskId, projectId });
    expect(e.verifiedAt).not.toBeNull();
    // nothing waits for the owner, and a teammate finds it before writing the same note again
    expect(await t.prisma.memoryEntry.count({ where: { runId: c.run.id, status: 'proposed' } })).toBe(0);
    expect(e.sources.map((s) => `${s.kind}:${s.ref}`).sort()).toEqual(['file:a.ts', `run:${c.run.id}`]);
    // the author reads it, and so does a teammate
    expect(await call(c, 'read_memory', { id: e.id })).toMatchObject({ ok: true });
    expect(await call(await ctx('task', {}, b), 'read_memory', { id: e.id })).toMatchObject({ ok: true });
  });

  it('propose_memory with scope agent_project keeps the author as agentId', async () => {
    const r = (await call(await ctx('task'), 'propose_memory', {
      scope: 'agent_project', type: 'lesson', title: 'My lesson', content: 'c', sources: [],
    })) as { ok: true; result: { entryId: string } };
    expect(await t.prisma.memoryEntry.findUniqueOrThrow({ where: { id: r.result.entryId } })).toMatchObject({
      scope: 'agent_project', agentId: a, projectId,
    });
  });

  it('submit_summary writes one verified task_summary; second call -> already_submitted; task_summary proposal -> invalid_args', async () => {
    const target = await ctx('task');
    const c = await ctx('summary', { summaryOfRunId: target.run.id, taskId: null });
    expect(
      await call(c, 'submit_summary', { summary: 's', proposals: [{ type: 'task_summary', title: 'x', content: 'y' }] }),
    ).toMatchObject({ ok: false, code: 'invalid_args' });
    const r = (await call(c, 'submit_summary', {
      summary: 'did things',
      proposals: [{ type: 'lesson', title: 'L', content: 'c' }],
    })) as { ok: true; result: { entryId: string; proposalIds: string[] } };
    expect(r.ok).toBe(true);
    const e = await t.prisma.memoryEntry.findUniqueOrThrow({ where: { id: r.result.entryId }, include: { sources: true } });
    expect(e).toMatchObject({ type: 'task_summary', status: 'verified', authorType: 'system', runId: target.run.id, taskId, title: 'Summary: Do it' });
    expect(e.sources.map((s) => s.kind).sort()).toEqual(['run', 'task']);
    const p = await t.prisma.memoryEntry.findUniqueOrThrow({ where: { id: r.result.proposalIds[0]! } });
    expect(p).toMatchObject({ status: 'verified', authorAgentId: a, runId: target.run.id });
    expect(await call(c, 'submit_summary', { summary: 'again' })).toMatchObject({ ok: false, code: 'already_submitted' });
    expect(await t.prisma.memoryEntry.count({ where: { runId: target.run.id, type: 'task_summary' } })).toBe(1);
  });

  it('unknown tool -> unknown_tool; summary run calling send_message -> unknown_tool', async () => {
    expect(await call(await ctx('task'), 'nope', {})).toMatchObject({ ok: false, code: 'unknown_tool' });
    expect(await call(await ctx('summary'), 'send_message', { to: 'b', body: 'x' })).toMatchObject({ code: 'unknown_tool' });
    expect(await call(await ctx('task'), 'submit_summary', { summary: 'x' })).toMatchObject({ code: 'unknown_tool' });
  });

  it('invalid args -> invalid_args', async () => {
    expect(await call(await ctx('task'), 'send_message', { to: 'b' })).toMatchObject({ ok: false, code: 'invalid_args' });
  });
});
