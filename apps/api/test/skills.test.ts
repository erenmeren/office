import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

const md = (name: string, body = 'body') => `---\nname: ${name}\ndescription: does ${name}\n---\n${body}\n`;

describe('skills', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let root: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'skill-roots-')));
    process.env.OFFICE_SKILL_IMPORT_ROOTS = root;
    process.env.OFFICE_DATA_DIR = await mkdtemp(join(tmpdir(), 'skill-data-'));
    t = await makeApp();
    cookie = await t.login();
  });
  afterAll(() => t.close());

  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  it('creates a UI skill as approved, versions it, and dedups identical content', async () => {
    const files = { 'SKILL.md': md('ui-skill') };
    const created = await req('POST', '/skills', { name: 'ui-skill', files });
    expect(created.statusCode).toBe(201);
    const skill = created.json();
    expect(skill).toMatchObject({ name: 'ui-skill', source: 'ui', status: 'approved' });
    expect(skill.currentVersion.version).toBe(1);

    const v2 = await req('POST', `/skills/${skill.id}/versions`, { files: { 'SKILL.md': md('ui-skill', 'changed') } });
    expect(v2.statusCode).toBe(201);
    expect(v2.json().version).toBe(2);
    const same = await req('POST', `/skills/${skill.id}/versions`, { files: { 'SKILL.md': md('ui-skill', 'changed') } });
    expect(same.statusCode).toBe(200);
    expect(same.json().version).toBe(2);

    const got = (await req('GET', `/skills/${skill.id}`)).json();
    expect(got.versions).toHaveLength(2);
    expect(got.currentVersion.files['SKILL.md']).toContain('changed');
    const old = (await req('GET', `/skills/${skill.id}/versions/1`)).json();
    expect(old.files['SKILL.md']).toBe(files['SKILL.md']);
    expect((await req('POST', '/skills', { name: 'ui-skill', files })).statusCode).toBe(409);
  });

  it('imports a local directory as pending_review and refuses paths outside the import roots', async () => {
    const dir = join(root, 'local-skill');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), md('local-skill'));
    await writeFile(join(dir, 'sub', 'a.md'), 'a');
    const ok = await req('POST', '/skills/import', { source: 'local', path: dir });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ name: 'local-skill', source: 'local', status: 'pending_review' });
    const v = (await req('GET', `/skills/${ok.json().id}`)).json();
    expect(Object.keys(v.currentVersion.files).sort()).toEqual(['SKILL.md', 'sub/a.md']);

    const elsewhere = await mkdtemp(join(tmpdir(), 'elsewhere-'));
    await writeFile(join(elsewhere, 'SKILL.md'), md('elsewhere'));
    const bad = await req('POST', '/skills/import', { source: 'local', path: elsewhere });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('path_outside_import_roots');
  });

  it('imports from a git repository', async () => {
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'skills/git-skill'), { recursive: true });
    await writeFile(join(repo, 'skills/git-skill/SKILL.md'), md('git-skill'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo });
    const res = await req('POST', '/skills/import', { source: 'git', url: `file://${repo}`, path: 'skills/git-skill' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'git-skill', source: 'git', status: 'pending_review' });
    expect(res.json().sourceRef.endsWith(':skills/git-skill')).toBe(true);
  });

  it('rejects hostile file paths and bad frontmatter with 400 invalid_skill and writes nothing', async () => {
    const before = await t.prisma.skill.count();
    const a = await req('POST', '/skills', { files: { 'SKILL.md': md('x'), '../x.md': 'x' } });
    expect(a.statusCode).toBe(400);
    expect(a.json()).toMatchObject({ error: 'invalid_skill', code: 'bad_path' });
    const b = await req('POST', '/skills', { files: { 'SKILL.md': md('Bad Name') } });
    expect(b.json()).toMatchObject({ error: 'invalid_skill', code: 'bad_name' });
    expect(await t.prisma.skill.count()).toBe(before);
  });

  it('approve and reject flip status; GET /skills hides files', async () => {
    const dir = join(root, 'flip-skill');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), md('flip-skill'));
    const { id } = (await req('POST', '/skills/import', { source: 'local', path: dir })).json();
    expect((await req('POST', `/skills/${id}/approve`)).json().status).toBe('approved');
    expect((await req('POST', `/skills/${id}/approve`)).statusCode).toBe(200);
    expect((await req('POST', `/skills/${id}/reject`)).json().status).toBe('rejected');
    const list = (await req('GET', '/skills')).json();
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s.currentVersion.files).toBeUndefined();
      expect(s.currentVersion.checksum).toBeTruthy();
    }
    expect((await req('POST', '/skills/nope/approve')).statusCode).toBe(404);
  });

  it('rejects http:// and ssh git urls with 400', async () => {
    for (const url of ['http://example.com/r.git', 'ssh://git@example.com/r.git', 'git@example.com:r.git', `file:///etc`]) {
      const res = await req('POST', '/skills/import', { source: 'git', url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_git_url');
    }
  });
});
