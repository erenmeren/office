import { expect, it } from 'vitest';
import { buildChildEnv } from './env.js';

it('strips CLAUDE* and AI_AGENT and sets subagent limits', () => {
  expect(
    buildChildEnv(
      { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', AI_AGENT: '1', PATH: '/bin', HOME: '/h' },
      { maxConcurrentSubagents: 3, maxSubagentDepth: 1 },
    ),
  ).toEqual({
    PATH: '/bin',
    HOME: '/h',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
  });
});
