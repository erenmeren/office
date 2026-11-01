import { spawn } from 'node:child_process';
import { redactSecrets } from '@office/runtime';
import type { CheckStatus } from '@office/shared';

const HEAD = 150_000;
const TAIL = 50_000;

function cap(s: string): string {
  return s.length <= HEAD + TAIL ? s : s.slice(0, HEAD) + '\n…[truncated]…\n' + s.slice(-TAIL);
}

export interface CheckOutcome {
  status: Exclude<CheckStatus, 'skipped'>;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/** Runs `command` through `sh -lc` in `cwd`; killed with SIGKILL after `timeoutSeconds`. Output capped and redacted. */
export function runCheck(cwd: string, command: string, timeoutSeconds: number, env: Record<string, string>): Promise<CheckOutcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    // own process group, so a timeout kills the command's children too
    const child = spawn('/bin/sh', ['-lc', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // keep head + tail only while reading, so a chatty command cannot exhaust memory
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.length > 2 * (HEAD + TAIL)) out = out.slice(0, HEAD) + out.slice(-(HEAD + TAIL));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutSeconds * 1000);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'timeout' : exitCode === 0 ? 'passed' : 'failed',
        exitCode: timedOut ? null : exitCode,
        durationMs: Date.now() - started,
        output: redactSecrets(cap(out)),
      });
    };
    child.on('error', (err) => {
      out += String(err);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}
