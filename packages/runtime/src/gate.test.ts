import { describe, expect, it } from 'vitest';
import { ApprovalPolicySchema, type ApprovalRequest, type EventBody, type RunSpec } from '@office/shared';
import { gateToolCall } from './gate.js';
import type { ToolBridge } from './types.js';

const base = { cwd: '/w', readOnlyCheckout: false } as RunSpec;
const policy = ApprovalPolicySchema.parse({});

function collect() {
  const events: EventBody[] = [];
  return { events, sink: { emit: (b: EventBody) => void events.push(b) } };
}

function bridge(decision: 'allow' | 'deny', message?: string) {
  const requests: ApprovalRequest[] = [];
  const tools: ToolBridge = {
    call: async () => ({ ok: true, result: null }),
    askApproval: async (r) => (requests.push(r), { requestId: r.requestId, decision, message }),
  };
  return { requests, tools };
}

describe('gateToolCall', () => {
  it('allows everything without a policy', async () => {
    const { sink, events } = collect();
    expect(await gateToolCall(base, sink, undefined, 'Bash', { command: 'rm -rf x' })).toEqual({ allow: true });
    expect(events).toEqual([]);
  });

  it('allows a call the policy allows without asking', async () => {
    const { sink, events } = collect();
    const b = bridge('deny');
    expect(await gateToolCall({ ...base, approvalPolicy: policy }, sink, b.tools, 'Bash', { command: 'ls' })).toEqual({ allow: true });
    expect(b.requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it('denies a blocked call with the reason', async () => {
    const { sink } = collect();
    const p = ApprovalPolicySchema.parse({ destructive_command: 'block' });
    const r = await gateToolCall({ ...base, approvalPolicy: p }, sink, bridge('allow').tools, 'Bash', { command: 'rm -rf x' });
    expect(r).toEqual({ allow: false, message: 'command matches "rm -rf": rm -rf x' });
  });

  it('asks the bridge and emits waiting/resolved events', async () => {
    const { sink, events } = collect();
    const b = bridge('allow');
    const r = await gateToolCall({ ...base, approvalPolicy: policy }, sink, b.tools, 'Bash', { command: 'rm -rf x' });
    expect(r).toEqual({ allow: true });
    expect(b.requests).toHaveLength(1);
    const req = b.requests[0]!;
    expect(req).toMatchObject({ toolName: 'Bash', input: { command: 'rm -rf x' }, type: 'destructive_command' });
    expect(events).toEqual([
      { type: 'agent.waiting_approval', payload: { ...req } },
      { type: 'agent.approval.resolved', payload: { requestId: req.requestId, decision: 'allow', message: undefined } },
    ]);
  });

  it('denies with the owner message or the default', async () => {
    const s = { ...base, approvalPolicy: policy };
    expect(await gateToolCall(s, collect().sink, bridge('deny', 'nope').tools, 'Bash', { command: 'rm -rf x' })).toEqual({
      allow: false,
      message: 'nope',
    });
    expect(await gateToolCall(s, collect().sink, bridge('deny').tools, 'Bash', { command: 'rm -rf x' })).toEqual({
      allow: false,
      message: 'Denied by the owner',
    });
  });

  it('denies an ask without an approval channel', async () => {
    const { sink, events } = collect();
    const r = await gateToolCall({ ...base, approvalPolicy: policy }, sink, undefined, 'Write', { file_path: '/w/.env.local' });
    expect(r).toEqual({ allow: false, message: 'No approval channel' });
    expect(events.map((e) => e.type)).toEqual(['agent.waiting_approval', 'agent.approval.resolved']);
  });

  it('denies writes on a read-only run before the policy', async () => {
    const ro = { ...base, readOnlyCheckout: true };
    const b = bridge('allow');
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(await gateToolCall(ro, collect().sink, b.tools, t, { file_path: '/w/a' })).toEqual({
        allow: false,
        message: 'Read-only run: writes are not permitted',
      });
    }
    for (const command of ['rm -rf x', 'echo a > b', 'echo a >> b', 'echo a | tee b']) {
      expect(await gateToolCall(ro, collect().sink, b.tools, 'Bash', { command })).toEqual({
        allow: false,
        message: 'Read-only run: this command may write',
      });
    }
    expect(await gateToolCall(ro, collect().sink, b.tools, 'Bash', { command: 'git log' })).toEqual({ allow: true });
    expect(b.requests).toEqual([]);
  });
});
