import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '@office/runtime';
import type { RunSpec, WorkerToApi } from '@office/shared';
import { RunExecutor } from '../src/executor.js';

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
  const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
    runId: 'run-1', sessionId: 'sess-1', agentId: 'agent-1', projectId: 'proj-1',
    cwd: join(root, 'repo'), prompt: 'do it', systemPrompt: 'sys', model: 'sonnet', allowedTools: [],
    maxTurns: 5, maxBudgetUsd: 1, maxConcurrentSubagents: 4, maxSubagentDepth: 1, ...over,
  });
  const done = () => sent.some((m) => m.type === 'run.result' || m.type === 'run.rejected');

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'office-exec-')));
    mkdirSync(join(root, 'repo'));
    sent = [];
    executor = new RunExecutor(new FakeAdapter(), (m) => sent.push(m), [root]);
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
    );
    boom.accept(spec());
    await until(done, 'result');
    expect(sent.map((m) => m.type)).toEqual(['run.accepted', 'run.event', 'run.result']);
    expect(sent[1]).toMatchObject({ event: { type: 'agent.failed', seq: 1, payload: { error: 'boom' } } });
    expect(sent[2]).toMatchObject({ result: { status: 'failed', error: 'boom' } });
  });
});
