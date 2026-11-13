import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentAllowed } from '../src/services/project-service.js';
import { storeArtifact, readArtifact } from '../src/services/artifact-store.js';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until } from './fake-worker.js';

describe('project settings, agents, audit, artifacts', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let projectId: string;
  let a1: string;
  let a2: string;
  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
    projectId = (await t.prisma.project.create({ data: { name: 'P', slug: 'p', repoPath: '/tmp/p' } })).id;
    a1 = (await t.prisma.agent.create({ data: { name: 'a1', slug: 'a1', role: 'dev' } })).id;
    a2 = (await t.prisma.agent.create({ data: { name: 'a2', slug: 'a2', role: 'dev' } })).id;
  });
  afterAll(() => t.close());
  const call = (method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    t.app.inject({ method, url, headers: { cookie }, payload: payload as object });

  it('settings round-trip with defaults, invalid patch is 400', async () => {
    const s = (await call('GET', `/projects/${projectId}/settings`)).json();
    expect(s.approvalTimeoutMinutes).toBe(30);
    expect(s.approvalPolicy.plan).toBe('auto');
    expect(s.defaultTaskBudgetUsd).toBe(0); // no cap per task run until the owner sets one
    expect((await call('PUT', `/projects/${projectId}/settings`, { defaultTaskBudgetUsd: 0 })).statusCode).toBe(200);
    const put = await call('PUT', `/projects/${projectId}/settings`, { checkCommand: 'pnpm test', dailyBudgetUsd: 10 });
    expect(put.statusCode).toBe(200);
    const again = (await call('GET', `/projects/${projectId}/settings`)).json();
    expect(again.checkCommand).toBe('pnpm test');
    expect(again.dailyBudgetUsd).toBe(10);
    expect(again.approvalTimeoutMinutes).toBe(30);
    expect((await call('PUT', `/projects/${projectId}/settings`, { dailyBudgetUsd: -1 })).statusCode).toBe(400);
    expect((await call('PUT', '/projects/nope/settings', {})).statusCode).toBe(404);
  });

  it('partial settings patch keeps unrelated stored values; audit lists only sent keys', async () => {
    const p = (await t.prisma.project.create({ data: { name: 'R', slug: 'r', repoPath: '/tmp/r' } })).id;
    const cur = (await call('GET', `/projects/${p}/settings`)).json();
    await call('PUT', `/projects/${p}/settings`, { envTemplate: [{ name: 'A', value: '1' }], approvalPolicy: { ...cur.approvalPolicy, plan: 'auto' } });
    await call('PUT', `/projects/${p}/settings`, { checkCommand: 'x' });
    const s = (await call('GET', `/projects/${p}/settings`)).json();
    expect(s.envTemplate).toEqual([{ name: 'A', value: '1' }]);
    expect(s.approvalPolicy.plan).toBe('auto');
    expect(s.checkCommand).toBe('x');
    const rows = (await call('GET', `/audit?targetType=project&targetId=${p}&limit=1`)).json();
    expect(rows[0].detail.keys).toEqual(['checkCommand']);
  });

  it("a project the owner makes puts finished work into its folder: the owner's own folder or one Office makes", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'office-lands-'));
    const post = (payload: object) => t.app.inject({ method: 'POST', url: '/projects', headers: { cookie }, payload });
    for (const payload of [{ name: 'Lands here', repoPath: dir }, { name: 'Lands there' }]) {
      const res = await post(payload);
      expect(res.statusCode).toBe(201);
      expect((await call('GET', `/projects/${res.json().id}/settings`)).json()).toMatchObject({ integrateWhenDone: true });
      if (!('repoPath' in payload)) rmSync(res.json().repoPath, { recursive: true, force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('an existing repository gives the project its checked-out branch as the default branch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'office-master-'));
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir });
    const post = (payload: object) => t.app.inject({ method: 'POST', url: '/projects', headers: { cookie }, payload });
    const res = await post({ name: 'M', slug: 'm-master', repoPath: dir });
    expect(res.statusCode).toBe(201);
    expect(res.json().defaultBranch).toBe('master');
    const explicit = await post({ name: 'M2', slug: 'm-explicit', repoPath: dir, defaultBranch: 'main' });
    expect(explicit.json().defaultBranch).toBe('main');
    // a folder inside that repository is refused with the root named; an empty folder becomes a repository
    execFileSync('mkdir', ['-p', join(dir, 'sub')]);
    const inside = await post({ name: 'S', slug: 'm-sub', repoPath: join(dir, 'sub') });
    expect(inside.statusCode).toBe(400);
    expect(inside.json()).toMatchObject({ error: 'not_repo_root', message: expect.stringContaining(`inside the repository at ${dir}`) });
    const fresh = mkdtempSync(join(tmpdir(), 'office-empty-'));
    const made = await post({ name: 'E', slug: 'm-empty', repoPath: fresh });
    expect(made.statusCode).toBe(201);
    expect(made.json().defaultBranch).toBe('main');
    expect(execFileSync('git', ['log', '--oneline'], { cwd: fresh }).toString()).toContain('Initial commit');
    expect(execFileSync('git', ['ls-files'], { cwd: fresh }).toString().trim().split('\n').sort()).toEqual(['.gitignore', 'CLAUDE.md']);
    expect(readFileSync(join(fresh, 'CLAUDE.md'), 'utf8')).toContain('# E');
    // a folder that does not exist yet is made, with the folders above it
    const plain = mkdtempSync(join(tmpdir(), 'office-plain-'));
    const missing = join(plain, 'deeper', 'new');
    expect((await post({ name: 'N', slug: 'm-new', repoPath: missing, defaultBranch: 'trunk' })).statusCode).toBe(201);
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: missing }).toString().trim()).toBe('trunk');
    // but not inside somebody's repository: a repository in a repository would be committed into the outer one
    const nested = await post({ name: 'X', slug: 'm-nested', repoPath: join(dir, 'not', 'yet') });
    expect(nested.statusCode).toBe(400);
    expect(nested.json()).toMatchObject({ error: 'not_repo_root', message: expect.stringContaining(`inside the repository at ${dir}`) });
    expect(existsSync(join(dir, 'not'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  it('a folder opened without a slug gets the first free one from its name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'office-open-'));
    try {
      const post = (payload: object) => t.app.inject({ method: 'POST', url: '/projects', headers: { cookie }, payload });
      const first = await post({ name: 'Şık Dükkanım', repoPath: join(dir, 'a') });
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json()).toMatchObject({ name: 'Şık Dükkanım', slug: 'sik-dukkanim', repoPath: join(dir, 'a') });
      // the same name again is a second project with the next free slug, not a conflict
      expect((await post({ name: 'Şık Dükkanım', repoPath: join(dir, 'b') })).json()).toMatchObject({ slug: 'sik-dukkanim-2' });
      // a name without a letter or digit still gets a slug
      expect((await post({ name: '!!!', repoPath: join(dir, 'c') })).json()).toMatchObject({ slug: 'project' });
      // a slug that was given and is taken stays a conflict
      expect((await post({ name: 'X', slug: 'sik-dukkanim', repoPath: join(dir, 'd') })).statusCode).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('project without repoPath gets a fresh repository under <dataDir>/repos/<slug>', async () => {
    const dir = resolve(t.config.dataDir, 'repos', 'fresh');
    await rm(dir, { recursive: true, force: true });
    try {
      const res = await t.app.inject({ method: 'POST', url: '/projects', headers: { cookie }, payload: { name: 'F', slug: 'fresh' } });
      expect(res.statusCode).toBe(201);
      expect(res.json().repoPath).toBe(dir);
      const log = execFileSync('git', ['log', '--format=%s', 'main'], { cwd: dir, encoding: 'utf8' }).trim();
      expect(log).toBe('Initial commit');
      // the directory now exists: a second project must not reuse it
      const again = await t.app.inject({ method: 'POST', url: '/projects', headers: { cookie }, payload: { name: 'F2', slug: 'fresh' } });
      expect(again.statusCode).toBe(409);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('project update and delete; delete refused while a mission is live, finished history goes with the project', async () => {
    const p = (await t.prisma.project.create({ data: { name: 'D', slug: 'd', repoPath: '/tmp/d' } })).id;
    const up = await t.app.inject({ method: 'PUT', url: `/projects/${p}`, headers: { cookie }, payload: { name: 'D2', defaultBranch: 'dev' } });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: 'D2', defaultBranch: 'dev' });
    await call('PUT', `/projects/${p}/agents`, { agentIds: [a1] });
    const task = await t.prisma.task.create({ data: { projectId: p, agentId: a1, title: 't', description: '' } });
    const mission = await t.prisma.mission.create({ data: { projectId: p, title: 'M', request: 'r', status: 'running' } });
    expect((await t.app.inject({ method: 'DELETE', url: `/projects/${p}`, headers: { cookie } })).statusCode).toBe(409);
    await t.prisma.mission.update({ where: { id: mission.id }, data: { status: 'cancelled' } });
    expect((await t.app.inject({ method: 'DELETE', url: `/projects/${p}`, headers: { cookie } })).statusCode).toBe(204);
    expect(await t.prisma.project.findUnique({ where: { id: p } })).toBeNull();
    expect(await t.prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
    expect(await t.prisma.mission.findUnique({ where: { id: mission.id } })).toBeNull();
    expect((await t.app.inject({ method: 'DELETE', url: `/projects/${p}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('missing artifact file is 404 artifact_file_missing', async () => {
    const art = await storeArtifact(t.prisma, t.config, { projectId, kind: 'k', name: 'n', content: 'x' });
    await rm(art.path);
    const res = await call('GET', `/artifacts/${art.id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('artifact_file_missing');
  });

  it('project agents set/replace, system rejected, agentAllowed', async () => {
    expect(await agentAllowed(t.prisma, projectId, a1)).toBe(true);
    expect((await call('PUT', `/projects/${projectId}/agents`, { agentIds: [a1] })).statusCode).toBe(200);
    expect(await agentAllowed(t.prisma, projectId, a1)).toBe(true);
    expect(await agentAllowed(t.prisma, projectId, a2)).toBe(false);
    await call('PUT', `/projects/${projectId}/agents`, { agentIds: [a2] });
    const list = (await call('GET', `/projects/${projectId}/agents`)).json();
    expect(list.map((a: { id: string }) => a.id)).toEqual([a2]);
    const sys = (await t.prisma.agent.create({ data: { name: 's', slug: 's', role: 'x', isSystem: true } })).id;
    const bad = await call('PUT', `/projects/${projectId}/agents`, { agentIds: [sys] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_agent');
  });

  it('audit rows written for settings and agents updates', async () => {
    const rows = (await call('GET', `/audit?targetType=project&targetId=${projectId}`)).json();
    const actions = rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('settings.updated');
    expect(actions).toContain('project_agents.updated');
  });

  it('artifact stored 0600 and redacted, served by route', async () => {
    const art = await storeArtifact(t.prisma, t.config, {
      projectId, kind: 'check_output', name: 'out', content: 'key sk-ant-api03-abcdefghijklmnopqrstuvwx end',
    });
    const path = `${t.config.artifactsDir}/${projectId}/${art.id}.txt`;
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toMatch(/sk-ant-api03-abc/);
    expect(art.bytes).toBe(Buffer.byteLength(await readFile(path, 'utf8')));
    expect(await readArtifact(t.config, art)).not.toMatch(/sk-ant/);
    const res = await call('GET', `/artifacts/${art.id}`);
    expect(res.json().content).toContain('end');
    expect((await call('GET', '/artifacts/nope')).statusCode).toBe(404);
  });
});

describe('project delete', () => {
  it('takes the whole history with it, but not while a mission is live', async () => {
    const t = await makeApp();
    const cookie = await t.login();
    const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });
    await req('POST', '/agents', { name: 'chief', slug: 'chief', role: 'chief', description: 'the chief', config: { systemPrompt: 'plan', model: 'sonnet', allowedTools: ['Read'] } });
    const p = (await req('POST', '/projects', { name: 'Gone', slug: 'gone', repoPath: '/tmp/office-ws/gone' })).json().id as string;
    const m = (await req('POST', '/missions', { projectId: p, request: 'do things' })).json().id as string;
    await t.prisma.task.create({ data: { projectId: p, agentId: (await t.prisma.agent.findFirstOrThrow()).id, title: 'T', missionId: m } });
    await t.prisma.memoryEntry.create({ data: { projectId: p, scope: 'project', type: 'decision', title: 'd', content: 'c', authorType: 'user' } });
    const refused = await req('DELETE', `/projects/${p}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'project_in_use', message: expect.stringContaining('1 mission(s)') });
    expect((await req('POST', `/missions/${m}/cancel`)).statusCode).toBe(200);
    expect((await req('DELETE', `/projects/${p}`)).statusCode).toBe(204);
    expect(await t.prisma.project.findUnique({ where: { id: p } })).toBeNull();
    expect(await t.prisma.mission.count({ where: { projectId: p } })).toBe(0);
    expect(await t.prisma.task.count({ where: { projectId: p } })).toBe(0);
    expect(await t.prisma.memoryEntry.count({ where: { projectId: p } })).toBe(0);
    expect((await t.prisma.auditLog.findFirst({ where: { action: 'project.deleted', targetId: p } }))?.detail).toEqual({ slug: 'gone' });
    await t.close();
  });
});

describe('project folder grant', () => {
  it('asks the local worker to add a folder outside its roots, and records the new roots', async () => {
    const t = await makeApp();
    const cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const req = (method: 'GET' | 'POST', url: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });
    const { id: workerId, enrollToken } = (await req('POST', '/workers', { name: 'w1' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1', allowedRoots: ['/tmp/office-ws'] });
    const dir = mkdtempSync(join(tmpdir(), 'office-grant-'));
    const creating = req('POST', '/projects', { name: 'G', slug: 'granted', repoPath: dir });
    const ask = await w.waitFor('roots.add');
    expect(ask.path).toBe(dir);
    w.send({ type: 'roots.changed', requestId: ask.requestId, allowedRoots: ['/tmp/office-ws', dir] });
    expect((await creating).statusCode).toBe(201);
    await until(async () => (await t.prisma.worker.findUniqueOrThrow({ where: { id: workerId } })).allowedRoots.includes(dir), 'roots stored');
    expect(t.app.gateway.onlineWorkers()[0]!.local(dir)).toBe(true);
    expect((await t.prisma.auditLog.findFirst({ where: { action: 'worker.root_granted' } }))?.detail).toMatchObject({ path: dir });
    // a folder already under the roots asks nothing
    const under = await req('POST', '/projects', { name: 'U', slug: 'under', repoPath: '/tmp/office-ws/u' });
    expect(under.statusCode).toBe(201);
    expect(w.received.filter((m) => m.type === 'roots.add')).toHaveLength(1);
    await w.close();
    rmSync(dir, { recursive: true, force: true });
    await t.close();
  });
});

describe('folder browser', () => {
  it('lists directories under the home, the data dir and worker roots only', async () => {
    const t = await makeApp();
    const cookie = await t.login();
    const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } });
    const base = mkdtempSync(join(tmpdir(), 'office-browse-'));
    execFileSync('mkdir', ['-p', join(base, 'repo', '.git'), join(base, 'plain'), join(base, '.hidden'), join(base, 'node_modules')]);
    const outside = await get(`/browse?path=${encodeURIComponent(base)}`);
    expect(outside.statusCode).toBe(400);
    expect(outside.json()).toMatchObject({ error: 'outside_scope' });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { enrollToken } = (await t.app.inject({ method: 'POST', url: '/workers', headers: { cookie }, payload: { name: 'w' } })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, allowedRoots: [base] });
    const listed = await get(`/browse?path=${encodeURIComponent(base)}`);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ path: base, parent: null, isRepo: false, dirs: [{ name: 'plain', isRepo: false }, { name: 'repo', isRepo: true }] });
    expect((await get(`/browse?path=${encodeURIComponent(join(base, 'repo'))}`)).json()).toMatchObject({ parent: base, isRepo: true, dirs: [] });
    expect((await get(`/browse?path=${encodeURIComponent(join(base, 'missing'))}`)).statusCode).toBe(404);
    expect((await get('/browse')).json().path).toBe(resolve(process.env.HOME!));
    await w.close();
    rmSync(base, { recursive: true, force: true });
    await t.close();
  });
});
