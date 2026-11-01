import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
import { ensureClone } from '../src/repos.js';

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

describe('remote integration', () => {
  const PROJECT = '00000000-0000-0000-0000-00000000000b';
  let root: string;
  let server: string;
  let clone: string;
  let wtDir: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'office-git-remote-')));
    wtDir = join(root, 'worktrees');
    // the "API": a non-bare repo over file://
    server = join(root, 'git', PROJECT);
    mkdirSync(server, { recursive: true });
    git(server, 'init', '-q', '-b', 'main');
    commitFile(server, 'README.md', 'hi\n', 'init');
    clone = await ensureClone({
      apiUrl: `file://${root}`, credential: 'c', remotePath: `/git/${PROJECT}`, reposDir: join(root, 'repos'),
      projectId: PROJECT, defaultBranch: 'main', missionBranch: 'office/m',
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('remote fastForward pushes with force-with-lease and reports needs_integration when the server moved', async () => {
    const wt = await createWorktree(clone, wtDir, 'run-r', 'office/m', 'office/m-runs/r');
    commitFile(wt.path, 'r.txt', 'r', 'r change');
    const head = git(wt.path, 'rev-parse', 'HEAD');
    // the server moves between our fetch and our push
    const moved = await createWorktree(server, wtDir, 'run-s', 'office/m', 'office/m-runs/s');
    commitFile(moved.path, 's.txt', 's', 's change');
    expect(await fastForward(server, 'office/m', git(moved.path, 'rev-parse', 'HEAD'))).toBe('fast_forwarded');
    const serverHead = git(server, 'rev-parse', 'office/m');

    const remote = { credential: 'c', baseCommit: wt.baseCommit, runBranch: 'office/m-runs/r' };
    const reasons: string[] = [];
    expect(await fastForward(clone, 'office/m', head, remote, (r) => reasons.push(r))).toBe('needs_integration');
    // git's own rejection text reaches the caller
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/rejected|stale info|failed to push/);
    expect(git(server, 'rev-parse', 'office/m')).toBe(serverHead);
    // the run's commits stay reachable on the API side
    expect(git(server, 'rev-parse', 'refs/heads/office/m-runs/r')).toBe(head);
  });

  it('remote fastForward never pushes a rewritten history onto the mission branch', async () => {
    const first = await createWorktree(clone, wtDir, 'run-1', 'office/m', 'office/m-runs/1');
    commitFile(first.path, 'b.txt', 'b', 'b');
    const b = git(first.path, 'rev-parse', 'HEAD');
    expect(await fastForward(clone, 'office/m', b, { credential: 'c', baseCommit: first.baseCommit, runBranch: 'office/m-runs/1' })).toBe('fast_forwarded');
    // the agent resets below its base and commits again: a-c does not contain b
    const second = await createWorktree(clone, wtDir, 'run-2', 'office/m', 'office/m-runs/2');
    expect(second.baseCommit).toBe(b);
    git(second.path, 'reset', '-q', '--hard', 'HEAD~1');
    commitFile(second.path, 'c.txt', 'c', 'c');
    const c = git(second.path, 'rev-parse', 'HEAD');
    expect(await fastForward(clone, 'office/m', c, { credential: 'c', baseCommit: b, runBranch: 'office/m-runs/2' })).toBe('needs_integration');
    expect(git(server, 'rev-parse', 'office/m')).toBe(b);
  });

  it('a local update-ref CAS and a remote push CAS on the same branch admit exactly one winner', async () => {
    const local = await createWorktree(server, wtDir, 'run-local', 'office/m', 'office/m-runs/local');
    const remote = await createWorktree(clone, wtDir, 'run-remote', 'office/m', 'office/m-runs/remote');
    expect(local.baseCommit).toBe(remote.baseCommit);
    commitFile(local.path, 'l.txt', 'l', 'local change');
    commitFile(remote.path, 'r.txt', 'r', 'remote change');
    const heads = [git(local.path, 'rev-parse', 'HEAD'), git(remote.path, 'rev-parse', 'HEAD')];
    // both CAS against the one server repository at the same time
    const results = await Promise.all([
      fastForward(server, 'office/m', heads[0]!),
      fastForward(clone, 'office/m', heads[1]!, { credential: 'c', baseCommit: remote.baseCommit, runBranch: 'office/m-runs/remote' }),
    ]);
    expect([...results].sort()).toEqual(['fast_forwarded', 'needs_integration']);
    expect(git(server, 'rev-parse', 'office/m')).toBe(heads[results.indexOf('fast_forwarded')]);
  });
});
