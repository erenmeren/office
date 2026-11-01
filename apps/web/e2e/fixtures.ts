import { test as base, expect, type Page } from '@playwright/test';

export const API = 'http://localhost:4000';

/** Console errors and warnings, uncaught page errors, and requests that leave localhost. */
export interface Noise {
  console: string[];
  external: string[];
}

export function watch(page: Page): Noise {
  const noise: Noise = { console: [], external: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') noise.console.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => noise.console.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && u.protocol !== 'data:') noise.external.push(r.url());
  });
  return noise;
}

export const expectQuiet = (noise: Noise) => {
  expect(noise.console, 'console errors/warnings').toEqual([]);
  expect(noise.external, 'requests leaving localhost').toEqual([]);
};

export const test = base.extend<{ noise: Noise }>({
  noise: async ({ page }, run) => {
    await run(watch(page));
  },
});

/** Same, logged in as the owner before every test (creates the owner when the database is empty). */
export const authed = test.extend<{ login: void }>({
  login: [
    async ({ page, request }, run) => {
      const email = process.env.OFFICE_E2E_EMAIL;
      const password = process.env.OFFICE_E2E_PASSWORD;
      if (!email || !password) throw new Error('set OFFICE_E2E_EMAIL and OFFICE_E2E_PASSWORD');
      const me = await (await request.get(`${API}/auth/me`)).json();
      const res = await request.post(`${API}${me.setupRequired ? '/auth/setup' : '/auth/login'}`, { data: { email, password } });
      expect(res.ok(), `login: ${res.status()}`).toBe(true);
      const cookie = res.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie')!.value.split(';')[0];
      const [name, value] = cookie.split('=');
      await page.context().addCookies([{ name, value, domain: 'localhost', path: '/' }]);
      await run();
    },
    { auto: true },
  ],
});

export { expect };
