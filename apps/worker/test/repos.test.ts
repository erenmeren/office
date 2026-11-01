import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureMissionBranch } from '../src/git.js';
import { ensureClone } from '../src/repos.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8' }).trim();
const PROJECT = '00000000-0000-0000-0000-00000000000a';
const CRED = 'cred-s3cret-value';

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

describe('ensureClone', () => {
  let root: string;
  let server: string;
  const opts = (over: Partial<Parameters<typeof ensureClone>[0]> = {}) => ({
    apiUrl: `file://${root}`, credential: CRED, remotePath: `/git/${PROJECT}`, reposDir: join(root, 'repos'),
    projectId: PROJECT, defaultBranch: 'main', missionBranch: 'office/m', ...over,
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'office-repos-')));
    // the "API": a non-bare repo over file://, same push/fetch semantics as the HTTP endpoint
    server = join(root, 'git', PROJECT);
    mkdirSync(server, { recursive: true });
    git(server, 'init', '-q', '-b', 'main');
    writeFileSync(join(server, 'README.md'), 'hi\n');
    git(server, 'add', '-A');
    git(server, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('clones once and fetches on later calls; the credential header appears in no file under the clone', async () => {
    const dir = await ensureClone(opts());
    expect(dir).toBe(join(root, 'repos', PROJECT));
    expect(git(dir, 'remote')).toBe('office');
    expect(git(dir, 'rev-parse', 'refs/remotes/office/main')).toBe(git(server, 'rev-parse', 'main'));
    writeFileSync(join(dir, '.git', 'marker'), 'x');
    git(server, 'commit', '-q', '--allow-empty', '-m', 'second');
    expect(await ensureClone(opts())).toBe(dir);
    // not re-cloned: the marker survives, and the new server commit was fetched
    expect(readFileSync(join(dir, '.git', 'marker'), 'utf8')).toBe('x');
    expect(git(dir, 'rev-parse', 'refs/remotes/office/main')).toBe(git(server, 'rev-parse', 'main'));
    for (const f of filesUnder(dir)) {
      const text = readFileSync(f, 'latin1');
      expect(text, f).not.toContain('Bearer');
      expect(text, f).not.toContain(CRED);
    }
  });

  it('creates and publishes the mission branch, and adopts the server copy when it already exists', async () => {
    const dir = await ensureClone(opts());
    const main = git(server, 'rev-parse', 'main');
    expect(git(server, 'rev-parse', 'refs/heads/office/m')).toBe(main);
    expect(git(dir, 'rev-parse', 'refs/heads/office/m')).toBe(main);

    // created on the server after our last fetch: the local push is rejected, the server copy wins
    git(server, 'branch', 'office/m2', 'main');
    git(server, 'checkout', '-q', 'office/m2');
    git(server, 'commit', '-q', '--allow-empty', '-m', 'server side');
    git(server, 'checkout', '-q', 'main');
    const theirs = git(server, 'rev-parse', 'office/m2');
    expect(await ensureMissionBranch(dir, 'office/m2', 'main', CRED)).toBe(theirs);
    expect(git(server, 'rev-parse', 'office/m2')).toBe(theirs);

    // already on the server at the first fetch
    git(server, 'branch', 'office/m3', 'office/m2');
    await ensureClone(opts({ missionBranch: 'office/m3' }));
    expect(git(dir, 'rev-parse', 'refs/heads/office/m3')).toBe(theirs);
  });

  it('rejects a project id that is not a plain name', async () => {
    await expect(ensureClone(opts({ projectId: '../x' }))).rejects.toThrow('invalid project id');
  });
});
