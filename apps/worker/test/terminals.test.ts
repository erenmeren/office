import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { WorkerToApi } from '@office/shared';
import { TerminalManager } from '../src/terminals.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'office-term-')));
const root = join(tmp, 'root');
mkdirSync(root);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sent: WorkerToApi[] = [];
const until = async (cond: () => boolean, what: string) => {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const output = (id: string) =>
  sent.flatMap((m) => (m.type === 'terminal.output' && m.terminalId === id ? [Buffer.from(m.data, 'base64').toString()] : [])).join('');
const open = { type: 'terminal.open' as const, dir: root, claudeSessionId: 'sid-1', cols: 80, rows: 24 };
let mgr: TerminalManager;
afterEach(() => mgr?.closeAll());

describe('terminal manager', () => {
  it('runs the command under a pty, streams output, takes input and reports the exit', async () => {
    sent.length = 0;
    mgr = new TerminalManager([root], (m) => sent.push(m), { liveSessions: async () => [], command: { exe: '/bin/sh', args: [] }, env: { PATH: process.env.PATH!, OFFICE_SECRET: 'x', HOME: tmp } });
    await mgr.open({ ...open, terminalId: 't1' });
    const opened = sent.find((m) => m.type === 'terminal.opened');
    expect(opened).toMatchObject({ terminalId: 't1', dir: root, claudeSessionId: 'sid-1' });
    mgr.input('t1', 'echo "office:$OFFICE_SECRET:$TERM"; pwd; exit 3\n');
    await until(() => sent.some((m) => m.type === 'terminal.exit'), 'exit');
    expect(output('t1')).toContain('office::xterm-256color');
    expect(output('t1')).toContain(root);
    expect(sent.find((m) => m.type === 'terminal.exit')).toMatchObject({ terminalId: 't1', exitCode: 3 });
    expect(mgr.size).toBe(0);
  });

  it('refuses a directory outside the roots and a session another process runs', async () => {
    sent.length = 0;
    mgr = new TerminalManager([root], (m) => sent.push(m), { liveSessions: async () => [{ sessionId: 'live-1', pid: 9, kind: 'interactive', status: 'busy' }], command: { exe: '/bin/sh', args: [] } });
    await mgr.open({ ...open, terminalId: 't2', dir: tmp });
    await mgr.open({ ...open, terminalId: 't3', resumeSessionId: 'live-1' });
    expect(sent).toEqual([
      { type: 'terminal.error', terminalId: 't2', code: 'outside_roots', message: `${tmp} is outside the workspace roots` },
      { type: 'terminal.error', terminalId: 't3', code: 'session_live', message: 'session is running in another process (pid 9)' },
    ]);
  });

  it('closes with SIGHUP and re-announces live terminals after a reconnect', async () => {
    sent.length = 0;
    mgr = new TerminalManager([root], (m) => sent.push(m), { liveSessions: async () => [], command: { exe: '/bin/sh', args: [] } });
    await mgr.open({ ...open, terminalId: 't4' });
    mgr.announce();
    expect(sent.filter((m) => m.type === 'terminal.opened')).toHaveLength(2);
    mgr.close('t4');
    await until(() => sent.some((m) => m.type === 'terminal.exit'), 'exit after close');
    expect(mgr.size).toBe(0);
  });
});
