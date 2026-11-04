import { z } from 'zod';

/** An Office-managed manual Claude Code session: a real `claude` process under a PTY on the local worker. */
export const TerminalStatusSchema = z.enum(['starting', 'running', 'exited']);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

export const TerminalErrorCodeSchema = z.enum(['outside_roots', 'session_live', 'spawn_failed', 'unknown_terminal']);
export type TerminalErrorCode = z.infer<typeof TerminalErrorCodeSchema>;

/** One keystroke batch; capped so a pasted file cannot flood the worker. */
export const TERMINAL_INPUT_MAX = 64 * 1024;
export const TerminalSizeSchema = z.object({ cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) });

/** Sent by the worker when a terminal starts, and again for every live terminal after a reconnect (idempotent). */
export const TerminalOpenedSchema = z.object({
  type: z.literal('terminal.opened'),
  terminalId: z.string().min(1),
  pid: z.number().int(),
  dir: z.string().min(1),
  claudeSessionId: z.string().min(1),
  resumedSessionId: z.string().optional(),
  startedAt: z.iso.datetime(),
});
export type TerminalOpened = z.infer<typeof TerminalOpenedSchema>;
