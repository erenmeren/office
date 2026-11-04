import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
// the package's own prisma binary: `node scripts/migrate-test.mjs` has no node_modules/.bin on its PATH
const prisma = new URL('../node_modules/.bin/prisma', import.meta.url).pathname;
const r = spawnSync(prisma, ['migrate', 'deploy'], { stdio: 'inherit', env: process.env });
if (r.error) throw r.error;
process.exit(r.status ?? 1);
