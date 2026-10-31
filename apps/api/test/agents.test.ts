import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

describe('agents', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
  });
  afterAll(() => t.close());

  const config = { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'] };
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  it('creates, versions immutably, and validates', async () => {
    const created = await req('POST', '/agents', { name: 'A', slug: 'a', role: 'dev', config });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent.currentVersion.version).toBe(1);
    expect(agent.currentVersion.config).toMatchObject({ maxTurns: 50, maxBudgetUsd: 2 });

    const put = await req('PUT', `/agents/${agent.id}`, { config: { ...config, systemPrompt: 'y' } });
    expect(put.json().currentVersion.version).toBe(2);
    const got = (await req('GET', `/agents/${agent.id}`)).json();
    expect(got.versions).toHaveLength(2);
    const v1 = got.versions.find((v: { version: number }) => v.version === 1);
    expect(v1.config.systemPrompt).toBe('x');

    const renamed = await req('PUT', `/agents/${agent.id}`, { name: 'B' });
    expect(renamed.json().name).toBe('B');
    expect(renamed.json().currentVersion.version).toBe(2);
    expect((await req('GET', `/agents/${agent.id}`)).json().versions).toHaveLength(2);

    const list = (await req('GET', '/agents')).json();
    expect(list[0].currentVersion.version).toBe(2);

    const bad = await req('POST', '/agents', {
      name: 'C', slug: 'c', role: 'dev', config: { ...config, allowedTools: 'Read' },
    });
    expect(bad.statusCode).toBe(400);
    const dup = await req('POST', '/agents', { name: 'A', slug: 'a', role: 'dev', config });
    expect(dup.statusCode).toBe(409);
    expect((await req('GET', '/agents/nope')).statusCode).toBe(404);
  });

  it('projects crud', async () => {
    const p = await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/p' });
    expect(p.statusCode).toBe(201);
    expect(p.json().defaultBranch).toBe('main');
    expect((await req('GET', `/projects/${p.json().id}`)).statusCode).toBe(200);
  });
});
