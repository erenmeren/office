import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { machineId } from '@office/runtime';
import type { ApiToWorker, WorkerToApi } from '@office/shared';

export interface FakeWorkerOptions {
  enrollToken?: string;
  credential?: string;
  name?: string;
  capacity?: number;
  allowedRoots?: string[];
  activeRunIds?: string[];
  tags?: string[];
  canClone?: boolean;
  /** Runtimes announced in hello (omitted: the gateway's default, Claude only). */
  runtimes?: ('claude' | 'codex')[];
  /** Models the worker's Claude login offers (omitted: none announced). */
  models?: { value: string; label: string; description?: string }[];
  /** Defaults to the API's own machine id (same host); `null` omits it like a pre-Phase 5 worker. */
  machineId?: string | null;
}

/** Connects to the listening app, sends `hello`, resolves after the first reply (welcome or error). */
export async function connectFakeWorker(app: FastifyInstance, opts: FakeWorkerOptions) {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`);
  const received: ApiToWorker[] = [];
  const taken = new Set<ApiToWorker>();
  const listeners = new Set<() => void>();
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

  ws.on('message', (data) => {
    received.push(JSON.parse(String(data)) as ApiToWorker);
    for (const l of [...listeners]) l();
  });

  // Resolves with the next message of `type` not already returned by an earlier waitFor.
  const waitFor = <T extends ApiToWorker['type']>(type: T) =>
    new Promise<Extract<ApiToWorker, { type: T }>>((resolve, reject) => {
      const check = () => {
        const m = received.find((x) => x.type === type && !taken.has(x));
        if (!m) return;
        taken.add(m);
        listeners.delete(check);
        clearTimeout(timer);
        resolve(m as Extract<ApiToWorker, { type: T }>);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(`waitFor('${type}') timed out after 5s; received: [${received.map((x) => x.type).join(', ')}]`),
        );
      }, 5000);
      listeners.add(check);
      check();
    });

  const send = (msg: WorkerToApi | Record<string, unknown>) => ws.send(JSON.stringify(msg));
  const close = async () => {
    if (ws.readyState !== WebSocket.CLOSED) ws.close();
    await closed;
  };

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  send({
    type: 'hello',
    enrollToken: opts.enrollToken,
    credential: opts.credential,
    name: opts.name ?? 'fake',
    capacity: opts.capacity ?? 1,
    allowedRoots: opts.allowedRoots ?? [],
    activeRunIds: opts.activeRunIds ?? [],
    tags: opts.tags ?? [],
    canClone: opts.canClone ?? false,
    ...(opts.runtimes && { runtimes: opts.runtimes }),
    ...(opts.models && { models: opts.models }),
    machineId: opts.machineId === null ? undefined : (opts.machineId ?? machineId(process.env.OFFICE_DATA_DIR!)),
  });
  const first = await new Promise<ApiToWorker>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply to hello after 5s')), 5000);
    const check = () => {
      if (!received[0]) return;
      listeners.delete(check);
      clearTimeout(timer);
      resolve(received[0]);
    };
    listeners.add(check);
    check();
  });
  const welcome = first.type === 'welcome' ? first : undefined;
  return {
    workerId: welcome?.workerId,
    credential: welcome?.credential ?? opts.credential,
    received,
    send,
    waitFor,
    close,
    closed,
  };
}

export type FakeWorker = Awaited<ReturnType<typeof connectFakeWorker>>;

/** Polls `fn` until it returns truthy, rejecting after 5 s. */
export async function until<T>(fn: () => Promise<T> | T, what = 'condition'): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`until(${what}) timed out after 5s`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
