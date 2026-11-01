import { expect, it } from 'vitest';
import { buildChildEnv } from './env.js';

it('strips CLAUDE*, AI_AGENT and Office secrets and sets subagent limits', () => {
  expect(
    buildChildEnv(
      {
        CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', AI_AGENT: '1', PATH: '/bin', HOME: '/h',
        DATABASE_URL: 'pg://a', DATABASE_URL_TEST: 'pg://b', COOKIE_SECRET: 's', REDIS_URL: 'redis://r',
        OFFICE_API_URL: 'ws://x', OFFICE_ENROLL_TOKEN: 't',
      },
      { maxConcurrentSubagents: 3, maxSubagentDepth: 1 },
    ),
  ).toEqual({
    PATH: '/bin',
    HOME: '/h',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
  });
});

it('sets the git author and committer from spec.git', () => {
  const git = {
    repoPath: '/r', defaultBranch: 'main', missionBranch: 'office/m', taskSlug: 't',
    committerName: 'Office', committerEmail: 'o@example.invalid', agentName: 'developer',
  };
  expect(buildChildEnv({ PATH: '/bin' }, { maxConcurrentSubagents: 1, maxSubagentDepth: 1, git })).toMatchObject({
    GIT_AUTHOR_NAME: 'Office',
    GIT_AUTHOR_EMAIL: 'o@example.invalid',
    GIT_COMMITTER_NAME: 'Office',
    GIT_COMMITTER_EMAIL: 'o@example.invalid',
  });
});
