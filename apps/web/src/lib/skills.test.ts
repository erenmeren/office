import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { frontmatterModel, skillErrorText, skillSourceLabel, withFrontmatterModel } from './skills';

describe('skills helpers', () => {
  it('labels sources as on the artboard', () => {
    expect(['ui', 'local', 'git'].map((s) => skillSourceLabel(s as 'ui'))).toEqual(['Created here', 'Local folder', 'Git']);
  });
  it('formats API errors with their message', () => {
    expect(skillErrorText(new ApiError(409, { error: 'skill_pinned', message: 'pinned by dev' }))).toBe('skill_pinned: pinned by dev');
    expect(skillErrorText(new ApiError(400, { error: 'invalid_skill', code: 'bad_name', message: 'x' }))).toBe('bad_name: x');
    expect(skillErrorText(new Error('boom'))).toBe('Error: boom');
  });
  it('sets, replaces and removes the model line of the frontmatter', () => {
    const md = '---\nname: a\ndescription: b\n---\n# A\n';
    const withModel = withFrontmatterModel(md, 'haiku');
    expect(withModel).toBe('---\nname: a\ndescription: b\nmodel: haiku\n---\n# A\n');
    expect(frontmatterModel(withModel)).toBe('haiku');
    expect(withFrontmatterModel(withModel, 'opus')).toBe('---\nname: a\ndescription: b\nmodel: opus\n---\n# A\n');
    expect(withFrontmatterModel(withModel, '')).toBe(md);
    expect(frontmatterModel(md)).toBe('');
    expect(withFrontmatterModel('no frontmatter', 'haiku')).toBe('no frontmatter');
  });
});
