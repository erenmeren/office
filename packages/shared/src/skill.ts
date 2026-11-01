import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SkillFilesSchema = z.record(z.string(), z.string());
export type SkillFiles = z.infer<typeof SkillFilesSchema>;

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_FILE_MAX_BYTES = 65_536;
export const SKILL_TOTAL_MAX_BYTES = 524_288;
export const SKILL_MAX_FILES = 50;

export const SkillModeSchema = z.enum(['eager', 'on_demand']);
export type SkillMode = z.infer<typeof SkillModeSchema>;
export const SkillStatusSchema = z.enum(['pending_review', 'approved', 'rejected']);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;
export const SkillSourceSchema = z.enum(['local', 'git', 'ui']);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const RunSkillSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  checksum: z.string(),
  mode: SkillModeSchema,
  files: SkillFilesSchema,
});
export type RunSkill = z.infer<typeof RunSkillSchema>;

export function parseSkillFrontmatter(markdown: string): { name?: string; description?: string; model?: string } {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end < 0) return {};
  const out: { name?: string; description?: string; model?: string } = {};
  for (const line of lines.slice(1, end)) {
    const m = /^(name|description|model):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1] as 'name' | 'description' | 'model'] = m[2]!.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

export class SkillValidationError extends Error {
  constructor(
    public readonly code:
      | 'missing_skill_md'
      | 'bad_path'
      | 'bad_name'
      | 'missing_description'
      | 'name_mismatch'
      | 'too_large'
      | 'too_many_files',
    message: string,
  ) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

export function validateSkillFiles(
  files: SkillFiles,
  expectedName?: string,
): { name: string; description: string } {
  const paths = Object.keys(files);
  if (!('SKILL.md' in files)) throw new SkillValidationError('missing_skill_md', 'SKILL.md is required');
  for (const p of paths) {
    if (p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '' || s === '..')) {
      throw new SkillValidationError('bad_path', `invalid path: ${p}`);
    }
  }
  if (paths.length > SKILL_MAX_FILES) {
    throw new SkillValidationError('too_many_files', `more than ${SKILL_MAX_FILES} files`);
  }
  let total = 0;
  for (const p of paths) {
    const n = bytes(files[p]!);
    if (n > SKILL_FILE_MAX_BYTES) throw new SkillValidationError('too_large', `${p} exceeds ${SKILL_FILE_MAX_BYTES} bytes`);
    total += n;
  }
  if (total > SKILL_TOTAL_MAX_BYTES) {
    throw new SkillValidationError('too_large', `skill exceeds ${SKILL_TOTAL_MAX_BYTES} bytes`);
  }
  const { name, description } = parseSkillFrontmatter(files['SKILL.md']!);
  if (!name || !SKILL_NAME_RE.test(name)) throw new SkillValidationError('bad_name', `invalid skill name: ${name ?? ''}`);
  if (!description) throw new SkillValidationError('missing_description', 'description is required');
  if (expectedName !== undefined && expectedName !== name) {
    throw new SkillValidationError('name_mismatch', `expected ${expectedName}, got ${name}`);
  }
  return { name, description };
}

export function skillChecksum(files: SkillFiles): string {
  const h = createHash('sha256');
  for (const p of Object.keys(files).sort()) h.update(`${p}\0${files[p]}\0`);
  return h.digest('hex');
}

export function skillPromptSection(skills: Pick<RunSkill, 'name' | 'mode'>[]): string {
  const names = (mode: SkillMode) => skills.filter((s) => s.mode === mode).map((s) => s.name).join(', ');
  const eager = names('eager');
  const lazy = names('on_demand');
  return [
    eager && `Before doing anything else, invoke the Skill tool for each of these skills and follow them: ${eager}.`,
    lazy && `These skills are available when relevant: ${lazy}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
