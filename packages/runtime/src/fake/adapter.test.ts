import { describe, expect, it } from 'vitest';
import type { EventBody, RunSpec, ToolCallResult } from '@office/shared';
import type { ToolBridge } from '../types.js';
import { FakeAdapter } from './adapter.js';

const spec: RunSpec = {
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
  const res = await new FakeAdapter().run({ ...spec, ...s }, { emit: (e) => void events.push(e) }, new AbortController().signal, b);
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
