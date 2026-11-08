import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalPolicySchema, RunSpecSchema, type EventBody } from '@office/shared';
import type { RunControl } from '../types.js';
import { CodexAdapter, codexArgs, codexRefusal } from './adapter.js';
import { normalizeCodexEvent } from './normalize.js';

// A stand-in for the Codex CLI: logs argv and stdin, then plays the JSONL of the scenario in $FAKE_CODEX_MODE.
const dir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
const bin = join(dir, 'codex');
const log = join(dir, 'log.json');
writeFileSync(
  bin,
  `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }));
  const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  const mode = process.env.FAKE_CODEX_MODE;
  out({ type: 'thread.started', thread_id: 'th-1' });
  out({ type: 'turn.started' });
  if (mode === 'ok') {
    out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok 1', exit_code: 0, status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Changed src/a.ts; npm test passes.' } });
    out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 100, output_tokens: 300, reasoning_output_tokens: 50 } });
    process.exit(0);
  }
  if (mode === 'fail') {
    process.stderr.write('ERROR codex_api: 401 Unauthorized\\n');
    out({ type: 'error', message: 'Reconnecting... 1/5 (401 Unauthorized)' });
    out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } });
    process.exit(1);
  }
  setTimeout(() => process.exit(0), 30000); // hang until killed
});
`,
);
chmodSync(bin, 0o755);
afterAll(() => delete process.env.FAKE_CODEX_MODE);

const spec = (over: Record<string, unknown> = {}) =>
  RunSpecSchema.parse({
    runId: 'r1', sessionId: 's1', agentId: 'a1', projectId: 'p1', cwd: dir, prompt: 'Fix the bug', systemPrompt: 'You are a developer.',
    model: 'gpt-5-codex', runtime: 'codex', allowedTools: [], maxTurns: 10, maxBudgetUsd: 0, kind: 'task',
    approvalPolicy: ApprovalPolicySchema.parse({ destructive_command: 'auto', sensitive_path: 'auto', git_push: 'auto', deploy: 'auto' }),
    ...over,
  });

const collect = () => {
  const events: EventBody[] = [];
  return { events, sink: { emit: (b: EventBody) => events.push(b) } };
};

describe('CodexAdapter (fake codex binary)', () => {
  beforeEach(() => writeFileSync(log, '{}'));

  it('a completed turn succeeds with the last agent message, thread id and token usage; events are mapped', async () => {
    process.env.FAKE_CODEX_MODE = 'ok';
    const { events, sink } = collect();
    const r = await new CodexAdapter(bin).run(spec(), sink, new AbortController().signal);
    expect(r).toMatchObject({
      status: 'succeeded', resultText: 'Changed src/a.ts; npm test passes.', sdkSessionId: 'th-1',
      usage: { inputTokens: 1200, outputTokens: 350, costUsd: 0, numTurns: 1 },
    });
    expect(events.map((e) => e.type)).toEqual([
      'agent.started', 'agent.tool.started', 'agent.command.executed', 'agent.tool.completed', 'agent.file.changed', 'agent.text', 'agent.completed',
    ]);
    const called = JSON.parse(readFileSync(log, 'utf8'));
    expect(called.argv).toEqual(codexArgs(spec()));
    expect(called.argv).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', '--model', 'gpt-5-codex', '-']));
    // a new thread gets the agent's instructions ahead of the task
    expect(called.stdin).toMatch(/^You are a developer\.[\s\S]*# Task\n\nFix the bug$/);
  });

  it('a failed turn fails with its message; a resume sends only the prompt with `resume <thread>`', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    const { events, sink } = collect();
    const r = await new CodexAdapter(bin).run(spec({ resumeSdkSessionId: 'th-0', prompt: 'Continue' }), sink, new AbortController().signal);
    expect(r).toMatchObject({ status: 'failed', error: 'codex: unexpected status 401 Unauthorized', sdkSessionId: 'th-1' });
    expect(events.at(-1)).toMatchObject({ type: 'agent.failed' });
    const called = JSON.parse(readFileSync(log, 'utf8'));
    expect(called.argv.slice(-3)).toEqual(['resume', 'th-0', '-']);
    expect(called.stdin).toBe('Continue');
  });

  it('interrupt stops the process and suspends with the thread id; abort cancels', async () => {
    process.env.FAKE_CODEX_MODE = 'hang';
    const ac = new AbortController();
    const control: RunControl = { interrupted: ac.signal };
    const { events, sink } = collect();
    const running = new CodexAdapter(bin).run(spec(), sink, new AbortController().signal, undefined, control);
    await new Promise((r) => setTimeout(r, 400));
    ac.abort();
    expect(await running).toMatchObject({ status: 'suspended', sdkSessionId: 'th-1' });
    expect(events.map((e) => e.type)).toContain('agent.waiting_reply');
    // no live delivery on Codex: the API leaves such mail for the next run
    expect(control.deliver).toBeUndefined();

    const cancel = new AbortController();
    const second = new CodexAdapter(bin).run(spec(), collect().sink, cancel.signal);
    await new Promise((r) => setTimeout(r, 400));
    cancel.abort();
    expect(await second).toMatchObject({ status: 'cancelled' });
  });

  it('refuses non-task runs and policies it cannot enforce, without starting codex', async () => {
    expect(codexRefusal(spec({ kind: 'chat' }))).toMatch('task runs only');
    expect(codexRefusal(spec({ approvalPolicy: ApprovalPolicySchema.parse({ sensitive_path: 'auto' }) }))).toMatch('destructive_command is not "auto"');
    const { sink } = collect();
    const r = await new CodexAdapter(join(dir, 'missing')).run(spec({ kind: 'plan' }), sink, new AbortController().signal);
    expect(r).toMatchObject({ status: 'failed', error: expect.stringContaining('task runs only') });
  });

  it('network is on only for open access with auto git_push and deploy; Claude aliases are not passed as models', () => {
    expect(codexArgs(spec())).toContain('sandbox_workspace_write.network_access=true');
    expect(codexArgs(spec({ networkAccess: 'allowlist' }))).toContain('sandbox_workspace_write.network_access=false');
    expect(codexArgs(spec({ approvalPolicy: ApprovalPolicySchema.parse({ destructive_command: 'auto', sensitive_path: 'auto' }) }))).toContain(
      'sandbox_workspace_write.network_access=false',
    );
    expect(codexArgs(spec({ model: 'sonnet' }))).not.toContain('--model');
    expect(codexArgs(spec({ gitDir: '/repo/.git' }))).toEqual(expect.arrayContaining(['--add-dir', '/repo/.git']));
  });

  it('normalizes a failed command and redacts secrets', () => {
    const [e] = normalizeCodexEvent({
      type: 'item.completed',
      item: { id: 'c', type: 'command_execution', command: 'x', aggregated_output: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', exit_code: 2, status: 'failed' },
    });
    expect(e).toMatchObject({ type: 'agent.tool.failed', payload: { exitCode: 2 } });
    expect(JSON.stringify(e)).not.toContain('sk-ant-api03-AAAA');
  });
});
