import type { RunSpec } from '@office/shared';

// Office's own settings and secrets; the agent never needs them
const OFFICE_KEY = /^(DATABASE_URL|OFFICE_)|^(COOKIE_SECRET|REDIS_URL)$/;

/**
 * Child env for the SDK: drop the parent's CLAUDE* / AI_AGENT keys so it uses the machine login,
 * drop Office's DATABASE_URL*, COOKIE_SECRET, REDIS_URL and OFFICE_* keys, then set subagent limits
 * and, for a mission run, the git author and committer.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  spec: Pick<RunSpec, 'maxConcurrentSubagents' | 'maxSubagentDepth'> & Partial<Pick<RunSpec, 'git'>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !k.startsWith('CLAUDE') && k !== 'AI_AGENT' && !OFFICE_KEY.test(k)) env[k] = v;
  }
  env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(spec.maxConcurrentSubagents);
  env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(spec.maxSubagentDepth);
  if (spec.git) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = spec.git.committerName;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = spec.git.committerEmail;
  }
  return env;
}
