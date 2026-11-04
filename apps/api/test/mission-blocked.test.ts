import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';
import { connectFakeWorker } from './fake-worker.js';

describe('a planning mission says why no worker takes it', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(() => t.close());
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });

  it('names the repository path no worker reaches, the missing tags, or nothing', async () => {
    await req('POST', '/agents', { name: 'chief', slug: 'chief', role: 'chief', description: 'the chief', config: { systemPrompt: 'plan', model: 'sonnet', allowedTools: ['Read'] } });
    const far = (await req('POST', '/projects', { name: 'Far', slug: 'far', repoPath: '/tmp/elsewhere/far' })).json();
    const near = (await req('POST', '/projects', { name: 'Near', slug: 'near', repoPath: '/tmp/office-ws/near' })).json();
    const mission = async (projectId: string) => (await req('POST', '/missions', { projectId, request: 'build tetris' })).json().id as string;
    const farMission = await mission(far.id);
    const blocked = async (id: string) => (await req('GET', `/missions/${id}`)).json().blocked as string | null;
    expect(await blocked(farMission)).toBe('No worker is online. Start a worker on this machine or connect a remote one.');
    const { enrollToken } = (await req('POST', '/workers', { name: 'w1' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, allowedRoots: ['/tmp/office-ws'] });
    expect(await blocked(farMission)).toContain('No online worker can reach /tmp/elsewhere/far');
    const nearMission = await mission(near.id);
    expect(await blocked(nearMission)).toBeNull();
    expect((await req('PUT', `/projects/${near.id}/settings`, { requiredWorkerTags: ['gpu'] })).statusCode).toBe(200);
    expect(await blocked(nearMission)).toContain('required tags (gpu)');
    await w.close();
  });
});
