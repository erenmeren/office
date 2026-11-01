import { describe, expect, it } from 'vitest';
import { EventType } from './enums.js';
import { RunResultSchema, RunSpecSchema } from './run-spec.js';

const base = {
  runId: 'r1',
  sessionId: 's1',
  agentId: 'a1',
  projectId: 'p1',
  cwd: '/w',
  prompt: 'p',
  systemPrompt: 's',
  model: 'sonnet',
  allowedTools: [],
  maxTurns: 5,
  maxBudgetUsd: 1,
};

describe('RunSpecSchema', () => {
  it('defaults skills and subagents to empty', () => {
    const p = RunSpecSchema.parse(base);
    expect(p.skills).toEqual([]);
    expect(p.subagents).toEqual([]);
  });
  it('round-trips a skill and a subagent', () => {
    const spec = {
      ...base,
      skills: [{ name: 'tdd', version: 1, checksum: 'abc', mode: 'eager', files: { 'SKILL.md': 'x' } }],
      subagents: [{ name: 'rev', description: 'd', prompt: 'p', skills: ['tdd'] }],
      skillsDir: '/tmp/sk',
    };
    expect(RunSpecSchema.parse(spec)).toMatchObject(spec);
  });
  it('knows agent.skill.invoked', () => {
    expect(EventType.options).toContain('agent.skill.invoked');
  });
});

describe('Phase 3 run fields', () => {
  it('defaults kind, startSeq and tools', () => {
    const p = RunSpecSchema.parse(base);
    expect(p.kind).toBe('task');
    expect(p.startSeq).toBe(0);
    expect(p.tools).toEqual([]);
  });
  it('requires sdkSessionId for suspended results', () => {
    const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0, numTurns: 1, durationMs: 1 };
    expect(RunResultSchema.parse({ status: 'suspended', usage, sdkSessionId: 's' }).status).toBe('suspended');
    expect(() => RunResultSchema.parse({ status: 'suspended', usage })).toThrow();
  });
});
