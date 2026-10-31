import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBody, RunSpec } from '@office/shared';

const h = vi.hoisted(() => ({ messages: [] as unknown[], throwAtEnd: undefined as Error | undefined, calls: [] as unknown[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: unknown) => {
    h.calls.push(params);
    return (async function* () {
      for (const m of h.messages) yield m;
      if (h.throwAtEnd) throw h.throwAtEnd;
    })();
  },
}));

const { ClaudeAdapter } = await import('./adapter.js');

const spec: RunSpec = {
  runId: 'r1',
  sessionId: 's1',
  agentId: 'a1',
  projectId: 'p1',
  cwd: '/tmp',
  prompt: 'hi',
  systemPrompt: '',
  model: 'haiku',
  allowedTools: ['Read'],
  maxTurns: 1,
  maxBudgetUsd: 0.01,
  maxConcurrentSubagents: 4,
  maxSubagentDepth: 1,
};
const init = { type: 'system', subtype: 'init', model: 'm', tools: [], session_id: 'sess-9', apiKeySource: 'none' };
const base = { is_error: false, total_cost_usd: 0.01, num_turns: 1, duration_ms: 5, usage: { input_tokens: 1, output_tokens: 2 }, session_id: 'sess-9' };

async function run() {
  const events: EventBody[] = [];
  const res = await new ClaudeAdapter().run(spec, { emit: (e) => void events.push(e) }, new AbortController().signal);
  return { events, res };
}

beforeEach(() => {
  h.messages = [];
  h.throwAtEnd = undefined;
  h.calls = [];
});

describe('ClaudeAdapter', () => {
  it('keeps the error result when the SDK throws after it', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['max turns'] }];
    h.throwAtEnd = new Error('Claude Code returned an error result: x');
    const { events, res } = await run();
    expect(events.filter((e) => e.type === 'agent.failed')).toHaveLength(1);
    expect(res.status).toBe('failed');
    expect(res.sdkSessionId).toBe('sess-9');
  });

  it('redacts secrets in resultText', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'k sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }];
    const { res } = await run();
    expect(res.resultText).toContain('[REDACTED]');
    expect(res.resultText).not.toContain('sk-ant-');
  });

  it('passes the hardened permission options', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    await run();
    const { options } = h.calls[0] as { options: Record<string, unknown> };
    expect(options.permissionMode).toBe('default');
    expect(options.settingSources).toEqual(['project']);
    expect(options.disallowedTools).toContain('Bash');
    expect(options.disallowedTools).not.toContain('Read');
  });
});
