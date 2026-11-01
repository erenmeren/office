import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

describe('auth', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('concurrent setups create exactly one owner', async () => {
    const setup = (email: string) =>
      t.app.inject({ method: 'POST', url: '/auth/setup', payload: { email, password: 'password123' } });
    const res = await Promise.all([setup('a@example.com'), setup('b@example.com')]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await t.prisma.user.count()).toBe(1);
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "UserSession","User" CASCADE');
  });

  it('reports setupRequired when no users', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setupRequired: true });
  });

  it('setup creates user and cookie; second setup 409', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/setup',
      payload: { email: 'owner@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toContain('office_session');
    expect(res.json()).not.toHaveProperty('passwordHash');
    const again = await t.app.inject({
      method: 'POST',
      url: '/auth/setup',
      payload: { email: 'b@example.com', password: 'password123' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('protects routes', async () => {
    const no = await t.app.inject({ method: 'GET', url: '/projects' });
    expect(no.statusCode).toBe(401);
    const anon = await t.app.inject({ method: 'GET', url: '/auth/me' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).toEqual({ setupRequired: false, anonymous: true });
    const login = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: 'password123' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = `office_session=${login.cookies[0]!.value}`;
    const ok = await t.app.inject({ method: 'GET', url: '/projects', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([]);
    const me = await t.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ email: 'owner@example.com', setupRequired: false });
  });

  it('wrong password 401', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'owner@example.com', password: 'nope-nope' },
    });
    expect(res.statusCode).toBe(401);
  });
});
