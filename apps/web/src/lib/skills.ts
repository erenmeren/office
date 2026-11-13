import { ApiError } from './api';
import type { Skill } from './queries';

/** Source words from the Skill Library artboard. */
export const skillSourceLabel = (source: Skill['source']): string =>
  source === 'ui' ? 'Created here' : source === 'local' ? 'Local folder' : 'Git';

/**
 * Who a skill comes from, read off where it was taken from: the Claude plugin that ships it, the owner's Claude skills
 * folder, the Git repository, or the owner for one written here. A folder elsewhere names nobody.
 */
export function skillBy(s: Pick<Skill, 'source' | 'sourceRef'>): string {
  if (s.source === 'ui') return 'You';
  const ref = s.sourceRef ?? '';
  if (s.source === 'git') return /^\w+:\/\/[^/]+\/([^#]+?)(?:\.git)?#/.exec(ref)?.[1] ?? '—';
  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/…
  const plugin = /\/\.claude\/plugins\/cache\/[^/]+\/([^/]+)\//.exec(ref)?.[1];
  return plugin ?? (/\/\.claude\/skills\//.test(ref) ? 'Your Claude skills' : '—');
}

/** The API's `{ error, message }` body, or the thrown error's text. */
export function skillErrorText(err: unknown): string {
  const b = err instanceof ApiError ? (err.body as { error?: string; code?: string; message?: string } | undefined) : undefined;
  if (!b?.error) return String(err);
  if (b.error === 'invalid_skill') return `${b.code}: ${b.message}`;
  return b.message ? `${b.error}: ${b.message}` : b.error;
}

/** Sets, replaces or removes (model '') the `model:` line of a SKILL.md frontmatter; text without frontmatter is returned unchanged. */
export function withFrontmatterModel(text: string, model: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text;
  const end = lines.indexOf('---', 1);
  if (end < 0) return text;
  const body = lines.slice(1, end).filter((l) => !/^model:/.test(l));
  if (model) body.push(`model: ${model}`);
  return [lines[0], ...body, ...lines.slice(end)].join('\n');
}

/** The `model:` frontmatter value, '' when absent. */
export function frontmatterModel(text: string): string {
  const m = /^model:\s*(.*?)\s*$/m.exec(text.split('\n---')[0] ?? '');
  return m?.[1]?.replace(/^(["'])(.*)\1$/, '$2') ?? '';
}
