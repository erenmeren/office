import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

export default defineConfig({
  // the e2e test truncates the shared test database, so run files serially
  test: { passWithNoTests: true, fileParallelism: false, env: { OFFICE_EMBEDDINGS: 'off' } },
});
