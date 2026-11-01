import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp, loadConfig } from '@office/api';
import { createPrisma, seed } from '@office/db';
import { FakeAdapter, machineId } from '@office/runtime';
import type { RunResult, RunSpec } from '@office/shared';
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

type Event = { type: string; seq: number; payload: Record<string, unknown> };
type Kind = 'local' | 'remote';

const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
const PASSING_TEST = "import test from 'node:test'; import assert from 'node:assert'; test('t', () => assert.ok(true));";

/** Records every spec it runs (with the worktree cwd) and the env file the worker wrote into the worktree. */
class RecordingAdapter extends FakeAdapter {
  specs: RunSpec[] = [];
  envFiles = new Map<string, string>();

  override async run(...args: Parameters<FakeAdapter['run']>): Promise<RunResult> {
    const [spec] = args;
    this.specs.push(spec);
    if (spec.git && spec.env) this.envFiles.set(spec.runId, readFileSync(join(spec.cwd, spec.env.file), 'utf8'));
    return super.run(...args);
  }
}

const codeTask = (key: string, description: string, agent = 'developer') => ({
  key, title: `Task ${key}`, description, kind: 'code', agent,
  requirements: ['a test'], acceptanceCriteria: ['node --test passes'],
});

describe('phase 5 two workers end to end with the fake runtime', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let prisma: ReturnType<typeof createPrisma>;
  let cookie: string;
  let port: number;
  let base: string;
  let repoRoot: string;
  let repo: string;
  let projectId: string;
  const homes = {} as Record<Kind, string>;
  const adapters = {} as Record<Kind, RecordingAdapter>;
  const ids = {} as Record<Kind, string>;
  const conns: Partial<Record<Kind, WorkerConnection>> = {};

  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, payload });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const getMission = async (id: string) => (await req('GET', `/missions/${id}`)).json();
  const getTask = async (id: string) => (await req('GET', `/tasks/${id}`)).json();
  const waitMission = (id: string, status: string) =>
    until(async () => {
      const m = await getMission(id);
      return m.status === status && m;
    }, `mission ${status}`);
  const events = async (runId: string) => (await req('GET', `/runs/${runId}/events`)).json() as Event[];
  type TaskView = { key: string; id: string; status: string };
  const taskByKey = (m: { tasks: TaskView[] }, key: string) => m.tasks.find((t) => t.key === key)!;
  const online = (kind: Kind) => app.gateway.onlineWorkers().some((w) => w.workerId === ids[kind]);
  const runOf = (taskId: string) =>
    until(() => prisma.taskRun.findFirst({ where: { taskId, kind: 'task' }, orderBy: { createdAt: 'asc' } }), 'task run');

  /** local: covers the repo, capacity 1, no clone. remote: no roots, clones, tagged `remote`. Same home on a restart. */
  async function startWorker(kind: Kind, opts: { enrollToken?: string; logger?: pino.Logger } = {}) {
    const local = kind === 'local';
    const conn = new WorkerConnection(
      {
        apiUrl: `ws://127.0.0.1:${port}`, home: homes[kind], enrollToken: opts.enrollToken,
        workspaceRoots: local ? [join(base, 'ws'), repoRoot] : [], runtime: 'fake', capacity: local ? 1 : 2, name: kind,
        tags: local ? [] : ['remote'], canClone: !local,
        // the local worker shares the API's host identity; the remote one is another machine
        machineId: local ? machineId(join(base, 'data')) : 'remote-machine',
      },
      { adapter: adapters[kind], heartbeatMs: 200, reconnectBaseMs: 300, logger: opts.logger ?? pino({ level: 'silent' }) },
    );
    conns[kind] = conn;
    await conn.start();
    ids[kind] ??= (await prisma.worker.findFirstOrThrow({ where: { name: kind } })).id;
    await until(() => online(kind), `${kind} online`);
  }

  async function stopWorker(kind: Kind) {
    await conns[kind]?.stop();
    conns[kind] = undefined;
    await until(() => !online(kind), `${kind} offline`);
  }

  /** Creates a mission, runs its plan with `fakePlan` and returns its id, still awaiting approval. */
  async function plannedMission(request: string, fakePlan: object) {
    const created = await req('POST', '/missions', { projectId, request });
    expect(created.statusCode).toBe(201);
    const missionId: string = created.json().id;
    process.env.OFFICE_FAKE_PLAN = JSON.stringify(fakePlan);
    try {
      await app.scheduler.tick();
      await waitMission(missionId, 'awaiting_approval');
    } finally {
      delete process.env.OFFICE_FAKE_PLAN;
    }
    return missionId;
  }

  async function approvePlan(missionId: string) {
    const approval = (await getMission(missionId)).approvals.find((a: { type: string }) => a.type === 'plan');
    expect((await req('POST', `/approvals/${approval.id}/approve`, {})).statusCode).toBe(200);
  }

  /**
   * Two independent code tasks for two agents (each agent runs one session at a time); the local worker (capacity 1)
   * takes one, the remote one the other.
   */
  async function parallelPair() {
    const missionId = await plannedMission('Two files', {
      summary: 'two parallel tasks',
      tasks: [codeTask('a', `COMMIT:one.test.js:${PASSING_TEST}`), codeTask('b', `COMMIT:two.test.js:${PASSING_TEST}`, 'designer')],
      risks: [],
    });
    await approvePlan(missionId);
    const mission = await getMission(missionId);
    const tasks = [taskByKey(mission, 'a'), taskByKey(mission, 'b')];
    await app.scheduler.tick();
    for (const t of tasks) {
      await until(async () => (await getTask(t.id)).status === 'review', `task ${t.key} review`);
    }
    const runs = await Promise.all(tasks.map((t) => runOf(t.id)));
    const branch: string = (await getMission(missionId)).branch;
    return { missionId, tasks, runs, branch };
  }

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'office-e2e5-')));
    for (const d of ['ws', 'repo', 'home-local', 'home-remote']) mkdirSync(join(base, d));
    homes.local = join(base, 'home-local');
    homes.remote = join(base, 'home-remote');
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL_TEST,
      OFFICE_SCHEDULER_INTERVAL_MS: '0',
      OFFICE_DATA_DIR: join(base, 'data'),
    });
    prisma = createPrisma(config.databaseUrl);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditLog","CheckResult","Artifact","GitWorkspace","Approval","TaskDependency","ProjectAgent","MemorySource","MemoryEntry","MessageDelivery","Message","Conversation","SubagentRun","SessionEvent","UsageRecord","AgentSession","TaskRun","Task","Mission","AgentSubagent","AgentSkill","AgentVersion","Agent","SkillVersion","Skill","Worker","Project","UserSession","User" CASCADE',
    );
    app = await buildApp(config, { prisma, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    const setup = await app.inject({
      method: 'POST', url: '/auth/setup', payload: { email: 'owner@example.com', password: 'password123' },
    });
    cookie = `office_session=${setup.cookies[0]!.value}`;
    await seed(prisma, join(base, 'ws'));

    repoRoot = join(base, 'repo');
    repo = join(repoRoot, 'app');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }) + '\n');
    git('add', '-A');
    git(...IDENTITY, 'commit', '-q', '-m', 'init');
    const project = await req('POST', '/projects', { name: 'App', slug: 'app', repoPath: repo, defaultBranch: 'main' });
    expect(project.statusCode).toBe(201);
    projectId = project.json().id;
    const settings = await req('PUT', `/projects/${projectId}/settings`, {
      checkCommand: 'node --test', envFile: '.env.local', envTemplate: [{ name: 'FOO', value: 'bar' }],
    });
    expect(settings.statusCode).toBe(200);

    for (const kind of ['local', 'remote'] as const) {
      delete ids[kind];
      adapters[kind] = new RecordingAdapter();
      const { enrollToken } = (await req('POST', '/workers', { name: kind })).json();
      await startWorker(kind, { enrollToken });
    }
  });

  afterEach(async () => {
    delete process.env.OFFICE_FAKE_PLAN;
    for (const kind of ['local', 'remote'] as const) {
      await conns[kind]?.stop();
      conns[kind] = undefined;
    }
    await app.close();
    await prisma.$disconnect();
    rmSync(base, { recursive: true, force: true });
  });

  it('two parallel code tasks run on two workers and both integrate into the mission branch', async () => {
    const { runs, branch } = await parallelPair();
    expect(new Set(runs.map((r) => r.workerId))).toEqual(new Set([ids.local, ids.remote]));
    for (const r of runs) expect(r.status).toBe('succeeded');

    // both started from main; the second to finish either saw the first (fast-forward) or kept its branch
    const files = git('ls-tree', '--name-only', branch).split('\n');
    const pending = runs.filter((r) => r.integration === 'needs_integration');
    expect(pending.length).toBeLessThanOrEqual(1);
    for (const r of runs.filter((r) => r.integration === 'fast_forwarded')) {
      const ws = await prisma.gitWorkspace.findFirstOrThrow({ where: { runId: r.id } });
      expect(git('merge-base', '--is-ancestor', ws.headCommit!, branch) === '').toBe(true);
    }
    if (pending.length === 0) {
      expect(files).toEqual(expect.arrayContaining(['one.test.js', 'two.test.js']));
    } else {
      // its commits are reachable on the API repository for manual integration
      const ws = await prisma.gitWorkspace.findFirstOrThrow({ where: { runId: pending[0]!.id } });
      expect(git('rev-parse', '--verify', `refs/heads/${ws.branch}`)).toBe(ws.headCommit);
      expect(files.filter((f) => f.endsWith('.test.js'))).toHaveLength(1);
    }
  }, 60_000);

  it('a remote worker never receives a repoPath', async () => {
    await parallelPair();
    const remoteSpecs = adapters.remote.specs;
    expect(remoteSpecs.length).toBeGreaterThan(0);
    for (const spec of remoteSpecs) {
      expect(spec.git?.remote).toEqual({ path: `/git/${projectId}` });
      expect(spec.git?.repoPath).toBeUndefined();
      expect(spec.cwd.startsWith(join(homes.remote, 'worktrees') + '/')).toBe(true);
    }
    // the clone lives in the remote home, made over HTTP from the API
    const clone = join(homes.remote, 'repos', projectId);
    expect(execFileSync('git', ['-C', clone, 'remote', 'get-url', 'office'], { encoding: 'utf8' }).trim()).toBe(
      `http://127.0.0.1:${port}/git/${projectId}`,
    );
  }, 60_000);

  it('the remote worker check result and env template land like a local one', async () => {
    const { runs } = await parallelPair();
    for (const r of runs) {
      const check = await prisma.checkResult.findFirstOrThrow({ where: { runId: r.id } });
      expect(check).toMatchObject({ status: 'passed', command: 'node --test', exitCode: 0 });
    }
    const remoteRun = runs.find((r) => r.workerId === ids.remote)!;
    const spec = adapters.remote.specs.find((s) => s.runId === remoteRun.id)!;
    expect(spec.cwd).toBe(join(homes.remote, 'worktrees', remoteRun.id));
    expect(adapters.remote.envFiles.get(remoteRun.id)).toBe('FOO=bar\n');
    const localRun = runs.find((r) => r.workerId === ids.local)!;
    expect(adapters.local.envFiles.get(localRun.id)).toBe('FOO=bar\n');
    // never in the API's checkout, never committed
    expect(existsSync(join(repo, '.env.local'))).toBe(false);
    expect(git('log', '--all', '--format=', '--name-only').split('\n')).not.toContain('.env.local');
  }, 60_000);

  it('a chat run goes to the local worker only', async () => {
    const developer = await prisma.agent.findUniqueOrThrow({ where: { slug: 'developer' } });
    const conv = (await req('POST', '/conversations', { projectId, kind: 'human', agentIds: [developer.id] })).json();
    await stopWorker('local');
    expect((await req('POST', `/conversations/${conv.id}/messages`, { type: 'question', body: 'hello?' })).statusCode).toBe(201);
    await app.scheduler.tick();
    // the remote worker is online with free slots, but a chat run needs the repo checkout
    expect(online('remote')).toBe(true);
    expect(await prisma.taskRun.count({ where: { kind: 'chat' } })).toBe(0);

    await startWorker('local');
    await app.scheduler.tick();
    const chat = await until(() => prisma.taskRun.findFirst({ where: { kind: 'chat', status: 'succeeded' } }), 'chat run');
    expect(chat.workerId).toBe(ids.local);
    expect(adapters.remote.specs.some((s) => s.kind === 'chat')).toBe(false);
  }, 60_000);

  it('a lost lease on the remote worker retries the task on the local worker from the mission head', async () => {
    const missionId = await plannedMission('Lost', {
      summary: 'one slow task', tasks: [codeTask('a', `COMMIT:lost.test.js:${PASSING_TEST}\nSLOW`)], risks: [],
    });
    const taskId = taskByKey(await getMission(missionId), 'a').id;
    // only the remote worker is online: the task goes there
    await stopWorker('local');
    await approvePlan(missionId);
    await app.scheduler.tick();
    const lostRun = await runOf(taskId);
    expect(lostRun.workerId).toBe(ids.remote);
    // the fake adapter reports its last tool before the 2 s SLOW wait
    await until(async () => (await events(lostRun.id)).some((e) => e.payload.toolUseId === 'fake-1'), 'remote run in SLOW');

    // the remote worker goes away mid-run: the socket closes first, so its cancelled result stays in its outbox
    await stopWorker('remote');
    const outboxFile = join(homes.remote, 'outbox', `${lostRun.id}.json`);
    await until(() => existsSync(outboxFile), 'result in the outbox');
    // stopped inside the SLOW window: a run that had already finished would have succeeded
    expect(JSON.parse(readFileSync(outboxFile, 'utf8')).result.status).toBe('cancelled');
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: lostRun.id } })).status).toBe('running');

    await startWorker('local');
    const branch: string = (await getMission(missionId)).branch;
    const missionHead = git('rev-parse', branch);
    await prisma.taskRun.update({ where: { id: lostRun.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await app.scheduler.tick();

    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: lostRun.id } })).status).toBe('lost');
    expect((await events(lostRun.id)).find((e) => e.type === 'run.lease.lost')?.payload).toEqual({
      workerId: ids.remote, retried: true,
    });
    const retry = await until(
      () => prisma.taskRun.findFirst({ where: { taskId, kind: 'task', id: { not: lostRun.id } } }),
      'retry run',
    );
    expect(retry.workerId).toBe(ids.local);
    expect((await req('GET', `/runs/${lostRun.id}`)).json().retriedByRunId).toBe(retry.id);
    await until(async () => (await getTask(taskId)).status === 'review', 'retry review');
    const retryWs = await prisma.gitWorkspace.findFirstOrThrow({ where: { runId: retry.id } });
    expect(retryWs.baseCommit).toBe(missionHead);
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: retry.id } })).integration).toBe('fast_forwarded');
    expect(git('rev-parse', branch)).toBe(retryWs.headCommit);

    // the remote worker comes back with the stale result: the API refuses it and the worker drops it
    const lines: { msg?: string; message?: string }[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    await startWorker('remote', { logger: pino({ level: 'warn' }, sink) });
    await until(() => !existsSync(outboxFile), 'stale result dropped');
    expect(lines.map((l) => l.message)).toContain(`No live lease for run ${lostRun.id} on this worker`);
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: lostRun.id } })).status).toBe('lost');
    expect(readdirSync(join(homes.remote, 'outbox'))).toEqual([]);
  }, 60_000);

  it('a waiting_reply run resumes only on its original worker', async () => {
    const architect = await prisma.agent.findUniqueOrThrow({ where: { slug: 'architect' } });
    const missionId = await plannedMission('Ask', {
      summary: 'one asking task', tasks: [codeTask('a', 'ASK:architect:Which database?')], risks: [],
    });
    const taskId = taskByKey(await getMission(missionId), 'a').id;
    await stopWorker('local');
    await approvePlan(missionId);
    await app.scheduler.tick();
    const run = await runOf(taskId);
    expect(run.workerId).toBe(ids.remote);
    await until(async () => (await getTask(taskId)).status === 'waiting_reply', 'task waiting_reply');
    await stopWorker('remote');

    // the architect answers from an inbox run on the local worker while the remote one is offline
    await startWorker('local');
    await app.scheduler.tick();
    const inbox = await until(
      () => prisma.taskRun.findFirst({ where: { agentId: architect.id, kind: 'inbox', status: 'succeeded' } }),
      'inbox run',
    );
    expect(inbox.workerId).toBe(ids.local);
    const question = await prisma.message.findFirstOrThrow({ where: { type: 'question' } });
    await until(() => prisma.message.findFirst({ where: { type: 'reply', inReplyToId: question.id } }), 'reply');
    await app.scheduler.tick();
    await app.scheduler.tick();
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('waiting_reply');
    expect(adapters.local.specs.some((s) => s.runId === run.id)).toBe(false);

    // the remote worker comes back: the run resumes there, in the same session
    await startWorker('remote');
    await app.scheduler.tick();
    const resumed = await until(async () => {
      const r = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
      return r.status === 'succeeded' && r;
    }, 'resumed run succeeded');
    expect(resumed.workerId).toBe(ids.remote);
    expect((await events(run.id)).some((e) => e.type === 'agent.resumed')).toBe(true);
    const resumedSpecs = adapters.remote.specs.filter((s) => s.runId === run.id);
    expect(resumedSpecs).toHaveLength(2);
    expect(resumedSpecs[1]!.resumeSdkSessionId).toBe(`fake-${resumedSpecs[0]!.sessionId}`);
    expect(adapters.local.specs.some((s) => s.runId === run.id)).toBe(false);
  }, 60_000);

  it('a remote run starts from the moved mission head and fast-forwards it over HTTP', async () => {
    const missionId = await plannedMission('Chain', {
      summary: 'local then remote',
      tasks: [
        codeTask('a', `COMMIT:one.test.js:${PASSING_TEST}`),
        { ...codeTask('b', `COMMIT:two.test.js:${PASSING_TEST}`, 'designer'), dependsOn: ['a'] },
      ],
      risks: [],
    });
    await approvePlan(missionId);
    const mission = await getMission(missionId);
    const a = taskByKey(mission, 'a');
    const b = taskByKey(mission, 'b');
    await app.scheduler.tick();
    const aDone = await until(async () => {
      const t = await getTask(a.id);
      return t.status === 'review' && t;
    }, 'a review');
    expect((await runOf(a.id)).workerId).toBe(ids.local);
    expect(aDone.git.integration).toBe('fast_forwarded');
    const branch: string = (await getMission(missionId)).branch;
    expect(git('rev-parse', branch)).toBe(aDone.git.headCommit);

    // b becomes ready with only the remote worker online
    await stopWorker('local');
    expect((await req('POST', `/tasks/${a.id}/done`, {})).statusCode).toBe(200);
    await app.scheduler.tick();
    const bDone = await until(async () => {
      const t = await getTask(b.id);
      return t.status === 'review' && t;
    }, 'b review');
    const bRun = await runOf(b.id);
    expect(bRun.workerId).toBe(ids.remote);
    expect(bRun.integration).toBe('fast_forwarded');
    // ensureClone fetched the head a moved the mission branch to
    expect(bDone.git.baseCommit).toBe(aDone.git.headCommit);
    expect(git('rev-parse', branch)).toBe(bDone.git.headCommit);
    const ws = await prisma.gitWorkspace.findFirstOrThrow({ where: { runId: bRun.id } });
    expect(ws.baseCommit).toBe(aDone.git.headCommit);
    expect(git('rev-parse', '--verify', `refs/heads/${ws.branch}`)).toBe(bDone.git.headCommit);
    expect(git('ls-tree', '--name-only', branch).split('\n')).toEqual(expect.arrayContaining(['one.test.js', 'two.test.js']));
  }, 60_000);
});
