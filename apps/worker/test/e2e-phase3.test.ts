import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp, loadConfig } from '@office/api';
import { createPrisma, seed } from '@office/db';
import { FakeAdapter, machineId } from '@office/runtime';
import { WorkerConnection } from '../src/connection.js';

async function until<T>(fn: () => Promise<T> | T, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`until(${what}) timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Event = { type: string; seq: number; payload: Record<string, unknown> };

describe('phase 3 end to end with the fake runtime', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let prisma: ReturnType<typeof createPrisma>;
  let cookie: string;
  let tempRoot: string;
  let home: string;
  let connection: WorkerConnection | undefined;

  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, payload });
  const getTask = async (id: string) => (await req('GET', `/tasks/${id}`)).json();
  const waitTask = (id: string, status: string) =>
    until(async () => {
      const t = await getTask(id);
      return t.status === status && t;
    }, `task ${status}`);
  const events = async (runId: string) => (await req('GET', `/runs/${runId}/events`)).json() as Event[];

  beforeEach(async () => {
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL_TEST,
      OFFICE_SCHEDULER_INTERVAL_MS: '0',
    });
    prisma = createPrisma(config.databaseUrl);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditLog","CheckResult","Artifact","GitWorkspace","Approval","TaskDependency","ProjectAgent","MemorySource","MemoryEntry","MessageDelivery","Message","Conversation","SubagentRun","SessionEvent","UsageRecord","AgentSession","TaskRun","Task","Mission","AgentSubagent","AgentSkill","AgentVersion","Agent","SkillVersion","Skill","Worker","Project","UserSession","User" CASCADE',
    );
    app = await buildApp(config, { prisma, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const setup = await app.inject({
      method: 'POST', url: '/auth/setup', payload: { email: 'owner@example.com', password: 'password123' },
    });
    cookie = `office_session=${setup.cookies[0]!.value}`;
    tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'office-ws-')));
    home = mkdtempSync(join(tmpdir(), 'office-home-'));
    await seed(prisma, tempRoot);

    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    connection = new WorkerConnection(
      {
        apiUrl: `ws://127.0.0.1:${port}`, home, enrollToken, workspaceRoots: [tempRoot],
        runtime: 'fake', capacity: 2, name: 'e2e', tags: [], canClone: false, machineId: machineId(process.env.OFFICE_DATA_DIR!),
      },
      { adapter: new FakeAdapter(), heartbeatMs: 200, reconnectBaseMs: 300, logger: pino({ level: 'silent' }) },
    );
    await connection.start();
  });

  afterEach(async () => {
    await connection?.stop();
    connection = undefined;
    await app.close();
    await prisma.$disconnect();
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('a message reaches the running session; pause and resume keep the session', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { slug: 'office-sandbox' } });
    const developer = await prisma.agent.findUniqueOrThrow({ where: { slug: 'developer' } });
    const task = (await req('POST', '/tasks', { projectId: project.id, agentId: developer.id, title: 'Slow', description: 'SLOW' })).json();
    await app.scheduler.tick();
    const running = await until(() => prisma.taskRun.findFirst({ where: { taskId: task.id, status: 'running' } }), 'running');

    const conv = (await req('POST', '/conversations', { projectId: project.id, kind: 'human', agentIds: [developer.id] })).json();
    const message = (await req('POST', `/conversations/${conv.id}/messages`, { type: 'message', body: 'Use Redis.' })).json();
    await app.scheduler.tick();
    await until(
      () => prisma.messageDelivery.findFirst({ where: { messageId: message.id, status: 'acknowledged' } }),
      'delivery acknowledged',
    );
    expect((await events(running.id)).find((e) => e.type === 'agent.message.received')?.payload).toMatchObject({ messageId: message.id });

    expect((await req('POST', `/runs/${running.id}/pause`)).statusCode).toBe(200);
    await until(() => prisma.taskRun.findFirst({ where: { id: running.id, status: 'waiting_reply' } }), 'paused');
    await app.scheduler.tick();
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: running.id } })).status).toBe('waiting_reply');
    expect((await req('POST', `/runs/${running.id}/resume`, {})).statusCode).toBe(200);
    await app.scheduler.tick();
    await until(() => prisma.taskRun.findFirst({ where: { id: running.id, status: 'succeeded' } }), 'resumed run finished');
  });

  it('question, suspend, inbox run, reply, resume, summary, memory and context pack', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { slug: 'office-sandbox' } });
    const projectId = project.id;
    const agent = (slug: string) => prisma.agent.findUniqueOrThrow({ where: { slug } });
    const developer = await agent('developer');
    const architect = await agent('architect');
    const summarizer = await agent('office-summarizer');

    // 1. the developer proposes a memory, asks the architect and suspends
    // MEMO comes first: the fake adapter stops reading markers at ASK and a resumed run makes no tool calls
    const task = (
      await req('POST', '/tasks', {
        projectId, agentId: developer.id, title: 'Pick a database', description: 'MEMO:Use Postgres\nASK:architect:Which database?',
      })
    ).json();
    await app.scheduler.tick();
    const waiting = await waitTask(task.id, 'waiting_reply');
    const devRunId: string = waiting.runs[0].id;
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: devRunId } })).status).toBe('waiting_reply');
    const question = await prisma.message.findFirstOrThrow({ where: { type: 'question' }, include: { deliveries: true } });
    expect(question.body).toBe('Which database?');
    expect(question.deliveries.map((d) => [d.recipientAgentId, d.status])).toEqual([[architect.id, 'pending']]);
    const suspended = await events(devRunId);
    expect(suspended.some((e) => e.type === 'memory.proposed' && typeof e.payload.entryId === 'string')).toBe(true);
    const waitingEvent = suspended.find((e) => e.type === 'agent.waiting_reply');
    expect(waitingEvent?.payload).toMatchObject({ messageId: question.id, to: 'architect' });
    expect(suspended.find((e) => e.type === 'agent.message.sent')?.payload).toMatchObject({
      messageId: question.id, to: 'architect', type: 'question',
    });

    // 2. the architect is woken by an inbox run and replies
    await app.scheduler.tick();
    const inboxRun = await until(
      () => prisma.taskRun.findFirst({ where: { agentId: architect.id, kind: 'inbox', status: 'succeeded' } }),
      'inbox run succeeded',
    );
    expect(inboxRun.taskId).toBeNull();
    const delivery = await prisma.messageDelivery.findFirstOrThrow({ where: { messageId: question.id } });
    expect(delivery.status).toBe('acknowledged');
    const reply = await prisma.message.findFirstOrThrow({ where: { type: 'reply', inReplyToId: question.id } });
    expect(reply.body).toBe('fake reply: Which database?');
    expect((await events(inboxRun.id)).some((e) => e.type === 'agent.message.received' && e.payload.count === 1)).toBe(true);

    // 3. the developer resumes in the same session, numbering after the suspended events
    await app.scheduler.tick();
    const done = await waitTask(task.id, 'done');
    expect(done.runs.map((r: { id: string }) => r.id)).toEqual([devRunId]);
    const devRun = (await req('GET', `/runs/${devRunId}`)).json();
    expect(devRun.session.sdkSessionId).toBe(`fake-${devRun.session.id}`);
    const all = await events(devRunId);
    const seqs = all.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const resumedAt = all.findIndex((e) => e.type === 'agent.resumed');
    expect(resumedAt).toBeGreaterThan(-1);
    expect(all.slice(resumedAt + 1).length).toBeGreaterThan(0);
    for (const e of all.slice(resumedAt + 1)) expect(e.seq).toBeGreaterThan(waitingEvent!.seq);
    expect(all.at(-1)!.type).toBe('agent.completed');

    // 4. the summarizer submits a verified task summary and a proposal
    await app.scheduler.tick();
    const summaryRun = await until(
      () => prisma.taskRun.findFirst({ where: { agentId: summarizer.id, kind: 'summary', summaryOfRunId: devRunId, status: 'succeeded' } }),
      'summary run succeeded',
    );
    const summary = await prisma.memoryEntry.findFirstOrThrow({ where: { projectId, type: 'task_summary' }, include: { sources: true } });
    expect(summary.status).toBe('verified');
    expect(summary.sources.map((s) => s.kind).sort()).toEqual(expect.arrayContaining(['run', 'task']));
    const lessons = await prisma.memoryEntry.findMany({ where: { projectId, type: 'lesson' } });
    expect(lessons.map((l) => [l.title, l.status]).sort()).toEqual([
      ['Use Postgres', 'verified'],
      ['fake proposal', 'verified'],
    ]);

    // 5. sessions closed; conversation, memory search and verify go through the routes
    const sessions = await prisma.agentSession.findMany({ where: { runId: { in: [devRunId, inboxRun.id, summaryRun.id] } } });
    expect(sessions).toHaveLength(3);
    for (const s of sessions) expect(s.endedAt).not.toBeNull();
    const conversation = (await req('GET', `/conversations/${question.conversationId}`)).json();
    expect(conversation.messages.map((m: { type: string }) => m.type)).toEqual(['question', 'reply']);
    for (const m of conversation.messages) expect(m.deliveries.length).toBeGreaterThan(0);
    const found = (await req('GET', `/memory?projectId=${projectId}&q=Postgres`)).json() as { id: string; title: string }[];
    expect(found.map((e) => e.title)).toContain('Use Postgres');
    const verified = await req('POST', `/memory/${summary.id}/verify`);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe('verified');
    const detail = (await req('GET', `/memory/${summary.id}?projectId=${projectId}`)).json();
    expect(detail.sources.map((s: { kind: string }) => s.kind)).toEqual(expect.arrayContaining(['run', 'task']));

    // 6. the next developer task gets the summary in its context pack
    const next = (await req('POST', '/tasks', { projectId, agentId: developer.id, title: 'Next', description: 'echo' })).json();
    await app.scheduler.tick();
    const nextRunId = (await waitTask(next.id, 'done')).runs[0].id;
    const nextRun = (await req('GET', `/runs/${nextRunId}`)).json();
    expect(nextRun.session.contextPack.summaryIds).toContain(summary.id);
  }, 30_000);
});
