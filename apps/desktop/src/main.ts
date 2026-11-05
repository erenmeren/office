// Electron main process: starts the bundled Postgres, runs boot.mjs (migrate, seed, enroll the worker),
// then the API, the web server and the worker as child processes, and opens the UI in one window.
// Resources (see scripts/bundle.sh): <res>/server (API, worker, db client, Postgres binaries, boot.mjs),
// <res>/web (Next.js standalone server), <res>/templates. State lives under $XDG_DATA_HOME/office.
import { app, BrowserWindow, dialog, powerSaveBlocker, shell } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const PG_PORT = 5440;
const API_PORT = 4100; // the web bundle is built with NEXT_PUBLIC_API_URL=http://127.0.0.1:4100
const WEB_PORT = 3100;

const DATA = process.env.OFFICE_DESKTOP_DATA ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'office');
const LOGS = join(DATA, 'logs');
const RES = app.isPackaged ? process.resourcesPath : join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SERVER = join(RES, 'server');
const PG = join(SERVER, 'node_modules', '@embedded-postgres', 'linux-x64', 'native');
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

const execFileP = promisify(execFile);
const children: ChildProcess[] = [];
let stopping = false;

/** A random value generated once and kept at <DATA>/<file>, mode 0600. */
function secret(file: string): string {
  const p = join(DATA, file);
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('base64url'), { mode: 0o600 });
  return readFileSync(p, 'utf8').trim();
}

/** KEY=VALUE lines from <DATA>/env, passed to the API and the worker (OFFICE_WORKSPACE_ROOTS is appended to the defaults). */
function userEnv(): Record<string, string> {
  const p = join(DATA, 'env');
  if (!existsSync(p)) return {};
  const lines = readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='));
  return Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
}

const pgEnv = { ...process.env, LD_LIBRARY_PATH: join(PG, 'lib') };
const pgctl = (...args: string[]) => execFileP(join(PG, 'bin', 'pg_ctl'), ['-D', join(DATA, 'pg'), ...args], { env: pgEnv });

async function startPostgres(): Promise<string> {
  const dir = join(DATA, 'pg');
  const password = secret('pg-password');
  if (!existsSync(join(dir, 'PG_VERSION'))) {
    await execFileP(
      join(PG, 'bin', 'initdb'),
      ['-D', dir, '-U', 'office', `--pwfile=${join(DATA, 'pg-password')}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'],
      { env: pgEnv },
    );
  }
  // a previous instance may have left the server running (e.g. the app was killed)
  const running = await pgctl('status').then(() => true, () => false);
  if (!running) {
    // TCP only: a unix socket path under a long home directory exceeds the 107-byte limit
    await pgctl('-o', `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, '-l', join(LOGS, 'postgres.log'), '-w', 'start');
  }
  return `postgresql://office:${encodeURIComponent(password)}@127.0.0.1:${PG_PORT}/office`;
}

const nodeEnv = (env: Record<string, string | undefined>) => ({ ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' });

/** Run a script with Electron's bundled Node, logging to <LOGS>/<name>.log; an exit while the app is up is fatal. */
function node(name: string, script: string, cwd: string, env: Record<string, string | undefined>): void {
  const log = openSync(join(LOGS, `${name}.log`), 'a');
  const child = spawn(process.execPath, [script], { cwd, env: nodeEnv(env), stdio: ['ignore', log, log] });
  child.on('exit', (code, signal) => {
    if (!stopping) void fail(`${name} exited (${code ?? signal})`);
  });
  children.push(child);
}

async function waitFor(url: string, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (stopping) return;
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up in ${timeoutMs / 1000} s`);
}

async function start(): Promise<void> {
  const workspaces = join(DATA, 'workspaces');
  const dataDir = join(DATA, 'data');
  const workerHome = join(DATA, 'worker');
  for (const d of [DATA, LOGS, workspaces, join(dataDir, 'repos'), workerHome]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const extra = userEnv();

  const DATABASE_URL = await startPostgres();
  const boot = await execFileP(process.execPath, [join(SERVER, 'boot.mjs')], {
    cwd: SERVER,
    maxBuffer: 16 * 1024 * 1024,
    env: nodeEnv({
      DATABASE_URL,
      OFFICE_MIGRATIONS_DIR: join(SERVER, 'node_modules', '@office', 'db', 'prisma', 'migrations'),
      OFFICE_TEMPLATES_DIR: join(RES, 'templates'),
      OFFICE_WORKSPACE_ROOT: workspaces,
      OFFICE_WORKER_HOME: workerHome,
    }),
  }).catch((err: Error & { stdout?: string; stderr?: string }) => {
    appendFileSync(join(LOGS, 'boot.log'), `${err.stdout ?? ''}${err.stderr ?? ''}`);
    throw new Error(`boot failed: ${err.message}`);
  });
  appendFileSync(join(LOGS, 'boot.log'), boot.stdout + boot.stderr);
  const { enrollToken } = JSON.parse(boot.stdout.trim().split('\n').at(-1) ?? '{}') as { enrollToken?: string };

  node('api', join(SERVER, 'node_modules', '@office', 'api', 'dist', 'server.js'), SERVER, {
    NODE_ENV: 'desktop', // not "production": the login cookie must work over plain http://127.0.0.1
    DATABASE_URL,
    API_PORT: String(API_PORT),
    API_HOST: '127.0.0.1',
    COOKIE_SECRET: secret('cookie-secret'),
    WEB_ORIGIN,
    OFFICE_DATA_DIR: dataDir,
    OFFICE_SKILL_IMPORT_ROOTS: join(homedir(), '.claude'),
    ...extra,
  });
  node('web', join(RES, 'web', 'apps', 'web', 'server.js'), join(RES, 'web', 'apps', 'web'), {
    NODE_ENV: 'production',
    PORT: String(WEB_PORT),
    HOSTNAME: '127.0.0.1',
  });
  await waitFor(`http://127.0.0.1:${API_PORT}/health`);
  node('worker', join(SERVER, 'node_modules', '@office', 'worker', 'dist', 'main.js'), SERVER, {
    OFFICE_API_URL: `ws://127.0.0.1:${API_PORT}`,
    OFFICE_WORKER_HOME: workerHome,
    OFFICE_RUNTIME: 'claude',
    OFFICE_WORKER_CAPACITY: '2',
    OFFICE_WORKER_NAME: 'desktop',
    ...extra,
    OFFICE_WORKSPACE_ROOTS: [workspaces, join(dataDir, 'repos'), extra.OFFICE_WORKSPACE_ROOTS].filter(Boolean).join(':'),
    ...(enrollToken ? { OFFICE_ENROLL_TOKEN: enrollToken } : {}),
  });
  await waitFor(WEB_ORIGIN);
  keepAwakeWhileRunning();

  const win = new BrowserWindow({ width: 1600, height: 1000, autoHideMenuBar: true, title: 'Office', icon: join(RES, 'icon.png') });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(WEB_ORIGIN);
  console.log(`ui loaded: ${win.webContents.getTitle()}`);
}

/** Keeps the machine from sleeping while a worker is executing a run, so an idle suspend cannot freeze an agent. */
function keepAwakeWhileRunning() {
  let blocker: number | undefined;
  setInterval(() => {
    fetch(`http://127.0.0.1:${API_PORT}/health`)
      .then((r) => r.json() as Promise<{ activeRuns?: number }>)
      .then(({ activeRuns }) => {
        if (activeRuns && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
        if (!activeRuns && blocker !== undefined) {
          powerSaveBlocker.stop(blocker);
          blocker = undefined;
        }
      })
      .catch(() => undefined);
  }, 15_000).unref();
}

async function shutdown(): Promise<void> {
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  await pgctl('stop', '-m', 'fast', '-w').catch(() => undefined);
}

async function fail(message: string): Promise<never> {
  await shutdown();
  dialog.showErrorBox('Office could not start', `${message}\n\nLogs: ${LOGS}`);
  app.exit(1);
  throw new Error(message);
}

let quitDone = false;
app.on('before-quit', (e) => {
  if (quitDone) return;
  e.preventDefault();
  void shutdown().finally(() => {
    quitDone = true;
    app.quit();
  });
});
app.on('window-all-closed', () => app.quit());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());

void app.whenReady().then(() => start().catch((err: Error) => fail(err.message)));
