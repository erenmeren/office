import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONDUCTOR_PROJECT_SLUG, announceSettledMissions, missionAhead } from '../src/services/conductor-service.js';
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

  it('an owner message in a tab wakes the Conductor (a system agent) with a chat run that has no built-in tools', async () => {
    await seedConductor();
    // no tab named: the agent, no conversation
    expect((await req('GET', '/conductor')).json()).toMatchObject({ agent: { slug: 'conductor' }, conversation: null, project: null });
    const { conversationId } = (await req('POST', '/conductor/tabs')).json();
    const { conversation, project } = (await req('GET', `/conductor?conversation=${conversationId}`)).json();
    expect(conversation).toMatchObject({ id: conversationId, kind: 'human', title: 'Conductor', aboutProjectId: null });
    expect(project).toBeNull();
    // each new tab starts a conversation of its own; closed before anything was said in it, it leaves nothing behind
    const unused = (await req('POST', '/conductor/tabs')).json().conversationId;
    expect(unused).not.toBe(conversationId);
    const close = (id: string) => t.app.inject({ method: 'DELETE', url: `/conductor/tabs/${id}`, headers: { cookie } });
    expect((await close(unused)).statusCode).toBe(204);
    expect(await t.prisma.conversation.findUnique({ where: { id: unused } })).toBeNull();
    expect((await close('nope')).statusCode).toBe(404);

    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const { enrollToken } = (await req('POST', '/workers', { name: 'w' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w', capacity: 1, allowedRoots: [home.repoPath] });
    const sent = await req('POST', `/conversations/${conversation.id}/messages`, { type: 'question', body: 'Add dark mode to the shop' });
    expect(sent.statusCode, sent.body).toBe(201);
    // a talk without a project is listed by how the owner began it, so a closed one can be opened again
    expect((await req('GET', '/conductor/tabs')).json()).toMatchObject([{ id: conversationId, title: 'Add dark mode to the shop' }]);
    await t.app.scheduler.tick();
    const { spec } = await w.waitFor('run.assign');
    expect(spec).toMatchObject({ kind: 'chat', cwd: home.repoPath, allowedTools: [], noBuiltinTools: true, skills: [], subagents: [] });
    expect(spec.tools.sort()).toEqual(
      ['create_mission', 'create_project', 'get_conversation', 'get_mission', 'get_project', 'list_missions', 'list_projects', 'read_inbox', 'reply_message', 'search_project_memory'],
    );
    expect(spec.systemPrompt).toContain('You are the Conductor');
    expect(spec.systemPrompt).toContain('a new tab that has no project yet');
    await w.close();
    // a tab something was said in is kept when it is closed
    expect((await close(conversationId)).statusCode).toBe(204);
    expect(await t.prisma.conversation.findUnique({ where: { id: conversationId } })).not.toBeNull();
  });

  it('each project has a tab: its own conversation with the Conductor, made on first use; tabs are answered at the same time', async () => {
    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const shop = (await req('GET', `/conductor?project=${projectId}`)).json();
    expect(shop).toMatchObject({ project: { id: projectId, slug: 'shop', name: 'Shop' }, conversation: { kind: 'human', aboutProjectId: projectId }, missions: [] });
    // a repeated GET keeps the one conversation, and closing the tab does not remove it
    expect((await t.app.inject({ method: 'DELETE', url: `/conductor/tabs/${shop.conversation.id}`, headers: { cookie } })).statusCode).toBe(204);
    expect((await req('GET', `/conductor?project=${projectId}`)).json().conversation.id).toBe(shop.conversation.id);
    const blog = await t.prisma.project.create({ data: { name: 'Blog', slug: 'blog', repoPath: '/tmp/office-ws/blog' } });
    const blogTab = (await req('GET', `/conductor?project=${blog.id}`)).json();
    expect(blogTab.conversation.id).not.toBe(shop.conversation.id);
    // the home project has no tab, nor has an unknown project or conversation
    for (const q of [`project=${home.id}`, 'project=nope', 'conversation=nope']) expect((await req('GET', `/conductor?${q}`)).statusCode, q).toBe(404);

    // the owner writes in both tabs: the Conductor answers each in a run of its own, both at once
    await t.prisma.taskRun.updateMany({ where: { projectId: home.id }, data: { status: 'succeeded' } });
    const { enrollToken } = (await req('POST', '/workers', { name: 'w-tabs' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w-tabs', capacity: 2, allowedRoots: [home.repoPath] });
    for (const tab of [shop, blogTab]) {
      expect((await req('POST', `/conversations/${tab.conversation.id}/messages`, { type: 'question', body: `How is ${tab.project.name} going?` })).statusCode).toBe(201);
    }
    await t.app.scheduler.tick();
    await t.app.scheduler.tick();
    const specs = [(await w.waitFor('run.assign')).spec, (await w.waitFor('run.assign')).spec];
    const live = await t.prisma.taskRun.findMany({ where: { kind: 'chat', status: { in: ['queued', 'running'] } } });
    expect(live.map((r) => r.conversationId).sort()).toEqual([shop.conversation.id, blogTab.conversation.id].sort());
    // each run reads the mail of its own tab only: the other tab's message waits for that tab's run
    const shopRun = live.find((r) => r.conversationId === shop.conversation.id)!;
    const session = await t.prisma.agentSession.findFirstOrThrow({ where: { runId: shopRun.id } });
    const inbox = (await executeTool(t.prisma, t.app.hub, t.config, { run: shopRun, session }, 'read_inbox', {})) as { result: { messages: { conversationId: string }[] } };
    expect(inbox.result.messages.map((m) => m.conversationId)).toEqual([shop.conversation.id]);
    expect(await t.prisma.messageDelivery.count({ where: { message: { conversationId: blogTab.conversation.id }, recipientAgentId: shopRun.agentId, status: 'pending' } })).toBe(1);
    // a message that arrives while both runs are at work goes into the run of its own tab, not into the other one
    await t.prisma.taskRun.updateMany({ where: { id: { in: live.map((r) => r.id) } }, data: { status: 'running' } });
    const late = (await req('POST', `/conversations/${blogTab.conversation.id}/messages`, { type: 'question', body: 'One more thing' })).json();
    await t.app.scheduler.tick();
    await w.waitFor('run.message');
    await new Promise((r) => setTimeout(r, 100));
    expect(w.received.filter((m: { type: string }) => m.type === 'run.message')).toMatchObject([{ runId: live.find((r) => r.conversationId === blogTab.conversation.id)!.id, messageId: late.id }]);
    // "interrupt and send" on a run puts the owner's message into that run's tab
    const blogRun = live.find((r) => r.conversationId === blogTab.conversation.id)!;
    const interrupted = await req('POST', `/runs/${blogRun.id}/interrupt`, { body: 'Stop, one change' });
    expect(interrupted.statusCode, interrupted.body).toBe(200);
    expect(await t.prisma.message.findFirstOrThrow({ where: { body: 'Stop, one change' } })).toMatchObject({ conversationId: blogTab.conversation.id });
    // each run is told whose tab it answers in
    expect(specs.map((s) => /tab for the project "(\w+)"/.exec(s.systemPrompt)?.[1]).sort()).toEqual(['Blog', 'Shop']);
    // and sees the unread mail of its own tab only
    for (const s of specs) expect(s.systemPrompt.match(/How is (\w+) going\?/g)).toEqual([`How is ${/tab for the project "(\w+)"/.exec(s.systemPrompt)![1]} going?`]);
    await w.close();

    // a deleted project takes its tab along, but not while the Conductor is answering in it
    const del = () => t.app.inject({ method: 'DELETE', url: `/projects/${blog.id}`, headers: { cookie } });
    expect((await del()).statusCode).toBe(409);
    await t.prisma.taskRun.updateMany({ where: { projectId: home.id }, data: { status: 'succeeded' } });
    expect((await del()).statusCode).toBe(204);
    expect(await t.prisma.conversation.findUnique({ where: { id: blogTab.conversation.id } })).toBeNull();
    expect(await t.prisma.message.count({ where: { conversationId: blogTab.conversation.id } })).toBe(0);
  });

  it('Conductor tools: projects, missions in a project by slug, unknown slugs listed; not for other runs', async () => {
    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const conductor = await t.prisma.agent.findUniqueOrThrow({ where: { slug: 'conductor' } });
    const conversation = await t.prisma.conversation.findFirstOrThrow({ where: { aboutProjectId: projectId } });
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

    const page = (await req('GET', `/conductor?project=${projectId}`)).json();
    expect(page.missions).toMatchObject([{ id: missionId, project: { slug: 'shop' }, taskCounts: {}, pendingApprovals: [] }]);
  });
  it('a new tab has no project: create_project makes one with its own repository and the tab becomes that project\'s; one tab, one project', async () => {
    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const conductor = await t.prisma.agent.findUniqueOrThrow({ where: { slug: 'conductor' } });
    // a new tab and a Conductor run answering in it
    const tab = async () => {
      const { conversationId } = (await req('POST', '/conductor/tabs')).json();
      const run = await t.prisma.taskRun.create({
        data: { agentId: conductor.id, projectId: home.id, kind: 'chat', conversationId, agentVersionId: conductor.currentVersionId!, status: 'running' },
      });
      const session = await t.prisma.agentSession.create({
        data: { runId: run.id, agentId: conductor.id, projectId: home.id, model: 'opus', status: 'running', startedAt: new Date() },
      });
      return { conversationId, call: (name: string, args: unknown) => executeTool(t.prisma, t.app.hub, t.config, { run, session }, name, args) };
    };
    const { conversationId, call } = await tab();
    const repos = t.config.projectsDir;
    expect(repos).toBe(resolve(t.config.dataDir, 'repos'));

    // no project yet: nothing is opened from this tab, not even in a project that exists
    expect(await call('create_mission', { project: 'shop', request: 'x' })).toMatchObject({ ok: false, code: 'wrong_tab', error: expect.stringContaining('own tab') });
    expect(await call('create_project', { name: 'Tarif Sitesı' })).toMatchObject({ ok: true, result: { project: 'tarif-sitesi', name: 'Tarif Sitesı' } });
    const project = await t.prisma.project.findUniqueOrThrow({ where: { slug: 'tarif-sitesi' } });
    expect(project).toMatchObject({ isSystem: false, repoPath: resolve(repos, 'tarif-sitesi'), defaultBranch: 'main', settings: { integrateWhenDone: true } });
    expect(existsSync(resolve(repos, 'tarif-sitesi', '.git'))).toBe(true);
    expect(await t.prisma.auditLog.count({ where: { action: 'project.created_by_conductor', targetId: project.id } })).toBe(1);
    // the tab is the new project's tab now
    expect((await req('GET', `/conductor?conversation=${conversationId}`)).json()).toMatchObject({ project: { id: project.id, slug: 'tarif-sitesi' }, conversation: { aboutProjectId: project.id } });
    expect((await req('GET', `/conductor?project=${project.id}`)).json().conversation.id).toBe(conversationId);
    expect(((await req('GET', '/conductor/tabs')).json() as { id: string }[]).map((talk) => talk.id)).not.toContain(conversationId);
    // one tab, one project: no second project from it, and no mission elsewhere
    expect(await call('create_project', { name: 'Another' })).toMatchObject({ ok: false, code: 'wrong_tab', error: expect.stringContaining('Tarif Sitesı') });
    expect(await call('create_mission', { project: 'shop', request: 'x' })).toMatchObject({ ok: false, code: 'wrong_tab', error: expect.stringContaining('own tab') });
    expect(await t.prisma.project.count({ where: { slug: 'another' } })).toBe(0);
    // the same name again, from another new tab, is a second project, not an error
    expect(await (await tab()).call('create_project', { name: 'Tarif Sitesı' })).toMatchObject({ ok: true, result: { project: 'tarif-sitesi-2' } });
    expect(await (await tab()).call('create_project', { name: '!!!' })).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(await call('create_mission', { project: 'tarif-sitesi', request: 'A page of recipes' })).toMatchObject({
      ok: true, result: { project: 'tarif-sitesi', status: 'planning' },
    });
  });
  it('a finished mission of the Conductor lands in the project folder and leaves it one note, which wakes it', async () => {
    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const conductor = await t.prisma.agent.findUniqueOrThrow({ where: { slug: 'conductor' } });
    const project = await t.prisma.project.findUniqueOrThrow({ where: { slug: 'tarif-sitesi' } });
    const conversation = await t.prisma.conversation.findFirstOrThrow({ where: { aboutProjectId: project.id } });
    const repo = project.repoPath;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
    // what a mission leaves behind: a branch with the work, the folder still on main
    const work = (branch: string, file: string) => {
      git('checkout', '-q', '-b', branch, 'main');
      writeFileSync(resolve(repo, file), 'made by the team\n');
      git('add', '-A');
      git('commit', '-q', '-m', `add ${file}`);
      git('checkout', '-q', 'main');
    };
    const mission = (title: string, status: 'done' | 'failed', branch: string | null) =>
      t.prisma.mission.create({ data: { projectId: project.id, title, request: title, status, branch, conductorConversationId: conversation.id } });
    const notes = () => t.prisma.message.findMany({ where: { conversationId: conversation.id, idempotencyKey: { startsWith: 'mission-settled:' } }, orderBy: { createdAt: 'asc' }, include: { deliveries: true } });
    const announce = () => announceSettledMissions(t.prisma, t.app.hub, t.app.log);

    work('office/page', 'index.html');
    const done = await mission('Recipe page', 'done', 'office/page');
    await announce();
    expect(existsSync(resolve(repo, 'index.html'))).toBe(true);
    const [note] = await notes();
    expect(note).toMatchObject({ type: 'escalation', senderAgentId: null, senderUserId: null, idempotencyKey: `mission-settled:${done.id}:done` });
    expect(note!.body).toContain('"Recipe page"');
    expect(note!.body).toContain(`The files are in the folder ${repo}`);
    expect(note!.deliveries).toMatchObject([{ recipientAgentId: conductor.id, status: 'pending' }]);
    expect(await t.prisma.auditLog.count({ where: { action: 'mission.integrated', targetId: done.id } })).toBe(1);
    // once only
    await announce();
    expect(await notes()).toHaveLength(1);

    // the folder has work of its own: nothing is merged over it, and the note says where the result waits
    work('office/more', 'more.html');
    writeFileSync(resolve(repo, 'index.html'), 'the owner is editing this\n');
    await mission('More pages', 'done', 'office/more');
    await mission('Broken idea', 'failed', null);
    await announce();
    expect(existsSync(resolve(repo, 'more.html'))).toBe(false);
    const bodies = (await notes()).map((n) => n.body);
    expect(bodies).toHaveLength(3);
    expect(bodies.find((b) => b.includes('"More pages"'))).toContain('on branch office/more');
    expect(bodies.find((b) => b.includes('"Broken idea"'))).toContain('is failed');
    git('checkout', '-q', '--', 'index.html');

    // a mission opened before the tabs, in a conversation that is no project's tab, reports in its project's tab
    const { conversationId: shared } = (await req('POST', '/conductor/tabs')).json();
    const early = await t.prisma.mission.create({ data: { projectId: project.id, title: 'From before the tabs', request: 'x', status: 'failed', conductorConversationId: shared } });
    await announce();
    expect(await t.prisma.message.findUnique({ where: { idempotencyKey: `mission-settled:${early.id}:failed` } })).toMatchObject({ conversationId: conversation.id });
    expect(await t.prisma.message.count({ where: { conversationId: shared } })).toBe(0);
    expect(await notes()).toHaveLength(4);

    // a mission settled long ago is not announced (nothing from before this feature, or from before a long stop)
    const old = await mission('Old one', 'done', null);
    await t.prisma.$executeRaw`UPDATE "Mission" SET "updatedAt" = now() - interval '1 hour' WHERE id = ${old.id}`;
    await announce();
    expect(await notes()).toHaveLength(4);

    // the note is mail for the Conductor: the next tick gives it a chat run in its conversation
    // (the runs earlier tests left queued or running would make it look busy)
    await t.prisma.taskRun.updateMany({ where: { agentId: conductor.id, status: { in: ['queued', 'running'] } }, data: { status: 'succeeded' } });
    const { enrollToken } = (await req('POST', '/workers', { name: 'w-note' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w-note', capacity: 1, allowedRoots: [home.repoPath] });
    await t.app.scheduler.tick();
    const { spec } = await w.waitFor('run.assign');
    expect(spec).toMatchObject({ kind: 'chat' });
    expect(spec.systemPrompt).toContain('Office:');
    await w.close();
  });

  it('where finished work lands in the folder, a second mission waits for the first and starts from what it left', async () => {
    const home = await t.prisma.project.findUniqueOrThrow({ where: { slug: CONDUCTOR_PROJECT_SLUG } });
    const project = await t.prisma.project.findUniqueOrThrow({ where: { slug: 'tarif-sitesi' } });
    const conversation = await t.prisma.conversation.findFirstOrThrow({ where: { aboutProjectId: project.id } });
    const repo = project.repoPath;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
    // nothing the earlier tests opened is still at work in this project
    await t.prisma.mission.updateMany({ where: { projectId: project.id, status: { in: ['planning', 'awaiting_approval', 'approved', 'running', 'review'] } }, data: { status: 'cancelled' } });
    git('checkout', '-q', '-b', 'office/first', 'main');
    writeFileSync(resolve(repo, 'first.html'), 'made by the first mission\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'add first.html');
    git('checkout', '-q', 'main');
    const first = await t.prisma.mission.create({
      data: { projectId: project.id, title: 'First', request: 'First', status: 'running', branch: 'office/first', conductorConversationId: conversation.id, createdAt: new Date(Date.now() - 60_000) },
    });
    const second = await t.prisma.mission.create({ data: { projectId: project.id, title: 'Second', request: 'Second', status: 'planning', conductorConversationId: conversation.id } });

    expect(await missionAhead(t.prisma, second, project.settings)).toMatchObject({ id: first.id, title: 'First' });
    expect(await missionAhead(t.prisma, first, project.settings)).toBeNull();
    // a project that keeps integration manual is not queued: its missions would not see each other's work anyway
    expect(await missionAhead(t.prisma, second, {})).toBeNull();

    // the Chief of this file has no version yet; a plan run needs one
    const chief = await t.prisma.agent.findUniqueOrThrow({ where: { slug: 'chief' } });
    await t.app.inject({ method: 'PUT', url: `/agents/${chief.id}`, headers: { cookie }, payload: { config: { systemPrompt: 'plan', model: 'sonnet', allowedTools: ['Read'] } } });
    const { enrollToken } = (await req('POST', '/workers', { name: 'w-queue' })).json();
    const w = await connectFakeWorker(t.app, { enrollToken, name: 'w-queue', capacity: 1, allowedRoots: [repo] });
    await t.app.scheduler.tick();
    expect((await t.prisma.mission.findUniqueOrThrow({ where: { id: second.id } })).planRunId).toBeNull();
    expect((await req('GET', `/missions/${second.id}`)).json()).toMatchObject({ waitsFor: 'First', blocked: null });

    // done a moment ago, not yet put into the folder: still ahead
    await t.prisma.mission.update({ where: { id: first.id }, data: { status: 'done' } });
    expect(await missionAhead(t.prisma, second, project.settings)).toMatchObject({ id: first.id });

    // the tick puts the first one's work into the folder, then plans the second from there
    await t.app.scheduler.tick();
    const { spec } = await w.waitFor('run.assign');
    expect(spec).toMatchObject({ kind: 'plan' });
    expect(existsSync(resolve(repo, 'first.html'))).toBe(true);
    expect((await req('GET', `/missions/${second.id}`)).json().waitsFor).toBeNull();
    await w.close();
  });
});
