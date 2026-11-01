import { defineConfig } from '@playwright/test';

// Owner credentials come from the environment, never from the repo:
//   OFFICE_E2E_EMAIL=... OFFICE_E2E_PASSWORD=... pnpm e2e
// Starts the API (environment from the repo's .env) and the web app unless they already run.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'bash -c "set -a; . ../../.env; set +a; pnpm --filter @office/api dev"',
      url: 'http://localhost:4000/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    { command: 'pnpm dev', url: 'http://localhost:3000/login', reuseExistingServer: true, timeout: 120_000 },
  ],
});
