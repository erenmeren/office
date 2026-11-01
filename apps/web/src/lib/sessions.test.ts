import { describe, expect, it } from 'vitest';
import type { OfficeEvent } from '@office/shared';
import { commandRows, elapsed, fileRows, kTokens, splitPath } from './sessions';

const ev = (seq: number, type: string, payload: Record<string, unknown>, s = seq): OfficeEvent =>
  ({ seq, type, payload, ts: new Date(Date.UTC(2026, 10, 1, 19, 0, s)).toISOString(), sessionId: 's', runId: 'r', agentId: 'a', projectId: 'p' }) as OfficeEvent;

describe('commandRows', () => {
  it('pairs each command with its Bash call for status and duration, and merges stored rows by seq', () => {
    const events = [
      ev(1, 'agent.tool.started', { tool: 'Bash', toolUseId: 't1', input: { command: 'ls' } }),
      ev(2, 'agent.command.executed', { command: 'ls' }),
      ev(3, 'agent.tool.started', { tool: 'Bash', toolUseId: 't2', input: { command: 'pnpm test' } }),
      ev(4, 'agent.command.executed', { command: 'pnpm test', parentToolUseId: 'sub' }),
      ev(6, 'agent.tool.completed', { toolUseId: 't1' }),
      ev(9, 'agent.tool.failed', { toolUseId: 't2' }),
      ev(10, 'agent.command.executed', { command: 'git diff' }),
    ];
    const stored = [{ seq: 2, ts: events[1].ts, command: 'ls' }];
    expect(commandRows(stored, events, true)).toEqual([
      expect.objectContaining({ seq: 2, command: 'ls', status: 'done', durationMs: 4000 }),
      expect.objectContaining({ seq: 4, command: 'pnpm test', status: 'failed', durationMs: 5000, bySubagent: 'sub' }),
      expect.objectContaining({ seq: 10, command: 'git diff', status: 'running', durationMs: undefined }),
    ]);
    expect(commandRows([], [events[6]], false)[0].status).toBeUndefined();
  });
});

it('fileRows adds live paths once', () => {
  expect(fileRows([{ path: 'a.ts', adds: 1 }], [ev(1, 'agent.file.changed', { path: 'a.ts' }), ev(2, 'agent.file.changed', { path: 'b.ts', parentToolUseId: 't' })])).toEqual([
    { path: 'a.ts', adds: 1 },
    { path: 'b.ts', bySubagent: 't' },
  ]);
});

it('elapsed', () => {
  expect([elapsed(8_000), elapsed(72_000), elapsed(7_380_000)]).toEqual(['8s', '1m 12s', '2h 3m']);
});

it('splitPath', () => {
  expect([splitPath('apps/web/a.tsx'), splitPath('a.tsx')]).toEqual([['apps/web', 'a.tsx'], ['', 'a.tsx']]);
});

describe('kTokens', () => {
  it('formats counts the way the inspector header shows them', () => {
    expect([0, 950, 1499, 21_000, 184_400, 999_499, 999_600, 1_234_000].map(kTokens)).toEqual(['0', '950', '1k', '21k', '184k', '999k', '1.0M', '1.2M']);
  });
});
