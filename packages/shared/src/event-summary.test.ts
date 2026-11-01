import { describe, expect, it } from 'vitest';
import type { OfficeEvent } from './events.js';
import { summarizeEvent } from './event-summary.js';

const ev = (type: string, payload: Record<string, unknown>) =>
  ({ type, seq: 1, ts: new Date().toISOString(), sessionId: 's', runId: 'r', agentId: 'a', projectId: 'p', payload }) as OfficeEvent;

describe('summarizeEvent', () => {
  it('summarises tools, text, commands and files on one line', () => {
    expect(summarizeEvent(ev('agent.tool.started', { tool: 'Bash', input: { command: 'ls -la' } }))).toBe('Bash ls -la');
    expect(summarizeEvent(ev('agent.text', { text: 'hello' }))).toBe('hello');
    expect(summarizeEvent(ev('agent.command.executed', { command: 'pnpm test' }))).toBe('$ pnpm test');
    expect(summarizeEvent(ev('agent.file.changed', { path: 'a.ts' }))).toBe('changed a.ts');
    expect(summarizeEvent(ev('agent.subagent.spawned', { subagentType: 'helper' }))).toBe('subagent helper');
  });

  it('falls back to the type name for unknown events and odd payloads', () => {
    expect(summarizeEvent(ev('something.new', {}))).toBe('something.new');
    expect(summarizeEvent(ev('agent.completed', { text: 42, tool: null }))).toBe('agent.completed');
  });
});
