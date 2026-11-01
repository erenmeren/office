import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskRun } from '@office/db';
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

  it('propose_memory writes a proposed entry with a run source', async () => {
    const c = await ctx('task');
    const r = (await call(c, 'propose_memory', {
      type: 'decision', title: 'Use X', content: 'because', sources: [{ kind: 'file', ref: 'a.ts' }],
    })) as { ok: true; result: { entryId: string } };
    const e = await t.prisma.memoryEntry.findUniqueOrThrow({ where: { id: r.result.entryId }, include: { sources: true } });
    expect(e).toMatchObject({ status: 'proposed', authorType: 'agent', authorAgentId: a, runId: c.run.id, taskId, projectId });
    expect(e.sources.map((s) => `${s.kind}:${s.ref}`).sort()).toEqual(['file:a.ts', `run:${c.run.id}`]);
    // own proposal is readable; another agent's is not
    expect(await call(c, 'read_memory', { id: e.id })).toMatchObject({ ok: true });
    expect(await call(await ctx('task', {}, b), 'read_memory', { id: e.id })).toMatchObject({ code: 'not_found' });
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
    expect(p).toMatchObject({ status: 'proposed', authorAgentId: a, runId: target.run.id });
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
