'use client';

import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { uiSocket } from '@/lib/ws';

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** An xterm view attached to an Office terminal over `/ws/ui`: scrollback on attach, keystrokes and resizes back. */
export function OfficeTerminal({ terminalId, live }: { terminalId: string; live: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    // browser only: xterm touches `window` at import time
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      if (disposed) return;
      const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'var(--font-mono, ui-monospace, monospace)', theme: { background: '#0f0d1a' }, scrollback: 5000 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      const socket = uiSocket();
      const resize = () => socket.send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows });
      cleanups.push(term.onData((data) => socket.send({ type: 'terminal.input', terminalId, data })).dispose);
      cleanups.push(term.onResize(resize).dispose);
      cleanups.push(
        socket.subscribe(`terminal:${terminalId}`, 0, (m) => {
          if (m.type === 'terminal.output') term.write(decode(m.data));
          else if (m.type === 'terminal.exit') term.write(`\r\n\x1b[2m[session ended${m.exitCode === null ? '' : `, exit ${m.exitCode}`}]\x1b[0m\r\n`);
        }),
      );
      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(el);
      cleanups.push(() => observer.disconnect());
      resize();
      term.focus();
      cleanups.push(() => term.dispose());
    });
    return () => {
      disposed = true;
      for (const c of cleanups.splice(0)) c();
    };
  }, [terminalId]);
  return <div ref={host} aria-label="Terminal" role="application" className={live ? 'h-[520px] w-full' : 'h-[520px] w-full opacity-70'} />;
}
