import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';

config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
const r = spawnSync('prisma', ['migrate', 'deploy'], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
