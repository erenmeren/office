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
  /** Present only when `claude agents --json` lists the session right now. */
  live: z.object({ pid: z.number(), kind: z.string(), status: z.string(), name: z.string().optional() }).optional(),
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
]);
export type SessionsQuery = z.infer<typeof SessionsQuerySchema>;

export const SessionsResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), sessions: z.array(ClaudeSessionInfoSchema) }),
  /** `nextOffset` is null once the transcript is exhausted. */
  z.object({ kind: z.literal('messages'), entries: z.array(TranscriptEntrySchema), nextOffset: z.number().int().nullable() }),
  z.object({ kind: z.literal('open'), terminal: z.string() }),
]);
export type SessionsResult = z.infer<typeof SessionsResultSchema>;

export const SessionsErrorCodeSchema = z.enum(['outside_roots', 'session_live', 'no_terminal', 'internal_error']);
export type SessionsErrorCode = z.infer<typeof SessionsErrorCodeSchema>;
