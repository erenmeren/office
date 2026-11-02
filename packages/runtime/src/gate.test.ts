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
    for (const command of [
      'rm -rf x', 'echo a > b', 'echo a >> b', 'echo a | tee b', 'echo a >b', 'rm  -rf x', 'cp a b', 'cd /w && mkdir x',
      'sed -i s/a/b/ f', 'eval "$cmd"', 'source ./x.sh', '. ./x.sh', 'pnpm add left-pad', 'npm i', 'curl -o f http://x',
      'git diff --output=x', 'sh -c "printf x >f"', 'sudo touch f', 'ls | xargs rm',
    ]) {
      expect(await gateToolCall(ro, collect().sink, b.tools, 'Bash', { command })).toEqual({
        allow: false,
        message: 'Read-only run: this command may write',
      });
    }
    for (const command of ['git log', 'ls -la', 'cat a.ts 2>&1', 'echo x >&2', 'grep -r "a->b" src', 'node -e "1>=0"', 'pnpm test', 'cat a | sort', 'curl http://x', 'sed -n 1,5p f', 'pnpm install-check']) {
      expect(await gateToolCall(ro, collect().sink, b.tools, 'Bash', { command })).toEqual({ allow: true });
    }
    expect(b.requests).toEqual([]);
  });

  it('a worktree run keeps the file tools inside the worktree and the skills dir', async () => {
    const wt = { ...base, cwd: '/w/run', skillsDir: '/home/x/runs/r/.office', git: { repoPath: '/repo' } } as RunSpec;
    const b = bridge('allow');
    for (const [tool, input] of [
      ['Read', { file_path: '/repo/.env.local' }],
      ['Read', { file_path: '../other/a.ts' }],
      ['Write', { file_path: '/tmp/x', content: '' }],
      ['Grep', { pattern: 'x', path: '/etc' }],
      ['Glob', { pattern: '**', path: '/w/runner' }],
    ] as const) {
      const r = await gateToolCall(wt, collect().sink, b.tools, tool, input as Record<string, unknown>);
      expect(r.allow).toBe(false);
      expect(!r.allow && r.message).toMatch(/outside the worktree/);
    }
    for (const [tool, input] of [
      ['Read', { file_path: '/w/run/src/a.ts' }],
      ['Read', { file_path: 'src/a.ts' }],
      ['Edit', { file_path: './b.ts' }],
      ['Grep', { pattern: 'x' }],
      ['Read', { file_path: '/home/x/runs/r/.office/skills/s/SKILL.md' }],
      ['Bash', { command: 'cat /etc/hostname' }],
    ] as const) {
      expect(await gateToolCall(wt, collect().sink, b.tools, tool, input as Record<string, unknown>)).toEqual({ allow: true });
    }
    // no worktree: no confinement
    expect(await gateToolCall(base, collect().sink, b.tools, 'Read', { file_path: '/etc/hostname' })).toEqual({ allow: true });
  });

  it('read-only runs allow only the read-only git list', async () => {
    const ro = { ...base, readOnlyCheckout: true };
    const b = bridge('allow');
    for (const command of [
      'git status', 'git --no-pager log --oneline -5', 'git -C /w diff HEAD~1', 'git show HEAD', 'git blame a.ts',
      'git grep foo', 'git ls-files', 'git rev-parse HEAD', 'git branch --list', 'git worktree list', 'git remote -v',
      'git describe --tags', 'git cat-file -p HEAD', 'cd /w && git log | head -3',
      'sh -c "git status"', "git log --format='%h %s'", '/usr/bin/git show HEAD',
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
      ['sh -c "git worktree add /tmp/x HEAD"', 'worktree add /tmp/x HEAD'],
      ["bash -c 'git checkout -b x'", 'checkout -b x'],
      ['/usr/bin/git cherry-pick abc', 'cherry-pick abc'],
      ['\\git checkout x', 'checkout x'],
      ['git -c core.pager=cat log', '-c core.pager=cat log'],
      ['git -C /w -c alias.l=!sh log', '-C /w -c alias.l=!sh log'],
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
      'git apply p.diff', 'git stash', 'git -C /w cherry-pick abc', 'git --no-pager cherry-pick x',
      'git --git-dir=/w/.git rebase main', 'git -c user.name=x merge y',
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
