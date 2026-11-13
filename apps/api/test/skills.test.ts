import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  const req = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd });
  const makeRepo = async (name: string, skill: string, body?: string) => {
    const repo = join(root, name);
    await mkdir(join(repo, 'skills', skill), { recursive: true });
    await writeFile(join(repo, 'skills', skill, 'SKILL.md'), md(skill, body));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    return repo;
  };
  afterEach(() => vi.unstubAllGlobals());

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

  it('reports the git failure cause with 400 git_clone_failed', async () => {
    const notRepo = join(root, 'not-a-repo');
    await mkdir(notRepo, { recursive: true });
    const res = await req('POST', '/skills/import', { source: 'git', url: `file://${notRepo}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('git_clone_failed');
    expect(res.json().message).toBeTruthy();
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
    expect((await req('POST', `/skills/${id}/disable`)).statusCode).toBe(200);
    expect((await req('POST', `/skills/${id}/disable`)).statusCode).toBe(409);
    expect((await req('GET', `/skills/${id}`)).json().status).toBe('disabled');
    expect((await req('POST', `/skills/${id}/enable`)).json().status).toBe('approved');
    expect((await req('POST', `/skills/${id}/reject`)).json().status).toBe('rejected');
    const list = (await req('GET', '/skills')).json();
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s.currentVersion.files).toBeUndefined();
      expect(s.currentVersion.checksum).toBeTruthy();
    }
    expect((await req('POST', '/skills/nope/approve')).statusCode).toBe(404);
  });

  it('lists skills by name, not in the order they were added, and word by word whatever the database collation', async () => {
    const added = ['zz-last', 'aab', 'aa-first'];
    for (const name of added) expect((await req('POST', '/skills', { name, files: { 'SKILL.md': md(name) } })).statusCode).toBe(201);
    const names = ((await req('GET', '/skills')).json() as { name: string }[]).map((s) => s.name);
    // an en_US database would put `aab` before `aa-first` (it skips the hyphen); a C one would not
    expect(names.filter((n) => added.includes(n))).toEqual(['aa-first', 'aab', 'zz-last']);
  });

  it('rejects http:// and ssh git urls with 400', async () => {
    for (const url of ['http://example.com/r.git', 'ssh://git@example.com/r.git', 'git@example.com:r.git', `file:///etc`]) {
      const res = await req('POST', '/skills/import', { source: 'git', url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_git_url');
    }
  });

  it('imports from git by frontmatter name, and refuses a bad market id', async () => {
    const repo = await makeRepo('repo-by-name', 'named-skill');
    const res = await req('POST', '/skills/import', { source: 'git', url: `file://${repo}`, name: 'named-skill' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'named-skill', source: 'git', sourceRef: `file://${repo}#HEAD:skills/named-skill` });
    const missing = await req('POST', '/skills/import', { source: 'git', url: `file://${repo}`, name: 'nope' });
    expect([missing.statusCode, missing.json().error]).toEqual([400, 'market_skill_not_found']);
    const bad = await req('POST', '/skills/import', { source: 'market', id: 'not-an-id' });
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'bad_market_id']);
  });

  it('proxies the marketplace search and reports 502 when skills.sh is down', async () => {
    const hit = { id: 'o/r/s', source: 'o/r', skillId: 's', name: 's', installs: 5, extra: 'dropped' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ skills: [hit] }), { status: 200 })));
    const res = await req('GET', '/skills/market?q=react');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skills: [{ id: 'o/r/s', source: 'o/r', skillId: 's', name: 's', installs: 5 }] });
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe('https://skills.sh/api/search?q=react');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const down = await req('GET', '/skills/market?q=react');
    expect([down.statusCode, down.json().error]).toEqual([502, 'market_unavailable']);
    expect((await req('GET', '/skills/market')).statusCode).toBe(400);
  });

  it('updates a git skill from its source and refuses to update a UI skill', async () => {
    const repo = await makeRepo('repo-upd', 'upd-skill');
    const skill = (await req('POST', '/skills/import', { source: 'git', url: `file://${repo}`, path: 'skills/upd-skill' })).json();
    const same = await req('POST', `/skills/${skill.id}/update`);
    expect([same.statusCode, same.json().created]).toEqual([200, false]);
    await writeFile(join(repo, 'skills/upd-skill/SKILL.md'), md('upd-skill', 'v2 body'));
    git(repo, 'commit', '-qam', 'v2');
    const upd = await req('POST', `/skills/${skill.id}/update`);
    expect([upd.statusCode, upd.json().created, upd.json().version.version]).toEqual([201, true, 2]);
    expect((await req('GET', `/skills/${skill.id}`)).json().currentVersion.files['SKILL.md']).toContain('v2 body');
    const ui = (await req('POST', '/skills', { name: 'ui-fixed', files: { 'SKILL.md': md('ui-fixed') } })).json();
    const no = await req('POST', `/skills/${ui.id}/update`);
    expect([no.statusCode, no.json().error]).toEqual([400, 'not_updatable']);
  });

  it('lists model and usedBy, deletes an unpinned skill, and refuses to delete a pinned one', async () => {
    const files = { 'SKILL.md': `---\nname: pinned-skill\ndescription: d\nmodel: haiku\n---\nbody\n` };
    const pinned = (await req('POST', '/skills', { name: 'pinned-skill', files })).json();
    const loose = (await req('POST', '/skills', { name: 'loose-skill', files: { 'SKILL.md': md('loose-skill') } })).json();
    const agent = await req('POST', '/agents', {
      name: 'pinner', slug: 'pinner', role: 'dev',
      config: { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'], skills: [{ skillId: pinned.id }] },
    });
    expect(agent.statusCode).toBe(201);
    const list = (await req('GET', '/skills')).json() as { id: string; model: string | null; usedBy: string[] }[];
    expect(list.find((s) => s.id === pinned.id)).toMatchObject({ model: 'haiku', usedBy: [agent.json().id] });
    expect(list.find((s) => s.id === loose.id)).toMatchObject({ model: null, usedBy: [] });

    const refused = await req('DELETE', `/skills/${pinned.id}`);
    expect([refused.statusCode, refused.json().error, refused.json().message]).toEqual([409, 'skill_pinned', 'pinned by pinner']);
    expect((await req('DELETE', `/skills/${loose.id}`)).statusCode).toBe(204);
    expect((await req('GET', `/skills/${loose.id}`)).statusCode).toBe(404);
    expect(await t.prisma.skillVersion.count({ where: { skillId: loose.id } })).toBe(0);
  });
});

describe('skills on this machine', () => {
  it('imports ~/.claude/skills and plugin skills approved, versions a changed one, skips a taken name', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { machineSkills, syncMachineSkills } = await import('../src/services/skill-service.js');
    const home = mkdtempSync(join(tmpdir(), 'office-home-'));
    const mk = (dir: string, name: string, desc: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
    };
    mk(join(home, '.claude', 'skills', 'mine'), 'mine', 'my own');
    mkdirSync(join(home, '.claude', 'skills', 'not-a-skill'), { recursive: true });
    mk(join(home, '.claude', 'plugins', 'cache', 'market', 'caveman', '1.0.0', 'skills', 'caveman'), 'caveman', 'terse');
    mk(join(home, '.claude', 'plugins', 'cache', 'market', 'other', '2.0.0', 'skills', 'mine'), 'mine', 'a clash');
    const t = await makeApp();
    const log = { info: () => {}, warn: () => {} };
    expect(await syncMachineSkills(t.prisma, log, home)).toEqual({ imported: 2, updated: 0, skipped: 1 });
    const mine = await t.prisma.skill.findUniqueOrThrow({ where: { name: 'mine' } });
    expect(mine).toMatchObject({ source: 'local', status: 'approved', sourceRef: join(home, '.claude', 'skills', 'mine') });
    expect((await machineSkills(t.prisma, home)).map((f) => [f.name, f.origin, !!f.skillId])).toEqual([
      ['mine', 'user', true],
      ['caveman', 'plugin:caveman', true],
      ['mine', 'plugin:other', false],
    ]);
    expect(await syncMachineSkills(t.prisma, log, home)).toEqual({ imported: 0, updated: 0, skipped: 1 });
    writeFileSync(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), `---\nname: mine\ndescription: my own, revised\n---\n# mine v2\n`);
    expect(await syncMachineSkills(t.prisma, log, home)).toEqual({ imported: 0, updated: 1, skipped: 1 });
    expect(await t.prisma.skillVersion.count({ where: { skillId: mine.id } })).toBe(2);
    await t.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('follows a plugin manifest skills path inside the plugin and takes the name from the frontmatter', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { syncMachineSkills } = await import('../src/services/skill-service.js');
    const home = mkdtempSync(join(tmpdir(), 'office-home-'));
    const plugin = (name: string, skills?: string) => {
      const root = join(home, '.claude', 'plugins', 'cache', 'market', name, '1.0.0');
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      if (skills) writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills }));
      return root;
    };
    const mk = (dir: string, name: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
    };
    mk(join(plugin('custom', './.claude/skills/'), '.claude', 'skills', 'folder-name'), 'real-name');
    mk(join(plugin('escape', '../../../../../../outside'), 'skills', 'inside'), 'inside');
    mk(join(home, 'outside', 'evil'), 'evil');
    const t = await makeApp();
    expect(await syncMachineSkills(t.prisma, { info: () => {}, warn: () => {} }, home)).toEqual({ imported: 2, updated: 0, skipped: 0 });
    expect((await t.prisma.skill.findMany({ orderBy: { name: 'asc' } })).map((s) => s.name)).toEqual(['inside', 'real-name']);
    await t.close();
    rmSync(home, { recursive: true, force: true });
  });
});
