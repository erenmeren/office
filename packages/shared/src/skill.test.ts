import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, skillChecksum, skillPromptSection, validateSkillFiles } from './skill.js';

const ok = {
  'SKILL.md': '---\nname: tdd\ndescription: "Write the test first"\n---\n# TDD\n',
  'reference/a.md': 'x',
};
const md = (fm: string) => ({ 'SKILL.md': `---\n${fm}\n---\n` });
const code = (c: string) => expect.objectContaining({ code: c });

describe('validateSkillFiles', () => {
  it('accepts a valid skill and returns name and description', () => {
    expect(validateSkillFiles(ok)).toEqual({ name: 'tdd', description: 'Write the test first' });
  });
  it('rejects a missing SKILL.md', () => {
    expect(() => validateSkillFiles({ 'a.md': 'x' })).toThrowError(code('missing_skill_md'));
  });
  it.each(['../x.md', '/etc/passwd', 'a\\b.md', 'a//b.md'])('rejects path %s', (p) => {
    expect(() => validateSkillFiles({ ...ok, [p]: 'x' })).toThrowError(code('bad_path'));
  });
  it('rejects a bad name, a missing description and a name mismatch', () => {
    expect(() => validateSkillFiles(md('name: Bad Name\ndescription: d'))).toThrowError(code('bad_name'));
    expect(() => validateSkillFiles(md('name: ok'))).toThrowError(code('missing_description'));
    expect(() => validateSkillFiles(ok, 'other')).toThrowError(code('name_mismatch'));
  });
  it('rejects a file over 64 KiB', () => {
    expect(() => validateSkillFiles({ ...ok, 'big.md': 'x'.repeat(65_537) })).toThrowError(code('too_large'));
  });
  it('rejects total over 512 KiB and more than 50 files', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'x'.repeat(65_536)]));
    expect(() => validateSkillFiles({ ...ok, ...many })).toThrowError(code('too_large'));
    const files = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, 'x']));
    expect(() => validateSkillFiles({ ...ok, ...files })).toThrowError(code('too_many_files'));
  });
});

describe('skillChecksum', () => {
  it('is order independent and content sensitive', () => {
    expect(skillChecksum({ a: '1', b: '2' })).toBe(skillChecksum({ b: '2', a: '1' }));
    expect(skillChecksum({ a: '1' })).not.toBe(skillChecksum({ a: '2' }));
  });
});

describe('skillPromptSection', () => {
  it('names eager skills to invoke and lists on-demand ones', () => {
    const s = skillPromptSection([
      { name: 'a', mode: 'eager' },
      { name: 'b', mode: 'on_demand' },
    ]);
    expect(s).toContain('invoke the Skill tool for each of these skills and follow them: a.');
    expect(s).toContain('available when relevant: b.');
    expect(skillPromptSection([])).toBe('');
  });

  it('parseSkillFrontmatter reads model', () => {
    expect(parseSkillFrontmatter('---\nname: a\ndescription: b\nmodel: "haiku"\n---\n')).toEqual({ name: 'a', description: 'b', model: 'haiku' });
  });
});
