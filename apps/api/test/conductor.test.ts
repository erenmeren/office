import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONDUCTOR_PROJECT_SLUG } from '../src/services/conductor-service.js';
import { executeTool } from '../src/services/tool-service.js';
import { connectFakeWorker } from './fake-worker.js';
import { makeApp } from './helpers.js';

describe('conductor', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let projectId: string;
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => t.app.inject({ method, url, headers: { cookie }, payload });

  beforeAll(async () => {
    t = await makeApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    cookie = await t.login();
    wipe();
    projectId = (await t.prisma.project.create({ data: { name: 'Shop', slug: 'shop', repoPath: '/tmp/office-ws/shop' } })).id;
    await t.prisma.agent.create({ data: { name: 'Chief', slug: 'chief', role: 'chief' } });
  });
  // folders the tests make under <dataDir>/repos; a leftover one would shift the slugs
  const wipe = () => [CONDUCTOR_PROJECT_SLUG, 'tarif-sitesi', 'tarif-sitesi-2'].forEach((slug) => rmSync(resolve(t.config.dataDir, 'repos', slug), { recursive: true, force: true }));
  afterAll(async () => {
    await t.close();
    wipe();
  });

  const seedConductor = async () => {
    const agent = await t.prisma.agent.create({ data: { name: 'Conductor', slug: 'conductor', role: 'system', isSystem: true } });
    const v = await t.prisma.agentVersion.create({
      data: { agentId: agent.id, version: 1, config: { systemPrompt: 'route', model: 'opus', allowedTools: ['Bash', 'Read'] } },
    });
    return t.prisma.agent.update({ where: { id: agent.id }, data: { currentVersionId: v.id } });
  };

  it('the home project is created on first use, hidden from GET /projects; without the agent there is no conversation', async () => {
    const res = (await req('GET', '/conductor')).json();
    expect(res.agent).toBeNull();
    expect(res.conversation).toBeNull();
    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    expect(home).toMatchObject({ id: res.projectId, isSystem: true });
    const listed = (await req('GET', '/projects')).json() as { slug: string }[];
    expect(listed.map((p) => p.slug)).toEqual(['shop']);
  });

  it('an owner message wakes the Conductor (a system agent) with a chat run that has no built-in tools', async () => {
    await seedConductor();
    const { conversation } = (await req('GET', '/conductor')).json();
    expect(conversation).toMatchObject({ kind: 'human', title: 'Conductor' });
    // a repeated GET keeps the one conversation
    expect((await req('GET', '/conductor')).json().conversation.id).toBe(conversation.id);

    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w', capacity: 1, allowedRoots: [home.repoPath] });
    const sent = await req('POST', `/conversations/${conversation.id}/messages`, { type: 'question', body: 'Add dark mode to the shop' });
    expect(sent.statusCode, sent.body).toBe(201);
    await t.app.scheduler.tick();
    const { spec } = await w.waitFor('run.assign');
    expect(spec).toMatchObject({ kind: 'chat', cwd: home.repoPath, allowedTools: [], noBuiltinTools: true, skills: [], subagents: [] });
    expect(spec.tools.sort()).toEqual(
      ['create_mission', 'create_project', 'get_conversation', 'get_mission', 'get_project', 'list_missions', 'list_projects', 'read_inbox', 'reply_message', 'search_project_memory'],
    );
    expect(spec.systemPrompt).toContain('You are the Conductor');
    await w.close();
  });

  it('Conductor tools: projects, missions in a project by slug, unknown slugs listed; not for other runs', async () => {
    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const conductor = await t.prisma.agent.findUniqueOrThrow({ where: { slug: 'conductor' } });
    const conversation = await t.prisma.conversation.findFirstOrThrow({ where: { projectId: home.id } });
    const ctx = async (pid: string) => {
      const run = await t.prisma.taskRun.create({
        data: { agentId: conductor.id, projectId: pid, kind: 'chat', conversationId: conversation.id, agentVersionId: conductor.currentVersionId!, status: 'running' },
      });
      const session = await t.prisma.agentSession.create({
        data: { runId: run.id, agentId: conductor.id, projectId: pid, model: 'opus', status: 'running', startedAt: new Date() },
      });
      return { run, session };
    };
    const c = await ctx(home.id);
    const call = (name: string, args: unknown, cc = c) => executeTool(t.prisma, t.app.hub, t.config, cc, name, args);

    expect(await call('list_projects', {})).toMatchObject({ ok: true, result: { projects: [{ slug: 'shop', liveMissions: 0 }] } });
    expect(await call('create_mission', { project: 'nope', request: 'x' })).toMatchObject({
      ok: false, code: 'not_found', error: expect.stringContaining('projects: shop'),
    });
    // the Conductor cannot open missions in its own home project
    expect(await call('create_mission', { project: CONDUCTOR_PROJECT_SLUG, request: 'x' })).toMatchObject({ ok: false, code: 'not_found' });

    const created = await call('create_mission', { project: 'shop', request: 'Add dark mode', title: 'Dark mode' });
    expect(created).toMatchObject({ ok: true, result: { project: 'shop', title: 'Dark mode', status: 'planning' } });
    const missionId = (created as { result: { missionId: string } }).result.missionId;
    expect(await t.prisma.mission.findUniqueOrThrow({ where: { id: missionId } })).toMatchObject({
      projectId, conductorConversationId: conversation.id,
    });
    expect(await t.prisma.auditLog.count({ where: { action: 'mission.created_by_conductor', targetId: missionId } })).toBe(1);

    expect(await call('get_mission', { missionId })).toMatchObject({ ok: true, result: { id: missionId, project: 'shop', request: 'Add dark mode', tasks: [] } });
    expect(await call('list_missions', { project: 'shop' })).toMatchObject({ ok: true, result: { missions: [{ id: missionId }] } });
    expect(await call('get_project', { project: 'shop' })).toMatchObject({ ok: true, result: { slug: 'shop', missions: [{ id: missionId }] } });

    // messaging other agents is not a Conductor tool
    expect(await call('send_message', { to: 'chief', body: 'hi' })).toMatchObject({ ok: false, code: 'unknown_tool' });
    // a run in an ordinary project cannot use the Conductor's tools
    expect(await call('create_mission', { project: 'shop', request: 'x' }, await ctx(projectId))).toMatchObject({ ok: false, code: 'unknown_tool' });

    const page = (await req('GET', '/conductor')).json();
    expect(page.missions).toMatchObject([{ id: missionId, project: { slug: 'shop' }, taskCounts: {}, pendingApprovals: [] }]);
  });
  it('create_project makes a project with its own repository and a slug from the name; a mission can be opened in it at once', async () => {
    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const conductor = await t.prisma.agent.findUniqueOrThrow({ where: { slug: 'conductor' } });
    const conversation = await t.prisma.conversation.findFirstOrThrow({ where: { projectId: home.id } });
    const run = await t.prisma.taskRun.create({
      data: { agentId: conductor.id, projectId: home.id, kind: 'chat', conversationId: conversation.id, agentVersionId: conductor.currentVersionId!, status: 'running' },
    });
    const session = await t.prisma.agentSession.create({
      data: { runId: run.id, agentId: conductor.id, projectId: home.id, model: 'opus', status: 'running', startedAt: new Date() },
    });
    const call = (name: string, args: unknown) => executeTool(t.prisma, t.app.hub, t.config, { run, session }, name, args);
    const repos = resolve(t.config.dataDir, 'repos');

    expect(await call('create_project', { name: 'Tarif Sitesı' })).toMatchObject({ ok: true, result: { project: 'tarif-sitesi', name: 'Tarif Sitesı' } });
    const project = await t.prisma.project.findUniqueOrThrow({ where: { slug: 'tarif-sitesi' } });
    expect(project).toMatchObject({ isSystem: false, repoPath: resolve(repos, 'tarif-sitesi'), defaultBranch: 'main' });
    expect(existsSync(resolve(repos, 'tarif-sitesi', '.git'))).toBe(true);
    expect(await t.prisma.auditLog.count({ where: { action: 'project.created_by_conductor', targetId: project.id } })).toBe(1);
    // the same name again is a second project, not an error
    expect(await call('create_project', { name: 'Tarif Sitesı' })).toMatchObject({ ok: true, result: { project: 'tarif-sitesi-2' } });
    expect(await call('create_project', { name: '!!!' })).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(await call('create_mission', { project: 'tarif-sitesi', request: 'A page of recipes' })).toMatchObject({
      ok: true, result: { project: 'tarif-sitesi', status: 'planning' },
    });
  });
});
