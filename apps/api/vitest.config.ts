import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

export default defineConfig({
  // test files share one database and truncate it, so run them serially
  test: { passWithNoTests: true, fileParallelism: false },
});
