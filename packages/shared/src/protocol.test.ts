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
