import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { handleSessionsQuery, openTerminal, reduceMessage, stripAnsi, type SessionsDeps } from '../src/sessions.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'office-sessions-')));
const root = join(tmp, 'root');
const outside = join(tmp, 'outside');
mkdirSync(join(root, 'app'), { recursive: true });
mkdirSync(outside);
symlinkSync(outside, join(root, 'link'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const session = (sessionId: string, cwd: string) => ({ sessionId, summary: `s ${sessionId}`, lastModified: 1, cwd, gitBranch: 'main' });
const deps = (over: Partial<SessionsDeps> = {}): SessionsDeps => ({
  store: {
    listSessions: vi.fn(async () => [session('a', join(root, 'app')), session('b', outside), session('c', join(root, 'link')), session('d', join(root, 'gone'))]),
    getSessionMessages: vi.fn(async () => []),
    renameSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  } as unknown as SessionsDeps['store'],
  liveSessions: async () => [{ sessionId: 'a', pid: 7, kind: 'interactive', status: 'busy', name: 'app-1' }],
  spawnTerminal: vi.fn(async () => 'kitty'),
  ...over,
});

describe('sessions.request handling', () => {
  it('lists only sessions under the roots (symlinks resolved), merged with the live status', async () => {
    const d = deps();
    const out = await handleSessionsQuery({ kind: 'list', limit: 10 }, [root], d);
    expect(out.result).toEqual({
      kind: 'list',
      sessions: [
        { sessionId: 'a', title: 's a', cwd: join(root, 'app'), gitBranch: 'main', lastModified: 1, live: { pid: 7, kind: 'interactive', status: 'busy', name: 'app-1' } },
        { sessionId: 'd', title: 's d', cwd: join(root, 'gone'), gitBranch: 'main', lastModified: 1 },
      ],
    });
    expect(d.store.listSessions).toHaveBeenCalledWith({ includeProgrammatic: false, limit: 10 });
  });

  it('refuses a transcript or terminal for a directory outside the roots', async () => {
    const d = deps();
    const m = await handleSessionsQuery({ kind: 'messages', sessionId: 'c', dir: join(root, 'link'), offset: 0, limit: 5 }, [root], d);
    expect(m.error?.code).toBe('outside_roots');
    const o = await handleSessionsQuery({ kind: 'open', sessionId: 'b', dir: outside }, [root], d);
    expect(o.error?.code).toBe('outside_roots');
    expect(d.store.getSessionMessages).not.toHaveBeenCalled();
    expect(d.spawnTerminal).not.toHaveBeenCalled();
  });

  it('pages the transcript, reduced to turns', async () => {
    const raw = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi <system-reminder>noise</system-reminder>' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', content: 'out' }] } },
    ];
    const d = deps({ store: { listSessions: vi.fn(), getSessionMessages: vi.fn(async () => raw) } as unknown as SessionsDeps['store'] });
    const page = await handleSessionsQuery({ kind: 'messages', sessionId: 'a', dir: join(root, 'app'), offset: 0, limit: 3 }, [root], d);
    expect(page.result).toEqual({
      kind: 'messages',
      entries: [
        { uuid: 'u1', role: 'user', text: 'hi', tools: [] },
        { uuid: 'a1', role: 'assistant', text: 'hello', tools: ['Bash'] },
      ],
      nextOffset: 3,
    });
    const last = await handleSessionsQuery({ kind: 'messages', sessionId: 'a', dir: join(root, 'app'), offset: 3, limit: 5 }, [root], d);
    expect(last.result).toMatchObject({ nextOffset: null });
    expect(reduceMessage({ type: 'system', uuid: 's', message: {} })).toBeUndefined();
  });

  it('opens a terminal only for a session no process is running', async () => {
    const d = deps();
    const live = await handleSessionsQuery({ kind: 'open', sessionId: 'a', dir: join(root, 'app') }, [root], d);
    expect(live.error).toEqual({ code: 'session_live', message: 'session is running in another process (pid 7)' });
    const ok = await handleSessionsQuery({ kind: 'open', sessionId: 'd', dir: join(root, 'app') }, [root], d);
    expect(ok.result).toEqual({ kind: 'open', terminal: 'kitty' });
    expect(d.spawnTerminal).toHaveBeenCalledWith(join(root, 'app'), 'd');
    const none = await handleSessionsQuery({ kind: 'open', sessionId: 'd', dir: join(root, 'app') }, [root], deps({ spawnTerminal: async () => { throw new Error('no display'); } }));
    expect(none.error).toEqual({ code: 'no_terminal', message: 'no display' });
  });

  it('opens $TERMINAL with claude --resume as argv in the session folder, and refuses without a display', async () => {
    const fake = join(tmp, 'fake-terminal.sh');
    const log = join(tmp, 'argv.log');
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > ${log}\n`);
    chmodSync(fake, 0o755);
    expect(await openTerminal(join(root, 'app'), 'sess-1', { TERMINAL: fake, DISPLAY: ':0', PATH: process.env.PATH })).toBe(fake);
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([join(root, 'app'), '-e', 'claude', '--resume', 'sess-1']);
    await expect(openTerminal(join(root, 'app'), 'sess-1', { TERMINAL: fake, PATH: process.env.PATH })).rejects.toThrow('no display');
  });

  it('starts, stops and removes background sessions through the claude CLI', async () => {
    const calls: [string[], string | undefined][] = [];
    const d = deps({ claude: async (args, cwd) => { calls.push([args, cwd]); return args[0] === '--bg' ? 'Started.\n  claude attach ab12cd34    open in this terminal\n' : `${args[0]}ped ${args[1]}`; } });
    const start = await handleSessionsQuery({ kind: 'background', action: 'start', dir: join(root, 'app'), prompt: 'do it' }, [root], d);
    expect(start.result).toEqual({ kind: 'background', id: 'ab12cd34', output: 'Started.\n  claude attach ab12cd34    open in this terminal\n' });
    expect(calls[0]).toEqual([['--bg', 'do it'], join(root, 'app')]);
    expect((await handleSessionsQuery({ kind: 'background', action: 'start', dir: outside, prompt: 'x' }, [root], d)).error?.code).toBe('outside_roots');
    expect((await handleSessionsQuery({ kind: 'background', action: 'stop', id: 'ab12cd34' }, [root], d)).result).toMatchObject({ kind: 'background', output: 'stopped ab12cd34' });
    expect((await handleSessionsQuery({ kind: 'background', action: 'rm', id: 'ab12cd34' }, [root], d)).result).toMatchObject({ output: 'rmped ab12cd34' });
    const failing = deps({ claude: async () => { throw new Error('Workspace not trusted'); } });
    expect((await handleSessionsQuery({ kind: 'background', action: 'start', dir: join(root, 'app'), prompt: 'x' }, [root], failing)).error).toEqual({ code: 'claude_failed', message: 'Workspace not trusted' });
  });

  it('renames and deletes sessions under the roots, never a running one, and cleans background logs', async () => {
    const d = deps({ claude: async () => '\x1b[2J\x1b[H\x1b[38;2;1;2;3mClaude Code\x1b[39m v2\r\n─────\r\n❯ hello\r\n\r\n\r\nok\n' });
    expect((await handleSessionsQuery({ kind: 'rename', sessionId: 'd', dir: join(root, 'app'), title: 'New name' }, [root], d)).result).toEqual({ kind: 'rename' });
    expect(d.store.renameSession).toHaveBeenCalledWith('d', 'New name', { dir: join(root, 'app') });
    expect((await handleSessionsQuery({ kind: 'rename', sessionId: 'b', dir: outside, title: 'x' }, [root], d)).error?.code).toBe('outside_roots');
    expect((await handleSessionsQuery({ kind: 'delete', sessionId: 'a', dir: join(root, 'app') }, [root], d)).error?.code).toBe('session_live');
    expect((await handleSessionsQuery({ kind: 'delete', sessionId: 'd', dir: join(root, 'app') }, [root], d)).result).toEqual({ kind: 'delete' });
    expect(d.store.deleteSession).toHaveBeenCalledWith('d', { dir: join(root, 'app') });
    expect((await handleSessionsQuery({ kind: 'background', action: 'logs', id: 'ab12' }, [root], d)).result).toEqual({ kind: 'background', output: 'Claude Code v2\n\n❯ hello\n\nok' });
    expect(stripAnsi('plain')).toBe('plain');
  });
});
