import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, PrismaClient } from '@office/db';
import { redactSecrets } from '@office/runtime';
import type { Config } from '../config.js';

const MAX_READ = 1_000_000;

export async function storeArtifact(
  db: PrismaClient,
  config: Config,
  a: { projectId: string; runId?: string; taskId?: string; kind: string; name: string; content: string; contentType?: string },
): Promise<Artifact> {
  const id = randomUUID();
  const dir = join(config.artifactsDir, a.projectId);
  const path = join(dir, `${id}.txt`);
  const content = redactSecrets(a.content);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
  const { content: _c, ...rest } = a;
  return db.artifact.create({ data: { ...rest, id, path, bytes: Buffer.byteLength(content) } });
}

export async function readArtifact(_config: Config, artifact: Artifact): Promise<string> {
  const buf = await readFile(artifact.path);
  return buf.length > MAX_READ ? `${buf.subarray(0, MAX_READ).toString('utf8')}\n[truncated]` : buf.toString('utf8');
}
