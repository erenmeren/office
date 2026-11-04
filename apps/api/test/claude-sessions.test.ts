import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiToWorker } from '@office/shared';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until, type FakeWorker } from './fake-worker.js';

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
  const worker = async (machineId?: string | null, name = 'w1') => {
    const { enrollToken } = (await req('POST', '/workers', { name })).json();
    return connectFakeWorker(t.app, { enrollToken, name, allowedRoots: ['/tmp/office-ws'], machineId });
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
    const wid = w.workerId!;
    expect(res.json()).toEqual({ sessions: [{ ...sessions[0], projectId: p, workerId: wid, workerName: 'w1', local: true }, { ...sessions[1], projectId: null, workerId: wid, workerName: 'w1', local: true }] });
    await w.close();
  });

  it('asks every worker with roots and joins a remote clone with its project', async () => {
    const p = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json().id;
    const local = await worker();
    const remote = await worker('other-machine', 'far');
    const pending = req('GET', '/claude-sessions');
    await answer(local, { result: { kind: 'list', sessions: [{ sessionId: 'l1', title: 'here', cwd: '/tmp/office-ws/p', lastModified: 1 }] } });
    await answer(remote, { result: { kind: 'list', sessions: [{ sessionId: 'r1', title: 'there', cwd: `/srv/worker/repos/${p}/x`, lastModified: 2 }] } });
    expect((await pending).json()).toEqual({
      sessions: [
        { sessionId: 'l1', title: 'here', cwd: '/tmp/office-ws/p', lastModified: 1, workerId: local.workerId, workerName: 'w1', local: true, projectId: p },
        { sessionId: 'r1', title: 'there', cwd: `/srv/worker/repos/${p}/x`, lastModified: 2, workerId: remote.workerId, workerName: 'far', local: false, projectId: p },
      ],
    });
    // a transcript on the remote worker goes to that worker
    const page = req('GET', `/claude-sessions/r1/messages?dir=/srv/worker/repos/${p}/x&workerId=${remote.workerId}`);
    expect(await answer(remote, { result: { kind: 'messages', entries: [], nextOffset: null } })).toMatchObject({ kind: 'messages', sessionId: 'r1' });
    expect((await page).statusCode).toBe(200);
    // no terminal emulator on another machine; rename goes there like a transcript
    expect((await req('POST', '/claude-sessions/r1/open', { dir: '/x', workerId: remote.workerId })).json()).toMatchObject({ error: 'not_local' });
    const renaming = req('POST', '/claude-sessions/r1/rename', { dir: '/x', title: ' Better ', workerId: remote.workerId });
    expect(await answer(remote, { result: { kind: 'rename' } })).toEqual({ kind: 'rename', sessionId: 'r1', dir: '/x', title: 'Better' });
    expect((await renaming).statusCode).toBe(200);
    await remote.close();
    await until(() => !t.app.gateway.isConnected(remote.workerId!), 'remote gone');
    expect((await req('GET', `/claude-sessions/r1/messages?dir=/x&workerId=${remote.workerId}`)).json()).toMatchObject({ error: 'worker_offline' });
    await local.close();
  });

  it('maps worker refusals and a missing local worker to HTTP errors', async () => {
    expect((await req('GET', '/claude-sessions')).json()).toEqual({ sessions: [], unavailable: 'no_local_worker' });
    const remote = await worker('other-machine');
    // without a workerId a transcript needs the local worker
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
    expect((await dropped).json()).toEqual({ sessions: [], unavailable: 'worker_failed:w1' });
  });

  it('starts, stops and removes background sessions through the worker', async () => {
    const w = await worker();
    const p = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json().id;
    const starting = req('POST', '/claude-sessions/background', { projectId: p, prompt: 'write the changelog' });
    expect(await answer(w, { result: { kind: 'background', id: 'ab12cd34', output: 'claude attach ab12cd34' } })).toEqual({ kind: 'background', action: 'start', dir: '/tmp/office-ws/p', prompt: 'write the changelog' });
    const started = await starting;
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ id: 'ab12cd34' });
    const stopping = req('POST', '/claude-sessions/background/ab12cd34/stop');
    expect(await answer(w, { result: { kind: 'background', output: 'stopped ab12cd34' } })).toEqual({ kind: 'background', action: 'stop', id: 'ab12cd34' });
    expect((await stopping).json()).toMatchObject({ output: 'stopped ab12cd34' });
    const failing = req('POST', '/claude-sessions/background', { dir: '/tmp/office-ws/q', prompt: 'x' });
    await answer(w, { error: { code: 'claude_failed', message: 'Workspace not trusted' } });
    expect((await failing).statusCode).toBe(409);
    const logs = req('POST', '/claude-sessions/background/ab12cd34/logs');
    expect(await answer(w, { result: { kind: 'background', output: 'screen text' } })).toEqual({ kind: 'background', action: 'logs', id: 'ab12cd34' });
    expect((await logs).json()).toMatchObject({ output: 'screen text' });
    const deleting = req('DELETE', '/claude-sessions/s9?dir=/tmp/office-ws/p');
    expect(await answer(w, { result: { kind: 'delete' } })).toEqual({ kind: 'delete', sessionId: 's9', dir: '/tmp/office-ws/p' });
    expect((await deleting).statusCode).toBe(200);
    const audits = await t.prisma.auditLog.findMany({ where: { targetType: 'claude_session' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['background.started', 'background.stopped', 'claude_session.deleted']);
    await w.close();
  });
});
