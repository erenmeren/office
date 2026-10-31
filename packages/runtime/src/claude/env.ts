import type { RunSpec } from '@office/shared';

/** Child env for the SDK: drop the parent's CLAUDE* / AI_AGENT keys so it uses the machine login, then set subagent limits. */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  spec: Pick<RunSpec, 'maxConcurrentSubagents' | 'maxSubagentDepth'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !k.startsWith('CLAUDE') && k !== 'AI_AGENT') env[k] = v;
  }
  env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(spec.maxConcurrentSubagents);
  env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(spec.maxSubagentDepth);
  return env;
}
