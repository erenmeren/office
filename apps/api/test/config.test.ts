import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

it('listens on 127.0.0.1 unless API_HOST is set', () => {
  const env = { DATABASE_URL: 'pg://x', COOKIE_SECRET: 'x'.repeat(32), WEB_ORIGIN: 'http://w', OFFICE_DATA_DIR: 'd' };
  expect(loadConfig(env).host).toBe('127.0.0.1');
  expect(loadConfig({ ...env, API_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
});
