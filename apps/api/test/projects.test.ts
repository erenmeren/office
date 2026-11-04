import { rm, stat, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentAllowed } from '../src/services/project-service.js';
import { storeArtifact, readArtifact } from '../src/services/artifact-store.js';
import { makeApp } from './helpers.js';

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

  it('project update and delete; delete refused while tasks exist', async () => {
    const p = (await t.prisma.project.create({ data: { name: 'D', slug: 'd', repoPath: '/tmp/d' } })).id;
    const up = await t.app.inject({ method: 'PUT', url: `/projects/${p}`, headers: { cookie }, payload: { name: 'D2', defaultBranch: 'dev' } });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: 'D2', defaultBranch: 'dev' });
    await call('PUT', `/projects/${p}/agents`, { agentIds: [a1] });
    const task = await t.prisma.task.create({ data: { projectId: p, agentId: a1, title: 't', description: '' } });
    expect((await t.app.inject({ method: 'DELETE', url: `/projects/${p}`, headers: { cookie } })).statusCode).toBe(409);
    await t.prisma.task.delete({ where: { id: task.id } });
    expect((await t.app.inject({ method: 'DELETE', url: `/projects/${p}`, headers: { cookie } })).statusCode).toBe(204);
    expect(await t.prisma.project.findUnique({ where: { id: p } })).toBeNull();
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
