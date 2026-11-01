import { describe, expect, it } from 'vitest';
import { OFFICE_TOOL_NAMES, ToolCallResultSchema, mcpToolName, parseToolArgs } from './office-tools.js';

describe('office tools', () => {
  it('applies send_message defaults', () => {
    const a = parseToolArgs('send_message', { to: 'architect', body: 'hi' });
    expect(a.type).toBe('message');
    expect(a.awaitReply).toBe(false);
  });
  it('rejects missing body', () => {
    expect(() => parseToolArgs('send_message', { to: 'x' })).toThrow();
  });
  it('names mcp tools', () => {
    expect(mcpToolName('read_inbox')).toBe('mcp__office__read_inbox');
    expect(OFFICE_TOOL_NAMES).toHaveLength(14);
  });
  it('accepts an error result', () => {
    expect(ToolCallResultSchema.safeParse({ ok: false, error: 'x', code: 'limit_exceeded' }).success).toBe(true);
  });
});
