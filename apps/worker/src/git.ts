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

/** Creates `branch` from `defaultBranch` when missing; returns its head commit. */
export async function ensureMissionBranch(repoPath: string, branch: string, defaultBranch: string): Promise<string> {
  const ref = `refs/heads/${branch}`;
  // a concurrent run may create it between the check and the create; rev-parse then still answers
  if (!(await succeeds(repoPath, 'rev-parse', '--verify', '-q', ref))) {
    await git(repoPath, 'branch', branch, defaultBranch).catch(() => {});
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
  await git(repoPath, 'worktree', 'add', '-q', '--detach', path, missionBranch);
  await git(path, 'checkout', '-q', '-B', runBranch);
  return { path, baseCommit: await git(path, 'rev-parse', 'HEAD') };
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

export async function collectResult(worktreePath: string, baseCommit: string) {
  const range = `${baseCommit}..HEAD`;
  const headCommit = await git(worktreePath, 'rev-parse', 'HEAD');
  const log = await git(worktreePath, 'log', '--format=%H%x09%s', range);
  const commits = log ? log.split('\n').map((l) => ({ sha: l.slice(0, l.indexOf('\t')), subject: l.slice(l.indexOf('\t') + 1) })) : [];
  const diffStat = await git(worktreePath, 'diff', '--stat', range);
  const names = await git(worktreePath, 'diff', '--name-only', range);
  return { headCommit, commits, diffStat, filesChanged: names ? names.split('\n').length : 0 };
}

/** Moves the mission branch to `headCommit` only when that is a fast-forward of its current head. */
export async function fastForward(repoPath: string, missionBranch: string, headCommit: string): Promise<IntegrationStatus> {
  const ref = `refs/heads/${missionBranch}`;
  const current = await git(repoPath, 'rev-parse', '--verify', ref);
  if (!(await succeeds(repoPath, 'merge-base', '--is-ancestor', current, headCommit))) return 'needs_integration';
  // compare-and-swap: a concurrent fast-forward in between makes this fail instead of being overwritten
  return (await succeeds(repoPath, 'update-ref', ref, headCommit, current)) ? 'fast_forwarded' : 'needs_integration';
}

export async function removeWorktree(repoPath: string, path: string): Promise<void> {
  await git(repoPath, 'worktree', 'remove', '--force', path).catch(() => {});
  await git(repoPath, 'worktree', 'prune').catch(() => {});
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
