import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { makeApp } from './helpers.js';
import { connectFakeWorker, until } from './fake-worker.js';

describe('worker gateway', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterEach(() => t.close());

  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  const enroll = async () => {
    const res = await req('POST', '/workers', { name: 'w1' });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; enrollToken: string };
  };

  it('enrolls with a token, then reconnects with the credential', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1', capacity: 2, allowedRoots: ['/tmp'] });
    const welcome = w.received[0]!;
    expect(welcome).toMatchObject({ type: 'welcome', workerId: id });
    expect(typeof w.credential).toBe('string');
    const row = await t.prisma.worker.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('online');
    expect(row.enrollTokenHash).toBeNull();
    expect(row.credentialHash).not.toBeNull();
    expect(row.capacity).toBe(2);
    expect(row.allowedRoots).toEqual(['/tmp']);

    const list = await req('GET', '/workers');
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).not.toHaveProperty('enrollTokenHash');
    expect(list.json()[0]).not.toHaveProperty('credentialHash');

    await w.close();
    await until(
      async () => (await t.prisma.worker.findUniqueOrThrow({ where: { id } })).status === 'offline',
      'worker offline',
    );

    // the enroll token is single-use
    const again = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    expect(again.received[0]!.type).toBe('error');

    const re = await connectFakeWorker(t.app, { credential: w.credential, name: 'w1' });
    expect(re.received[0]).toEqual({ type: 'welcome', workerId: id });
    await re.close();
  });

  it('rejects a bad credential with an error, then closes', async () => {
    const w = await connectFakeWorker(t.app, { credential: 'nope', name: 'x' });
    expect(w.received[0]!.type).toBe('error');
    expect(await w.closed).toBe(4401);
  });

  it('closes a socket whose first message is not hello', async () => {
    const { port } = t.app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
    const messages: unknown[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    const code = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'heartbeat', capacity: 1, activeRunIds: [] }));
    expect(await code).toBe(4400);
    expect(messages).toEqual([{ type: 'error', message: expect.any(String) }]);
  });

  it('revoked worker is disconnected and cannot reconnect', async () => {
    const { id, enrollToken } = await enroll();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w1' });
    const del = await req('DELETE', `/workers/${id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json().status).toBe('revoked');
    expect(del.json()).not.toHaveProperty('credentialHash');
    await w.closed;
    expect((await t.prisma.worker.findUniqueOrThrow({ where: { id } })).status).toBe('revoked');

    const re = await connectFakeWorker(t.app, { credential: w.credential, name: 'w1' });
    expect(re.received[0]!.type).toBe('error');
    expect(await re.closed).toBe(4401);
  });
});
