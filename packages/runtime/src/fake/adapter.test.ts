import { describe, expect, it } from 'vitest';
import type { EventBody, RunSpec } from '@office/shared';
import { FakeAdapter } from './adapter.js';

function spec(prompt: string): RunSpec {
  return {
    runId: 'r1',
    sessionId: 's1',
    agentId: 'a1',
    projectId: 'p1',
    cwd: '/tmp',
    prompt,
    systemPrompt: '',
    model: 'fake-model',
    allowedTools: [],
    maxTurns: 1,
    maxBudgetUsd: 0,
    maxConcurrentSubagents: 4,
    maxSubagentDepth: 1,
  };
}

function collect() {
  const events: EventBody[] = [];
  return { events, sink: { emit: (b: EventBody) => void events.push(b) } };
}

describe('FakeAdapter', () => {
  it('emits five events in order and succeeds', async () => {
    const { events, sink } = collect();
    const res = await new FakeAdapter().run(spec('hello'), sink, new AbortController().signal);
    expect(events.map((e) => e.type)).toEqual([
      'agent.started',
      'agent.text',
      'agent.tool.started',
      'agent.tool.completed',
      'agent.completed',
    ]);
    expect(res.status).toBe('succeeded');
    expect(res.resultText).toContain('hello');
    expect(res.sdkSessionId).toBe('fake-s1');
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 1, durationMs: 0 });
  });

  it('fails on FAIL prompt', async () => {
    const { events, sink } = collect();
    const res = await new FakeAdapter().run(spec('please FAIL'), sink, new AbortController().signal);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('fake failure');
    expect(events.at(-1)).toEqual({ type: 'agent.failed', payload: { error: 'fake failure' } });
  });

  it('returns cancelled when aborted during SLOW prompt', async () => {
    const { events, sink } = collect();
    const ac = new AbortController();
    const p = new FakeAdapter().run(spec('SLOW'), sink, ac.signal);
    setTimeout(() => ac.abort(), 50);
    const res = await p;
    expect(res.status).toBe('cancelled');
    expect(events.at(-1)?.type).toBe('agent.cancelled');
  });
});
