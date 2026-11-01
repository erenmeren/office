import { z } from 'zod';
import type { ApprovalType } from './enums.js';

export const DEFAULT_DESTRUCTIVE_PATTERNS = [
  'rm -rf',
  'git reset --hard',
  'git push',
  'git push --force',
  'drizzle-kit',
  'npm run db:',
  'pnpm db:',
  'DROP TABLE',
  'TRUNCATE',
];
export const DEFAULT_SENSITIVE_PATHS = ['.env', '.env.*', 'credentials.json', '*.pem', '*.key', 'id_rsa'];

export const ApprovalModeSchema = z.enum(['ask', 'auto', 'block']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const ApprovalPolicySchema = z.object({
  plan: ApprovalModeSchema.default('ask'),
  git_push: ApprovalModeSchema.default('ask'),
  merge: ApprovalModeSchema.default('ask'),
  deploy: ApprovalModeSchema.default('ask'),
  destructive_command: ApprovalModeSchema.default('ask'),
  sensitive_path: ApprovalModeSchema.default('ask'),
  budget_exceeded: ApprovalModeSchema.default('ask'),
  destructivePatterns: z.array(z.string()).default(DEFAULT_DESTRUCTIVE_PATTERNS),
  sensitivePaths: z.array(z.string()).default(DEFAULT_SENSITIVE_PATHS),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export type PolicyVerdict =
  | { verdict: 'allow' }
  | { verdict: 'ask' | 'block'; type: ApprovalType; reason: string };

// `*` and `?` only; everything else is literal.
function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** Global git options skipped before the subcommand: `-C dir`, `-c k=v`, `--no-pager`, `--git-dir=…`. */
export const GIT_OPTIONS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--no-pager|--git-dir=\S+))*`;

// git calls that create or rewrite commits without `git commit`: they need the same approval
const COMMIT_EQUIVALENT = new RegExp(
  String.raw`\bgit${GIT_OPTIONS}\s+(worktree\s+add|cherry-pick|rebase|merge|am|apply|stash)(?![\w-])`,
  'i',
);

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep']);

function decide(policy: ApprovalPolicy, type: ApprovalType, reason: string): PolicyVerdict {
  const mode = policy[type];
  return mode === 'auto' ? { verdict: 'allow' } : { verdict: mode, type, reason };
}

export function evaluateToolCall(
  policy: ApprovalPolicy,
  toolName: string,
  input: Record<string, unknown>,
): PolicyVerdict {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const lower = command.toLowerCase();
    if (lower.includes('git push')) return decide(policy, 'git_push', `git push: ${command}`);
    const hit = policy.destructivePatterns.find((p) => lower.includes(p.toLowerCase()));
    if (hit) return decide(policy, 'destructive_command', `command matches "${hit}": ${command}`);
    const commit = policy.destructivePatterns.some((p) => p.toLowerCase() === 'git commit') && COMMIT_EQUIVALENT.exec(command);
    if (commit) return decide(policy, 'destructive_command', `git ${commit[1]} is commit-equivalent ("git commit"): ${command}`);
    return { verdict: 'allow' };
  }
  if (FILE_TOOLS.has(toolName)) {
    // Grep's `glob` names files too: `.env*` or `**/.env.local` reach the same secrets as `path`
    for (const raw of [input.file_path, input.notebook_path, input.path, input.glob]) {
      const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() : undefined;
      if (!base) continue;
      // a `glob` input is itself a pattern: `.env*` reaches `.env` although no sensitive glob matches the text `.env*`
      const hit = policy.sensitivePaths.find((g) => globToRegExp(g).test(base) || (raw === input.glob && globToRegExp(base).test(g)));
      if (hit) return decide(policy, 'sensitive_path', `${toolName} touches sensitive path ${base} (matches "${hit}")`);
    }
  }
  return { verdict: 'allow' };
}
