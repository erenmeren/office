import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter, type RuntimeAdapter } from '@office/runtime';
import { ApprovalPolicySchema, type RunSpec, type WorkerToApi } from '@office/shared';
import { RunExecutor } from '../src/executor.js';
import { sweepWorktrees } from '../src/git.js';

async function until(fn: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`until(${what}) timed out`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('RunExecutor', () => {
  let root: string;
  let sent: WorkerToApi[];
  let executor: RunExecutor;
  let runsDir: string;
  const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
    runId: 'run-1', sessionId: 'sess-1', agentId: 'agent-1', projectId: 'proj-1',
    cwd: join(root, 'repo'), prompt: 'do it', systemPrompt: 'sys', model: 'sonnet', allowedTools: [],
    maxTurns: 5, maxBudgetUsd: 1, maxConcurrentSubagents: 4, maxSubagentDepth: 1, skills: [], subagents: [], ...over,
  });
  const done = () => sent.some((m) => m.type === 'run.result' || m.type === 'run.rejected');

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'office-exec-')));
    mkdirSync(join(root, 'repo'));
    sent = [];
    runsDir = join(root, 'runs');
    executor = new RunExecutor(new FakeAdapter(), (m) => sent.push(m), [root], runsDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts, streams five sequenced events, then a succeeded result', async () => {
    executor.accept(spec());
    expect(executor.activeRunIds()).toEqual(['run-1']);
    await until(done, 'result');
    expect(sent.map((m) => m.type)).toEqual([
      'run.accepted', 'run.event', 'run.event', 'run.event', 'run.event', 'run.event', 'run.result',
    ]);
    const events = sent.flatMap((m) => (m.type === 'run.event' ? [m.event] : []));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const e of events) {
      expect(e).toMatchObject({ runId: 'run-1', sessionId: 'sess-1', agentId: 'agent-1', projectId: 'proj-1' });
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
    }
    expect(events[0]!.type).toBe('agent.started');
    expect(events[4]!.type).toBe('agent.completed');
    expect(sent.at(-1)).toMatchObject({ type: 'run.result', runId: 'run-1', sessionId: 'sess-1', result: { status: 'succeeded' } });
    expect(executor.activeRunIds()).toEqual([]);
  });

  it('rejects an existing sibling directory that shares the root prefix', async () => {
    // `<root>-other` starts with `<root>` as a string but is not under it by segment
    mkdirSync(root + '-other/repo', { recursive: true });
    try {
      executor.accept(spec({ cwd: root + '-other/repo' }));
    } finally {
      rmSync(root + '-other', { recursive: true, force: true });
    }
    expect(sent).toEqual([{ type: 'run.rejected', runId: 'run-1', reason: 'cwd outside allowed roots' }]);
    expect(executor.activeRunIds()).toEqual([]);
  });

  it('rejects a symlink inside a root that points outside it', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'office-outside-')));
    symlinkSync(outside, join(root, 'escape'));
    try {
      executor.accept(spec({ cwd: join(root, 'escape') }));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(sent).toEqual([{ type: 'run.rejected', runId: 'run-1', reason: 'cwd outside allowed roots' }]);
  });

  it('cancels a running SLOW prompt', async () => {
    executor.accept(spec({ prompt: 'SLOW work' }));
    await until(() => sent.filter((m) => m.type === 'run.event').length === 4, 'four events');
    executor.cancel('run-1');
    await until(done, 'result');
    expect(sent.at(-1)).toMatchObject({ type: 'run.result', result: { status: 'cancelled' } });
  });

  it('redacts secrets in event payloads before sending', async () => {
    executor.accept(spec({ prompt: 'use token=abcdefghijklmnop' }));
    await until(done, 'result');
    const text = sent.find((m) => m.type === 'run.event' && m.event.type === 'agent.text');
    expect(text).toMatchObject({ event: { payload: { text: 'fake: use token=[REDACTED]' } } });
  });

  it('turns an adapter exception into agent.failed and a failed result', async () => {
    const boom = new RunExecutor(
      { name: 'fake', run: async () => { throw new Error('boom'); } },
      (m) => sent.push(m),
      [root],
      runsDir,
    );
    boom.accept(spec());
    await until(done, 'result');
    expect(sent.map((m) => m.type)).toEqual(['run.accepted', 'run.event', 'run.result']);
    expect(sent[1]).toMatchObject({ event: { type: 'agent.failed', seq: 1, payload: { error: 'boom' } } });
    expect(sent[2]).toMatchObject({ result: { status: 'failed', error: 'boom' } });
  });

  const withSkill = {
    name: 'tdd', version: 1, checksum: 'c', mode: 'eager' as const,
    files: { 'SKILL.md': '---\nname: tdd\ndescription: d\n---\nbody' },
  };

  it('removes the run root after success, failure and cancel', async () => {
    for (const prompt of ['ok', 'FAIL it', 'SLOW work']) {
      sent = [];
      executor.accept(spec({ prompt, skills: [withSkill] }));
      if (prompt === 'SLOW work') {
        await until(() => sent.filter((m) => m.type === 'run.event').length >= 4, 'four events');
        expect(existsSync(join(runsDir, 'run-1', '.office'))).toBe(true);
        executor.cancel('run-1');
      }
      await until(() => done() && executor.activeRunIds().length === 0, 'result');
      expect(existsSync(join(runsDir, 'run-1'))).toBe(false);
    }
  });

  it('passes skillsDir to the adapter when the spec has skills', async () => {
    const seen: RunSpec[] = [];
    const inner = new FakeAdapter();
    const rec: RuntimeAdapter = { name: 'fake', run: (s, sink, sig) => (seen.push(s), inner.run(s, sink, sig)) };
    new RunExecutor(rec, (m) => sent.push(m), [root], runsDir).accept(spec({ skills: [withSkill] }));
    await until(done, 'result');
    expect(seen[0]!.skillsDir).toBe(join(runsDir, 'run-1', '.office'));
  });

  it('turns a hostile skill into agent.failed and a failed result without running the adapter', async () => {
    executor.accept(spec({ skills: [{ ...withSkill, name: '../evil' }] }));
    await until(done, 'result');
    expect(sent.at(-1)).toMatchObject({ type: 'run.result', result: { status: 'failed' } });
    expect(sent.some((m) => m.type === 'run.event' && m.event.type === 'agent.failed')).toBe(true);
    expect(existsSync(join(runsDir, 'run-1'))).toBe(false);
  });

  describe('office tool bridge', () => {
    const toolCalls = () => sent.flatMap((m) => (m.type === 'tool.call' ? [m] : []));
    const eventsOf = () => sent.flatMap((m) => (m.type === 'run.event' ? [m.event] : []));

    it('sends a tool.call and resumes the adapter when resolveTool answers', async () => {
      executor.accept(spec({ prompt: 'SEND:qa:hello' }));
      await until(() => toolCalls().length === 1, 'tool.call');
      expect(toolCalls()[0]).toMatchObject({
        type: 'tool.call', runId: 'run-1', sessionId: 'sess-1', name: 'send_message', args: { to: 'qa', body: 'hello' },
      });
      executor.resolveTool(toolCalls()[0]!.callId, { ok: true, result: { messageId: 'm1', conversationId: 'c1' } });
      await until(done, 'result');
      expect(sent.at(-1)).toMatchObject({ type: 'run.result', result: { status: 'succeeded' } });
      expect(eventsOf().find((e) => e.type === 'agent.message.sent')?.payload).toEqual({
        messageId: 'm1', conversationId: 'c1', to: 'qa', type: 'message',
      });
    });

    it('emits agent.message.received and memory.proposed after successful calls, none after a failed one', async () => {
      executor.accept(spec({ prompt: 'MEMO:t1\nINBOX\nMEMO:t2' }));
      // MEMO:t1, MEMO:t2 (failed), then read_inbox
      await until(() => toolCalls().length === 1, 'propose 1');
      executor.resolveTool(toolCalls()[0]!.callId, { ok: true, result: { entryId: 'e1', status: 'proposed' } });
      await until(() => toolCalls().length === 2, 'propose 2');
      executor.resolveTool(toolCalls()[1]!.callId, { ok: false, code: 'bad', error: 'nope' });
      await until(() => toolCalls().length === 3, 'read_inbox');
      expect(toolCalls()[2]!.name).toBe('read_inbox');
      executor.resolveTool(toolCalls()[2]!.callId, { ok: true, result: { messages: [{ id: 'm1', type: 'message', body: 'x' }] } });
      await until(done, 'result');
      const types = eventsOf().map((e) => e.type);
      expect(eventsOf().filter((e) => e.type === 'memory.proposed').map((e) => e.payload)).toEqual([{ entryId: 'e1' }]);
      expect(eventsOf().find((e) => e.type === 'agent.message.received')?.payload).toEqual({ count: 1 });
      expect(types).not.toContain('agent.message.sent');
    });

    it('suspends with the adapter-emitted waiting_reply only, and sends a suspended result', async () => {
      executor.accept(spec({ prompt: 'ASK:architect:Which database?' }));
      await until(() => toolCalls().length === 1, 'tool.call');
      expect(toolCalls()[0]!.args).toMatchObject({ type: 'question', awaitReply: true });
      executor.resolveTool(toolCalls()[0]!.callId, { ok: true, result: { messageId: 'm1', conversationId: 'c1' }, suspend: true });
      await until(done, 'result');
      expect(sent.at(-1)).toMatchObject({ type: 'run.result', result: { status: 'suspended', sdkSessionId: 'fake-sess-1' } });
      const types = eventsOf().map((e) => e.type);
      expect(types.filter((t) => t === 'agent.waiting_reply')).toHaveLength(1);
      expect(eventsOf().find((e) => e.type === 'agent.message.sent')?.payload).toMatchObject({ type: 'question', to: 'architect' });
    });

    it('times out an unanswered call', async () => {
      const quick = new RunExecutor(new FakeAdapter(), (m) => sent.push(m), [root], runsDir, 50);
      quick.accept(spec({ prompt: 'SEND:qa:hello' }));
      await until(done, 'result');
      expect(sent.at(-1)).toMatchObject({ result: { status: 'succeeded' } });
      expect(eventsOf().find((e) => e.type === 'agent.tool.failed')?.payload).toMatchObject({ output: 'timeout' });
      // a late answer is ignored
      quick.resolveTool(toolCalls()[0]!.callId, { ok: true, result: {} });
    });

    it('failPendingTools answers every pending call with disconnected', async () => {
      executor.accept(spec({ prompt: 'SEND:qa:hello' }));
      await until(() => toolCalls().length === 1, 'tool.call');
      executor.failPendingTools();
      await until(done, 'result');
      expect(eventsOf().find((e) => e.type === 'agent.tool.failed')?.payload).toMatchObject({ output: 'disconnected' });
      expect(eventsOf().some((e) => e.type === 'agent.message.sent')).toBe(false);
    });

    it('numbers events from spec.startSeq', async () => {
      executor.accept(spec({ startSeq: 7, resumeSdkSessionId: 'fake-sess-1', prompt: 'Reply from qa:\nyes' }));
      await until(done, 'result');
      expect(eventsOf().map((e) => e.seq)).toEqual([8, 9, 10, 11, 12]);
    });

    it('does not materialize skills for a summary run', async () => {
      const seen: RunSpec[] = [];
      const inner = new FakeAdapter();
      const rec: RuntimeAdapter = { name: 'fake', run: (s, sink, sig, t) => (seen.push(s), inner.run(s, sink, sig, t)) };
      const ex = new RunExecutor(rec, (m) => sent.push(m), [root], runsDir);
      ex.accept(spec({ kind: 'summary', prompt: 'Summarize run 1', skills: [withSkill] }));
      await until(() => toolCalls().length === 1, 'submit_summary');
      expect(existsSync(join(runsDir, 'run-1'))).toBe(false);
      ex.resolveTool(toolCalls()[0]!.callId, { ok: true, result: { entryId: 'e1', proposalIds: [] } });
      await until(done, 'result');
      expect(seen[0]!.skillsDir).toBeUndefined();
    });
  });

  describe('approvals and cancel', () => {
    const policy = ApprovalPolicySchema.parse({});
    const approvals = () => sent.flatMap((m) => (m.type === 'approval.request' ? [m] : []));
    const eventsOf = () => sent.flatMap((m) => (m.type === 'run.event' ? [m.event] : []));

    it('relays DANGER through approval.request and resumes on resolveApproval; repeats and unknown ids are ignored', async () => {
      executor.accept(spec({ prompt: 'DANGER:rm -rf x', approvalPolicy: policy }));
      await until(() => approvals().length === 1, 'approval.request');
      const req = approvals()[0]!;
      expect(req).toMatchObject({ runId: 'run-1', sessionId: 'sess-1', request: { toolName: 'Bash', input: { command: 'rm -rf x' } } });
      executor.resolveApproval('run-1', { requestId: 'unknown', decision: 'deny' });
      executor.resolveApproval('run-1', { requestId: req.request.requestId, decision: 'allow' });
      executor.resolveApproval('run-1', { requestId: req.request.requestId, decision: 'deny' });
      await until(done, 'result');
      expect(sent.at(-1)).toMatchObject({ result: { status: 'succeeded' } });
      expect(eventsOf().find((e) => e.type === 'agent.approval.resolved')?.payload).toMatchObject({ decision: 'allow' });
      expect(eventsOf().some((e) => e.type === 'agent.command.executed')).toBe(true);
    });

    it('cancel denies a pending approval', async () => {
      executor.accept(spec({ prompt: 'DANGER:rm -rf x', approvalPolicy: policy }));
      await until(() => approvals().length === 1, 'approval.request');
      executor.cancel('run-1');
      await until(done, 'result');
      expect(eventsOf().find((e) => e.type === 'agent.approval.resolved')?.payload).toMatchObject({ decision: 'deny', message: 'run cancelled' });
      expect(sent.at(-1)).toMatchObject({ result: { status: 'cancelled' } });
    });

    it('cancel settles a pending tool call with cancelled', async () => {
      executor.accept(spec({ prompt: 'SEND:qa:hello' }));
      await until(() => sent.some((m) => m.type === 'tool.call'), 'tool.call');
      executor.cancel('run-1');
      await until(done, 'result');
      expect(eventsOf().find((e) => e.type === 'agent.tool.failed')?.payload).toMatchObject({ output: 'cancelled' });
      expect(sent.at(-1)).toMatchObject({ result: { status: 'cancelled' } });
    });
  });

  describe('git worktrees', () => {
    const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
    const git = (cwd: string, ...args: string[]) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8' }).trim();
    const TEST = "COMMIT:sum.test.js:import test from 'node:test'; import assert from 'node:assert'; test('sum', () => assert.equal(1 + 1, 2));";
    let repo: string;
    const gitSpec = (over: Partial<RunSpec> = {}) =>
      spec({
        cwd: repo,
        prompt: TEST,
        taskKind: 'code',
        checkCommand: 'node --test',
        checkTimeoutSeconds: 60,
        env: { file: '.env.local', vars: [{ name: 'API_URL', value: 'http://dummy' }] },
        git: {
          repoPath: repo, defaultBranch: 'main', missionBranch: 'office/t', taskSlug: 'a',
          committerName: 'Office', committerEmail: 'o@example.invalid', agentName: 'developer',
        },
        ...over,
      } as Partial<RunSpec>);
    const result = () => (sent.at(-1) as Extract<WorkerToApi, { type: 'run.result' }>).result;

    beforeEach(() => {
      repo = join(root, 'repo');
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      writeFileSync(join(repo, 'README.md'), 'hi\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'init');
    });

    it('commits in a worktree, passes the check, fast-forwards the mission branch and removes the worktree', async () => {
      const seen: RunSpec[] = [];
      const inner = new FakeAdapter();
      const rec: RuntimeAdapter = { name: 'fake', run: (s, sink, sig, t) => (seen.push(s), inner.run(s, sink, sig, t)) };
      new RunExecutor(rec, (m) => sent.push(m), [root], runsDir).accept(gitSpec());
      await until(done, 'result');
      const r = result();
      expect(r.status).toBe('succeeded');
      expect(seen[0]!.cwd).toBe(join(root, 'worktrees', 'run-1'));
      expect(r.git).toMatchObject({ integration: 'fast_forwarded', filesChanged: 1 });
      expect(r.git!.commits).toHaveLength(1);
      expect(r.git!.branch).toMatch(/^office\/t-runs\/a-run-1/);
      expect(r.check).toMatchObject({ command: 'node --test', status: 'passed', exitCode: 0 });
      expect(git(repo, 'rev-parse', 'office/t')).toBe(r.git!.headCommit);
      expect(git(repo, 'log', '-1', '--format=%B', 'office/t')).toContain('Office-Agent: developer run-1');
      // the env template never reaches a commit
      expect(git(repo, 'show', '--name-only', '--format=', 'office/t')).toBe('sum.test.js');
      expect(existsSync(join(root, 'worktrees', 'run-1'))).toBe(false);
    });

    it('a failed check leaves the mission branch alone and keeps the worktree until it is swept', async () => {
      executor.accept(gitSpec({ checkCommand: 'exit 1' }));
      await until(done, 'result');
      const r = result();
      expect(r.check).toMatchObject({ status: 'failed', exitCode: 1 });
      expect(r.git).toMatchObject({ integration: 'none' });
      expect(r.git!.commits).toHaveLength(1);
      expect(git(repo, 'rev-parse', 'office/t')).toBe(r.git!.baseCommit);
      const wt = join(root, 'worktrees', 'run-1');
      expect(r.git!.worktreePath).toBe(wt);
      expect(existsSync(wt)).toBe(true);
      expect(statSync(join(wt, '.env.local')).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('API_URL=http://dummy\n');
      const old = new Date(Date.now() - 8 * 86_400_000);
      utimesSync(wt, old, old);
      await sweepWorktrees(repo, join(root, 'worktrees'), []);
      expect(existsSync(wt)).toBe(false);
    });

    it('keeps the worktree of a suspended run and reuses it when the run resumes', async () => {
      executor.accept(gitSpec({ prompt: 'COMMIT:a.txt:x\nASK:qa:ok?', checkCommand: 'true' }));
      await until(() => sent.some((m) => m.type === 'tool.call'), 'tool.call');
      const call = sent.find((m) => m.type === 'tool.call') as Extract<WorkerToApi, { type: 'tool.call' }>;
      executor.resolveTool(call.callId, { ok: true, result: { messageId: 'm1' }, suspend: true });
      await until(done, 'suspended');
      expect(result().status).toBe('suspended');
      const wt = join(root, 'worktrees', 'run-1');
      expect(existsSync(wt)).toBe(true);
      sent.length = 0;
      await until(() => executor.activeRunIds().length === 0, 'idle');
      executor.accept(gitSpec({ prompt: 'Reply from qa:\nyes', resumeSdkSessionId: 'fake-sess-1', checkCommand: 'true' }));
      await until(done, 'resumed result');
      const r = result();
      expect(r).toMatchObject({ status: 'succeeded', git: { integration: 'fast_forwarded' }, check: { status: 'passed' } });
      expect(r.git!.commits.map((c) => c.subject)).toEqual(['fake: a.txt']);
      expect(existsSync(wt)).toBe(false);
    });

    it('fails the run when the setup command fails', async () => {
      executor.accept(gitSpec({ setupCommand: 'echo broken; exit 2' }));
      await until(done, 'result');
      expect(result()).toMatchObject({ status: 'failed', error: expect.stringMatching(/^setup failed: /) });
      expect(result().check).toBeUndefined();
    });
  });
});
