import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBody, RunSpec } from '@office/shared';

const h = vi.hoisted(() => ({ messages: [] as unknown[], throwAtEnd: undefined as Error | undefined, calls: [] as unknown[], interrupt: vi.fn(async () => {}), beforeEnd: undefined as (() => Promise<void>) | undefined }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: unknown) => {
    h.calls.push(params);
    const gen = (async function* () {
      if (h.beforeEnd) await h.beforeEnd();
      for (const m of h.messages) yield m;
      if (h.throwAtEnd) throw h.throwAtEnd;
    })();
    return Object.assign(gen, { interrupt: h.interrupt });
  },
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (o: { name: string; tools: unknown[] }) => ({ type: 'sdk', name: o.name, instance: {}, tools: o.tools }),
}));

const { ClaudeAdapter, buildQueryOptions, effectiveAllowedTools } = await import('./adapter.js');

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
  skills: [],
  subagents: [],
  kind: 'task',
  startSeq: 0,
  tools: [],
} as RunSpec;
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
  h.beforeEnd = undefined;
  h.interrupt.mockClear();
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
    expect(options.disallowedTools).not.toContain('mcp__*');
    expect(options.strictMcpConfig).toBe(true);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool']),
    );
  });

  it('passes skills, skillsDir and subagents and grants Skill and Agent', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    const skill = { name: 'tdd', version: 1, checksum: 'c', mode: 'eager' as const, files: {} };
    const sub = { name: 'reviewer', description: 'd', prompt: 'p', skills: ['tdd'] };
    await new ClaudeAdapter().run(
      { ...spec, skills: [skill], subagents: [sub], skillsDir: '/tmp/x/.office' },
      { emit: () => {} },
      new AbortController().signal,
    );
    const { options } = h.calls[0] as { options: Record<string, unknown> };
    expect(options.additionalDirectories).toEqual(['/tmp/x/.office']);
    expect(options.skills).toEqual(['tdd']);
    expect(options.agents).toEqual({ reviewer: { description: 'd', prompt: 'p', skills: ['tdd'] } });
    expect(options.allowedTools).toEqual(['Read', 'Skill', 'Agent', 'Task']);
    expect(options.disallowedTools).not.toContain('Skill');
    expect(options.disallowedTools).not.toContain('Agent');
    expect(options.disallowedTools).not.toContain('Task');
  });

  it('omits skill and subagent options when none are pinned', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    await run();
    const { options } = h.calls[0] as { options: Record<string, unknown> };
    expect(options.additionalDirectories).toBeUndefined();
    expect(options.skills).toBeUndefined();
    expect(options.agents).toBeUndefined();
  });
});

describe('effectiveAllowedTools', () => {
  const skill = { name: 'tdd', version: 1, checksum: 'c', mode: 'eager' as const, files: {} };
  const sub = { name: 'reviewer', description: 'd', prompt: 'p', skills: [] };

  it('adds Skill only with skills and Agent only with subagents', () => {
    expect(effectiveAllowedTools(spec)).toEqual(['Read']);
    expect(effectiveAllowedTools({ ...spec, skills: [skill] })).toEqual(['Read', 'Skill']);
    expect(effectiveAllowedTools({ ...spec, subagents: [sub] })).toEqual(['Read', 'Agent', 'Task']);
  });

  it('does not duplicate Skill or Agent', () => {
    const s = { ...spec, allowedTools: ['Skill', 'Agent', 'Task'], skills: [skill], subagents: [sub] };
    expect(effectiveAllowedTools(s)).toEqual(['Skill', 'Agent', 'Task']);
  });
});

describe('office tools', () => {
  const bridge = { call: async () => ({ ok: true as const, result: {}, suspend: true }) };

  it('builds the office server and allows its tools only when tools are served', () => {
    const o = buildQueryOptions({ ...spec, tools: ['read_inbox'] }, bridge, () => {});
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['office']);
    expect(o.allowedTools).toContain('mcp__office__read_inbox');
    expect(o.disallowedTools?.some((t) => t.startsWith('mcp__'))).toBe(false);
    expect(o.strictMcpConfig).toBe(true);
    expect(buildQueryOptions({ ...spec, tools: [] }, bridge, () => {}).mcpServers).toBeUndefined();
    expect(buildQueryOptions({ ...spec, tools: ['read_inbox'] }, undefined, () => {}).mcpServers).toBeUndefined();
  });

  it('maps a suspend tool call to a suspended result and interrupts', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] }];
    h.beforeEnd = async () => {
      const { options } = h.calls[0] as { options: { mcpServers: { office: { tools: { handler: (a: unknown) => Promise<unknown> }[] } } } };
      await options.mcpServers.office.tools[0]!.handler({});
      await new Promise((r) => setTimeout(r, 5));
    };
    const events: EventBody[] = [];
    const res = await new ClaudeAdapter().run(
      { ...spec, tools: ['send_message'] },
      { emit: (e) => void events.push(e) },
      new AbortController().signal,
      bridge,
    );
    expect(res).toMatchObject({ status: 'suspended', sdkSessionId: 'sess-9' });
    expect(h.interrupt).toHaveBeenCalled();
    expect(events.some((e) => e.type === 'agent.failed')).toBe(false);
  });
});
