import { expect, it } from 'vitest';
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
