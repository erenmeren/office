'use client';

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';
import { uiSocket } from '@/lib/ws';

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * An xterm view attached to an Office terminal over `/ws/ui`: scrollback on attach, keystrokes and resizes back.
 * One tab holds the keyboard at a time; another tab's view stays live and can take it.
 */
export function OfficeTerminal({ terminalId, live, className }: { terminalId: string; live: boolean; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [control, setControl] = useState(true);
  const stdin = useRef<(on: boolean) => void>(() => {});
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
      stdin.current = (on) => (term.options.disableStdin = !on);
      const socket = uiSocket();
      const resize = () => socket.send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows });
      cleanups.push(term.onData((data) => socket.send({ type: 'terminal.input', terminalId, data })).dispose);
      cleanups.push(term.onResize(resize).dispose);
      cleanups.push(
        socket.subscribe(`terminal:${terminalId}`, 0, (m) => {
          if (m.type === 'terminal.output') term.write(decode(m.data));
          else if (m.type === 'terminal.exit') term.write(`\r\n\x1b[2m[session ended${m.exitCode === null ? '' : `, exit ${m.exitCode}`}]\x1b[0m\r\n`);
          else if (m.type === 'terminal.control') {
            setControl(m.yours);
            term.options.disableStdin = !m.yours;
          }
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
  return (
    <div className={`relative ${className ?? 'h-[520px]'} w-full`}>
      <div ref={host} aria-label="Terminal" role="application" className={live ? 'h-full w-full' : 'h-full w-full opacity-70'} />
      {!control && live && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-white/13 bg-black/70 px-3 py-2 text-[13px] text-ink-2" role="status">
          <span>Another tab is typing here. You see everything; keystrokes are off.</span>
          <Button size="xs" variant="secondary" onClick={() => uiSocket().send({ type: 'terminal.control', terminalId })}>
            Take control
          </Button>
        </div>
      )}
    </div>
  );
}
