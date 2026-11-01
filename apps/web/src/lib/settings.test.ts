import { describe, expect, it } from 'vitest';
import { changedKeys, linesToList, listToLines, policyRows } from './settings';

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

  it('defines the six policy rows, git push and merge together', () => {
    expect(policyRows.map((r) => r.keys)).toEqual([['plan'], ['destructive_command'], ['deploy'], ['git_push', 'merge'], ['sensitive_path'], ['budget_exceeded']]);
  });
});
