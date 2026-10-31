import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeEvent, UiServerMessage } from '@office/shared';
import { nextAfterSeq, UiSocket } from './ws';

const event = (seq: number): UiServerMessage => ({
  type: 'event',
  topic: 'run:r1',
  event: {
    type: 'agent.text',
    seq,
    ts: '2026-10-31T00:00:00.000Z',
    sessionId: 's1',
    runId: 'r1',
    agentId: 'a1',
    projectId: 'p1',
    payload: { text: 'hi' },
  } satisfies OfficeEvent,
});

describe('nextAfterSeq', () => {
  it('returns the max seq seen', () => {
    let s = 0;
    for (const seq of [1, 3, 2]) s = nextAfterSeq(s, event(seq));
    expect(s).toBe(3);
  });

  it('ignores non-event messages', () => {
    expect(nextAfterSeq(5, { type: 'replay.done', topic: 'run:r1', lastSeq: 9 })).toBe(5);
    expect(nextAfterSeq(5, { type: 'run.status.changed', topic: 'run:r1', runId: 'r1', status: 'running' })).toBe(5);
    expect(nextAfterSeq(5, { type: 'error', message: 'x' })).toBe(5);
  });
});

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: UiServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

describe('UiSocket', () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeSocket.all = [];
  });

  it('re-subscribes with the highest seq seen after reconnect', () => {
    vi.useFakeTimers();
    const ui = new UiSocket('ws://x/ws/ui', (url) => new FakeSocket(url) as unknown as WebSocket);
    const got: UiServerMessage[] = [];
    ui.subscribe('run:r1', 0, (m) => got.push(m));

    const first = FakeSocket.all[0]!;
    first.open();
    expect(first.sent).toEqual([{ type: 'subscribe', topic: 'run:r1', afterSeq: 0 }]);
    first.receive(event(1));
    first.receive(event(4));
    expect(got).toHaveLength(2);

    first.close();
    vi.advanceTimersByTime(1000);
    const second = FakeSocket.all[1]!;
    second.open();
    expect(second.sent).toEqual([{ type: 'subscribe', topic: 'run:r1', afterSeq: 4 }]);
  });

  it('stops delivering after unsubscribe', () => {
    const ui = new UiSocket('ws://x/ws/ui', (url) => new FakeSocket(url) as unknown as WebSocket);
    const got: UiServerMessage[] = [];
    const off = ui.subscribe('run:r1', 0, (m) => got.push(m));
    const s = FakeSocket.all[0]!;
    s.open();
    off();
    expect(s.sent.at(-1)).toEqual({ type: 'unsubscribe', topic: 'run:r1' });
    s.receive(event(1));
    expect(got).toHaveLength(0);
  });
});
