import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

describe('agents', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
  });
  afterAll(() => t.close());

  const config = { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'] };
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  it('creates, versions immutably, and validates', async () => {
    const created = await req('POST', '/agents', { name: 'A', slug: 'a', role: 'dev', config });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent.currentVersion.version).toBe(1);
    expect(agent.currentVersion.config).toMatchObject({ maxTurns: 50, maxBudgetUsd: 2 });

    const put = await req('PUT', `/agents/${agent.id}`, { config: { ...config, systemPrompt: 'y' } });
    expect(put.json().currentVersion.version).toBe(2);
    const got = (await req('GET', `/agents/${agent.id}`)).json();
    expect(got.versions).toHaveLength(2);
    const v1 = got.versions.find((v: { version: number }) => v.version === 1);
    expect(v1.config.systemPrompt).toBe('x');

    const renamed = await req('PUT', `/agents/${agent.id}`, { name: 'B' });
    expect(renamed.json().name).toBe('B');
    expect(renamed.json().currentVersion.version).toBe(2);
    expect((await req('GET', `/agents/${agent.id}`)).json().versions).toHaveLength(2);

    const list = (await req('GET', '/agents')).json();
    expect(list[0].currentVersion.version).toBe(2);

    const bad = await req('POST', '/agents', {
      name: 'C', slug: 'c', role: 'dev', config: { ...config, allowedTools: 'Read' },
    });
    expect(bad.statusCode).toBe(400);
    const dup = await req('POST', '/agents', { name: 'A', slug: 'a', role: 'dev', config });
    expect(dup.statusCode).toBe(409);
    expect((await req('GET', '/agents/nope')).statusCode).toBe(404);
  });

  const md = (name: string, body = 'body') => `---\nname: ${name}\ndescription: does ${name}\n---\n${body}\n`;
  const approvedSkill = async (name: string) =>
    (await req('POST', '/skills', { name, files: { 'SKILL.md': md(name) } })).json() as {
      id: string;
      currentVersion: { id: string };
    };
  const pendingSkill = async (name: string) => {
    const skill = await t.prisma.skill.create({
      data: { name, description: 'd', source: 'local', sourceRef: '/x', status: 'pending_review' },
    });
    const v = await t.prisma.skillVersion.create({
      data: { skillId: skill.id, version: 1, files: { 'SKILL.md': md(name) }, checksum: 'c' },
    });
    await t.prisma.skill.update({ where: { id: skill.id }, data: { currentVersionId: v.id } });
    return skill;
  };
  const sub = (skills: string[] = []) => ({ name: 'helper', description: 'helps', prompt: 'help', skills });

  it('pins approved skills and subagents on the version and resolves the latest skill version by default', async () => {
    const s = await approvedSkill('pin-skill');
    const res = await req('POST', '/agents', {
      name: 'P', slug: 'pin', role: 'dev',
      config: { ...config, skills: [{ skillId: s.id, mode: 'eager' }], subagents: [sub(['pin-skill'])] },
    });
    expect(res.statusCode).toBe(201);
    const cur = res.json().currentVersion;
    expect(cur.skills).toEqual([
      { skillId: s.id, skillVersionId: s.currentVersion.id, name: 'pin-skill', version: 1, mode: 'eager' },
    ]);
    expect(cur.subagents).toHaveLength(1);
    expect(cur.subagents[0]).toMatchObject({ name: 'helper', skills: ['pin-skill'] });
    expect(cur.config.skills).toBeUndefined();
    const listed = (await req('GET', '/agents')).json().find((a: { slug: string }) => a.slug === 'pin');
    expect(listed.currentVersion.skills[0].name).toBe('pin-skill');
    const one = await req('GET', `/agents/${res.json().id}/versions/1`);
    expect(one.json().skills[0].version).toBe(1);
    expect((await req('GET', `/agents/${res.json().id}/versions/9`)).statusCode).toBe(404);
  });

  it('refuses a pending skill (409 skill_not_approved), a foreign skill version (400) and a subagent skill not pinned (400)', async () => {
    const pending = await pendingSkill('pending-skill');
    const a = await approvedSkill('ok-a');
    const b = await approvedSkill('ok-b');
    const post = (slug: string, extra: object) =>
      req('POST', '/agents', { name: slug, slug, role: 'dev', config: { ...config, ...extra } });

    const r1 = await post('r1', { skills: [{ skillId: pending.id }] });
    expect([r1.statusCode, r1.json().error]).toEqual([409, 'skill_not_approved']);
    const r2 = await post('r2', { skills: [{ skillId: a.id, skillVersionId: b.currentVersion.id }] });
    expect([r2.statusCode, r2.json().error]).toEqual([400, 'skill_version_mismatch']);
    const r3 = await post('r3', { skills: [{ skillId: a.id }], subagents: [sub(['ok-b'])] });
    expect([r3.statusCode, r3.json().error]).toEqual([400, 'subagent_skill_unknown']);
    expect(await t.prisma.agent.count({ where: { slug: { in: ['r1', 'r2', 'r3'] } } })).toBe(0);
    expect(await t.prisma.agentSkill.count({ where: { skillId: a.id } })).toBe(0);
  });

  it('a new agent version keeps the old pins: version 1 still lists skill v1 after the skill gets v2 and the agent is re-saved pinning v2', async () => {
    const s = await approvedSkill('evolving');
    const agent = (
      await req('POST', '/agents', { name: 'E', slug: 'evo', role: 'dev', config: { ...config, skills: [{ skillId: s.id }] } })
    ).json();
    expect(agent.currentVersion.skills[0]).toMatchObject({ version: 1, mode: 'on_demand' });
    const v2 = (await req('POST', `/skills/${s.id}/versions`, { files: { 'SKILL.md': md('evolving', 'new') } })).json();
    const put = await req('PUT', `/agents/${agent.id}`, {
      config: { ...config, skills: [{ skillId: s.id, skillVersionId: v2.id }] },
    });
    expect(put.json().currentVersion.skills[0].version).toBe(2);
    const got = (await req('GET', `/agents/${agent.id}`)).json();
    const byVersion = (n: number) => got.versions.find((v: { version: number }) => v.version === n);
    expect(byVersion(1).skills[0].version).toBe(1);
    expect(byVersion(2).skills[0].version).toBe(2);
  });

  it('projects crud', async () => {
    const p = await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/p' });
    expect(p.statusCode).toBe(201);
    expect(p.json().defaultBranch).toBe('main');
    expect((await req('GET', `/projects/${p.json().id}`)).statusCode).toBe(200);
    const dup = await req('POST', '/projects', { name: 'P2', slug: 'p', repoPath: '/tmp/p2' });
    expect(dup.statusCode).toBe(409);
  });

  it('GET /agents hides system agents; the detail route still returns them', async () => {
    const sys = await t.prisma.agent.create({ data: { name: 'Sum', slug: 'office-summarizer', role: 'system', isSystem: true } });
    const list = (await req('GET', '/agents')).json() as { id: string }[];
    expect(list.map((a) => a.id)).not.toContain(sys.id);
    expect((await req('GET', `/agents/${sys.id}`)).statusCode).toBe(200);
  });
});
