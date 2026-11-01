import { afterEach, describe, expect, it } from 'vitest';
import type { RunSpec } from '@office/shared';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until, type FakeWorker } from './fake-worker.js';
import { sendMessage } from '../src/services/message-service.js';
import { createEntry } from '../src/services/memory-service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0.5, numTurns: 1, durationMs: 5 };

async function setup() {
  const t = await makeApp();
  const cookie = await t.login();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });
  const projectId = (await req('POST', '/projects', { name: 'P', slug: 'p1', repoPath: '/tmp/office-ws/p1' })).json().id as string;
  const agent = async (slug: string, maxTurns = 30) =>
    (
      await req('POST', '/agents', {
        name: slug, slug, role: 'dev',
        config: { systemPrompt: 'be nice', model: 'sonnet', allowedTools: ['Read', 'Edit', 'Bash'], maxTurns },
      })
    ).json().id as string;
  const a = await agent('a');
  const b = await agent('b');
  const workers: FakeWorker[] = [];
  const worker = async (capacity = 1) => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w', capacity, allowedRoots: ['/tmp/office-ws'] });
    workers.push(w);
    return w;
  };
  const createTask = async (title = 'Fix the bug', agentId = a) =>
    (await req('POST', '/tasks', { projectId, agentId, title, description: 'details' })).json() as { id: string };
  const assign = async (w: FakeWorker) => {
    await t.app.scheduler.tick();
    return (await w.waitFor('run.assign')).spec;
  };
  const run = (id: string) => t.prisma.taskRun.findUniqueOrThrow({ where: { id }, include: { session: true, task: true } });
  const result = (w: FakeWorker, spec: RunSpec, r: Record<string, unknown>) =>
    w.send({ type: 'run.result', runId: spec.runId, sessionId: spec.sessionId, result: { usage, ...r } });
  const event = (w: FakeWorker, spec: RunSpec, seq: number) =>
    w.send({
      type: 'run.event',
      event: {
        type: 'agent.text', seq, ts: new Date().toISOString(), sessionId: spec.sessionId,
        runId: spec.runId, agentId: spec.agentId, projectId: spec.projectId, payload: { text: `e${seq}` },
      },
    });
  // an error reply to junk proves every earlier message from that worker was handled
  const flush = async (w: FakeWorker) => {
    w.send({ type: 'bogus' });
    await w.waitFor('error');
  };
  const close = async () => {
    for (const w of workers) await w.close();
    await t.close();
  };

  /** A task run of agent `a` that asked `b` a question and suspended. */
  const suspended = async () => {
    const task = await createTask();
    const w = await worker();
    const spec = await assign(w);
    w.send({ type: 'run.accepted', runId: spec.runId });
    event(w, spec, 1);
    event(w, spec, 2);
    const { message } = await sendMessage(t.prisma, t.config.messageLimits, {
      projectId, type: 'question', body: 'Which database?', senderAgentId: a, senderSessionId: spec.sessionId,
      taskId: task.id, recipientAgentIds: [b], awaitReply: true,
    });
    // b's inbox wake is not under test here
    await t.prisma.messageDelivery.updateMany({ where: { messageId: message.id }, data: { status: 'acknowledged' } });
    await t.prisma.taskRun.update({ where: { id: spec.runId }, data: { waitingForMessageId: message.id } });
    result(w, spec, { status: 'suspended', sdkSessionId: 'sdk-1' });
    await flush(w);
    return { task, w, spec, question: message };
  };

  return { t, req, projectId, a, b, agent, worker, createTask, assign, run, result, flush, suspended, close };
}

describe('run lifecycle', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => {
    delete process.env.OFFICE_REPLY_TIMEOUT_MINUTES;
    await s.close();
  });

  it('a suspended result parks the run and frees the worker', async () => {
    s = await setup();
    const { task, spec } = await s.suspended();
    const r = await s.run(spec.runId);
    expect(r.status).toBe('waiting_reply');
    expect(r.leaseExpiresAt).toBeNull();
    expect(r.finishedAt).toBeNull();
    expect(r.waitingSince).toBeTruthy();
    expect(r.workerId).toBeTruthy();
    expect(r.session).toMatchObject({ status: 'waiting_reply', sdkSessionId: 'sdk-1' });
    expect((await s.t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('waiting_reply');
    expect(s.t.app.gateway.onlineWorkers()[0]!.activeRuns).toBe(0);
  });

  it('a reply resumes the run once with the SDK session and startSeq', async () => {
    s = await setup();
    const { task, w, spec, question } = await s.suspended();
    await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'reply', body: 'Use Postgres.', senderAgentId: s.b, inReplyToId: question.id, recipientAgentIds: [],
    });
    const resumed = await s.assign(w);
    const lastSeq = await s.t.prisma.sessionEvent.aggregate({ where: { sessionId: spec.sessionId }, _max: { seq: true } });
    expect(resumed).toMatchObject({ runId: spec.runId, sessionId: spec.sessionId, resumeSdkSessionId: 'sdk-1', kind: 'task' });
    expect(resumed.startSeq).toBe(lastSeq._max.seq);
    expect(resumed.startSeq).toBe(3);
    expect(resumed.prompt).toBe('Reply from b:\nUse Postgres.');
    const ev = await s.t.prisma.sessionEvent.findFirstOrThrow({ where: { sessionId: spec.sessionId, seq: 3 } });
    expect(ev.type).toBe('agent.resumed');
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.filter((m) => m.type === 'run.assign')).toHaveLength(2);
    const r = await s.run(spec.runId);
    expect(r).toMatchObject({ status: 'queued', waitingSince: null, waitingForMessageId: null });
    expect(r.leaseExpiresAt).toBeTruthy();
    expect(await s.t.prisma.taskRun.count()).toBe(1);
    // accept -> task running again; then finish
    w.send({ type: 'run.accepted', runId: spec.runId });
    await until(async () => (await s.run(spec.runId)).task!.status === 'running', 'task running');
    s.result(w, resumed, { status: 'succeeded', resultText: 'done', sdkSessionId: 'sdk-1' });
    await until(async () => (await s.run(spec.runId)).task!.status === 'done', 'task done');
    expect((await s.run(spec.runId)).costUsd).toBe(1);
    expect((await s.t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).attempts).toBe(1);
  });

  it('timeout resumes with the no-reply prompt', async () => {
    process.env.OFFICE_REPLY_TIMEOUT_MINUTES = '0';
    s = await setup();
    const { w, spec } = await s.suspended();
    await sleep(5);
    const resumed = await s.assign(w);
    expect(resumed.runId).toBe(spec.runId);
    expect(resumed.prompt).toBe('No reply was received within 0 minutes. Continue or escalate.');
  });

  const offline = async (w: FakeWorker) => {
    const id = (w.received[0] as { workerId: string }).workerId;
    await w.close();
    await until(async () => !s.t.app.gateway.onlineWorkers().some((x) => x.workerId === id), 'worker offline');
  };
  const assignsOf = (w: FakeWorker, runId: string) =>
    w.received.filter((m) => m.type === 'run.assign' && m.spec.runId === runId);

  it('resumes a waiting_reply run only on its original worker', async () => {
    s = await setup();
    const { w, spec, question } = await s.suspended();
    const other = await s.worker();
    await offline(w);
    await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'reply', body: 'Use Postgres.', senderAgentId: s.b, inReplyToId: question.id, recipientAgentIds: [],
    });
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(assignsOf(other, spec.runId)).toHaveLength(0);
    expect((await s.run(spec.runId)).status).toBe('waiting_reply');

    const back = await connectFakeWorker(s.t.app, { credential: w.credential, name: 'w', capacity: 1, allowedRoots: ['/tmp/office-ws'] });
    try {
      const resumed = await s.assign(back);
      expect(resumed).toMatchObject({ runId: spec.runId, resumeSdkSessionId: 'sdk-1', prompt: 'Reply from b:\nUse Postgres.' });
      expect((await s.run(spec.runId)).workerId).toBe((w.received[0] as { workerId: string }).workerId);
      expect(assignsOf(other, spec.runId)).toHaveLength(0);
    } finally {
      await back.close();
    }
  });

  it('fails a resume whose pinned worker is still offline at the timeout and retries fresh', async () => {
    process.env.OFFICE_REPLY_TIMEOUT_MINUTES = '0';
    s = await setup();
    const { task, w, spec } = await s.suspended();
    await offline(w);
    const other = await s.worker();
    await sleep(5);
    const retry = await s.assign(other);
    const failed = await s.run(spec.runId);
    expect(failed).toMatchObject({ status: 'failed', error: 'pinned worker offline at resume' });
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.session?.status).toBe('failed');
    const ev = await s.t.prisma.sessionEvent.findMany({ where: { sessionId: failed.session!.id, type: 'run.resume.failed' } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ reason: 'pinned worker offline at resume' });
    expect(retry.runId).not.toBe(spec.runId);
    expect(retry.resumeSdkSessionId).toBeUndefined();
    expect(await s.t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'queued', attempts: 2 });
  });

  it('owner cancels a live run; the task is ready again and an audit row exists', async () => {
    s = await setup();
    const task = await s.createTask();
    const w = await s.worker();
    const spec = await s.assign(w);
    w.send({ type: 'run.accepted', runId: spec.runId });
    const res = await s.req('POST', `/runs/${spec.runId}/cancel`);
    expect(res.json()).toEqual({ id: spec.runId, status: 'cancelled' });
    expect((await w.waitFor('run.cancel')).runId).toBe(spec.runId);
    expect(await s.t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'ready', attempts: 0 });
    expect(await s.t.prisma.auditLog.findFirst({ where: { action: 'run.cancelled', targetId: spec.runId } })).toMatchObject({
      targetType: 'run', detail: { taskId: task.id },
    });
    s.result(w, spec, { status: 'succeeded', summary: 'late' });
    await s.flush(w);
    expect((await s.run(spec.runId)).status).toBe('cancelled');
  });

  it('cancelling a summary run lets the parent run be summarized again', async () => {
    s = await setup();
    const summarizer = await s.agent('office-summarizer');
    await s.t.prisma.agent.update({ where: { id: summarizer }, data: { isSystem: true } });
    await s.createTask();
    const w = await s.worker();
    const spec = await s.assign(w);
    s.result(w, spec, { status: 'succeeded', resultText: 'done', sdkSessionId: 'sdk-1' });
    await s.flush(w);
    const sum = await s.assign(w);
    expect((await s.run(spec.runId)).summarizedAt).toBeTruthy();
    await s.req('POST', `/runs/${sum.runId}/cancel`);
    expect((await s.run(spec.runId)).summarizedAt).toBeNull();
  });

  it('cancel of a finished run is 409; ?task=true cancels the task', async () => {
    s = await setup();
    const task = await s.createTask();
    const w = await s.worker();
    const spec = await s.assign(w);
    const res = await s.req('POST', `/runs/${spec.runId}/cancel?task=true`);
    expect(res.statusCode).toBe(200);
    expect((await s.t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('cancelled');
    const again = await s.req('POST', `/runs/${spec.runId}/cancel`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('run_not_live');
  });

  it('a cancelled waiting run is not resumed', async () => {
    s = await setup();
    const { task, w, spec, question } = await s.suspended();
    const res = await s.req('POST', `/tasks/${task.id}/cancel`);
    expect(res.json().status).toBe('cancelled');
    expect((await s.run(spec.runId)).status).toBe('cancelled');
    await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'reply', body: 'late', senderAgentId: s.b, inReplyToId: question.id, recipientAgentIds: [],
    });
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.filter((m) => m.type === 'run.assign')).toHaveLength(1);
  });

  it('a question to an idle agent creates an inbox run; a plain message does not', async () => {
    s = await setup();
    const w = await s.worker();
    await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'message', body: 'fyi', senderAgentId: s.a, recipientAgentIds: [s.b],
    });
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.filter((m) => m.type === 'run.assign')).toHaveLength(0);

    await sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'question', body: 'Which database?', senderAgentId: s.a, recipientAgentIds: [s.b],
    });
    const spec = await s.assign(w);
    expect(spec).toMatchObject({ kind: 'inbox', agentId: s.b, prompt: 'You have new messages. Read your inbox and answer.' });
    expect(spec.maxTurns).toBeLessThanOrEqual(8);
    expect(spec.maxBudgetUsd).toBeLessThanOrEqual(0.25);
    expect(spec.allowedTools).toEqual(['Read']);
    expect(spec.tools).toContain('reply_message');
    expect(spec.tools).not.toContain('submit_summary');
    expect(spec.systemPrompt).toContain('You were woken to answer your inbox.');
    const r = await s.run(spec.runId);
    expect(r).toMatchObject({ kind: 'inbox', taskId: null });
    expect(r.conversationId).toBeTruthy();
    // a second tick does not wake b again while its inbox run is live
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.filter((m) => m.type === 'run.assign')).toHaveLength(1);
  });

  const ask = (from: { senderAgentId?: string; senderUserId?: string }, body = 'Which database?') =>
    sendMessage(s.t.prisma, s.t.config.messageLimits, {
      projectId: s.projectId, type: 'question', body, recipientAgentIds: [s.b], ...from,
    });
  const assigns = (w: FakeWorker) => w.received.filter((m) => m.type === 'run.assign').length;

  it('a lost wake run is retried on the next tick', async () => {
    s = await setup();
    const w = await s.worker();
    await ask({ senderAgentId: s.a });
    const first = await s.assign(w);
    await s.t.prisma.taskRun.update({ where: { id: first.runId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const second = await s.assign(w);
    expect((await s.run(first.runId)).status).toBe('lost');
    expect(second).toMatchObject({ kind: 'inbox', agentId: s.b });
    expect(second.runId).not.toBe(first.runId);
    expect(await s.t.prisma.messageDelivery.count({ where: { status: 'pending' } })).toBe(1);
  });

  it('stops waking after two wake runs newer than the delivery', async () => {
    s = await setup();
    const w = await s.worker();
    await ask({ senderAgentId: s.a });
    for (let i = 0; i < 2; i++) {
      const spec = await s.assign(w);
      // ends without reading the inbox
      s.result(w, spec, { status: 'succeeded', resultText: 'nothing' });
      await s.flush(w);
    }
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(assigns(w)).toBe(2);
    expect(await s.t.prisma.messageDelivery.count({ where: { status: 'pending' } })).toBe(1);
  });

  it('an owner question still pending after an inbox run gets its own chat run', async () => {
    s = await setup();
    const w = await s.worker();
    const owner = await s.t.prisma.user.findFirstOrThrow();
    await ask({ senderAgentId: s.a });
    const { message: human } = await ask({ senderUserId: owner.id }, 'Status?');
    const inbox = await s.assign(w);
    expect(inbox.kind).toBe('inbox');
    s.result(w, inbox, { status: 'succeeded', resultText: 'nothing' });
    await s.flush(w);
    const chat = await s.assign(w);
    expect(chat).toMatchObject({ kind: 'chat', agentId: s.b });
    expect((await s.run(chat.runId)).conversationId).toBe(human.conversationId);
  });

  it('finished runs wait for a summarizer to be seeded', async () => {
    s = await setup();
    await s.createTask('Pick the database');
    const w = await s.worker();
    const spec = await s.assign(w);
    s.result(w, spec, { status: 'succeeded', resultText: 'Picked Postgres', sdkSessionId: 'sdk-1' });
    await s.flush(w);
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(assigns(w)).toBe(1);
    expect((await s.run(spec.runId)).summarizedAt).toBeNull();
    const summarizer = await s.agent('office-summarizer');
    await s.t.prisma.agent.update({ where: { id: summarizer }, data: { isSystem: true } });
    const sum = await s.assign(w);
    expect(sum).toMatchObject({ kind: 'summary', agentId: summarizer });
    expect((await s.run(spec.runId)).summarizedAt).toBeTruthy();
  });

  it('a finished task run gets one summary run for office-summarizer', async () => {
    s = await setup();
    const summarizer = await s.agent('office-summarizer');
    await s.t.prisma.agent.update({ where: { id: summarizer }, data: { isSystem: true } });
    const task = await s.createTask('Pick the database');
    const w = await s.worker();
    const spec = await s.assign(w);
    s.result(w, spec, { status: 'succeeded', resultText: 'Picked Postgres', sdkSessionId: 'sdk-1' });
    await s.flush(w);

    const sum = await s.assign(w);
    expect(sum).toMatchObject({ kind: 'summary', agentId: summarizer, allowedTools: [], skills: [], subagents: [] });
    expect(sum.tools).toEqual(['submit_summary']);
    expect(sum.prompt).toContain('Pick the database');
    expect(sum.prompt).toContain('Picked Postgres');
    expect(sum.systemPrompt).toContain('Call submit_summary exactly once.');
    expect((await s.run(spec.runId)).summarizedAt).toBeTruthy();
    expect(await s.run(sum.runId)).toMatchObject({ kind: 'summary', taskId: task.id, summaryOfRunId: spec.runId });

    s.result(w, sum, { status: 'succeeded', resultText: 'summarized' });
    await s.flush(w);
    await s.t.app.scheduler.tick();
    await sleep(100);
    expect(w.received.filter((m) => m.type === 'run.assign')).toHaveLength(2);
    expect((await s.t.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('done');
  });

  it('context pack reaches the spec and the session', async () => {
    s = await setup();
    const entry = await createEntry(s.t.prisma, {
      projectId: s.projectId, scope: 'project', type: 'decision', title: 'Database choice',
      content: 'We use Postgres for everything.', authorType: 'owner', status: 'verified', sources: [],
    });
    await s.createTask('Database migration');
    const w = await s.worker();
    const spec = await s.assign(w);
    expect(spec.systemPrompt).toContain(`m:${entry.id}`);
    const run = (await s.req('GET', `/runs/${spec.runId}`)).json();
    expect(run.kind).toBe('task');
    expect(run.session.contextPack.entryIds).toContain(entry.id);
    expect(run.session.contextPack.chars).toBeGreaterThan(0);
  });
});
