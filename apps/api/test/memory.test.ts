import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContextPack } from '../src/services/context-pack.js';
import { createEntry } from '../src/services/memory-service.js';
import { makeApp } from './helpers.js';

describe('memory', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let projectId: string;
  let otherId: string;
  let agentId: string;
  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
    projectId = (await t.prisma.project.create({ data: { name: 'P', slug: 'p', repoPath: '/tmp/p' } })).id;
    otherId = (await t.prisma.project.create({ data: { name: 'Q', slug: 'q', repoPath: '/tmp/q' } })).id;
    agentId = (await t.prisma.agent.create({ data: { name: 'a', slug: 'a', role: 'dev' } })).id;
  });
  afterAll(() => t.close());

  const add = (over: Record<string, unknown> = {}) =>
    createEntry(t.prisma, {
      projectId, scope: 'project', type: 'decision', title: 't', content: 'c',
      authorType: 'user', status: 'verified', sources: [], ...over,
    } as Parameters<typeof createEntry>[1]);

  it('owner adds a verified decision and finds it by keyword', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/memory', headers: { cookie },
      payload: { projectId, type: 'decision', title: 'Token policy', content: 'We use token rotation every hour' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('verified');
    const hit = await t.app.inject({ method: 'GET', url: `/memory?projectId=${projectId}&q=token+rotation`, headers: { cookie } });
    expect(hit.json()[0].id).toBe(res.json().id);
    const none = await t.app.inject({ method: 'GET', url: `/memory?projectId=${projectId}&q=nothingness`, headers: { cookie } });
    expect(none.json()).toEqual([]);
  });

  it('proposed entries are not returned to the context pack', async () => {
    const p = await add({ status: 'proposed', title: 'login validation draft', content: 'login validation draft rules' });
    const v = await add({ title: 'login validation', content: 'login validation must trim emails' });
    const pack = await buildContextPack(t.prisma, { projectId, agentId, taskText: 'fix login validation', maxChars: 12000 });
    expect(pack.entryIds).toContain(v.id);
    expect(pack.entryIds).not.toContain(p.id);
  });

  it('supersede keeps the chain', async () => {
    const old = await add({ title: 'Cache ttl', content: 'cache ttl is sixty seconds' });
    const res = await t.app.inject({
      method: 'PUT', url: `/memory/${old.id}`, headers: { cookie },
      payload: { title: 'Cache ttl', content: 'cache ttl is ninety seconds' },
    });
    expect(res.statusCode).toBe(200);
    const next = res.json();
    expect(next.id).not.toBe(old.id);
    expect(next.version).toBe(2);
    expect((await t.prisma.memoryEntry.findUniqueOrThrow({ where: { id: old.id } })).supersededById).toBe(next.id);
    const got = await t.app.inject({ method: 'GET', url: `/memory/${next.id}?projectId=${projectId}`, headers: { cookie } });
    expect(got.json().revisions).toHaveLength(2);
    const found = await t.app.inject({ method: 'GET', url: `/memory?projectId=${projectId}&q=cache+ttl`, headers: { cookie } });
    expect(found.json().map((e: { id: string }) => e.id)).toEqual([next.id]);
  });

  it('project isolation', async () => {
    const e = await add({ title: 'Iso' });
    const res = await t.app.inject({ method: 'GET', url: `/memory/${e.id}?projectId=${otherId}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('context pack caps size', async () => {
    const big = 'database migration '.repeat(110);
    await t.prisma.memoryEntry.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        projectId, scope: 'project' as const, type: 'convention' as const, title: `Big ${i}`, content: big,
        authorType: 'user', status: 'verified' as const,
      })),
    });
    const conv = await t.prisma.conversation.create({
      data: { projectId, kind: 'direct', title: 'x' },
    });
    const msg = await t.prisma.message.create({
      data: { conversationId: conv.id, projectId, type: 'message', body: 'please look' },
    });
    await t.prisma.messageDelivery.create({ data: { messageId: msg.id, recipientAgentId: agentId } });
    const pack = await buildContextPack(t.prisma, {
      projectId, agentId, taskText: 'database migration '.repeat(2700), maxChars: 12000,
    });
    expect(pack.text.length).toBeLessThanOrEqual(12000);
    expect(pack.entryIds.length).toBeGreaterThanOrEqual(1);
    expect(pack.inboxCount).toBe(1);
    expect(pack.text).toContain('please look');
  });

  it('concurrent supersede: one winner, one 409, one successor', async () => {
    const old = await add({ title: 'Race', content: 'race base' });
    const put = (content: string) =>
      t.app.inject({ method: 'PUT', url: `/memory/${old.id}`, headers: { cookie }, payload: { title: 'Race', content } });
    const codes = (await Promise.all([put('one'), put('two')])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(await t.prisma.memoryEntry.count({ where: { title: 'Race', version: 2 } })).toBe(1);
  });

  it('status routes honour an explicit projectId', async () => {
    const e = await add({ status: 'proposed', title: 'Scoped' });
    const bad = await t.app.inject({ method: 'POST', url: `/memory/${e.id}/verify?projectId=${otherId}`, headers: { cookie } });
    expect(bad.statusCode).toBe(404);
    const ok = await t.app.inject({ method: 'POST', url: `/memory/${e.id}/verify?projectId=${projectId}`, headers: { cookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('project-less agent lesson is managed and appears in the pack', async () => {
    const l = await add({ projectId: undefined, agentId, scope: 'agent', type: 'lesson', status: 'proposed', title: 'Own lesson' });
    const v = await t.app.inject({ method: 'POST', url: `/memory/${l.id}/verify`, headers: { cookie } });
    expect(v.statusCode).toBe(200);
    const pack = await buildContextPack(t.prisma, { projectId, agentId, taskText: '', maxChars: 12000 });
    expect(pack.entryIds).toContain(l.id);
  });
});
