import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { readArtifact } from '../services/artifact-store.js';

export async function artifactRoutes(app: FastifyInstance, opts: { config: Config }) {
  app.get('/artifacts/:id', async (req) => {
    const artifact = await app.prisma.artifact.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!artifact) throw new HttpError(404, 'not_found');
    return { ...artifact, content: await readArtifact(opts.config, artifact) };
  });
}
