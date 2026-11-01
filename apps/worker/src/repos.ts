import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureMissionBranch, gitAuth } from './git.js';

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
  if (!existsSync(dir)) {
    await mkdir(o.reposDir, { recursive: true });
    // ws://host -> http://host, wss:// -> https://; the credential never goes into the URL
    const url = o.apiUrl.replace(/^ws/, 'http') + o.remotePath;
    await gitAuth(o.reposDir, o.credential, 'clone', '-q', '--no-checkout', '--origin', 'office', url, dir);
  }
  // --update-head-ok: run branches the API mirrors back may be checked out in a kept worktree; only that run pushes them
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
