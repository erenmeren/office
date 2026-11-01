import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { normalizeSdkMessage } from './normalize.js';

// Hand-written minimal messages; cast because they omit fields the SDK types require.
const msgs = JSON.parse(
  readFileSync(new URL('./__fixtures__/sdk-messages.json', import.meta.url), 'utf8'),
) as SDKMessage[];
const out = msgs.map(normalizeSdkMessage);
const types = out.map((evs) => evs.map((e) => e.type));

describe('normalizeSdkMessage', () => {
  it('maps every fixture message to the expected event types', () => {
    expect(types).toEqual([
      ['agent.started'],
      ['agent.thinking', 'agent.text', 'agent.tool.started'],
      ['agent.tool.completed'],
      ['agent.tool.started', 'agent.subagent.spawned'],
      ['agent.tool.started', 'agent.file.changed'],
      ['agent.tool.failed'],
      ['agent.subagent.completed'],
      ['agent.completed'],
      ['agent.failed'],
      [],
    ]);
  });

  it('builds the expected payloads', () => {
    expect(out[0]![0]!.payload).toEqual({
      model: 'claude-haiku-5-5',
      tools: ['Bash', 'Agent', 'Write'],
      sdkSessionId: 'sess-1',
      slashCommands: ['/tdd'],
      agents: [],
    });
    expect(out[1]![2]!.payload).toEqual({ toolUseId: 'tu-1', tool: 'Bash', input: { command: 'echo hi' } });
    expect(out[3]![1]!.payload).toEqual({ toolUseId: 'tu-2', description: 'Explore repo', subagentType: 'Explore' });
    expect(out[4]![1]!.payload).toEqual({ path: '/tmp/x.ts', parentToolUseId: 'tu-2' });
    expect(out[5]![0]!.payload).toEqual({ toolUseId: 'tu-3', output: 'denied', parentToolUseId: 'tu-2' });
    expect(out[6]![0]!.payload).toEqual({ toolUseId: 'tu-2', status: 'completed', summary: 'explored' });
    expect(out[7]![0]!.payload).toEqual({ resultText: 'done', costUsd: 0.01, numTurns: 3, durationMs: 1200 });
    expect(out[8]![0]!.payload).toEqual({ subtype: 'error_max_turns', errors: ['max turns reached'] });
  });

  it('emits agent.skill.invoked for a Skill tool_use', () => {
    const msg = {
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: 's',
      uuid: 'u',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-s', name: 'Skill', input: { skill: 'tdd' } }] },
    } as unknown as SDKMessage;
    const evs = normalizeSdkMessage(msg);
    expect(evs.map((e) => e.type)).toEqual(['agent.tool.started', 'agent.skill.invoked']);
    expect(evs[1]!.payload).toEqual({ toolUseId: 'tu-s', skill: 'tdd' });
  });

  it('never leaks thinking content', () => {
    expect(out[1]![0]!.payload).toEqual({ chars: 'PRIVATE_THOUGHT plan'.length });
    expect(JSON.stringify(out)).not.toContain('PRIVATE_THOUGHT');
  });

  it('redacts secrets in tool results', () => {
    expect(out[2]![0]!.payload).toEqual({ toolUseId: 'tu-1', output: 'hi [REDACTED]' });
    expect(JSON.stringify(out)).not.toContain('sk-ant-');
  });
});
