import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCheck } from '../src/checks.js';

describe('runCheck', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'office-check-'));
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('passes on exit 0 with stdout and stderr', async () => {
    const r = await runCheck(cwd, 'echo out; echo err >&2', 10, env);
    expect(r).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails with the exit code', async () => {
    expect(await runCheck(cwd, 'exit 3', 10, env)).toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('times out and kills the command', async () => {
    const started = Date.now();
    const r = await runCheck(cwd, 'sleep 5; echo after', 1, env);
    // the whole process group is gone: no orphaned sleep finishes the script
    await new Promise((res) => setTimeout(res, 200));
    expect(r).toMatchObject({ status: 'timeout', exitCode: null });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('caps the output at head 150 000 + tail 50 000 chars', async () => {
    const r = await runCheck(cwd, "node -e \"process.stdout.write('a'.repeat(150000) + 'b'.repeat(100000) + 'c'.repeat(50000))\"", 30, env);
    expect(r.output.startsWith('a'.repeat(150000))).toBe(true);
    expect(r.output.endsWith('c'.repeat(50000))).toBe(true);
    expect(r.output).toContain('…[truncated]…');
    expect(r.output).not.toContain('b');
    expect(r.output.length).toBeLessThanOrEqual(200_100);
  });

  it('redacts secrets in the output', async () => {
    const r = await runCheck(cwd, 'echo key sk-ant-abcdefghijklmnopqrstuvwxyz', 10, env);
    expect(r.output).toContain('[REDACTED]');
    expect(r.output).not.toContain('sk-ant-abc');
  });
});
