import { execFile as execFileCb } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { IntegrationStatus } from '@office/shared';

const execFile = promisify(execFileCb);
const SWEEP_AGE_MS = 7 * 86_400_000;

/** Runs git without a shell; returns trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

const succeeds = (cwd: string, ...args: string[]) => git(cwd, ...args).then(() => true, () => false);

/**
 * git against the API remote: the worker credential goes in as `http.extraHeader` through the environment,
 * so it is never in argv (`ps`), the URL (stderr) or a file. No prompts.
 */
export async function gitAuth(cwd: string, credential: string, ...args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential}`,
  };
  const { stdout } = await execFile('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Push context for a clone of the API repository (remote `office`). */
export interface RemoteAuth {
  credential: string;
  // the worktree's recorded base: the mission head the run started from
  baseCommit: string;
  runBranch: string;
}

/**
 * Creates `branch` from `defaultBranch` when missing; returns its head commit.
 * With `credential` (a clone): created from `office/<defaultBranch>` and pushed; if the API already has it, its copy wins.
 */
export async function ensureMissionBranch(repoPath: string, branch: string, defaultBranch: string, credential?: string): Promise<string> {
  const ref = `refs/heads/${branch}`;
  // a concurrent run may create it between the check and the create; rev-parse then still answers
  if (!(await succeeds(repoPath, 'rev-parse', '--verify', '-q', ref))) {
    if (credential === undefined) {
      // a project created with the form's default while the repository uses master, say: name the fix, not "Needed a single revision"
      if (!(await succeeds(repoPath, 'rev-parse', '--verify', '-q', `refs/heads/${defaultBranch}`))) {
        const branches = (await git(repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').catch(() => '')).trim().split('\n').filter(Boolean);
        throw new Error(`default branch "${defaultBranch}" does not exist in ${repoPath} (branches: ${branches.join(', ') || 'none'}); set the project's default branch in Settings`);
      }
      await git(repoPath, 'branch', branch, defaultBranch);
    } else {
      await git(repoPath, 'branch', branch, `refs/remotes/office/${defaultBranch}`);
      await gitAuth(repoPath, credential, 'push', '-q', 'office', `${ref}:${ref}`)
        .catch(() => gitAuth(repoPath, credential, 'fetch', '-q', 'office', `+${ref}:${ref}`))
        .catch(async (err) => {
          // unpublished: drop the local branch so the next run creates and publishes it again
          await git(repoPath, 'branch', '-D', branch).catch(() => {});
          throw err;
        });
    }
  }
  return git(repoPath, 'rev-parse', '--verify', ref);
}

/** Detached worktree at the mission head, then a run branch, so a failed run never moves the mission branch. */
export async function createWorktree(
  repoPath: string,
  worktreesDir: string,
  runId: string,
  missionBranch: string,
  runBranch: string,
): Promise<{ path: string; baseCommit: string }> {
  await mkdir(worktreesDir, { recursive: true });
  const path = join(worktreesDir, runId);
  try {
    await git(repoPath, 'worktree', 'add', '-q', '--detach', path, missionBranch);
    await git(path, 'checkout', '-q', '-B', runBranch);
    return { path, baseCommit: await git(path, 'rev-parse', 'HEAD') };
  } catch (err) {
    // a half-made worktree would block the retry of this run id
    await removeWorktree(repoPath, path);
    throw err;
  }
}

/** Adds `line` to the worktree's info/exclude unless present. */
export async function excludeFromGit(worktreePath: string, line: string): Promise<void> {
  const file = resolve(worktreePath, await git(worktreePath, 'rev-parse', '--git-path', 'info/exclude'));
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').includes(line)) return;
  await mkdir(resolve(file, '..'), { recursive: true });
  await appendFile(file, (current && !current.endsWith('\n') ? '\n' : '') + line + '\n');
}

const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Worktree-local prepare-commit-msg hook that adds `Office-Agent: <agentName> <runId>` when missing. */
export async function installTrailerHook(worktreePath: string, who: { agentName: string; runId: string }): Promise<void> {
  const hooksDir = join(worktreePath, '.office-hooks');
  await mkdir(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'prepare-commit-msg');
  const trailer = shQuote(`Office-Agent: ${who.agentName} ${who.runId}`);
  await writeFile(
    hook,
    `#!/bin/sh\ngrep -q '^Office-Agent:' "$1" || git interpret-trailers --in-place --trailer ${trailer} "$1"\n`,
  );
  await chmod(hook, 0o755);
  // written to the shared repo config, so only when not already set
  const enabled = await git(worktreePath, 'config', '--get', 'extensions.worktreeConfig').catch(() => '');
  if (enabled !== 'true') await git(worktreePath, 'config', 'extensions.worktreeConfig', 'true');
  await git(worktreePath, 'config', '--worktree', 'core.hooksPath', hooksDir);
  await excludeFromGit(worktreePath, '/.office-hooks/');
}

export type GitIdentity = { name: string; email: string };
const identity = (who: GitIdentity) => ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`];

/**
 * Commits whatever the run left uncommitted (changed and new files), so finished work is never lost when the agent
 * forgets `git commit`. Returns false when there was nothing to commit.
 */
export async function commitLeftovers(worktreePath: string, who: GitIdentity, message: string): Promise<boolean> {
  // shortcut: build output is excluded by these names when the project has no .gitignore yet; extend when a project needs more
  await git(worktreePath, 'add', '-A', '--', '.', ':!node_modules', ':!dist', ':!build', ':!.next', ':!coverage', ':!out');
  if (await succeeds(worktreePath, 'diff', '--cached', '--quiet')) return false;
  await git(worktreePath, ...identity(who), 'commit', '-q', '-m', message);
  return true;
}

/**
 * Rebases the run branch onto `target` (the mission head) when the mission moved under it, so parallel tasks that
 * touch different files still fast-forward. A conflict aborts the rebase and leaves the branch as it was.
 */
export async function rebaseOnto(worktreePath: string, target: string, who: GitIdentity): Promise<{ ok: true; base: string } | { ok: false; reason: string }> {
  const base = await git(worktreePath, 'rev-parse', '--verify', `${target}^{commit}`);
  if (await succeeds(worktreePath, 'merge-base', '--is-ancestor', base, 'HEAD')) return { ok: true, base };
  try {
    await git(worktreePath, ...identity(who), 'rebase', '-q', base);
    return { ok: true, base };
  } catch (err) {
    await git(worktreePath, 'rebase', '--abort').catch(() => {});
    const detail = String((err as { stderr?: string; message?: string }).stderr || (err as Error).message || '').trim().slice(0, 500);
    return { ok: false, reason: `rebase onto the mission head ${base.slice(0, 7)} conflicts; integrate by hand. ${detail}` };
  }
}

export async function collectResult(worktreePath: string, baseCommit: string) {
  const range = `${baseCommit}..HEAD`;
  const headCommit = await git(worktreePath, 'rev-parse', 'HEAD');
  const log = await git(worktreePath, 'log', '--format=%H%x09%s', range);
  const commits = log ? log.split('\n').map((l) => ({ sha: l.slice(0, l.indexOf('\t')), subject: l.slice(l.indexOf('\t') + 1) })) : [];
  const diffStat = await git(worktreePath, 'diff', '--stat', range);
  const names = await git(worktreePath, 'diff', '--name-only', range);
  return { headCommit, commits, diffStat, filesChanged: names ? names.split('\n').length : 0 };
}

/**
 * Moves the mission branch to `headCommit` only when that is a fast-forward of its current head.
 * With `remote` (a clone) the CAS is a push to the API leased on the run's base commit; the run branch is pushed
 * first so a needs_integration run keeps its commits reachable on the API side. A rejected lease push reports
 * git's stderr through `onRejected`.
 */
export async function fastForward(
  repoPath: string,
  missionBranch: string,
  headCommit: string,
  remote?: RemoteAuth,
  onRejected?: (reason: string) => void,
): Promise<IntegrationStatus> {
  const ref = `refs/heads/${missionBranch}`;
  if (remote) {
    const run = `refs/heads/${remote.runBranch}`;
    await gitAuth(repoPath, remote.credential, 'push', '-q', 'office', `${run}:${run}`);
    // the lease implies force: a rewritten history (amend, reset) must never reach the mission branch
    if (!(await succeeds(repoPath, 'merge-base', '--is-ancestor', remote.baseCommit, headCommit))) return 'needs_integration';
    let stderr = '';
    const pushed = await gitAuth(repoPath, remote.credential, 'push', '-q', 'office', `${headCommit}:${ref}`, `--force-with-lease=${ref}:${remote.baseCommit}`).then(
      () => true,
      (err: { stderr?: string; message?: string }) => {
        stderr = String(err.stderr || err.message || '').trim().slice(0, 2000);
        // the server may have applied the push and the response got lost
        return gitAuth(repoPath, remote.credential, 'ls-remote', 'office', ref).then((out) => out.split('\t')[0] === headCommit, () => false);
      },
    );
    if (!pushed) {
      onRejected?.(stderr || 'push to the mission branch was rejected');
      return 'needs_integration';
    }
    // mirror the API locally, so removeWorktree sees the run branch as integrated; a late update never moves it back
    await git(repoPath, 'update-ref', ref, headCommit, remote.baseCommit).catch(() => {});
    return 'fast_forwarded';
  }
  const current = await git(repoPath, 'rev-parse', '--verify', ref);
  if (!(await succeeds(repoPath, 'merge-base', '--is-ancestor', current, headCommit))) return 'needs_integration';
  // compare-and-swap: a concurrent fast-forward in between makes this fail instead of being overwritten
  return (await succeeds(repoPath, 'update-ref', ref, headCommit, current)) ? 'fast_forwarded' : 'needs_integration';
}

/**
 * Removes the worktree; with `branches`, also deletes the run branch when the mission branch contains it
 * (fast-forwarded, or no commits of its own). A needs_integration branch is kept for manual integration.
 */
export async function removeWorktree(repoPath: string, path: string, branches?: { run: string; mission: string }): Promise<void> {
  await git(repoPath, 'worktree', 'remove', '--force', path).catch(() => {});
  await git(repoPath, 'worktree', 'prune').catch(() => {});
  if (branches && (await succeeds(repoPath, 'merge-base', '--is-ancestor', `refs/heads/${branches.run}`, `refs/heads/${branches.mission}`))) {
    await git(repoPath, 'branch', '-D', branches.run).catch(() => {});
  }
}

/** Removes this repo's worktrees under `worktreesDir` that belong to no active run and are older than 7 days. */
export async function sweepWorktrees(repoPath: string, worktreesDir: string, activeRunIds: string[]): Promise<void> {
  const root = resolve(worktreesDir) + '/';
  const list = await git(repoPath, 'worktree', 'list', '--porcelain');
  const paths = list.split('\n').flatMap((l) => (l.startsWith('worktree ') ? [l.slice(9)] : []));
  for (const path of paths) {
    if (!path.startsWith(root) || activeRunIds.includes(path.slice(root.length))) continue;
    const mtime = await stat(path).then((s) => s.mtimeMs, () => 0);
    if (Date.now() - mtime > SWEEP_AGE_MS) await removeWorktree(repoPath, path);
  }
}
