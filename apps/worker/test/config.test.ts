import { expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.js';

it('fails fast on missing or nonexistent workspace roots', () => {
  const env = { OFFICE_API_URL: 'ws://x' };
  expect(() => loadWorkerConfig(env)).toThrow('OFFICE_WORKSPACE_ROOTS is empty or missing');
  expect(() => loadWorkerConfig({ ...env, OFFICE_WORKSPACE_ROOTS: '/nonexistent-office-root' })).toThrow(
    'Workspace root does not exist: /nonexistent-office-root',
  );
});
