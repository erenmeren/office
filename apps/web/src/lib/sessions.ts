import type { OfficeEvent } from '@office/shared';
import type { SessionCommand, SessionFile } from './queries';

export interface CommandRow {
  seq: number;
  ts: string;
  command: string | null;
  /** undefined: no completion recorded and the run is not live */
  status?: 'running' | 'done' | 'failed';
  durationMs?: number;
  exitCode?: number;
  bySubagent?: string;
}

const pl = (e: OfficeEvent) => (e.payload ?? {}) as Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * Stored commands merged with `run:` events by seq. A command is paired with the Bash tool call of the
 * same command text (first unclaimed, in seq order) so its completion gives status and duration.
 */
export function commandRows(stored: SessionCommand[], events: OfficeEvent[], live: boolean): CommandRow[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const ends = new Map(sorted.filter((e) => e.type === 'agent.tool.completed' || e.type === 'agent.tool.failed').map((e) => [str(pl(e).toolUseId), e]));
  const starts = sorted.filter((e) => e.type === 'agent.tool.started' && pl(e).tool === 'Bash');
  const claimed = new Set<OfficeEvent>();
  const rows = new Map<number, CommandRow>(stored.map((c) => [c.seq, { ...c }]));
  for (const e of sorted.filter((e) => e.type === 'agent.command.executed')) {
    const p = pl(e);
    rows.set(e.seq, { ...rows.get(e.seq), seq: e.seq, ts: e.ts, command: str(p.command) ?? null, bySubagent: rows.get(e.seq)?.bySubagent ?? str(p.parentToolUseId) });
  }
  return [...rows.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((r) => {
      const start = starts.find((s) => !claimed.has(s) && str((pl(s).input as Record<string, unknown> | undefined)?.command) === r.command);
      if (start) claimed.add(start);
      const end = start && ends.get(str(pl(start).toolUseId));
      const status = end
        ? end.type === 'agent.tool.failed' ? 'failed' : 'done'
        : r.exitCode !== undefined ? (r.exitCode === 0 ? 'done' : 'failed')
        : live ? 'running' : undefined;
      const durationMs = r.durationMs ?? (end ? Date.parse(end.ts) - Date.parse(r.ts) : undefined);
      return { ...r, status, durationMs };
    });
}

/** Stored files plus paths from live `agent.file.changed` events not yet in the stored list. */
export function fileRows(stored: SessionFile[], events: OfficeEvent[]): SessionFile[] {
  const files = new Map(stored.map((f) => [f.path, f]));
  for (const e of events.filter((e) => e.type === 'agent.file.changed')) {
    const path = str(pl(e).path);
    if (path && !files.has(path)) files.set(path, { path, bySubagent: str(pl(e).parentToolUseId) });
  }
  return [...files.values()];
}

/** "1m 12s", "2h 3m", "8s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Token counts: "950", "21k", "1.2M". */
export function kTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const LIVE_STATUSES = ['running', 'waiting_reply', 'waiting_approval'];
/** The run statuses the API lists as live sessions. */
export const isLive = (status: string) => LIVE_STATUSES.includes(status);

export const clockTime = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** `[directory, file]`; the directory is '' for a bare file name. */
export function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf('/');
  return i === -1 ? ['', path] : [path.slice(0, i), path.slice(i + 1)];
}
