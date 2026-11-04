import { z } from 'zod';

/** A Claude Code session found on a worker's machine (SDK `listSessions`), outside Office's own runs. */
export const ClaudeSessionInfoSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string(),
  cwd: z.string().min(1),
  gitBranch: z.string().optional(),
  createdAt: z.number().optional(),
  lastModified: z.number(),
  fileSize: z.number().optional(),
  /** Present only when `claude agents --json` lists the session right now (`--all`: finished background ones too). */
  live: z.object({
    pid: z.number().optional(),
    kind: z.string(),
    status: z.string().optional(),
    /** background sessions: `running`, `done`, `failed`, ... and the short id `claude attach|stop|rm` take */
    state: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
  }).optional(),
});
export type ClaudeSessionInfo = z.infer<typeof ClaudeSessionInfoSchema>;

/** One transcript turn, reduced on the worker: no raw API objects cross the wire. */
export const TranscriptEntrySchema = z.object({
  uuid: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  tools: z.array(z.string()),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const SessionsQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), limit: z.number().int().min(1).max(500).default(200) }),
  z.object({
    kind: z.literal('messages'),
    sessionId: z.string().min(1),
    dir: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  z.object({ kind: z.literal('open'), sessionId: z.string().min(1), dir: z.string().min(1) }),
  /** background sessions (`claude --bg`): `start` needs `dir` and `prompt`, `stop` and `rm` need `id` */
  z.object({
    kind: z.literal('background'),
    action: z.enum(['start', 'stop', 'rm']),
    dir: z.string().min(1).optional(),
    prompt: z.string().min(1).max(20_000).optional(),
    id: z.string().min(1).max(64).optional(),
  }),
]);
export type SessionsQuery = z.infer<typeof SessionsQuerySchema>;

export const SessionsResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), sessions: z.array(ClaudeSessionInfoSchema) }),
  /** `nextOffset` is null once the transcript is exhausted. */
  z.object({ kind: z.literal('messages'), entries: z.array(TranscriptEntrySchema), nextOffset: z.number().int().nullable() }),
  z.object({ kind: z.literal('open'), terminal: z.string() }),
  /** `id` is the short id `claude attach|stop|rm` take (start only) */
  z.object({ kind: z.literal('background'), id: z.string().optional(), output: z.string() }),
]);
export type SessionsResult = z.infer<typeof SessionsResultSchema>;

export const SessionsErrorCodeSchema = z.enum(['outside_roots', 'session_live', 'no_terminal', 'claude_failed', 'internal_error']);
export type SessionsErrorCode = z.infer<typeof SessionsErrorCodeSchema>;
