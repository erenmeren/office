import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

describe('tasks', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let projectId: string;
  let agentId: string;
  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
    projectId = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/p' })).json().id;
    agentId = (
      await req('POST', '/agents', {
        name: 'A', slug: 'a', role: 'dev', config: { systemPrompt: 's', model: 'sonnet', allowedTools: [] },
      })
    ).json().id;
  });
  afterAll(() => t.close());

  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  it('creates a ready task, shows runs, cancels', async () => {
    const created = await req('POST', '/tasks', { projectId, agentId, title: 'T', description: 'd' });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.status).toBe('ready');

    const got = await req('GET', `/tasks/${task.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().runs).toEqual([]);

    const list = (await req('GET', `/tasks?projectId=${projectId}`)).json();
    expect(list.map((x: { id: string }) => x.id)).toEqual([task.id]);

    const cancelled = await req('POST', `/tasks/${task.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    expect((await req('GET', `/tasks/${task.id}`)).json().status).toBe('cancelled');

    expect((await req('POST', `/tasks/${task.id}/cancel`)).statusCode).toBe(409);
    expect((await req('POST', '/tasks', { projectId, agentId })).statusCode).toBe(400);
    expect((await req('GET', '/tasks/nope')).statusCode).toBe(404);
  });
});
