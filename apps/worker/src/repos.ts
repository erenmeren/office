import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureMissionBranch, git, gitAuth } from './git.js';

export interface CloneOptions {
  apiUrl: string;
  credential: string;
  remotePath: string;
  reposDir: string;
  projectId: string;
  defaultBranch: string;
  missionBranch: string;
}

// one clone or fetch per clone directory at a time
const inFlight = new Map<string, Promise<string>>();

/**
 * The worker's clone of the API repository at `<reposDir>/<projectId>` (remote `office`), cloned on first use and
 * fetched on every call; the mission branch exists locally and on the API afterwards. Returns the clone dir.
 */
export async function ensureClone(opts: CloneOptions): Promise<string> {
  if (!/^[\w-]+$/.test(opts.projectId)) throw new Error(`invalid project id: ${opts.projectId}`);
  const dir = join(opts.reposDir, opts.projectId);
  const next = (inFlight.get(dir) ?? Promise.resolve(dir)).catch(() => dir).then(() => sync(dir, opts));
  inFlight.set(dir, next);
  try {
    return await next;
  } finally {
    if (inFlight.get(dir) === next) inFlight.delete(dir);
  }
}

async function sync(dir: string, o: CloneOptions): Promise<string> {
  // ws://host -> http://host, wss:// -> https://; joined like the socket URL (`${apiUrl}/ws/worker`), so a base path
  // is kept and a trailing slash is not doubled. The credential never goes into the URL.
  const url = o.apiUrl.replace(/^ws/, 'http').replace(/\/+$/, '') + o.remotePath;
  // a clone killed half-way is not a repository of its own: start over
  if (existsSync(dir) && (await git(dir, 'rev-parse', '--git-dir').catch(() => '')) !== '.git') {
    await rm(dir, { recursive: true, force: true });
  }
  if (!existsSync(dir)) {
    await mkdir(o.reposDir, { recursive: true });
    const tmp = `${dir}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    await gitAuth(o.reposDir, o.credential, 'clone', '-q', '--no-checkout', '--origin', 'office', url, tmp);
    await rename(tmp, dir);
  } else {
    // follow a changed OFFICE_API_URL
    await git(dir, 'remote', 'set-url', 'office', url);
  }
  // --update-head-ok lets fetch write run branches checked out in kept worktrees; safe because run branch names are
  // run-id-unique, only the owning run pushes them, and fetch never prunes
  await gitAuth(
    dir,
    o.credential,
    'fetch', '-q', '--update-head-ok', 'office',
    `+refs/heads/${o.defaultBranch}:refs/remotes/office/${o.defaultBranch}`,
    '+refs/heads/office/*:refs/heads/office/*',
  );
  await ensureMissionBranch(dir, o.missionBranch, o.defaultBranch, o.credential);
  return dir;
}
