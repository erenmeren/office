import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunSkill } from '@office/shared';
import { materializeSkills, removeRunRoot, runRoot, sweepRunRoots } from '../src/skills.js';

const skill = (name: string, files?: Record<string, string>): RunSkill => ({
  name, version: 1, checksum: 'c', mode: 'eager',
  files: files ?? { 'SKILL.md': `---\nname: ${name}\ndescription: d\n---\nbody`, 'ref/a.md': 'a' },
});

describe('skills materialization', () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'office-runs-'));
  });
  afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

  it('writes the pinned files under <runsDir>/<runId>/.office/.claude/skills/<name>/ and returns the .office dir', async () => {
    const dir = await materializeSkills(runsDir, 'run-1', [skill('tdd')]);
    expect(dir).toBe(join(runsDir, 'run-1', '.office'));
    const base = join(dir!, '.claude', 'skills', 'tdd');
    expect(readFileSync(join(base, 'ref/a.md'), 'utf8')).toBe('a');
    expect(statSync(join(base, 'SKILL.md')).mode & 0o777).toBe(0o600);
  });

  it('returns undefined and creates nothing for no skills', async () => {
    expect(await materializeSkills(runsDir, 'run-1', [])).toBeUndefined();
    expect(readdirSync(runsDir)).toEqual([]);
  });

  it('throws before writing on a hostile path or name', async () => {
    await expect(materializeSkills(runsDir, 'run-1', [skill('ok'), skill('ok2', { '../x': 'y' })])).rejects.toThrow();
    await expect(materializeSkills(runsDir, 'run-1', [skill('../evil')])).rejects.toThrow();
    expect(readdirSync(runsDir)).toEqual([]);
    expect(() => runRoot(runsDir, '../x')).toThrow();
  });

  it('sweepRunRoots removes stale roots and keeps active ones', async () => {
    mkdirSync(join(runsDir, 'a'));
    mkdirSync(join(runsDir, 'b'));
    expect(await sweepRunRoots(runsDir, ['b'])).toEqual(['a']);
    expect(existsSync(join(runsDir, 'a'))).toBe(false);
    expect(existsSync(join(runsDir, 'b'))).toBe(true);
    await removeRunRoot(runsDir, 'b');
    await removeRunRoot(runsDir, 'b');
    expect(readdirSync(runsDir)).toEqual([]);
  });
});
