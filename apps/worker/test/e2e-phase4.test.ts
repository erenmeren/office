import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
const PASSING_TEST = "import test from 'node:test'; import assert from 'node:assert'; test('t', () => assert.ok(true));";

/** Records every spec it runs and the env file the worker wrote into the worktree; `beforeRun` runs first. */
class RecordingAdapter extends FakeAdapter {
  specs: RunSpec[] = [];
  envFiles = new Map<string, string>();
  beforeRun?: (spec: RunSpec) => Promise<void> | void;

  override async run(...args: Parameters<FakeAdapter['run']>): Promise<RunResult> {
    const [spec] = args;
    this.specs.push(spec);
    if (spec.git && spec.env) this.envFiles.set(spec.runId, readFileSync(join(spec.cwd, spec.env.file), 'utf8'));
    await this.beforeRun?.(spec);
    return super.run(...args);
  }
}

describe('phase 4 end to end with the fake runtime', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let prisma: ReturnType<typeof createPrisma>;
  let cookie: string;
  let tempRoot: string;
  let repoRoot: string;
  let repo: string;
  let home: string;
  let projectId: string;
  let adapter: RecordingAdapter;
  let connection: WorkerConnection | undefined;

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
  const waitTask = (id: string, status: string) =>
    until(async () => {
      const t = await getTask(id);
      return t.status === status && t;
    }, `task ${status}`);
  const events = async (runId: string) => (await req('GET', `/runs/${runId}/events`)).json() as Event[];
  type TaskView = { key: string; id: string; status: string; kind: string };
  const taskByKey = (m: { tasks: TaskView[] }, key: string) => m.tasks.find((t) => t.key === key)!;

  /** Creates a mission, runs its plan (with `fakePlan` as OFFICE_FAKE_PLAN when given) and approves it. */
  async function plannedMission(request: string, fakePlan?: object) {
    const created = await req('POST', '/missions', { projectId, request });
    expect(created.statusCode).toBe(201);
    const missionId: string = created.json().id;
    if (fakePlan) process.env.OFFICE_FAKE_PLAN = JSON.stringify(fakePlan);
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
    expect(approval.status).toBe('pending');
    expect((await req('POST', `/approvals/${approval.id}/approve`, {})).statusCode).toBe(200);
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'office-home-'));
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL_TEST,
      OFFICE_SCHEDULER_INTERVAL_MS: '0',
      OFFICE_DATA_DIR: join(home, 'data'),
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
    await seed(prisma, tempRoot);

    // the mission project: an ESM package with one commit on main
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'office-repo-')));
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
      // these flows exercise plan and tool approvals; a new project's policy is auto everywhere
      approvalPolicy: { plan: 'ask' },
    });
    expect(settings.statusCode).toBe(200);

    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    adapter = new RecordingAdapter();
    connection = new WorkerConnection(
      {
        apiUrl: `ws://127.0.0.1:${port}`, home, enrollToken, workspaceRoots: [tempRoot, repoRoot],
        runtime: 'fake', capacity: 2, name: 'e2e', tags: [], canClone: false, machineId: machineId(join(home, 'data')),
      },
      { adapter, heartbeatMs: 200, reconnectBaseMs: 300, logger: pino({ level: 'silent' }) },
    );
    await connection.start();
    await until(() => app.gateway.onlineWorkers().length > 0, 'worker online');
  });

  afterEach(async () => {
    delete process.env.OFFICE_FAKE_PLAN;
    await connection?.stop();
    connection = undefined;
    await app.close();
    await prisma.$disconnect();
    for (const dir of [tempRoot, repoRoot, home]) rmSync(dir, { recursive: true, force: true });
  });

  it('plans, approves, runs a code task and a review task, and closes after the Chief review', async () => {
    const developer = await prisma.agent.findUniqueOrThrow({ where: { slug: 'developer' } });

    // 1. request -> read-only plan run with a JSON schema -> awaiting approval with a pending plan approval
    const missionId = await plannedMission('Add a sum helper');
    const planSpec = adapter.specs.find((s) => s.kind === 'plan')!;
    expect(planSpec.readOnlyCheckout).toBe(true);
    expect(planSpec.outputFormat?.type).toBe('json_schema');
    let mission = await getMission(missionId);
    expect(mission.planRun.status).toBe('succeeded');
    const a = taskByKey(mission, 'a');
    const b = taskByKey(mission, 'b');
    expect(a).toMatchObject({ status: 'planned', kind: 'code', dependencies: [] });
    expect(b).toMatchObject({ status: 'planned', kind: 'review', dependencies: [a.id] });
    expect(mission.approvals.map((x: { type: string; status: string }) => [x.type, x.status])).toEqual([['plan', 'pending']]);

    // 2. approve -> a runs in a worktree, commits, the check passes, the mission branch is fast-forwarded
    await approvePlan(missionId);
    mission = await getMission(missionId);
    expect(taskByKey(mission, 'a').status).toBe('ready');
    expect(taskByKey(mission, 'b').status).toBe('planned');
    await app.scheduler.tick();
    const aDone = await waitTask(a.id, 'review');
    const aRunId: string = aDone.runs[0].id;
    const aSpec = adapter.specs.find((s) => s.runId === aRunId)!;
    expect(aSpec.cwd).toBe(join(home, 'worktrees', aRunId));
    expect(adapter.envFiles.get(aRunId)).toContain('FOO=bar');
    const branch: string = aSpec.git!.missionBranch;
    expect(branch).toMatch(/^office\/add-a-sum-helper-/);
    const ws = await prisma.gitWorkspace.findFirstOrThrow({ where: { runId: aRunId } });
    expect(ws.branch).toMatch(/-runs\/a-/);
    expect(ws.baseCommit).toBe(git('rev-parse', 'main'));
    expect(ws.headCommit).toBe(git('rev-parse', branch));
    expect(aDone.git).toMatchObject({ runId: aRunId, integration: 'fast_forwarded', headCommit: ws.headCommit });
    expect(git('rev-list', '--count', `main..${branch}`)).toBe('1');
    expect(git('log', '-1', '--format=%B', branch)).toContain(`Office-Agent: ${developer.name} ${aRunId}`);
    expect(git('show', '--name-only', '--format=', branch).split('\n')).toEqual(['sum.test.js']);
    expect(existsSync(join(home, 'worktrees', aRunId))).toBe(false);
    const check = await prisma.checkResult.findFirstOrThrow({ where: { runId: aRunId } });
    expect(check).toMatchObject({ status: 'passed', command: 'node --test', exitCode: 0 });
    const checkArtifact = (await req('GET', `/artifacts/${check.artifactId}`)).json();
    expect(checkArtifact.kind).toBe('check_output');
    expect(checkArtifact.content).toContain('pass 1');
    expect((await events(aRunId)).find((e) => e.type === 'agent.check.completed')?.payload).toMatchObject({
      status: 'passed', checkResultId: check.id,
    });

    // 3. owner closes a -> b (read-only review) runs without commits -> mission review -> Chief review run
    expect((await req('POST', `/tasks/${a.id}/done`, {})).statusCode).toBe(200);
    expect((await getTask(b.id)).status).toBe('ready');
    await app.scheduler.tick();
    const bDone = await waitTask(b.id, 'review');
    const bRun = bDone.runs[0];
    expect(bRun.status).toBe('succeeded');
    const bSpec = adapter.specs.find((s) => s.runId === bRun.id)!;
    expect(bSpec.readOnlyCheckout).toBe(true);
    expect(bSpec.git?.missionBranch).toBe(branch);
    const bWs = await prisma.gitWorkspace.findFirstOrThrow({ where: { runId: bRun.id } });
    expect(bWs.headCommit).toBe(bWs.baseCommit);
    expect(git('rev-parse', branch)).toBe(ws.headCommit);
    await waitMission(missionId, 'review');

    // summary runs of a and b may hold both worker slots on the first tick: tick until the review run is created
    const reviewRun = await until(async () => {
      await app.scheduler.tick();
      return prisma.taskRun.findFirst({ where: { kind: 'review', reviewOfMissionId: missionId, status: 'succeeded' } });
    }, 'review run succeeded');
    const reviewSpec = adapter.specs.find((s) => s.runId === reviewRun.id)!;
    expect(reviewSpec.kind).toBe('review');
    expect(reviewSpec.outputFormat?.type).toBe('json_schema');
    expect(reviewSpec.tools).toContain('review_task');
    expect((await req('GET', `/runs/${reviewRun.id}`)).json()).toMatchObject({ kind: 'review', reviewOfMissionId: missionId });
    await until(async () => (await getMission(missionId)).summary === 'fake review', 'mission summary');
    expect((await getTask(b.id)).status).toBe('review');
    expect(await getMission(missionId)).toMatchObject({ status: 'review', reviewRunId: reviewRun.id });
    expect((await req('POST', `/tasks/${b.id}/done`, {})).statusCode).toBe(200);
    mission = await waitMission(missionId, 'done');
    expect(mission.summary).toBe("Closed by the owner's decision. Chief's note before that: fake review");

    // 6. persistence: the mission view carries tasks, dependencies, approvals, checks; the task view its git
    expect(mission.planRun).toMatchObject({ status: 'succeeded' });
    expect(mission.approvals).toEqual([expect.objectContaining({ type: 'plan', status: 'approved' })]);
    expect(taskByKey(mission, 'a')).toMatchObject({
      status: 'done', dependencies: [], dependents: [b.id], checkResult: expect.objectContaining({ status: 'passed', artifactId: check.artifactId }),
    });
    expect(taskByKey(mission, 'b')).toMatchObject({ status: 'done', dependencies: [a.id], checkResult: null });
    expect((await getTask(a.id)).git).toMatchObject({ branch: ws.branch, headCommit: ws.headCommit, integration: 'fast_forwarded' });
    expect((await req('GET', `/artifacts/${check.artifactId}`)).json().content).toContain('pass 1');
  }, 60_000);

  it('a destructive command waits for the owner and continues after a deny', async () => {
    const missionId = await plannedMission('Clean the modules', {
      summary: 'danger plan',
      tasks: [
        {
          key: 'a', title: 'Clean', description: 'DANGER:rm -rf node_modules', kind: 'code', agent: 'developer',
          requirements: ['clean'], acceptanceCriteria: ['clean'],
        },
      ],
      risks: [],
    });
    await approvePlan(missionId);
    const taskId = taskByKey(await getMission(missionId), 'a').id;
    await app.scheduler.tick();

    const approval = await until(async () => {
      const list = (await req('GET', `/approvals?projectId=${projectId}&status=pending`)).json() as { type: string; id: string; runId: string }[];
      return list.find((x) => x.type === 'destructive_command');
    }, 'destructive approval pending');
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: approval.runId } })).status).toBe('waiting_approval');
    expect((await getTask(taskId)).status).toBe('waiting_approval');
    expect((await events(approval.runId)).some((e) => e.type === 'agent.waiting_approval')).toBe(true);

    expect((await req('POST', `/approvals/${approval.id}/deny`, { message: 'no' })).statusCode).toBe(200);
    await waitTask(taskId, 'review');
    expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: approval.runId } })).status).toBe('succeeded');
    const all = await events(approval.runId);
    expect(all.find((e) => e.type === 'agent.approval.resolved')?.payload).toMatchObject({ decision: 'deny' });
    expect(all.some((e) => e.type === 'agent.tool.failed')).toBe(true);
    expect(all.some((e) => e.type === 'agent.command.executed' && e.payload.command === 'rm -rf node_modules')).toBe(false);
  }, 60_000);

  it('a run whose base went stale is rebased onto the mission head and fast-forwarded', async () => {
    const codeTask = (key: string, file: string) => ({
      key, title: `Write ${file}`, description: `COMMIT:${file}:${PASSING_TEST}`, kind: 'code', agent: 'developer',
      requirements: ['a test'], acceptanceCriteria: ['node --test passes'],
    });
    expect((await req('PUT', `/projects/${projectId}/settings`, { maxConcurrentRuns: 1 })).statusCode).toBe(200);
    const missionId = await plannedMission('Two files', {
      summary: 'two parallel tasks', tasks: [codeTask('a', 'one.test.js'), codeTask('b', 'two.test.js')], risks: [],
    });
    await approvePlan(missionId);
    const mission = await getMission(missionId);
    const a = taskByKey(mission, 'a');
    const b = taskByKey(mission, 'b');

    // once b's worktree exists, someone commits on the mission branch: b's base is stale
    let manual = '';
    adapter.beforeRun = (spec) => {
      if (spec.git?.taskSlug !== 'b') return;
      const ref = `refs/heads/${spec.git.missionBranch}`;
      const head = git('rev-parse', ref);
      manual = execFileSync('git', ['-C', repo, ...IDENTITY, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'manual'], {
        encoding: 'utf8',
      }).trim();
      git('update-ref', ref, manual, head);
    };

    await app.scheduler.tick();
    const aDone = await waitTask(a.id, 'review');
    expect(aDone.git.integration).toBe('fast_forwarded');
    // project concurrency 1: b starts only after a finished
    expect((await getTask(b.id)).status).toBe('ready');
    const bDone = await until(async () => {
      await app.scheduler.tick();
      const t = await getTask(b.id);
      return t.status === 'review' && t;
    }, 'b review');
    const bRunId: string = bDone.runs[0].id;
    const bRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: bRunId } });
    expect(bRun.integration).toBe('fast_forwarded');
    // the base is the moved mission head, not the commit the worktree was created from
    expect(manual).not.toBe('');
    expect(bRun.baseCommit).toBe(manual);
    const branch = (await getMission(missionId)).branch as string;
    expect(git('rev-parse', branch)).toBe(bRun.headCommit);
    expect(git('rev-parse', `${branch}^`)).toBe(manual);
    expect(git('ls-tree', '--name-only', branch)).toContain('two.test.js');
    expect(bRun.worktreePath).toBeNull();
  }, 60_000);
});
