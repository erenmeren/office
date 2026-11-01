import { spawn } from 'node:child_process';
import { mkdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { authenticateWorkerBearer } from '../plugins/worker-bearer.js';

// git smart-HTTP paths only; anything else never reaches http-backend
const GIT_PATH = /^(?:info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/[0-9A-Za-z._/-]+)$/;

/** `<dataDir>/git-roots/<projectId>/repo` → repoPath, refreshed atomically on every request. */
function projectRoot(dataDir: string, projectId: string, repoPath: string): string {
  const root = join(dataDir, 'git-roots', projectId);
  mkdirSync(root, { recursive: true });
  const link = join(root, 'repo');
  let current: string | undefined;
  try {
    current = readlinkSync(link);
  } catch {
    current = undefined;
  }
  if (current !== repoPath) {
    const tmp = join(root, `.repo-${randomBytes(6).toString('hex')}`);
    symlinkSync(repoPath, tmp);
    renameSync(tmp, link);
  }
  return root;
}

export async function gitRoutes(app: FastifyInstance, opts: { config: Config }) {
  const { config } = opts;
  app.addContentTypeParser(
    ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'],
    (_req, payload, done) => done(null, payload),
  );

  app.all('/git/:projectId/*', async (request, reply) => {
    const { workerId } = await authenticateWorkerBearer(app, request);
    const { projectId, '*': rest } = request.params as { projectId: string; '*': string };
    if (!GIT_PATH.test(rest) || rest.split('/').some((s) => s === '..' || s === '.')) throw new HttpError(404, 'not_found');
    const project = await app.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, repoPath: true, defaultBranch: true },
    });
    if (!project) throw new HttpError(404, 'not_found');

    const h = request.headers;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_PROJECT_ROOT: projectRoot(config.dataDir, project.id, project.repoPath),
      PATH_INFO: `/repo/${rest}`,
      GIT_HTTP_EXPORT_ALL: '1',
      REMOTE_USER: `worker:${workerId}`,
      OFFICE_DEFAULT_BRANCH: project.defaultBranch,
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'http.receivepack',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: config.gitHooksDir,
      GIT_CONFIG_KEY_2: 'receive.denyDeletes',
      GIT_CONFIG_VALUE_2: 'true',
      REQUEST_METHOD: request.method,
      QUERY_STRING: request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '',
    };
    if (h['content-type']) env.CONTENT_TYPE = h['content-type'];
    if (h['content-length']) env.CONTENT_LENGTH = h['content-length'];
    if (typeof h['content-encoding'] === 'string') env.HTTP_CONTENT_ENCODING = h['content-encoding'];

    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); // http-backend may exit before reading the whole body
    child.stderr.on('data', (d: Buffer) => app.log.warn({ projectId, workerId, stderr: String(d).trim() }, 'git http-backend'));
    const body = request.body as Readable | undefined;
    if (body && typeof body.pipe === 'function') body.pipe(child.stdin);
    else child.stdin.end();

    // CGI response: headers up to the blank line, then the body
    const { status, headers, out } = await new Promise<{ status: number; headers: Record<string, string>; out: PassThrough }>(
      (resolve, reject) => {
        let buf = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const end = buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          child.stdout.off('data', onData);
          const headers: Record<string, string> = {};
          let status = 200;
          for (const line of buf.subarray(0, end).toString('latin1').split('\r\n')) {
            const i = line.indexOf(':');
            if (i < 0) continue;
            const k = line.slice(0, i).trim();
            const v = line.slice(i + 1).trim();
            if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 200;
            else headers[k] = v;
          }
          const out = new PassThrough();
          out.write(buf.subarray(end + 4));
          child.stdout.pipe(out);
          resolve({ status, headers, out });
        };
        child.stdout.on('data', onData);
        child.on('error', reject);
        child.on('close', (code) => reject(new Error(`git http-backend exited ${code} before sending headers`)));
      },
    );
    return reply.code(status).headers(headers).send(out);
  });
}
