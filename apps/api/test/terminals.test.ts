import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiClientMessage, UiServerMessage } from '@office/shared';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until } from './fake-worker.js';

describe('manual sessions (terminals on the local worker)', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await t.close();
  });

  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });
  const worker = async () => {
    const { enrollToken } = (await req('POST', '/workers', { name: 'w1' })).json();
    return connectFakeWorker(t.app, { enrollToken, allowedRoots: ['/tmp/office-ws'] });
  };
  const uiClient = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/ws/ui`, { headers: { cookie } });
    sockets.push(ws);
    const msgs: UiServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d)) as UiServerMessage));
    await new Promise<void>((resolve, reject) => ws.once('open', resolve).once('error', reject));
    return { msgs, send: (m: UiClientMessage) => ws.send(JSON.stringify(m)), ws };
  };
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('opens on the project repo, streams output and input over /ws/ui, stops and forgets', async () => {
    const w = await worker();
    const project = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json();
    const opening = req('POST', '/terminals', { projectId: project.id, cols: 100, rows: 30 });
    const open = await w.waitFor('terminal.open');
    expect(open).toMatchObject({ dir: '/tmp/office-ws/p', cols: 100, rows: 30 });
    expect(open.resumeSessionId).toBeUndefined();
    w.send({ type: 'terminal.opened', terminalId: open.terminalId, pid: 42, dir: open.dir, claudeSessionId: open.claudeSessionId, startedAt: new Date().toISOString() });
    const res = await opening;
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: open.terminalId, projectId: project.id, status: 'running', pid: 42, claudeSessionId: open.claudeSessionId });

    // output before anyone watches is kept as scrollback and replayed on subscribe
    w.send({ type: 'terminal.output', terminalId: open.terminalId, data: b64('hello ') });
    await until(() => t.app.gateway.terminals.scrollback(open.terminalId) !== '', 'scrollback');
    const ui = await uiClient();
    ui.send({ type: 'subscribe', topic: `terminal:${open.terminalId}` });
    await until(() => ui.msgs.length >= 1, 'replay');
    expect(ui.msgs[0]).toEqual({ type: 'terminal.output', topic: `terminal:${open.terminalId}`, data: b64('hello ') });
    w.send({ type: 'terminal.output', terminalId: open.terminalId, data: b64('world') });
    await until(() => ui.msgs.length >= 2, 'live output');
    expect(ui.msgs[1]).toMatchObject({ type: 'terminal.output', data: b64('world') });

    ui.send({ type: 'terminal.input', terminalId: open.terminalId, data: 'ls\r' });
    expect(await w.waitFor('terminal.input')).toEqual({ type: 'terminal.input', terminalId: open.terminalId, data: 'ls\r' });
    ui.send({ type: 'terminal.resize', terminalId: open.terminalId, cols: 80, rows: 24 });
    expect(await w.waitFor('terminal.resize')).toMatchObject({ cols: 80, rows: 24 });

    expect((await req('DELETE', `/terminals/${open.terminalId}`)).json()).toMatchObject({ status: 'running' });
    expect(await w.waitFor('terminal.close')).toEqual({ type: 'terminal.close', terminalId: open.terminalId });
    w.send({ type: 'terminal.exit', terminalId: open.terminalId, exitCode: 0 });
    await until(() => ui.msgs.some((m) => m.type === 'terminal.exit'), 'exit');
    expect((await req('GET', '/terminals')).json()).toMatchObject([{ id: open.terminalId, status: 'exited', exitCode: 0 }]);
    expect((await req('DELETE', `/terminals/${open.terminalId}`)).json()).toMatchObject({ status: 'exited' });
    expect((await req('GET', '/terminals')).json()).toEqual([]);
    const audits = await t.prisma.auditLog.findMany({ where: { targetId: open.terminalId }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['terminal.opened', 'terminal.closed']);
    await w.close();
  });

  it('maps refusals, re-adopts an announced terminal and ends terminals of a gone worker', async () => {
    expect((await req('POST', '/terminals', { dir: '/tmp/office-ws/x' })).statusCode).toBe(503);
    expect((await req('POST', '/terminals', { dir: '/tmp/office-ws/x', projectId: 'p' })).statusCode).toBe(400);
    const w = await worker();
    const project = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json();
    const live = req('POST', '/terminals', { dir: '/tmp/office-ws/p/sub', resumeSessionId: 'old-1' });
    const open = await w.waitFor('terminal.open');
    expect(open).toMatchObject({ resumeSessionId: 'old-1', claudeSessionId: 'old-1' });
    w.send({ type: 'terminal.error', terminalId: open.terminalId, code: 'session_live', message: 'pid 7' });
    expect((await live).statusCode).toBe(409);
    expect((await req('GET', '/terminals')).json()).toEqual([]);

    // a terminal from before an API restart: announced by the worker, joined with the project by its folder
    w.send({ type: 'terminal.opened', terminalId: 'old-term', pid: 5, dir: '/tmp/office-ws/p/deep', claudeSessionId: 'c1', startedAt: '2026-11-04T00:00:00.000Z' });
    await until(() => t.app.gateway.terminals.get('old-term'), 'adopted');
    expect(t.app.gateway.terminals.get('old-term')).toMatchObject({ projectId: project.id, status: 'running', pid: 5, startedAt: '2026-11-04T00:00:00.000Z' });
    await w.close();
    await until(() => t.app.gateway.terminals.get('old-term')?.status === 'exited', 'exited with the worker');
    expect(t.app.gateway.terminals.get('old-term')).toMatchObject({ exitCode: null });
  });
});
