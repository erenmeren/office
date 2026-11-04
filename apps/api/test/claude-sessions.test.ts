import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiToWorker } from '@office/shared';
import { makeApp } from './helpers.js';
import { connectFakeWorker, type FakeWorker } from './fake-worker.js';

describe('claude sessions (external CLI sessions through the local worker)', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(() => t.close());

  const req = (method: 'GET' | 'POST', url: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });
  const worker = async (machineId?: string | null) => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w1' })).json();
    return connectFakeWorker(t.app, { enrollToken, allowedRoots: ['/tmp/office-ws'], machineId });
  };
  // answers the next sessions.request with `reply`, returning the query it carried
  const answer = async (w: FakeWorker, reply: Omit<Extract<ApiToWorker, { type: 'sessions.request' }>, 'type' | 'requestId' | 'query'> & object) => {
    const m = await w.waitFor('sessions.request');
    w.send({ type: 'sessions.response', requestId: m.requestId, ...reply });
    return m.query;
  };

  it('lists sessions joined with projects and without Office SDK sessions', async () => {
    const w = await worker();
    const p = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json().id;
    const sessions = [
      { sessionId: 's1', title: 'in p', cwd: '/tmp/office-ws/p/sub', lastModified: 2 },
      { sessionId: 's2', title: 'elsewhere', cwd: '/tmp/office-ws/other', lastModified: 1, live: { pid: 1, kind: 'interactive', status: 'idle' } },
    ];
    const pending = req('GET', '/claude-sessions');
    const query = await answer(w, { result: { kind: 'list', sessions } });
    expect(query).toEqual({ kind: 'list', limit: 200 });
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [{ ...sessions[0], projectId: p }, { ...sessions[1], projectId: null }] });
    await w.close();
  });

  it('maps worker refusals and a missing local worker to HTTP errors', async () => {
    expect((await req('GET', '/claude-sessions')).json()).toEqual({ sessions: [], unavailable: 'no_local_worker' });
    const remote = await worker('other-machine');
    expect((await req('GET', '/claude-sessions')).json()).toEqual({ sessions: [], unavailable: 'no_local_worker' });
    expect((await req('GET', '/claude-sessions/s1/messages?dir=/tmp/office-ws/p')).statusCode).toBe(503);
    await remote.close();
    const w = await worker();
    const live = req('POST', '/claude-sessions/s1/open', { dir: '/tmp/office-ws/p' });
    expect(await answer(w, { error: { code: 'session_live', message: 'pid 7' } })).toEqual({ kind: 'open', sessionId: 's1', dir: '/tmp/office-ws/p' });
    expect((await live).statusCode).toBe(409);
    const page = req('GET', '/claude-sessions/s1/messages?dir=/tmp/office-ws/p&offset=20&limit=10');
    expect(await answer(w, { result: { kind: 'messages', entries: [{ uuid: 'u', role: 'user', text: 'hi', tools: [] }], nextOffset: null } })).toEqual({
      kind: 'messages', sessionId: 's1', dir: '/tmp/office-ws/p', offset: 20, limit: 10,
    });
    expect((await page).json()).toEqual({ kind: 'messages', entries: [{ uuid: 'u', role: 'user', text: 'hi', tools: [] }], nextOffset: null });
    const dropped = req('GET', '/claude-sessions');
    await w.waitFor('sessions.request');
    await w.close();
    expect((await dropped).json()).toEqual({ sessions: [], unavailable: 'worker_disconnected' });
  });
});
