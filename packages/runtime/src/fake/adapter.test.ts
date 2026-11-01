import { describe, expect, it } from 'vitest';
import type { EventBody, RunSpec, ToolCallResult } from '@office/shared';
import type { ToolBridge } from '../types.js';
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
    skills: [],
    subagents: [],
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

  it('invokes only eager skills', async () => {
    const { events, sink } = collect();
    const s = spec('hello');
    s.skills = [
      { name: 'tdd', version: 1, checksum: 'c', mode: 'eager', files: {} },
      { name: 'docs', version: 1, checksum: 'c', mode: 'on_demand', files: {} },
    ];
    await new FakeAdapter().run(s, sink, new AbortController().signal);
    const invoked = events.filter((e) => e.type === 'agent.skill.invoked');
    expect(invoked).toEqual([{ type: 'agent.skill.invoked', payload: { toolUseId: 'fake-skill-tdd', skill: 'tdd' } }]);
    expect(events.slice(0, 4).map((e) => e.type)).toEqual([
      'agent.started',
      'agent.tool.started',
      'agent.skill.invoked',
      'agent.tool.completed',
    ]);
  });

  it('spawns and completes a subagent on SUBAGENT prompt', async () => {
    const { events, sink } = collect();
    const s = spec('run SUBAGENT');
    s.subagents = [{ name: 'reviewer', description: 'd', prompt: 'p', skills: [] }];
    await new FakeAdapter().run(s, sink, new AbortController().signal);
    const spawned = events.find((e) => e.type === 'agent.subagent.spawned');
    const completed = events.find((e) => e.type === 'agent.subagent.completed');
    expect(spawned?.payload).toEqual({ toolUseId: 'fake-sub-1', subagentType: 'reviewer', description: 'fake subagent' });
    expect(completed?.payload).toEqual({ toolUseId: 'fake-sub-1', status: 'completed', summary: 'done' });
    expect(events.indexOf(spawned!)).toBeLessThan(events.indexOf(completed!));
  });
});

const toolSpec: RunSpec = {
  runId: 'r1', sessionId: 's1', agentId: 'a1', projectId: 'p1', cwd: '/tmp', prompt: 'hi', systemPrompt: '',
  model: 'haiku', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, maxConcurrentSubagents: 1, maxSubagentDepth: 1,
  skills: [], subagents: [], kind: 'task', startSeq: 0, tools: [],
} as RunSpec;

function bridge(respond: (name: string) => ToolCallResult = () => ({ ok: true, result: {} })) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const b: ToolBridge = { call: async (name, args) => (calls.push({ name, args }), respond(name)) };
  return { b, calls };
}
async function run(s: Partial<RunSpec>, b?: ToolBridge) {
  const events: EventBody[] = [];
  const res = await new FakeAdapter().run({ ...toolSpec, ...s }, { emit: (e) => void events.push(e) }, new AbortController().signal, b);
  return { res, events };
}

describe('FakeAdapter tool markers', () => {
  it('ASK suspends right after one send_message with awaitReply', async () => {
    const { b, calls } = bridge(() => ({ ok: true, result: { messageId: 'm1' }, suspend: true }));
    const { res, events } = await run({ prompt: 'ASK:qa:ready?' }, b);
    expect(res.status).toBe('suspended');
    expect(res.sdkSessionId).toBe('fake-s1');
    expect(calls).toEqual([{ name: 'send_message', args: { to: 'qa', body: 'ready?', type: 'question', awaitReply: true } }]);
    expect(events.find((e) => e.type === 'agent.waiting_reply')?.payload).toEqual({ messageId: 'm1', to: 'qa' });
  });

  it('INBOX replies to each question', async () => {
    const { b, calls } = bridge((n) =>
      n === 'read_inbox'
        ? { ok: true, result: { messages: [{ id: 'm1', type: 'question', body: 'why?' }, { id: 'm2', type: 'message', body: 'fyi' }] } }
        : { ok: true, result: {} },
    );
    const { res } = await run({ kind: 'inbox', prompt: 'You have new messages.' }, b);
    expect(res.status).toBe('succeeded');
    expect(calls.filter((c) => c.name === 'reply_message')).toEqual([
      { name: 'reply_message', args: { messageId: 'm1', body: 'fake reply: why?' } },
    ]);
  });

  it('summary kind submits one summary', async () => {
    const { b, calls } = bridge();
    await run({ kind: 'summary', prompt: 'Summarize run 1\nmore' }, b);
    expect(calls.map((c) => c.name)).toEqual(['submit_summary']);
    expect(calls[0]!.args.summary).toBe('fake summary of Summarize run 1');
  });

  it('SEND and MEMO call tools; tool errors do not stop the run', async () => {
    const { b, calls } = bridge(() => ({ ok: false, error: 'nope', code: 'bad' }));
    const { res, events } = await run({ prompt: 'SEND:qa:yo\nMEMO:t1' }, b);
    expect(res.status).toBe('succeeded');
    expect(calls.map((c) => c.name)).toEqual(['send_message', 'propose_memory']);
    expect(events.filter((e) => e.type === 'agent.tool.failed')).toHaveLength(2);
  });

  it('a resumed run makes no tool calls and completes', async () => {
    const { b, calls } = bridge();
    const { res, events } = await run({ resumeSdkSessionId: 'x', prompt: 'Reply from qa:\nyes' }, b);
    expect(res.status).toBe('succeeded');
    expect(calls).toEqual([]);
    expect(events.some((e) => e.type === 'agent.text')).toBe(true);
  });

  it('ignores markers without a bridge', async () => {
    const { res } = await run({ prompt: 'ASK:qa:x' });
    expect(res.status).toBe('succeeded');
  });
});
