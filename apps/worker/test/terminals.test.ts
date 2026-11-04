import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { WorkerToApi } from '@office/shared';
import { claudeArgs, TerminalManager } from '../src/terminals.js';

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
const open = { type: 'terminal.open' as const, dir: root, claudeSessionId: 'sid-1', fork: false, cols: 80, rows: 24 };
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
    // a fork of a running session is fine: it writes a new session
    await mgr.open({ ...open, terminalId: 't3f', resumeSessionId: 'live-1', fork: true });
    expect(sent.find((m) => m.type === 'terminal.opened')).toMatchObject({ terminalId: 't3f' });
    expect(sent.filter((m) => m.type === 'terminal.error')).toEqual([
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

  it('keeps output while disconnected and flushes it after the re-announce', async () => {
    sent.length = 0;
    let connected = false;
    mgr = new TerminalManager([root], (m) => sent.push(m), { liveSessions: async () => [], command: { exe: '/bin/sh', args: [] }, connected: () => connected });
    await mgr.open({ ...open, terminalId: 't5' });
    mgr.input('t5', 'echo buffered-line\n');
    await new Promise((r) => setTimeout(r, 300));
    expect(output('t5')).toBe('');
    connected = true;
    mgr.announce();
    expect(sent.map((m) => m.type)).toEqual(['terminal.opened', 'terminal.opened', 'terminal.output']);
    expect(output('t5')).toContain('buffered-line');
  });

  it('builds the claude argv for new, resumed, forked and attached sessions', () => {
    expect(claudeArgs({ claudeSessionId: 'n', fork: false })).toEqual(['--session-id', 'n']);
    expect(claudeArgs({ claudeSessionId: 'o', resumeSessionId: 'o', fork: false })).toEqual(['--resume', 'o']);
    expect(claudeArgs({ claudeSessionId: 'n', resumeSessionId: 'o', fork: true })).toEqual(['--resume', 'o', '--fork-session', '--session-id', 'n']);
    expect(claudeArgs({ claudeSessionId: 'x', fork: false, attachId: 'ab12' })).toEqual(['attach', 'ab12']);
  });
});
