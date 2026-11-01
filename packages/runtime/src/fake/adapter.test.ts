import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalPolicySchema, PlanSchema, type EventBody, type RunSpec, type ToolCallResult } from '@office/shared';
import type { ToolBridge } from '../types.js';
import { FakeAdapter } from './adapter.js';
import { FAKE_PLAN } from './plan.js';

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

describe('FakeAdapter orchestration markers', () => {
  const policy = ApprovalPolicySchema.parse({});
  function approving(decision: 'allow' | 'deny') {
    const { b, calls } = bridge();
    b.askApproval = async (r) => ({ requestId: r.requestId, decision });
    return { b, calls };
  }

  it('PLAN returns FAKE_PLAN as structured output', async () => {
    const { res } = await run({ prompt: 'PLAN' }, bridge().b);
    expect(res.status).toBe('succeeded');
    expect(res.structuredOutput).toEqual(FAKE_PLAN);
    expect(PlanSchema.parse(FAKE_PLAN).tasks).toHaveLength(2);
    expect(FAKE_PLAN.tasks.map((t) => [t.key, t.agent, t.kind])).toEqual([
      ['a', 'developer', 'code'],
      ['b', 'qa-engineer', 'review'],
    ]);
  });

  it('plan kind uses OFFICE_FAKE_PLAN when set', async () => {
    process.env.OFFICE_FAKE_PLAN = JSON.stringify({ summary: 'env plan', tasks: [], risks: [] });
    try {
      const { res } = await run({ prompt: 'x', kind: 'plan' }, bridge().b);
      expect(res.structuredOutput).toEqual({ summary: 'env plan', tasks: [], risks: [] });
    } finally {
      delete process.env.OFFICE_FAKE_PLAN;
    }
  });

  it('REVIEW reviews each listed task as done; tool errors do not stop it', async () => {
    const { b, calls } = bridge(() => ({ ok: false, error: 'x', code: 'bad' }));
    const { res, events } = await run({ prompt: 'REVIEW:t1,t2' }, b);
    expect(calls).toEqual([
      { name: 'review_task', args: { taskId: 't1', decision: 'done', note: 'fake review' } },
      { name: 'review_task', args: { taskId: 't2', decision: 'done', note: 'fake review' } },
    ]);
    expect(events.filter((e) => e.type === 'agent.tool.failed')).toHaveLength(2);
    expect(res.structuredOutput).toEqual({ summary: 'fake review', tasks: [] });
  });

  it('DANGER denied by the owner fails the tool call', async () => {
    const { b } = approving('deny');
    const { res, events } = await run({ prompt: 'DANGER:rm -rf x', approvalPolicy: policy }, b);
    const types = events.map((e) => e.type);
    expect(types).toContain('agent.waiting_approval');
    expect(types).toContain('agent.approval.resolved');
    const failed = events.find((e) => e.type === 'agent.tool.failed');
    expect(failed?.payload.output).toBe('denied: Denied by the owner');
    expect(types).not.toContain('agent.command.executed');
    expect(res.status).toBe('succeeded');
  });

  it('DANGER allowed by the owner completes without running the command', async () => {
    const { b } = approving('allow');
    const { events } = await run({ prompt: 'DANGER:rm -rf x', approvalPolicy: policy }, b);
    const started = events.find((e) => e.type === 'agent.tool.started' && e.payload.tool === 'Bash');
    expect(started?.payload.input).toEqual({ command: 'rm -rf x' });
    const id = started!.payload.toolUseId;
    expect(events).toContainEqual({ type: 'agent.command.executed', payload: { command: 'rm -rf x' } });
    expect(events).toContainEqual({ type: 'agent.tool.completed', payload: { toolUseId: id, output: '' } });
  });

  it('SECRETWRITE goes through the gate as a sensitive path', async () => {
    const asked: string[] = [];
    const { b } = bridge();
    b.askApproval = async (r) => (asked.push(r.type), { requestId: r.requestId, decision: 'deny' });
    const { events } = await run({ prompt: 'SECRETWRITE', approvalPolicy: policy }, b);
    expect(asked).toEqual(['sensitive_path']);
    expect(events.some((e) => e.type === 'agent.tool.failed')).toBe(true);
  });

  it('COMMIT writes the file and commits it in a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-commit-'));
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      const { events, res } = await run({ prompt: 'COMMIT:src/a.txt:one\\ntwo', cwd: dir }, bridge().b);
      expect(res.status).toBe('succeeded');
      expect(readFileSync(join(dir, 'src/a.txt'), 'utf8')).toBe('one\ntwo');
      expect(execFileSync('git', ['log', '--format=%s %an'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('fake: src/a.txt t');
      expect(events).toContainEqual({ type: 'agent.file.changed', payload: { path: 'src/a.txt' } });
      expect(events).toContainEqual({ type: 'agent.command.executed', payload: { command: 'git commit' } });
    } finally {
      process.env = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('COMMIT outside a git repo or with .. fails the tool call and continues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-nogit-'));
    try {
      const { events, res } = await run({ prompt: 'COMMIT:a.txt:x\nCOMMIT:../b.txt:x', cwd: dir }, bridge().b);
      expect(events.filter((e) => e.type === 'agent.tool.failed')).toHaveLength(2);
      expect(res.status).toBe('succeeded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
