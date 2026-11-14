import { describe, expect, it } from 'vitest';
import { modelChoices } from './models';

describe('modelChoices', () => {
  const offered = [{ value: 'claude-fable-5-2', label: 'Fable 5.2' }, { value: 'opus', label: 'Opus 5.5' }];
  it('offers what the worker reported', () => {
    expect(modelChoices(offered, 'opus')).toEqual(offered);
    expect(modelChoices(offered, '')).toEqual(offered);
    expect(modelChoices(undefined, '')).toEqual([]);
  });
  it('keeps a model the list no longer has, so an agent does not silently lose its choice', () => {
    expect(modelChoices(offered, 'claude-opus-4-1')).toEqual([{ value: 'claude-opus-4-1', label: 'claude-opus-4-1' }, ...offered]);
    expect(modelChoices(undefined, 'sonnet')).toEqual([{ value: 'sonnet', label: 'sonnet' }]);
  });
});
