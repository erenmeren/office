import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp, loadConfig } from '@office/api';
import { createPrisma, seed } from '@office/db';
import { FakeAdapter, machineId } from '@office/runtime';
import type { RunResult, WorkerToApi } from '@office/shared';
import { WorkerConnection } from '../src/connection.js';

async function until<T>(fn: () => Promise<T> | T, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`until(${what}) timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

type Event = { type: string; seq: number; payload: Record<string, unknown> };

const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
const PASSING_TEST = "import test from 'node:test'; import assert from 'node:assert'; test('t', () => assert.ok(true));";

/**
 * A task run whose prompt contains `HOLD` finishes its fake work, then waits until the test releases it (or it is
 * aborted) and emits one more event: a deterministic "still running" window instead of SLOW's fixed 2 s.
 */
class HoldAdapter extends FakeAdapter {
  private releases = new Map<string, () => void>();
  private sinks = new Map<string, { emit(e: { type: 'agent.text'; payload: { text: string } }): void }>();

  override async run(...args: Parameters<FakeAdapter['run']>): Promise<RunResult> {
    const [spec, sink, signal] = args;
    const result = await super.run(...args);
    if (spec.kind !== 'task' || !spec.prompt.includes('HOLD') || result.status !== 'succeeded') return result;
    await new Promise<void>((resolve) => {
      this.releases.set(spec.runId, resolve);
      this.sinks.set(spec.runId, sink);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    this.releases.delete(spec.runId);
    this.sinks.delete(spec.runId);
    if (signal.aborted) return { status: 'cancelled', usage: result.usage };
    sink.emit({ type: 'agent.text', payload: { text: 'released' } });
    return result;
  }

  isHeld = (runId: string) => this.releases.has(runId);
  release = (runId: string) => this.releases.get(runId)?.();
  /** Emits an event from a held run, e.g. while the worker is disconnected. */
  say = (runId: string, text: string) => this.sinks.get(runId)?.emit({ type: 'agent.text', payload: { text } });
}

describe('phase 6 recovery end to end with the fake runtime', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let config: ReturnType<typeof loadConfig>;
  let prisma: ReturnType<typeof createPrisma>;
  let cookie: string;
  let port: number;
  let base: string;
  let home: string;
  let repo: string;
  let sandboxId: string;
  let workerId: string;
  let adapter: HoldAdapter;
  let conn: WorkerConnection | undefined;
  // every message the worker hands to its socket layer (results, resends, integration checks)
  let sent: WorkerToApi[];
  // when set, the next run.result.ack is swallowed and the worker socket dies before reading it
  let dropNextAck = false;

  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, payload });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const events = async (runId: string) => (await req('GET', `/runs/${runId}/events`)).json() as Event[];
  const getTask = async (id: string) => (await req('GET', `/tasks/${id}`)).json();
  const waitTask = (id: string, status: string) =>
    until(async () => {
      const t = await getTask(id);
      return t.status === status && t;
    }, `task ${status}`);
  const runOf = (taskId: string) =>
    until(() => prisma.taskRun.findFirst({ where: { taskId, kind: 'task' }, orderBy: { createdAt: 'asc' } }), 'task run');
  const online = () => app.gateway.onlineWorkers().some((w) => w.workerId === workerId);
  const agentId = async (slug: string) => (await prisma.agent.findUniqueOrThrow({ where: { slug } })).id;
  const sandboxTask = async (agent: string, title: string, description: string) => {
    const res = await req('POST', '/tasks', { projectId: sandboxId, agentId: await agentId(agent), title, description });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  };

  async function startWorker(opts: { enrollToken?: string; heartbeatMs?: number } = {}) {
    const c = new WorkerConnection(
      {
        apiUrl: `ws://127.0.0.1:${port}`, home, enrollToken: opts.enrollToken, workspaceRoots: [join(base, 'ws'), join(base, 'repo')],
        runtime: 'fake', capacity: 3, name: 'local', tags: [], canClone: false, machineId: machineId(join(base, 'data')),
      },
      { adapter, heartbeatMs: opts.heartbeatMs ?? 200, reconnectBaseMs: 300, logger: pino({ level: 'silent' }) },
    );
    const internals = c as unknown as {
      send(m: WorkerToApi): void;
      onMessage(raw: string): Promise<void>;
      socket?: { terminate(): void };
    };
    const send = internals.send.bind(c);
    internals.send = (m) => {
      sent.push(m);
      send(m);
    };
    const onMessage = internals.onMessage.bind(c);
    internals.onMessage = async (raw) => {
      if (dropNextAck && (JSON.parse(raw) as { type?: string }).type === 'run.result.ack') {
        dropNextAck = false;
        internals.socket?.terminate();
        return;
      }
      return onMessage(raw);
    };
    conn = c;
    await c.start();
    workerId ??= (await prisma.worker.findFirstOrThrow({ where: { name: 'local' } })).id;
    await until(online, 'worker online');
  }

  /** Closes the API (scheduler stopped, sockets dropped) and builds a new one on the same port and database. */
  async function restartApi(whileDown?: () => void) {
    await app.close();
    await until(() => conn && (conn as unknown as { socket?: { readyState: number } }).socket?.readyState !== 1, 'worker socket closed');
    whileDown?.();
    app = await buildApp(config, { prisma, logger: false });
    await app.listen({ port, host: '127.0.0.1' });
    await until(online, 'worker reconnected');
  }

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'office-e2e6-')));
    for (const d of ['ws', 'repo', 'home']) mkdirSync(join(base, d));
    home = join(base, 'home');
    sent = [];
    dropNextAck = false;
    workerId = undefined as unknown as string;
    config = loadConfig({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL_TEST,
      OFFICE_SCHEDULER_INTERVAL_MS: '0',
      OFFICE_DATA_DIR: join(base, 'data'),
    });
    prisma = createPrisma(config.databaseUrl);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditLog","CheckResult","Artifact","GitWorkspace","Approval","TaskDependency","ProjectAgent","MemorySource","MemoryEntry","MessageDelivery","Message","Conversation","SubagentRun","SessionEvent","UsageRecord","AgentSession","TaskRun","Task","Mission","AgentSubagent","AgentSkill","AgentVersion","Agent","SkillVersion","Skill","Worker","Project","UserSession","User" CASCADE',
    );
    port = await freePort();
    app = await buildApp(config, { prisma, logger: false });
    await app.listen({ port, host: '127.0.0.1' });
    const setup = await app.inject({
      method: 'POST', url: '/auth/setup', payload: { email: 'owner@example.com', password: 'password123' },
    });
    cookie = `office_session=${setup.cookies[0]!.value}`;
    await seed(prisma, join(base, 'ws'));
    sandboxId = (await prisma.project.findUniqueOrThrow({ where: { slug: 'office-sandbox' } })).id;
    // the destructive-approval flow below needs a policy that asks; a project's default is auto
    expect((await req('PUT', `/projects/${sandboxId}/settings`, { approvalPolicy: { destructive_command: 'ask' } })).statusCode).toBe(200);

    adapter = new HoldAdapter();
    const { enrollToken } = (await req('POST', '/workers', { name: 'local' })).json();
    await startWorker({ enrollToken });
  });

  afterEach(async () => {
    delete process.env.OFFICE_FAKE_PLAN;
    await conn?.stop();
    conn = undefined;
    await app.close();
    await prisma.$disconnect();
    rmSync(base, { recursive: true, force: true });
  });

  it('API restart mid-run: the worker reconnects, the lease reattaches, the run completes and events continue the sequence', async () => {
    const task = await sandboxTask('developer', 'Long job', 'HOLD');
    await app.scheduler.tick();
    const run = await runOf(task.id);
    await until(() => adapter.isHeld(run.id), 'run held');
    await until(async () => (await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'running', 'run running');
    const before = await events(run.id);
    expect(before.length).toBeGreaterThan(0);

    const restartedAt = new Date();
    // events produced during the outage are buffered and delivered after the reconnect
    await restartApi(() => {
      adapter.say(run.id, 'during outage 1');
      adapter.say(run.id, 'during outage 2');
    });
    // the reconnecting hello reported the run: its lease was renewed and the new gateway counts it
    const reattached = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(reattached.status).toBe('running');
    expect(reattached.leaseExpiresAt!.getTime()).toBeGreaterThan(restartedAt.getTime());
    expect(app.gateway.onlineWorkers().find((w) => w.workerId === workerId)?.activeRuns).toBe(1);

    adapter.release(run.id);
    await waitTask(task.id, 'done');
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded');
    const all = await events(run.id);
    const seqs = all.map((e) => e.seq);
    // contiguous 1..N: nothing lost during the outage
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(all.filter((e) => e.type === 'agent.text' && String(e.payload.text).startsWith('during outage')).length).toBe(2);
    const released = all.find((e) => e.type === 'agent.text' && e.payload.text === 'released');
    expect(released!.seq).toBeGreaterThan(Math.max(...before.map((e) => e.seq)));
    expect(await prisma.taskRun.count({ where: { taskId: task.id } })).toBe(1);
    expect(await prisma.usageRecord.count({ where: { runId: run.id } })).toBe(1);
  }, 60_000);

  it('API restart with a due summary and an expired approval: both resume from the database on the first tick', async () => {
    const quick = await sandboxTask('developer', 'Quick job', 'echo');
    const danger = await sandboxTask('architect', 'Clean', 'DANGER:rm -rf node_modules');
    await app.scheduler.tick();
    await waitTask(quick.id, 'done');
    const quickRun = await runOf(quick.id);
    const approval = await until(
      () => prisma.approval.findFirst({ where: { type: 'destructive_command', status: 'pending' } }),
      'destructive approval pending',
    );
    const dangerRun = await runOf(danger.id);
    expect(approval.runId).toBe(dangerRun.id);
    await until(async () => (await prisma.taskRun.findUniqueOrThrow({ where: { id: dangerRun.id } })).status === 'waiting_approval', 'waiting_approval');
    await prisma.approval.update({ where: { id: approval.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await restartApi();
    // nothing happened while the API was down or on startup: both wait for the first tick
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: quickRun.id } })).summarizedAt).toBeNull();
    expect(await prisma.taskRun.count({ where: { kind: 'summary' } })).toBe(0);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('pending');

    await app.scheduler.tick();
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('expired');
    expect(await prisma.taskRun.findFirst({ where: { kind: 'summary', summaryOfRunId: quickRun.id } })).not.toBeNull();

    // the denied run continues on the worker without running the command; the summary run completes
    await waitTask(danger.id, 'done');
    const dangerEvents = await events(dangerRun.id);
    expect(dangerEvents.find((e) => e.type === 'agent.approval.resolved')?.payload).toMatchObject({ decision: 'deny' });
    expect(dangerEvents.some((e) => e.type === 'agent.command.executed' && e.payload.command === 'rm -rf node_modules')).toBe(false);
    await until(
      () => prisma.taskRun.findFirst({ where: { kind: 'summary', summaryOfRunId: quickRun.id, status: 'succeeded' } }),
      'summary run succeeded',
    );
    expect(await prisma.memoryEntry.count({ where: { projectId: sandboxId, type: 'task_summary' } })).toBe(1);
  }, 60_000);

  it('a question sent before the restart wakes the recipient after it', async () => {
    const architect = await agentId('architect');
    const task = await sandboxTask('developer', 'Pick a database', 'ASK:architect:Which database?');
    await app.scheduler.tick();
    await waitTask(task.id, 'waiting_reply');
    const run = await runOf(task.id);
    const question = await prisma.message.findFirstOrThrow({ where: { type: 'question' }, include: { deliveries: true } });
    expect(question.deliveries.map((d) => [d.recipientAgentId, d.status])).toEqual([[architect, 'pending']]);

    await restartApi();
    expect(await prisma.taskRun.count({ where: { agentId: architect } })).toBe(0);

    await app.scheduler.tick();
    const inbox = await until(
      () => prisma.taskRun.findFirst({ where: { agentId: architect, kind: 'inbox', status: 'succeeded' } }),
      'inbox run succeeded',
    );
    expect(inbox.workerId).toBe(workerId);
    expect((await prisma.messageDelivery.findFirstOrThrow({ where: { messageId: question.id } })).status).toBe('acknowledged');
    await until(() => prisma.message.findFirst({ where: { type: 'reply', inReplyToId: question.id } }), 'reply');

    // the reply resumes the suspended developer run in the same session
    await app.scheduler.tick();
    await waitTask(task.id, 'done');
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded');
    expect((await events(run.id)).some((e) => e.type === 'agent.resumed')).toBe(true);
  }, 60_000);

  it('a result whose socket died before the ack is resent after reconnect and stored once', async () => {
    const task = await sandboxTask('developer', 'Quick job', 'echo');
    dropNextAck = true;
    await app.scheduler.tick();
    const run = await runOf(task.id);
    const results = () => sent.filter((m) => m.type === 'run.result' && m.runId === run.id);

    // the API applied the result and acked; the ack died with the socket, so the worker resends after the welcome
    await until(() => !dropNextAck, 'ack dropped');
    await until(() => results().length >= 2, 'result resent after reconnect');
    await until(() => !existsSync(join(home, 'outbox', `${run.id}.json`)), 'outbox entry removed after ack');
    expect(readdirSync(join(home, 'outbox'))).toEqual([]);
    expect((conn as unknown as { unsentResults: Map<string, unknown> }).unsentResults.size).toBe(0);

    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded');
    expect(await prisma.taskRun.count({ where: { taskId: task.id } })).toBe(1);
    expect(await prisma.usageRecord.count({ where: { runId: run.id } })).toBe(1);
    expect((await getTask(task.id)).status).toBe('done');
  }, 60_000);

  it('a run whose lease was lost while it kept running does not fast-forward', async () => {
    // a git project with a mission whose one code task commits, then holds
    repo = join(base, 'repo', 'app');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }) + '\n');
    git('add', '-A');
    git(...IDENTITY, 'commit', '-q', '-m', 'init');
    const project = await req('POST', '/projects', { name: 'App', slug: 'app', repoPath: repo, defaultBranch: 'main' });
    expect(project.statusCode).toBe(201);
    const projectId: string = project.json().id;
    // approvals are part of these flows; a new project's policy is auto everywhere
    expect((await req('PUT', `/projects/${projectId}/settings`, { checkCommand: 'node --test', approvalPolicy: { plan: 'ask' } })).statusCode).toBe(200);

    // no heartbeats: nothing renews the lease once the test expires it
    await conn!.stop();
    await until(() => !online(), 'worker offline');
    await startWorker({ heartbeatMs: 600_000 });

    const created = await req('POST', '/missions', { projectId, request: 'One file' });
    expect(created.statusCode).toBe(201);
    const missionId: string = created.json().id;
    process.env.OFFICE_FAKE_PLAN = JSON.stringify({
      summary: 'one task',
      tasks: [{
        key: 'a', title: 'Task a', description: `COMMIT:one.test.js:${PASSING_TEST}\nHOLD`, kind: 'code', agent: 'developer',
        requirements: ['a test'], acceptanceCriteria: ['node --test passes'],
      }],
      risks: [],
    });
    await app.scheduler.tick();
    const awaiting = await until(async () => {
      const m = (await req('GET', `/missions/${missionId}`)).json();
      return m.status === 'awaiting_approval' && m;
    }, 'mission awaiting_approval');
    delete process.env.OFFICE_FAKE_PLAN;
    const planApproval = awaiting.approvals.find((a: { type: string }) => a.type === 'plan');
    expect((await req('POST', `/approvals/${planApproval.id}/approve`, {})).statusCode).toBe(200);
    const taskId: string = (await req('GET', `/missions/${missionId}`)).json().tasks[0].id;
    await app.scheduler.tick();
    const run = await runOf(taskId);
    await until(() => adapter.isHeld(run.id), 'run held after its commit');

    const branch: string = (await req('GET', `/missions/${missionId}`)).json().branch;
    const missionHead = git('rev-parse', branch);
    await prisma.taskRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    adapter.release(run.id);

    const result = await until(() => sent.find((m) => m.type === 'run.result' && m.runId === run.id), 'run result');
    expect(sent.some((m) => m.type === 'integration.check' && m.runId === run.id)).toBe(true);
    const r = (result as Extract<WorkerToApi, { type: 'run.result' }>).result;
    expect(r.status).toBe('succeeded');
    expect(r.check?.status).toBe('passed');
    expect(r.git).toMatchObject({ integration: 'needs_integration', integrationReason: 'lease lost' });
    expect(r.git!.commits.length).toBeGreaterThan(0);
    expect(git('rev-parse', branch)).toBe(missionHead);
    expect(git('ls-tree', '--name-only', branch).split('\n')).not.toContain('one.test.js');

    // the API refuses the result of a run it no longer leases; the worker drops it
    await until(() => !existsSync(join(home, 'outbox', `${run.id}.json`)), 'stale result dropped');
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).not.toBe('succeeded');
    expect(await prisma.usageRecord.count({ where: { runId: run.id } })).toBe(0);
  }, 60_000);
});
