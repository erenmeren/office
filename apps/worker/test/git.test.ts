import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectResult,
  createWorktree,
  ensureMissionBranch,
  fastForward,
  installTrailerHook,
  removeWorktree,
  sweepWorktrees,
} from '../src/git.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8' }).trim();
const commitFile = (cwd: string, file: string, content: string, msg: string) => {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
};

describe('git worktrees', () => {
  let root: string;
  let repo: string;
  let wtDir: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'office-git-')));
    repo = join(root, 'repo');
    wtDir = join(root, 'worktrees');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    commitFile(repo, 'README.md', 'hi\n', 'init');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates the mission branch from the default branch once', async () => {
    const base = await ensureMissionBranch(repo, 'office/m-abc123', 'main');
    expect(base).toBe(git(repo, 'rev-parse', 'main'));
    commitFile(repo, 'b.txt', 'b', 'second on main');
    // already exists: not moved to the new main head
    expect(await ensureMissionBranch(repo, 'office/m-abc123', 'main')).toBe(base);
  });

  it('runs on a run branch whose commits carry the Office-Agent trailer, then fast-forwards the mission branch', async () => {
    await ensureMissionBranch(repo, 'office/m', 'main');
    const wt = await createWorktree(repo, wtDir, 'run-12345678-x', 'office/m', 'office/m-runs/t1-run-1234');
    expect(wt.path).toBe(join(wtDir, 'run-12345678-x'));
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('office/m-runs/t1-run-1234');
    expect(wt.baseCommit).toBe(git(repo, 'rev-parse', 'office/m'));
    await installTrailerHook(wt.path, { agentName: "dev'eloper", runId: 'run-12345678-x' });
    commitFile(wt.path, 'a.txt', 'a\n', 'add a');
    commitFile(wt.path, 'c.txt', 'c\n', 'add c\n\nOffice-Agent: other run-0');
    expect(git(wt.path, 'log', '-1', '--format=%B', 'HEAD~1')).toContain("Office-Agent: dev'eloper run-12345678-x");
    // an existing trailer is left alone
    expect(git(wt.path, 'log', '-1', '--format=%B').match(/Office-Agent:/g)).toHaveLength(1);
    // the hooks dir is ignored, so `git add -A` never commits it
    expect(git(wt.path, 'status', '--porcelain')).toBe('');

    const r = await collectResult(wt.path, wt.baseCommit);
    expect(r.commits.map((c) => c.subject)).toEqual(['add c', 'add a']);
    expect(r.filesChanged).toBe(2);
    expect(r.diffStat).toContain('2 files changed');
    expect(r.headCommit).toBe(git(wt.path, 'rev-parse', 'HEAD'));

    expect(await fastForward(repo, 'office/m', r.headCommit)).toBe('fast_forwarded');
    expect(git(repo, 'rev-parse', 'office/m')).toBe(r.headCommit);
    // the main checkout is untouched
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('returns needs_integration when the mission branch moved meanwhile', async () => {
    await ensureMissionBranch(repo, 'office/m', 'main');
    const wt = await createWorktree(repo, wtDir, 'run-a', 'office/m', 'office/m-runs/a');
    const other = await createWorktree(repo, wtDir, 'run-b', 'office/m', 'office/m-runs/b');
    commitFile(other.path, 'a.txt', 'theirs', 'b change');
    expect(await fastForward(repo, 'office/m', git(other.path, 'rev-parse', 'HEAD'))).toBe('fast_forwarded');
    commitFile(wt.path, 'a.txt', 'ours', 'a change');
    const before = git(repo, 'rev-parse', 'office/m');
    expect(await fastForward(repo, 'office/m', git(wt.path, 'rev-parse', 'HEAD'))).toBe('needs_integration');
    expect(git(repo, 'rev-parse', 'office/m')).toBe(before);
  });

  it('removing a worktree deletes its run branch when fast-forwarded or empty, keeps it when it needs integration', async () => {
    await ensureMissionBranch(repo, 'office/m', 'main');
    const branches = () => git(repo, 'branch', '--list', '--format=%(refname:short)').split('\n');
    const empty = await createWorktree(repo, wtDir, 'run-e', 'office/m', 'office/m-runs/e');
    const ff = await createWorktree(repo, wtDir, 'run-f', 'office/m', 'office/m-runs/f');
    const late = await createWorktree(repo, wtDir, 'run-l', 'office/m', 'office/m-runs/l');
    commitFile(ff.path, 'f.txt', 'f', 'f change');
    expect(await fastForward(repo, 'office/m', git(ff.path, 'rev-parse', 'HEAD'))).toBe('fast_forwarded');
    commitFile(late.path, 'l.txt', 'l', 'l change');
    expect(await fastForward(repo, 'office/m', git(late.path, 'rev-parse', 'HEAD'))).toBe('needs_integration');
    for (const [wt, b] of [[empty, 'e'], [ff, 'f'], [late, 'l']] as const) {
      await removeWorktree(repo, wt.path, { run: `office/m-runs/${b}`, mission: 'office/m' });
    }
    expect(branches()).not.toContain('office/m-runs/e');
    expect(branches()).not.toContain('office/m-runs/f');
    expect(branches()).toContain('office/m-runs/l');
  });

  it('removes a worktree, and sweeps only inactive worktrees older than 7 days', async () => {
    await ensureMissionBranch(repo, 'office/m', 'main');
    const a = await createWorktree(repo, wtDir, 'run-a', 'office/m', 'office/m-runs/a');
    await removeWorktree(repo, a.path);
    expect(existsSync(a.path)).toBe(false);
    await removeWorktree(repo, a.path); // already gone: no error

    const old = await createWorktree(repo, wtDir, 'run-old', 'office/m', 'office/m-runs/old');
    const active = await createWorktree(repo, wtDir, 'run-active', 'office/m', 'office/m-runs/active');
    const fresh = await createWorktree(repo, wtDir, 'run-fresh', 'office/m', 'office/m-runs/fresh');
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    utimesSync(old.path, eightDaysAgo, eightDaysAgo);
    utimesSync(active.path, eightDaysAgo, eightDaysAgo);
    await sweepWorktrees(repo, wtDir, ['run-active']);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(active.path)).toBe(true);
    expect(existsSync(fresh.path)).toBe(true);
  });
});
