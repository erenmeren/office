import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SKILL_NAME_RE, validateSkillFiles, type RunSkill } from '@office/shared';

export function runRoot(runsDir: string, runId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new Error(`invalid run id: ${runId}`);
  return join(runsDir, runId);
}

/** Writes pinned skills to `<runRoot>/.office/.claude/skills/<name>/`; returns `<runRoot>/.office` (the `additionalDirectories` entry). */
export async function materializeSkills(runsDir: string, runId: string, skills: RunSkill[]): Promise<string | undefined> {
  if (skills.length === 0) return undefined;
  const root = runRoot(runsDir, runId);
  // validate everything first so a hostile skill leaves nothing on disk
  for (const s of skills) {
    if (!SKILL_NAME_RE.test(s.name)) throw new Error(`invalid skill name: ${s.name}`);
    validateSkillFiles(s.files, s.name);
  }
  const office = join(root, '.office');
  for (const s of skills) {
    const base = join(office, '.claude', 'skills', s.name);
    for (const [path, content] of Object.entries(s.files)) {
      const file = join(base, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, { mode: 0o600 });
    }
  }
  return office;
}

export async function removeRunRoot(runsDir: string, runId: string): Promise<void> {
  await rm(runRoot(runsDir, runId), { recursive: true, force: true });
}

export async function sweepRunRoots(runsDir: string, keep: string[]): Promise<string[]> {
  await mkdir(runsDir, { recursive: true });
  const removed: string[] = [];
  for (const name of await readdir(runsDir)) {
    if (keep.includes(name)) continue;
    await rm(join(runsDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
