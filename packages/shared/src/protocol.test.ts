import { describe, expect, it } from 'vitest';
import { ProjectSettingsSchema } from './project-settings.js';
import { WorkerToApiSchema } from './protocol.js';
import { RunSpecSchema } from './run-spec.js';

const hello = { type: 'hello', name: 'w', capacity: 1, allowedRoots: [], activeRunIds: [] };
const git = RunSpecSchema.shape.git.unwrap();
const base = { defaultBranch: 'main', missionBranch: 'office/x-abc123', taskSlug: 't', committerName: 'a', committerEmail: 'a@example.invalid', agentName: 'dev' };
const remote = { path: '/git/00000000-0000-0000-0000-000000000000' };

describe('phase 5 schemas', () => {
  it('hello defaults tags to [] and canClone to false', () => {
    expect(WorkerToApiSchema.parse(hello)).toMatchObject({ tags: [], canClone: false });
  });
  it('hello rejects a tag with uppercase or spaces', () => {
    expect(() => WorkerToApiSchema.parse({ ...hello, tags: ['GPU box'] })).toThrow();
  });
  it('run spec git needs exactly one of repoPath or remote', () => {
    expect(() => git.parse(base)).toThrow('git needs exactly one of repoPath or remote');
    expect(() => git.parse({ ...base, repoPath: '/r', remote })).toThrow();
    expect(git.parse({ ...base, remote }).remote?.path).toMatch(/^\/git\//);
    expect(git.parse({ ...base, repoPath: '/r' }).repoPath).toBe('/r');
  });
  it('project settings default requiredWorkerTags to []', () => {
    expect(ProjectSettingsSchema.parse({}).requiredWorkerTags).toEqual([]);
  });
});

describe('unified sessions schemas', () => {
  it('both socket schemas parse every session and terminal message (no duplicate discriminators)', async () => {
    const { ApiToWorkerSchema, UiClientMessageSchema, UiServerMessageSchema } = await import('./protocol.js');
    expect(ApiToWorkerSchema.parse({ type: 'sessions.request', requestId: 'r', query: { kind: 'background', action: 'start', dir: '/p', prompt: 'go' } }).type).toBe('sessions.request');
    expect(ApiToWorkerSchema.parse({ type: 'sessions.request', requestId: 'r', query: { kind: 'background', action: 'stop', id: 'ab12' } }).type).toBe('sessions.request');
    expect(ApiToWorkerSchema.parse({ type: 'terminal.open', terminalId: 't', dir: '/p', claudeSessionId: 's', cols: 80, rows: 24 })).toMatchObject({ fork: false });
    expect(WorkerToApiSchema.parse({ type: 'sessions.response', requestId: 'r', result: { kind: 'background', id: 'ab12', output: 'ok' } }).type).toBe('sessions.response');
    expect(WorkerToApiSchema.parse({ type: 'terminal.output', terminalId: 't', data: 'aGk=' }).type).toBe('terminal.output');
    expect(UiClientMessageSchema.parse({ type: 'subscribe', topic: 'terminal:abc' }).type).toBe('subscribe');
    expect(UiClientMessageSchema.safeParse({ type: 'terminal.input', terminalId: 't', data: 'x'.repeat(64 * 1024 + 1) }).success).toBe(false);
    expect(UiServerMessageSchema.parse({ type: 'terminal.control', topic: 'terminal:abc', yours: true }).type).toBe('terminal.control');
  });
});
