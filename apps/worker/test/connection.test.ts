import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { FakeAdapter } from '@office/runtime';
import type { WorkerToApi } from '@office/shared';
import { WorkerConnection } from '../src/connection.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

it('buffers an approval.request made while disconnected and delivers it once after the next welcome', async () => {
  const home = mkdtempSync(join(tmpdir(), 'office-conn-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const wss = new WebSocketServer({ port: 0 });
  cleanup.push(() => new Promise((r) => wss.close(r)));
  const received: WorkerToApi[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d)) as WorkerToApi;
      received.push(msg);
      if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'welcome', workerId: 'w1', credential: 'c1' }));
    });
  });
  const port = (wss.address() as { port: number }).port;
  const conn = new WorkerConnection(
    { apiUrl: `ws://127.0.0.1:${port}`, home, enrollToken: 't', workspaceRoots: [home], runtime: 'fake', capacity: 1, name: 'w' },
    { adapter: new FakeAdapter(), heartbeatMs: 60_000, reconnectBaseMs: 300, logger: pino({ level: 'silent' }) },
  );
  cleanup.push(() => conn.stop());
  await conn.start();
  sockets[0]!.terminate();
  await new Promise((r) => setTimeout(r, 50));
  const request = { requestId: 'q1', toolName: 'Bash', input: { command: 'rm -rf x' }, type: 'destructive_command' as const, reason: 'r' };
  (conn as unknown as { send(m: WorkerToApi): void }).send({ type: 'approval.request', runId: 'r1', sessionId: 's1', request });
  const deadline = Date.now() + 3000;
  while (received.filter((m) => m.type === 'hello').length < 2 || !received.some((m) => m.type === 'approval.request')) {
    if (Date.now() > deadline) throw new Error('approval.request not delivered after reconnect');
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 100));
  expect(received.filter((m) => m.type === 'approval.request')).toEqual([
    { type: 'approval.request', runId: 'r1', sessionId: 's1', request },
  ]);
});
