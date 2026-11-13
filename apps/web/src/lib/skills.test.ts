import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { frontmatterModel, skillBy, skillErrorText, skillSourceLabel, withFrontmatterModel } from './skills';

describe('skills helpers', () => {
  it('labels sources as on the artboard', () => {
    expect(['ui', 'local', 'git'].map((s) => skillSourceLabel(s as 'ui'))).toEqual(['Created here', 'Local folder', 'Git']);
  });
  it('names who a skill comes from: the Claude plugin, the Claude skills folder, the repository, or the owner', () => {
    const by = (source: string, sourceRef: string | null) => skillBy({ source: source as 'ui', sourceRef });
    expect(by('local', '/home/o/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/brainstorming')).toBe('superpowers');
    expect(by('local', '/home/o/.claude/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/2.13.0/.claude/skills/design')).toBe('ui-ux-pro-max');
    expect(by('local', '/home/o/.claude/skills/graphify')).toBe('Your Claude skills');
    expect(by('local', '/srv/skills/x')).toBe('—');
    expect(by('git', 'https://github.com/vercel-labs/skills#HEAD:skills/find-skills')).toBe('vercel-labs/skills');
    expect(by('git', 'https://example.com/a/b.git#main:.')).toBe('a/b');
    expect(by('ui', null)).toBe('You');
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
