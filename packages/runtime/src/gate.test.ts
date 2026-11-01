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

  it('read-only runs allow only the read-only git list', async () => {
    const ro = { ...base, readOnlyCheckout: true };
    const b = bridge('allow');
    for (const command of [
      'git status', 'git --no-pager log --oneline -5', 'git -C /w diff HEAD~1', 'git show HEAD', 'git blame a.ts',
      'git grep foo', 'git ls-files', 'git rev-parse HEAD', 'git branch --list', 'git worktree list', 'git remote -v',
      'git describe --tags', 'git cat-file -p HEAD', 'cd /w && git log | head -3',
    ]) {
      expect(await gateToolCall(ro, collect().sink, b.tools, 'Bash', { command })).toEqual({ allow: true });
    }
    for (const [command, sub] of [
      ['git worktree add /tmp/x HEAD', 'worktree add /tmp/x HEAD'],
      ['git cherry-pick abc', 'cherry-pick abc'],
      ['git -C /w checkout -b x', 'checkout -b x'],
      ['git status && git stash', 'stash'],
      ['git branch new', 'branch new'],
      ['git remote add o url', 'remote add o url'],
      ['cd /w; git commit -m x', 'commit -m x'],
    ] as const) {
      expect(await gateToolCall(ro, collect().sink, b.tools, 'Bash', { command })).toEqual({
        allow: false,
        message: `Read-only run: git ${sub} is not on the read-only git list`,
      });
    }
    expect(b.requests).toEqual([]);
  });

  it('commit-equivalent git calls ask like git commit wherever git commit needs approval', async () => {
    const withCommit = { ...base, approvalPolicy: ApprovalPolicySchema.parse({ destructivePatterns: ['rm -rf', 'git commit'] }) };
    for (const command of [
      'git worktree add /tmp/x', 'git cherry-pick abc', 'git rebase main', 'git merge x', 'git am p.patch',
      'git apply p.diff', 'git stash', 'git -C /w cherry-pick abc',
    ]) {
      const b = bridge('deny');
      expect(await gateToolCall(withCommit, collect().sink, b.tools, 'Bash', { command })).toEqual({ allow: false, message: 'Denied by the owner' });
      expect(b.requests[0]).toMatchObject({ type: 'destructive_command', reason: expect.stringContaining('commit-equivalent') });
    }
    for (const command of ['git merge-base a b', 'git stash-like', 'git log']) {
      expect(await gateToolCall(withCommit, collect().sink, bridge('deny').tools, 'Bash', { command })).toEqual({ allow: true });
    }
    // without a git commit pattern they pass, as git commit does
    expect(await gateToolCall({ ...base, approvalPolicy: policy }, collect().sink, bridge('deny').tools, 'Bash', { command: 'git cherry-pick abc' })).toEqual({ allow: true });
  });

  it('gates a chat run and a read-only plan run with the project policy', async () => {
    const chat = { ...base, kind: 'chat', approvalPolicy: policy } as RunSpec;
    const b = bridge('deny', 'no');
    expect(await gateToolCall(chat, collect().sink, b.tools, 'Bash', { command: 'rm -rf /tmp/probe' })).toEqual({ allow: false, message: 'no' });
    expect(b.requests[0]).toMatchObject({ type: 'destructive_command' });
    // plan/review: read-only gate first, then the sensitive-path check on reads
    const plan = { ...base, kind: 'plan', readOnlyCheckout: true, approvalPolicy: policy } as RunSpec;
    const p = bridge('deny');
    expect(await gateToolCall(plan, collect().sink, p.tools, 'Read', { file_path: '/w/.env.local' })).toEqual({ allow: false, message: 'Denied by the owner' });
    expect(p.requests[0]).toMatchObject({ type: 'sensitive_path' });
    expect(await gateToolCall(plan, collect().sink, p.tools, 'Read', { file_path: '/w/src/a.ts' })).toEqual({ allow: true });
  });
});
