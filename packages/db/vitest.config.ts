import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

export default defineConfig({
  test: { passWithNoTests: true },
});
