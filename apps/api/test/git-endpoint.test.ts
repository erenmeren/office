import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeApp } from './helpers.js';
import { connectFakeWorker, type FakeWorker } from './fake-worker.js';

// never prompt for credentials: a 401 must fail the command, not hang it
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('git endpoint', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let tmp: string;
  let repo: string;
  let projectId: string;
  let worker: FakeWorker;
  let base: string;

  beforeEach(async () => {
    t = await makeApp();
    cookie = await t.login();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    tmp = mkdtempSync(join(tmpdir(), 'office-git-'));
    repo = join(tmp, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    projectId = (await t.prisma.project.create({ data: { name: 'G', slug: 'g', repoPath: repo } })).id;
    const res = await t.app.inject({ method: 'POST', url: '/workers', headers: { cookie }, payload: { name: 'w' } });
    worker = await connectFakeWorker(t.app, { enrollToken: res.json().enrollToken, name: 'w' });
  });
  afterEach(async () => {
    await worker.close();
    await t.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const auth = () => `Authorization: Bearer ${worker.credential}`;
  // the server runs in this process: network git commands must be async or they deadlock it
  const clone = async (dir = join(tmp, 'clone')) => {
    await run('git', ['-c', `http.extraHeader=${auth()}`, 'clone', '-q', `${base}/git/${projectId}`, dir], { env });
    git(dir, 'config', 'user.email', 'w@w');
    git(dir, 'config', 'user.name', 'w');
    return dir;
  };
  const push = (dir: string, ...args: string[]) =>
    run('git', ['-c', `http.extraHeader=${auth()}`, 'push', 'origin', ...args], { cwd: dir, env }).then(
      () => ({ status: 0, stderr: '' }),
      (e: { code: number; stderr: string }) => ({ status: e.code, stderr: e.stderr }),
    );
  const refOf = (ref: string) => {
    try {
      return git(repo, 'rev-parse', '-q', '--verify', ref);
    } catch {
      return '';
    }
  };
  const commit = (dir: string, file: string) => {
    writeFileSync(join(dir, file), file);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', file);
  };

  it('clones with a valid worker credential', async () => {
    const dir = await clone();
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
  });

  it('rejects a missing or wrong bearer with 401', async () => {
    const url = `${base}/git/${projectId}/info/refs?service=git-upload-pack`;
    const none = await fetch(url);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'worker_unauthorized' });
    expect((await fetch(url, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    // an owner cookie is not accepted here
    expect((await fetch(url, { headers: { cookie } })).status).toBe(401);
  });

  it('rejects a revoked worker with 401', async () => {
    const url = `${base}/git/${projectId}/info/refs?service=git-upload-pack`;
    const headers = { authorization: `Bearer ${worker.credential}` };
    expect((await fetch(url, { headers })).status).toBe(200);
    await t.app.inject({ method: 'DELETE', url: `/workers/${worker.workerId}`, headers: { cookie } });
    expect((await fetch(url, { headers })).status).toBe(401);
  });

  it('returns 404 for an unknown project', async () => {
    const res = await fetch(`${base}/git/nope/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${worker.credential}` },
    });
    expect(res.status).toBe(404);
  });

  it('accepts a fast-forward push to refs/heads/office/*', async () => {
    const dir = await clone();
    git(dir, 'checkout', '-qb', 'office/t-abc123');
    commit(dir, 'b.txt');
    const r = await push(dir, 'office/t-abc123');
    expect(r.status, r.stderr).toBe(0);
    expect(refOf('refs/heads/office/t-abc123')).toBe(git(dir, 'rev-parse', 'HEAD'));
    commit(dir, 'c.txt');
    expect((await push(dir, 'office/t-abc123')).status).toBe(0);
    expect(refOf('refs/heads/office/t-abc123')).toBe(git(dir, 'rev-parse', 'HEAD'));
  });

  it('rejects a push to the default branch, a delete and a tag, atomically', async () => {
    const dir = await clone();
    const main = refOf('refs/heads/main');
    commit(dir, 'b.txt');
    git(dir, 'branch', 'office/ok');
    const both = await push(dir, 'office/ok', 'main');
    expect(both.status).not.toBe(0);
    expect(both.stderr).toContain('office: rejected refs/heads/main');
    expect(refOf('refs/heads/office/ok')).toBe('');
    expect(refOf('refs/heads/main')).toBe(main);

    git(dir, 'branch', 'office/t-abc123');
    expect((await push(dir, 'office/t-abc123')).status).toBe(0);
    expect((await push(dir, ':office/t-abc123')).status).not.toBe(0);
    expect(refOf('refs/heads/office/t-abc123')).not.toBe('');

    git(dir, 'tag', 'v1');
    const tag = await push(dir, 'v1');
    expect(tag.status).not.toBe(0);
    expect(tag.stderr).toContain('office: rejected refs/tags/v1');
    expect(refOf('refs/tags/v1')).toBe('');
  });

  it('rejects a non-fast-forward of office/*', async () => {
    const dir = await clone();
    git(dir, 'checkout', '-qb', 'office/t-abc123');
    commit(dir, 'b.txt');
    expect((await push(dir, 'office/t-abc123')).status).toBe(0);
    const old = refOf('refs/heads/office/t-abc123');
    git(dir, 'commit', '-q', '--amend', '-m', 'amended');
    const forced = await push(dir, '--force', 'office/t-abc123');
    expect(forced.status).not.toBe(0);
    expect(forced.stderr).toContain('not a fast-forward');
    expect(refOf('refs/heads/office/t-abc123')).toBe(old);
  });

  it('never passes a client path to the filesystem', async () => {
    const { port } = t.app.server.address() as AddressInfo;
    const get = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${worker.credential}` } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on('error', reject);
        req.end();
      });
    for (const p of [`/git/${projectId}/../../etc/passwd`, `/git/${projectId}/objects/../../../etc/passwd`, `/git/${projectId}/config`]) {
      expect([400, 404]).toContain(await get(p));
    }
    expect(await get(`/git/${projectId}/HEAD`)).toBe(200);
    expect(readdirSync(join(t.config.dataDir, 'git-roots', projectId))).toEqual(['repo']);
  });
});
