import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { isUnderRoot } from '../lib/paths.js';

/**
 * Folder picker for the project form: lists directories on the API's machine inside the owner's home, the data directory
 * and the local workers' roots. Nothing else is readable, and only directory names are returned.
 */
export async function browseRoutes(app: FastifyInstance, opts: { config: Config }) {
  const scopes = () => [homedir(), opts.config.dataDir, ...app.gateway.onlineWorkers().flatMap((w) => w.allowedRoots)].map((p) => resolve(p));
  app.get('/browse', async (req) => {
    const { path } = z.object({ path: z.string().optional() }).parse(req.query);
    const allowed = scopes();
    const dir = resolve(path ?? homedir());
    if (!allowed.some((s) => isUnderRoot(dir, s))) throw new HttpError(400, 'outside_scope', `only folders under ${allowed.join(', ')} can be browsed`);
    if (!existsSync(dir)) throw new HttpError(404, 'not_found');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
      throw new HttpError(400, 'unreadable');
    });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => ({ name: e.name, path: join(dir, e.name), isRepo: existsSync(join(dir, e.name, '.git')) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(dir);
    return { path: dir, parent: parent !== dir && allowed.some((s) => isUnderRoot(parent, s)) ? parent : null, isRepo: existsSync(join(dir, '.git')), dirs, roots: allowed };
  });
}
