import { describe, expect, it } from 'vitest';
import { OfficeEventSchema } from './events.js';
import { WorkerToApiSchema } from './protocol.js';

const event = {
  type: 'agent.started',
  seq: 1,
  ts: '2026-10-31T12:00:00.000Z',
  sessionId: 's1',
  runId: 'r1',
  agentId: 'a1',
  projectId: 'p1',
  payload: { hello: 'world' },
};

describe('OfficeEventSchema', () => {
  it('accepts a full valid event', () => {
    expect(OfficeEventSchema.parse(event)).toEqual(event);
  });
  it('rejects seq 0', () => {
    expect(OfficeEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false);
  });
  it('rejects unknown type', () => {
    expect(OfficeEventSchema.safeParse({ ...event, type: 'agent.nope' }).success).toBe(false);
  });
});

describe('WorkerToApiSchema', () => {
  it('parses a run.event message', () => {
    const msg = { type: 'run.event', event };
    expect(WorkerToApiSchema.parse(msg)).toEqual(msg);
  });
  it('rejects unknown type', () => {
    expect(WorkerToApiSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });
});
