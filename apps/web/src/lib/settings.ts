import type { ProjectSettings } from '@office/shared';

export type PolicyKey = keyof Omit<ProjectSettings['approvalPolicy'], 'destructivePatterns' | 'sensitivePaths'>;

export const policyRows: { label: string; hint: string; applies: string; keys: PolicyKey[] }[] = [
  { label: 'Approve the full task plan', hint: 'Chief cannot start tasks until you approve the plan', applies: 'All projects', keys: ['plan'] },
  { label: 'Destructive shell commands', hint: 'rm -rf, git reset --hard, force push', applies: 'All workers', keys: ['destructive_command'] },
  { label: 'Deployment', hint: 'Any command that ships to an environment', applies: 'All workers', keys: ['deploy'] },
  { label: 'Git push and merge', hint: 'Integration of a task branch into main', applies: 'All workers', keys: ['git_push', 'merge'] },
  { label: 'Sensitive resources', hint: '.env files, credentials, key stores', applies: 'All workers', keys: ['sensitive_path'] },
  { label: 'Spend beyond a budget', hint: 'A task or session would pass its cap', applies: 'All workers', keys: ['budget_exceeded'] },
];

export const linesToList = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export const listToLines = (list: string[]) => list.join('\n');

/** Top-level keys whose values differ (deep equality). */
export function changedKeys<T extends Record<string, unknown>>(original: T, draft: T): (keyof T)[] {
  return (Object.keys(draft) as (keyof T)[]).filter((k) => JSON.stringify(original[k]) !== JSON.stringify(draft[k]));
}
