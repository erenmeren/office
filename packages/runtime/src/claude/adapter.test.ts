import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPolicySchema, type EventBody, type RunSpec } from '@office/shared';

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

import type { RunControl } from '../types.js';

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

async function run(patch: Partial<RunSpec> = {}) {
  const events: EventBody[] = [];
  const res = await new ClaudeAdapter().run({ ...spec, ...patch }, { emit: (e) => void events.push(e) }, new AbortController().signal);
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

  describe('messages into the live session', () => {
    const start = async (messages: unknown[], during: (control: RunControl) => void) => {
      const control: RunControl = { interrupted: new AbortController().signal };
      h.messages = messages;
      h.beforeEnd = async () => during(control);
      const events: EventBody[] = [];
      const res = await new ClaudeAdapter().run(spec, { emit: (e) => events.push(e) }, new AbortController().signal, undefined, control);
      const params = h.calls.at(-1) as { prompt: AsyncIterable<{ message: { content: string } }> };
      return { control, events, res, input: params.prompt };
    };
    const texts = async (input: AsyncIterable<{ message: { content: string } }>) => {
      const out: string[] = [];
      for await (const m of input) out.push(m.message.content);
      return out;
    };

    it('takes a message while it runs, then refuses and closes the input', async () => {
      let taken: boolean | undefined;
      const { control, events, input } = await start([init, { ...base, type: 'result', subtype: 'success', result: 'ok' }], (c) => {
        taken = c.deliver?.('m1', 'use Redis');
      });
      expect(taken).toBe(true);
      expect(events.find((e) => e.type === 'agent.message.received')?.payload).toEqual({ count: 1, messageId: 'm1' });
      expect(control.deliver).toBeUndefined();
      expect(await texts(input)).toEqual(['hi', 'use Redis']);
    });

    it('uses the last result when a background task starts another turn', async () => {
      const task = (subtype: string) => ({ ...base, type: 'system', subtype, task_id: 't1' });
      const { res } = await start(
        [init, task('task_started'), { ...base, type: 'result', subtype: 'success', result: 'first' }, task('task_notification'), { ...base, type: 'result', subtype: 'success', result: 'last' }],
        () => {},
      );
      expect(res.resultText).toBe('last');
    });
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

  it('open network (default): no sandbox; allowlist: sandbox closed except the listed hosts', async () => {
    const gitSpec = { git: { repoPath: '/repo', defaultBranch: 'main', missionBranch: 'office/m', taskSlug: 't', committerName: 'c', committerEmail: 'c@x.invalid', agentName: 'dev' }, networkAccess: 'allowlist' } as Partial<RunSpec>;
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    await run({ ...gitSpec, networkAccess: 'open' });
    expect((h.calls[0] as { options: Record<string, unknown> }).options.sandbox).toBeUndefined();
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    await run(gitSpec);
    let { options } = h.calls[1] as { options: { sandbox: { network: Record<string, unknown> } } };
    expect(options.sandbox.network).toEqual({ allowLocalBinding: true });
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    await run({ ...gitSpec, networkAllowedDomains: ['maratus.co', '*.maratus.co'] });
    ({ options } = h.calls[2] as { options: { sandbox: { network: Record<string, unknown> } } });
    expect(options.sandbox.network).toEqual({ allowLocalBinding: true, allowedDomains: ['maratus.co', '*.maratus.co'] });
  });

  it('passes maxBudgetUsd only when positive (0 is no cap)', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    await run();
    expect((h.calls[0] as { options: Record<string, unknown> }).options.maxBudgetUsd).toBe(0.01);
    h.calls.length = 0;
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    await run({ maxBudgetUsd: 0 });
    expect((h.calls[0] as { options: Record<string, unknown> }).options).not.toHaveProperty('maxBudgetUsd');
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
  const bridge = { call: async () => ({ ok: true as const, result: { messageId: 'm1' }, suspend: true }) };

  it('builds the office server and allows its tools only when tools are served', () => {
    const o = buildQueryOptions({ ...spec, tools: ['read_inbox'] }, bridge, () => {});
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['office']);
    expect(o.allowedTools).toContain('mcp__office__read_inbox');
    expect(o.disallowedTools?.some((t) => t.startsWith('mcp__'))).toBe(false);
    expect(o.strictMcpConfig).toBe(true);
    expect(buildQueryOptions({ ...spec, tools: [] }, bridge, () => {}).mcpServers).toBeUndefined();
    // a worktree run runs Bash in the SDK sandbox, writable in the worktree, the git dir and the skills dir
    const wt = buildQueryOptions({ ...spec, git: { repoPath: '/repo' } as RunSpec['git'], gitDir: '/repo/.git', skillsDir: '/s' }, bridge, () => {});
    expect(wt.sandbox).toMatchObject({ enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false });
    expect(wt.sandbox?.filesystem?.allowWrite).toEqual(expect.arrayContaining(['/repo/.git', '/s']));
    expect(buildQueryOptions(spec, bridge, () => {}).sandbox).toBeUndefined();
    expect(buildQueryOptions({ ...spec, tools: ['read_inbox'] }, undefined, () => {}).mcpServers).toBeUndefined();
  });

  it('maps a suspend tool call to a suspended result and interrupts', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] }];
    h.beforeEnd = async () => {
      const { options } = h.calls[0] as { options: { mcpServers: { office: { tools: { handler: (a: unknown) => Promise<unknown> }[] } } } };
      await options.mcpServers.office.tools[0]!.handler({ to: 'qa' });
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
    expect(events.filter((e) => e.type === 'agent.waiting_reply')).toEqual([
      { type: 'agent.waiting_reply', payload: { messageId: 'm1', to: 'qa' } },
    ]);
    expect(events.some((e) => e.type === 'agent.failed')).toBe(false);
  });

  async function suspendThen(setup: () => void) {
    h.beforeEnd = async () => {
      const { options } = h.calls[0] as { options: { mcpServers: { office: { tools: { handler: (a: unknown) => Promise<unknown> }[] } } } };
      await options.mcpServers.office.tools[0]!.handler({});
      await new Promise((r) => setTimeout(r, 5));
    };
    setup();
    const events: EventBody[] = [];
    const res = await new ClaudeAdapter().run(
      { ...spec, tools: ['send_message'] },
      { emit: (e) => void events.push(e) },
      new AbortController().signal,
      bridge,
    );
    return { res, events };
  }

  it('suspends with the init session id when the SDK throws after interrupt', async () => {
    const { res, events } = await suspendThen(() => {
      h.messages = [init];
      h.throwAtEnd = new Error('interrupted');
    });
    expect(res).toMatchObject({ status: 'suspended', sdkSessionId: 'sess-9' });
    expect(events.some((e) => e.type === 'agent.failed')).toBe(false);
  });

  it('suspends with the init session id when the stream ends without a result', async () => {
    const { res } = await suspendThen(() => {
      h.messages = [init];
    });
    expect(res).toMatchObject({ status: 'suspended', sdkSessionId: 'sess-9' });
  });

  it('turns a bridge error into an isError tool result', async () => {
    const failing = { call: async () => ({ ok: false as const, code: 'x', error: 'boom' }) };
    const o = buildQueryOptions({ ...spec, tools: ['read_inbox'] }, failing, () => {});
    const server = o.mcpServers!.office as unknown as { tools: { handler: (a: unknown) => Promise<unknown> }[] };
    expect(await server.tools[0]!.handler({})).toEqual({ content: [{ type: 'text', text: 'Error x: boom' }], isError: true });
  });
});

describe('policy gate and structured output', () => {
  const schema = { type: 'object', properties: { summary: { type: 'string' } } };

  it('passes outputFormat to query and returns structured_output', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok', structured_output: { summary: 's' } }];
    const res = await new ClaudeAdapter().run(
      { ...spec, outputFormat: { type: 'json_schema', schema } },
      { emit: () => {} },
      new AbortController().signal,
    );
    const { options } = h.calls[0] as { options: Record<string, unknown> };
    expect(options.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(res.structuredOutput).toEqual({ summary: 's' });
  });

  it('omits outputFormat when unset', async () => {
    h.messages = [init, { ...base, type: 'result', subtype: 'success', result: 'ok' }];
    const { res } = await run();
    const { options } = h.calls[0] as { options: Record<string, unknown> };
    expect(options.outputFormat).toBeUndefined();
    expect(res.structuredOutput).toBeUndefined();
  });

  type CanUse = (t: string, i: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown>;
  const opts = { signal: new AbortController().signal };

  it('canUseTool denies unlisted tools before the gate', async () => {
    const asks: unknown[] = [];
    const b = { call: async () => ({ ok: true as const, result: null }), askApproval: async (r: { requestId: string }) => (asks.push(r), { requestId: r.requestId, decision: 'allow' as const }) };
    const o = buildQueryOptions({ ...spec, approvalPolicy: ApprovalPolicySchema.parse({}) }, b, () => {});
    expect(await (o.canUseTool as CanUse)('Bash', { command: 'rm -rf x' }, opts)).toEqual({
      behavior: 'deny',
      message: 'Tool not permitted by Agent Office policy',
    });
    expect(asks).toEqual([]);
  });

  it('canUseTool runs the gate: read-only write denied, ask routed to the bridge', async () => {
    const events: EventBody[] = [];
    const b = { call: async () => ({ ok: true as const, result: null }), askApproval: async (r: { requestId: string }) => ({ requestId: r.requestId, decision: 'deny' as const, message: 'no' }) };
    const s = { ...spec, allowedTools: ['Bash', 'Write'], approvalPolicy: ApprovalPolicySchema.parse({}) };
    const ro = buildQueryOptions({ ...s, readOnlyCheckout: true }, b, () => {}, { emit: (e) => void events.push(e) });
    expect(await (ro.canUseTool as CanUse)('Write', { file_path: '/tmp/a' }, opts)).toEqual({
      behavior: 'deny',
      message: 'Read-only run: writes are not permitted',
    });
    const o = buildQueryOptions(s, b, () => {}, { emit: (e) => void events.push(e) });
    expect(await (o.canUseTool as CanUse)('Bash', { command: 'rm -rf x' }, opts)).toEqual({ behavior: 'deny', message: 'no' });
    expect(await (o.canUseTool as CanUse)('Bash', { command: 'ls' }, opts)).toEqual({ behavior: 'allow' });
    expect(events.map((e) => e.type)).toEqual(['agent.waiting_approval', 'agent.approval.resolved', 'agent.command.executed']);
  });
});

describe('PreToolUse gate hook', () => {
  type Hook = (i: Record<string, unknown>, id: string | undefined, o: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
  const hookOf = (o: { hooks?: unknown }) =>
    (o.hooks as { PreToolUse: { hooks: Hook[]; timeout: number }[] }).PreToolUse[0]!;
  const pre = (tool_name: string, tool_input: Record<string, unknown>, tool_use_id = 'tu1') => ({
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    tool_use_id,
  });
  const opts = { signal: new AbortController().signal };
  const policy = ApprovalPolicySchema.parse({});
  function denying() {
    const asks: unknown[] = [];
    const b = {
      call: async () => ({ ok: true as const, result: null }),
      askApproval: async (r: { requestId: string }) => (asks.push(r), { requestId: r.requestId, decision: 'deny' as const, message: 'no' }),
    };
    return { asks, b };
  }

  it('denies an owner-denied Bash call and asks once per tool use', async () => {
    const events: EventBody[] = [];
    const { asks, b } = denying();
    const o = buildQueryOptions({ ...spec, allowedTools: ['Bash'], approvalPolicy: policy, approvalTimeoutMinutes: 30 }, b, () => {}, {
      emit: (e) => void events.push(e),
    });
    const m = hookOf(o);
    expect(m.timeout).toBe(30 * 60 + 60);
    expect(await m.hooks[0]!(pre('Bash', { command: 'rm -rf x' }), 'tu1', opts)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    });
    expect(events.map((e) => e.type)).toEqual(['agent.waiting_approval', 'agent.approval.resolved']);
    type CanUse = (t: string, i: Record<string, unknown>, o: { signal: AbortSignal; toolUseID: string }) => Promise<unknown>;
    expect(await (o.canUseTool as CanUse)('Bash', { command: 'rm -rf x' }, { ...opts, toolUseID: 'tu1' })).toEqual({
      behavior: 'deny',
      message: 'no',
    });
    expect(asks).toHaveLength(1);
    // the denied call never shows as executed; the allowed one does, once, after the gate
    expect(events.map((e) => e.type)).not.toContain('agent.command.executed');
    expect(await m.hooks[0]!(pre('Bash', { command: 'ls' }, 'tu2'), 'tu2', opts)).toEqual({});
    await (o.canUseTool as CanUse)('Bash', { command: 'ls' }, { ...opts, toolUseID: 'tu2' });
    expect(events.filter((e) => e.type === 'agent.command.executed')).toEqual([{ type: 'agent.command.executed', payload: { command: 'ls' } }]);
  });

  it('stamps the subagent parent on agent.command.executed from the SDK message that carried the tool use', async () => {
    const events: EventBody[] = [];
    h.messages = [init, {
      type: 'assistant', parent_tool_use_id: 'tu-agent', session_id: 's', uuid: 'u',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-sub', name: 'Bash', input: { command: 'ls' } }] },
    }];
    const runP = new ClaudeAdapter().run({ ...spec, allowedTools: ['Bash'] }, { emit: (e) => void events.push(e) }, new AbortController().signal);
    // the hook fires after the run loop has read the subagent's tool_use
    await vi.waitFor(() => expect(events.some((e) => e.type === 'agent.tool.started')).toBe(true));
    const options = (h.calls[0] as { options: ReturnType<typeof buildQueryOptions> }).options;
    await hookOf(options).hooks[0]!(pre('Bash', { command: 'ls' }, 'tu-sub'), 'tu-sub', opts);
    await runP;
    expect(events.find((e) => e.type === 'agent.tool.started')!.payload).toMatchObject({ parentToolUseId: 'tu-agent' });
    expect(events.find((e) => e.type === 'agent.command.executed')!.payload).toEqual({ command: 'ls', parentToolUseId: 'tu-agent' });
  });

  it('keeps gated tools out of allowedTools and disallowedTools under a policy', () => {
    const s = { ...spec, allowedTools: ['Read', 'Bash', 'Edit', 'Write'] };
    for (const g of [{ ...s, approvalPolicy: policy }, { ...s, readOnlyCheckout: true }]) {
      const o = buildQueryOptions(g, undefined, () => {});
      expect(o.allowedTools).toEqual(['Read']);
      for (const t of ['Bash', 'Edit', 'Write']) expect(o.disallowedTools).not.toContain(t);
    }
    const plain = buildQueryOptions(s, undefined, () => {});
    expect(plain.allowedTools).toEqual(['Read', 'Bash', 'Edit', 'Write']);
  });

  it('denies Write on a read-only run', async () => {
    const o = buildQueryOptions({ ...spec, allowedTools: ['Write'], readOnlyCheckout: true }, undefined, () => {});
    expect(await hookOf(o).hooks[0]!(pre('Write', { file_path: '/tmp/a' }), 'tu1', opts)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Read-only run: writes are not permitted',
      },
    });
  });
});

