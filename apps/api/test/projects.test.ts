import { stat, readFile } from 'node:fs/promises';
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
    expect(s.approvalPolicy.plan).toBe('ask');
    const put = await call('PUT', `/projects/${projectId}/settings`, { checkCommand: 'pnpm test', dailyBudgetUsd: 10 });
    expect(put.statusCode).toBe(200);
    const again = (await call('GET', `/projects/${projectId}/settings`)).json();
    expect(again.checkCommand).toBe('pnpm test');
    expect(again.dailyBudgetUsd).toBe(10);
    expect(again.approvalTimeoutMinutes).toBe(30);
    expect((await call('PUT', `/projects/${projectId}/settings`, { dailyBudgetUsd: -1 })).statusCode).toBe(400);
    expect((await call('PUT', '/projects/nope/settings', {})).statusCode).toBe(404);
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
