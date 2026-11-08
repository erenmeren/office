import { describe, expect, it } from 'vitest';
import { ProjectSettingsSchema } from '@office/shared';
import { changedKeys, codexBlockedBy, commaToList, linesToList, listToLines, policyRows, validateSettingsDraft } from './settings';

describe('settings helpers', () => {
  it('converts between lines and lists', () => {
    expect(linesToList(' rm -rf \n\n git reset --hard\r\n')).toEqual(['rm -rf', 'git reset --hard']);
    expect(linesToList('')).toEqual([]);
    expect(listToLines(['a', 'b'])).toBe('a\nb');
  });

  it('reports changed top-level keys by deep equality', () => {
    const a = { x: 1, tpl: [{ name: 'A', value: '1' }], policy: { plan: 'ask', list: ['a'] } };
    const same = { x: 1, tpl: [{ name: 'A', value: '1' }], policy: { plan: 'ask', list: ['a'] } };
    expect(changedKeys(a, same)).toEqual([]);
    expect(changedKeys(a, { ...same, x: 2, policy: { plan: 'auto', list: ['a'] } })).toEqual(['x', 'policy']);
    expect(changedKeys(a, { ...same, tpl: [] })).toEqual(['tpl']);
  });

  it('validates numbers and env names', () => {
    const ok = ProjectSettingsSchema.parse({});
    expect(validateSettingsDraft(ok)).toEqual([]);
    const bad = { ...ok, maxConcurrentRuns: 0, defaultMaxAttempts: 1.5, dailyBudgetUsd: NaN, envTemplate: [{ name: 'OK_1', value: '' }, { name: 'bad name', value: '' }] };
    expect(validateSettingsDraft(bad).map((p) => p.field)).toEqual(['maxConcurrentRuns', 'defaultMaxAttempts', 'dailyBudgetUsd', 'envTemplate.1']);
  });

  it('validates required worker tags', () => {
    const ok = ProjectSettingsSchema.parse({});
    expect(commaToList(' gpu, remote,, ')).toEqual(['gpu', 'remote']);
    expect(validateSettingsDraft({ ...ok, requiredWorkerTags: commaToList('gpu, remote') })).toEqual([]);
    expect(validateSettingsDraft({ ...ok, requiredWorkerTags: commaToList('GPU') })).toEqual([
      { field: 'requiredWorkerTags', message: 'tags are lowercase letters, digits and dashes' },
    ]);
  });

  it('defines the six policy rows, git push and merge together', () => {
    expect(policyRows.map((r) => r.keys)).toEqual([['plan'], ['destructive_command'], ['deploy'], ['git_push', 'merge'], ['sensitive_path'], ['budget_exceeded']]);
  });

  it('names the policies that make the project refuse Codex, only when Codex is in use', () => {
    const s = ProjectSettingsSchema.parse({});
    expect(codexBlockedBy(s, true)).toBeUndefined(); // auto everywhere
    const gated = { ...s, approvalPolicy: { ...s.approvalPolicy, destructive_command: 'ask' as const, sensitive_path: 'block' as const } };
    expect(codexBlockedBy(gated, false)).toBeUndefined();
    expect(codexBlockedBy(gated, true)).toBe('destructive command and sensitive path');
    expect(codexBlockedBy({ ...gated, routing: [{ runtime: 'codex' }] }, false)).toBe('destructive command and sensitive path');
  });
});
