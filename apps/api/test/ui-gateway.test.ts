import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeEvent, RunSpec, UiClientMessage, UiServerMessage } from '@office/shared';
import { UiServerMessageSchema } from '@office/shared';
import { makeApp } from './helpers.js';
import { UiGateway } from '../src/ws/ui-gateway.js';
import { listEvents } from '../src/services/event-store.js';
import { connectFakeWorker, until, type FakeWorker } from './fake-worker.js';

describe('ui gateway', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let w: FakeWorker;
  let spec: RunSpec;
  let taskId: string;
  let clients: UiClient[];

  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });
  const event = (seq: number): OfficeEvent => ({
    type: 'agent.text', seq, ts: new Date().toISOString(), sessionId: spec.sessionId,
    runId: spec.runId, agentId: spec.agentId, projectId: spec.projectId, payload: { text: `e${seq}` },
  });
  const workerEvent = (seq: number) => w.send({ type: 'run.event', event: event(seq) });
  const flush = async () => {
    w.send({ type: 'bogus' });
    await w.waitFor('error');
  };

  class UiClient {
    msgs: UiServerMessage[] = [];
    ws: WebSocket;
    closed: Promise<number>;
    constructor(headers: Record<string, string> | undefined, port = (t.app.server.address() as AddressInfo).port) {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ui`, { headers });
      this.ws.on('message', (d) => this.msgs.push(UiServerMessageSchema.parse(JSON.parse(String(d)))));
      this.closed = new Promise((r) => this.ws.on('close', (code) => r(code)));
      clients.push(this);
    }
    open() {
      return new Promise<void>((resolve, reject) => {
        this.ws.once('open', () => resolve());
        this.ws.once('error', reject);
      });
    }
    send(m: UiClientMessage) {
      this.ws.send(JSON.stringify(m));
    }
    seqs(topic: string) {
      return this.msgs.flatMap((m) => (m.type === 'event' && m.topic === topic ? [m.event.seq] : []));
    }
    done(topic: string) {
      return until(() => this.msgs.find((m) => m.type === 'replay.done' && m.topic === topic), 'replay.done');
    }
  }
  // A second, unauthenticated server sharing the real hub and DB, with an injectable listEvents.
  let extra: ReturnType<typeof Fastify>[] = [];
  const connectWith = async (list: typeof listEvents) => {
    const app2 = Fastify();
    await app2.register(websocket);
    new UiGateway(t.prisma, t.app.hub, app2.log, list).register(app2, process.env.WEB_ORIGIN!);
    await app2.listen({ port: 0, host: '127.0.0.1' });
    extra.push(app2);
    const c = new UiClient({}, (app2.server.address() as AddressInfo).port);
    await c.open();
    return c;
  };
  const connect = async () => {
    const c = new UiClient({ Cookie: cookie });
    await c.open();
    return c;
  };

  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    clients = [];
    const projectId = (await req('POST', '/projects', { name: 'P', slug: 'p1', repoPath: '/tmp/office-ws/p1' })).json().id;
    const agentId = (
      await req('POST', '/agents', {
        name: 'A', slug: 'a', role: 'dev', config: { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'] },
      })
    ).json().id;
    taskId = (await req('POST', '/tasks', { projectId, agentId, title: 'T', description: 'd' })).json().id;
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    w = await connectFakeWorker(t.app, { enrollToken, name: 'w', capacity: 1, allowedRoots: ['/tmp/office-ws'] });
    await t.app.scheduler.tick();
    spec = (await w.waitFor('run.assign')).spec;
    w.send({ type: 'run.accepted', runId: spec.runId });
    for (const seq of [1, 2, 3]) workerEvent(seq);
    await flush();
  });
  afterEach(async () => {
    for (const c of clients) c.ws.close();
    for (const a of extra) await a.close();
    extra = [];
    await w.close();
    await t.close();
  });

  it('refuses an unauthenticated connection', async () => {
    const c = new UiClient(undefined);
    const outcome = await new Promise<string>((resolve) => {
      c.ws.once('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
      c.ws.once('close', (code) => resolve(`close ${code}`));
      c.ws.once('error', () => {});
    });
    expect(outcome).toMatch(/^(http 401|close 4401)$/);
  });

  it('refuses a browser Origin other than WEB_ORIGIN, accepts WEB_ORIGIN and a missing Origin', async () => {
    const outcome = (origin?: string) => {
      const c = new UiClient({ Cookie: cookie, ...(origin ? { Origin: origin } : {}) });
      return new Promise<string>((resolve) => {
        c.ws.once('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
        c.ws.once('open', () => resolve('open'));
        c.ws.once('error', () => {});
      });
    };
    expect(await outcome('http://evil.example')).toBe('http 403');
    expect(await outcome(process.env.WEB_ORIGIN)).toBe('open');
    expect(await outcome()).toBe('open');
  });

  it('replays stored events, then replay.done, then live events once', async () => {
    const topic = `run:${spec.runId}`;
    const c = await connect();
    c.send({ type: 'subscribe', topic });
    await c.done(topic);
    expect(c.seqs(topic)).toEqual([1, 2, 3]);
    expect(c.msgs.at(-1)).toEqual({ type: 'replay.done', topic, lastSeq: 3 });

    workerEvent(4);
    await until(() => c.seqs(topic).includes(4), 'live seq 4');
    t.app.hub.publish(topic, event(4)); // duplicate live delivery
    t.app.hub.publish(topic, event(3));
    workerEvent(5);
    await until(() => c.seqs(topic).includes(5), 'live seq 5');
    expect(c.seqs(topic)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reconnect with afterSeq only receives newer events', async () => {
    const topic = `run:${spec.runId}`;
    workerEvent(4);
    await flush();
    const c = await connect();
    c.send({ type: 'subscribe', topic, afterSeq: 2 });
    await c.done(topic);
    expect(c.seqs(topic)).toEqual([3, 4]);
  });

  it('buffers live events during replay and drops those already replayed', async () => {
    const topic = `run:${spec.runId}`;
    let entered!: () => void;
    const inReplay = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    const c = await connectWith(async (...args) => {
      const page = await listEvents(...args);
      entered();
      await block;
      return page;
    });
    c.send({ type: 'subscribe', topic });
    await inReplay;
    t.app.hub.publish(topic, event(3)); // duplicate of a replayed event
    t.app.hub.publish(topic, event(4)); // new
    release();
    await c.done(topic);
    await until(() => c.seqs(topic).includes(4), 'live seq 4');
    expect(c.msgs.map((m) => (m.type === 'event' ? m.event.seq : m.type))).toEqual([1, 2, 3, 'replay.done', 4]);
  });

  it('streams project:<id> events live without replay', async () => {
    const topic = `project:${spec.projectId}`;
    const c = await connect();
    c.send({ type: 'subscribe', topic });
    await until(() => t.app.hub.subscriberCount(topic) === 1, 'project subscription');
    workerEvent(4);
    await until(() => c.seqs(topic).includes(4), 'live seq 4');
    expect(c.seqs(topic)).toEqual([4]);
    expect(c.msgs.some((m) => m.type === 'replay.done')).toBe(false);
    expect(c.msgs[0]).toMatchObject({ type: 'event', topic, event: { runId: spec.runId, projectId: spec.projectId } });
  });

  it('removes the hub subscription when the socket closes while subscribing', async () => {
    const topic = `run:${spec.runId}`;
    const c = await connect();
    c.send({ type: 'subscribe', topic });
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 200));
    expect(t.app.hub.subscriberCount(topic)).toBe(0);
  });

  it('reports a failed replay and leaves no subscription', async () => {
    const topic = `run:${spec.runId}`;
    const c = await connectWith(async () => {
      throw new Error('db down');
    });
    c.send({ type: 'subscribe', topic });
    await until(() => c.msgs.length > 0, 'error message');
    expect(c.msgs).toEqual([{ type: 'error', message: 'replay failed' }]);
    expect(t.app.hub.subscriberCount(topic)).toBe(0);
  });

  it('stops delivering after unsubscribe', async () => {
    const topic = `run:${spec.runId}`;
    const c = await connect();
    c.send({ type: 'subscribe', topic });
    await c.done(topic);
    c.send({ type: 'unsubscribe', topic });
    c.send({ type: 'subscribe', topic: 'run:nope' }); // its error reply proves the unsubscribe was processed
    await until(() => c.msgs.some((m) => m.type === 'error'), 'ordering probe');
    workerEvent(4);
    await flush();
    expect(c.seqs(topic)).toEqual([1, 2, 3]);
  });

  it('errors on unknown run and invalid messages', async () => {
    const c = await connect();
    c.send({ type: 'subscribe', topic: 'run:nope' });
    c.ws.send('{"type":"bogus"}');
    await until(() => c.msgs.length === 2, 'two errors');
    expect(c.msgs).toEqual([
      { type: 'error', message: 'run not found' },
      { type: 'error', message: 'invalid message' },
    ]);
  });

  it('global subscriber sees task.status.changed when the run completes', async () => {
    const c = await connect();
    c.send({ type: 'subscribe', topic: 'global' });
    c.send({ type: 'subscribe', topic: 'run:nope' }); // its error reply proves the subscribe was processed
    await until(() => c.msgs.some((m) => m.type === 'error'), 'ordering probe');
    w.send({
      type: 'run.result', runId: spec.runId, sessionId: spec.sessionId,
      result: {
        status: 'succeeded', resultText: 'ok', sdkSessionId: 's',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1, numTurns: 1, durationMs: 1 },
      },
    });
    const msg = await until(
      () => c.msgs.find((m) => m.type === 'task.status.changed' && m.task.status === 'done'),
      'task done on global',
    );
    expect(msg).toMatchObject({ topic: 'global', task: { id: taskId, status: 'done' } });
  });
});
