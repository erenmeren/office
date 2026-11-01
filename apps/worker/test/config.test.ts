import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkerConfig } from '../src/config.js';

it('fails fast on missing or nonexistent workspace roots', () => {
  const env = { OFFICE_API_URL: 'ws://x' };
  expect(() => loadWorkerConfig(env)).toThrow('OFFICE_WORKSPACE_ROOTS is empty or missing');
  expect(() => loadWorkerConfig({ ...env, OFFICE_WORKSPACE_ROOTS: '/nonexistent-office-root' })).toThrow(
    'Workspace root does not exist: /nonexistent-office-root',
  );
});

it('accepts empty OFFICE_WORKSPACE_ROOTS when OFFICE_WORKER_CAN_CLONE=true', () => {
  const c = loadWorkerConfig({ OFFICE_API_URL: 'ws://x', OFFICE_WORKER_CAN_CLONE: 'true', OFFICE_WORKER_TAGS: 'gpu, linux' });
  expect(c).toMatchObject({ workspaceRoots: [], canClone: true, tags: ['gpu', 'linux'] });
});

it('rejects an invalid tag', () => {
  expect(() => loadWorkerConfig({ OFFICE_API_URL: 'ws://x', OFFICE_WORKER_CAN_CLONE: 'true', OFFICE_WORKER_TAGS: 'Bad Tag' })).toThrow(
    /OFFICE_WORKER_TAGS/,
  );
});

it('falls back to a random machine id persisted 0600 in the worker home when /etc/machine-id is unreadable', () => {
  const home = mkdtempSync(join(tmpdir(), 'office-mid-'));
  try {
    const env = { OFFICE_API_URL: 'ws://x', OFFICE_WORKER_CAN_CLONE: 'true', OFFICE_WORKER_HOME: home };
    const first = loadWorkerConfig(env, join(home, 'no-such-machine-id')).machineId;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(home, 'machine-id'), 'utf8')).toBe(first);
    expect(statSync(join(home, 'machine-id')).mode & 0o777).toBe(0o600);
    expect(loadWorkerConfig(env, join(home, 'no-such-machine-id')).machineId).toBe(first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
