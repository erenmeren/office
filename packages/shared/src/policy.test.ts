import { describe, expect, it } from 'vitest';
import { ApprovalPolicySchema, DEFAULT_DESTRUCTIVE_PATTERNS, DEFAULT_SENSITIVE_PATHS, evaluateToolCall } from './policy.js';
import { ProjectSettingsSchema } from './project-settings.js';

const policy = ApprovalPolicySchema.parse({});

describe('ApprovalPolicySchema', () => {
  it('defaults every mode to ask and fills pattern lists', () => {
    const p = ApprovalPolicySchema.prefault({}).parse(undefined);
    for (const k of ['plan', 'git_push', 'merge', 'deploy', 'destructive_command', 'sensitive_path', 'budget_exceeded'] as const) {
      expect(p[k]).toBe('ask');
    }
    expect(ProjectSettingsSchema.parse({}).approvalPolicy).toEqual(p);
    expect(ProjectSettingsSchema.parse({}).defaultMaxAttempts).toBe(2);
    expect(p.destructivePatterns).toEqual(DEFAULT_DESTRUCTIVE_PATTERNS);
    expect(p.sensitivePaths).toEqual(DEFAULT_SENSITIVE_PATHS);
  });
});

describe('evaluateToolCall', () => {
  it('asks for rm -rf', () => {
    expect(evaluateToolCall(policy, 'Bash', { command: 'rm -rf node_modules' })).toMatchObject({
      verdict: 'ask',
      type: 'destructive_command',
    });
  });
  it('classifies git push before destructive patterns', () => {
    expect(evaluateToolCall(policy, 'Bash', { command: 'git push origin x' })).toMatchObject({
      verdict: 'ask',
      type: 'git_push',
    });
    expect(evaluateToolCall(policy, 'Bash', { command: 'git push --force' })).toMatchObject({ type: 'git_push' });
  });
  it('catches git push behind global options or extra spaces, and spaced-out patterns', () => {
    for (const command of ['git -C /w push', 'git  push', 'git --no-pager -c x=y push origin', 'cd x &&  git\tpush']) {
      expect(evaluateToolCall(policy, 'Bash', { command })).toMatchObject({ type: 'git_push' });
    }
    expect(evaluateToolCall(policy, 'Bash', { command: 'git pushover' })).not.toMatchObject({ type: 'git_push' });
    expect(evaluateToolCall(policy, 'Bash', { command: 'git  reset   --hard' })).toMatchObject({ type: 'destructive_command' });
  });
  it('matches destructive patterns case-insensitively', () => {
    expect(evaluateToolCall(policy, 'Bash', { command: 'psql -c "drop table x"' })).toMatchObject({
      type: 'destructive_command',
    });
  });
  it('asks for sensitive paths by basename', () => {
    expect(evaluateToolCall(policy, 'Write', { file_path: '/w/app/.env.local' })).toMatchObject({
      verdict: 'ask',
      type: 'sensitive_path',
    });
    expect(evaluateToolCall(policy, 'Read', { file_path: '/w/certs/server.pem' })).toMatchObject({ type: 'sensitive_path' });
    expect(evaluateToolCall(policy, 'NotebookEdit', { notebook_path: '/w/id_rsa' })).toMatchObject({ type: 'sensitive_path' });
  });
  it('asks for Grep on a sensitive path or glob', () => {
    expect(evaluateToolCall(policy, 'Grep', { pattern: 'KEY', path: '/w/.env.local' })).toMatchObject({
      verdict: 'ask',
      type: 'sensitive_path',
    });
    expect(evaluateToolCall(policy, 'Grep', { pattern: 'KEY', path: '/w', glob: '.env*' })).toMatchObject({ type: 'sensitive_path' });
    expect(evaluateToolCall(policy, 'Grep', { pattern: 'KEY', glob: '**/.env.local' })).toMatchObject({ type: 'sensitive_path' });
    expect(evaluateToolCall(policy, 'Grep', { pattern: 'KEY', glob: '*.ts' })).toEqual({ verdict: 'allow' });
  });
  it('allows ordinary calls', () => {
    expect(evaluateToolCall(policy, 'Read', { file_path: '/w/README.md' })).toEqual({ verdict: 'allow' });
    expect(evaluateToolCall(policy, 'Bash', { command: 'ls' })).toEqual({ verdict: 'allow' });
    expect(evaluateToolCall(policy, 'Bash', {})).toEqual({ verdict: 'allow' });
    expect(evaluateToolCall(policy, 'Grep', { path: '/w/src' })).toEqual({ verdict: 'allow' });
  });
  it('honours auto and block modes', () => {
    const auto = ApprovalPolicySchema.parse({ destructive_command: 'auto' });
    expect(evaluateToolCall(auto, 'Bash', { command: 'rm -rf x' })).toEqual({ verdict: 'allow' });
    const block = ApprovalPolicySchema.parse({ destructive_command: 'block' });
    expect(evaluateToolCall(block, 'Bash', { command: 'rm -rf x' })).toMatchObject({
      verdict: 'block',
      type: 'destructive_command',
    });
  });
});
