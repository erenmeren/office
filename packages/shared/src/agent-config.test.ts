import { describe, expect, it } from 'vitest';
import { AgentConfigSchema, minBudget } from './agent-config.js';

describe('minBudget', () => {
  it('treats 0 and undefined as no cap and takes the lowest positive cap', () => {
    expect(minBudget()).toBe(0);
    expect(minBudget(0, undefined)).toBe(0);
    expect(minBudget(0, 5)).toBe(5);
    expect(minBudget(2, 5)).toBe(2);
    expect(minBudget(5, 0.25)).toBe(0.25);
    expect(minBudget(0, 0.25)).toBe(0.25);
  });
});

describe('AgentConfigSchema.maxBudgetUsd', () => {
  const base = { systemPrompt: '', model: 'sonnet', allowedTools: [] };
  it('defaults to 0 (no cap) and accepts 0', () => {
    expect(AgentConfigSchema.parse(base).maxBudgetUsd).toBe(0);
    expect(AgentConfigSchema.parse({ ...base, maxBudgetUsd: 0 }).maxBudgetUsd).toBe(0);
    expect(AgentConfigSchema.safeParse({ ...base, maxBudgetUsd: -1 }).success).toBe(false);
  });
});
