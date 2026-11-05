// First-run and upgrade steps of the desktop app, run by the Electron main process before the API starts:
// create the database, apply the Prisma migrations, seed, and enroll the bundled worker.
// Prints one JSON line last: { migrated: string[], enrollToken?: string }.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { syncMachineSkills } from '@office/api';
import { createPrisma, seed } from '@office/db';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const url = new URL(env('DATABASE_URL'));

async function ensureDatabase() {
  const name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.href });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (r.rowCount === 0) await c.query(`CREATE DATABASE "${name}"`);
  } finally {
    await c.end();
  }
}

// Same bookkeeping table and checksum as `prisma migrate deploy`, without shipping the Prisma CLI.
// Each migration.sql goes as one multi-statement query, which is what Prisma sends too.
async function migrate(dir) {
  const c = new pg.Client({ connectionString: url.href });
  await c.connect();
  const done = [];
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
      migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`);
    const applied = new Set(
      (await c.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).rows.map((r) => r.migration_name),
    );
    const names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const name of names) {
      if (applied.has(name)) continue;
      const sql = await readFile(join(dir, name, 'migration.sql'), 'utf8');
      try {
        await c.query(sql);
      } catch (err) {
        throw new Error(`migration ${name}: ${err.message}`);
      }
      await c.query(
        'INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ($1, $2, $3, now(), 1)',
        [randomUUID(), sha256(sql), name],
      );
      done.push(name);
    }
  } finally {
    await c.end();
  }
  return done;
}

const out = { migrated: [] };
await ensureDatabase();
out.migrated = await migrate(env('OFFICE_MIGRATIONS_DIR'));
const prisma = createPrisma(url.href);
try {
  // the owner's Claude skills first: the seed pins the ones its agent templates name
  await syncMachineSkills(prisma, { info() {}, warn() {} });
  for (const line of await seed(prisma, env('OFFICE_WORKSPACE_ROOT'), env('OFFICE_TEMPLATES_DIR'))) console.log(line);
  if (!existsSync(join(env('OFFICE_WORKER_HOME'), 'credentials.json'))) {
    // the bundled worker has no credential yet: hand it a fresh enroll token (the owner would use POST /workers)
    await prisma.worker.deleteMany({ where: { name: 'desktop', status: 'pending', credentialHash: null } });
    const token = randomBytes(32).toString('base64url');
    await prisma.worker.create({ data: { name: 'desktop', status: 'pending', enrollTokenHash: sha256(token), capacity: 2 } });
    out.enrollToken = token;
  }
} finally {
  await prisma.$disconnect();
}
console.log(JSON.stringify(out));
