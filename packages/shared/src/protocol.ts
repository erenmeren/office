import { z } from 'zod';
import { ApprovalScopeSchema, ApprovalStatusSchema, ApprovalTypeSchema, MissionStatusSchema, RunStatus, TaskStatus } from './enums.js';
import { ApprovalDecisionSchema, ApprovalRequestSchema } from './approval.js';
import { MemoryStatusSchema } from './memory.js';
import { MessageViewSchema } from './messaging.js';
import { ToolCallResultSchema } from './office-tools.js';
import { OfficeEventSchema } from './events.js';
import { RunResultSchema, RunSpecSchema } from './run-spec.js';
import { SessionsErrorCodeSchema, SessionsQuerySchema, SessionsResultSchema } from './claude-sessions.js';
import { TERMINAL_INPUT_MAX, TerminalErrorCodeSchema, TerminalOpenedSchema, TerminalSizeSchema } from './terminals.js';

export const WorkerTagSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

export const WorkerToApiSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    enrollToken: z.string().optional(),
    credential: z.string().optional(),
    name: z.string(),
    capacity: z.number(),
    allowedRoots: z.array(z.string()),
    activeRunIds: z.array(z.string()),
    tags: z.array(WorkerTagSchema).default([]),
    canClone: z.boolean().default(false),
    /** The worker host's identity; a worker is local only when it equals the API's (old workers omit it). */
    machineId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal('heartbeat'),
    capacity: z.number(),
    activeRunIds: z.array(z.string()),
  }),
  z.object({ type: z.literal('run.accepted'), runId: z.string() }),
  z.object({ type: z.literal('run.rejected'), runId: z.string(), reason: z.string() }),
  z.object({ type: z.literal('run.event'), event: OfficeEventSchema }),
  z.object({
    type: z.literal('run.result'),
    runId: z.string(),
    sessionId: z.string(),
    result: RunResultSchema,
  }),
  z.object({
    type: z.literal('tool.call'),
    runId: z.string(),
    sessionId: z.string(),
    callId: z.string(),
    name: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal('approval.request'),
    runId: z.string(),
    sessionId: z.string(),
    request: ApprovalRequestSchema,
  }),
  /** Asked right before a fast-forward; the API answers `integration.allowed`. */
  z.object({ type: z.literal('integration.check'), runId: z.string() }),
  /** `ok: false`: the run cannot take it any more; the delivery stays pending for the next run boundary. */
  z.object({ type: z.literal('run.message.ack'), runId: z.string(), messageId: z.string(), ok: z.boolean() }),
  /** Answer to `sessions.request` (external Claude Code sessions on this worker's machine). */
  z.object({
    type: z.literal('sessions.response'),
    requestId: z.string(),
    result: SessionsResultSchema.optional(),
    error: z.object({ code: SessionsErrorCodeSchema, message: z.string() }).optional(),
  }),
  /** Manual sessions (unified sessions Phase 2): a `claude` process under a PTY on this worker. */
  TerminalOpenedSchema,
  z.object({ type: z.literal('terminal.error'), terminalId: z.string(), code: TerminalErrorCodeSchema, message: z.string() }),
  /** base64 PTY output; dropped while disconnected (the API keeps the scrollback) */
  z.object({ type: z.literal('terminal.output'), terminalId: z.string(), data: z.string() }),
  z.object({ type: z.literal('terminal.exit'), terminalId: z.string(), exitCode: z.number().int().nullable(), signal: z.number().int().optional() }),
  /** Answer to `roots.add`: the worker's workspace roots now (unchanged on error). */
  z.object({ type: z.literal('roots.changed'), requestId: z.string().optional(), allowedRoots: z.array(z.string()), error: z.string().optional() }),
]);
export type WorkerToApi = z.infer<typeof WorkerToApiSchema>;

export const ApiToWorkerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), workerId: z.string(), credential: z.string().optional() }),
  z.object({ type: z.literal('run.assign'), spec: RunSpecSchema }),
  z.object({ type: z.literal('run.cancel'), runId: z.string() }),
  /** Owner "interrupt and send": end the SDK turn with a `suspended` result; the API resumes the run with the owner's message. */
  z.object({ type: z.literal('run.interrupt'), runId: z.string() }),
  /** A message for the agent of a running run, delivered into its live session. */
  z.object({ type: z.literal('run.message'), runId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ type: z.literal('tool.result'), callId: z.string(), result: ToolCallResultSchema }),
  z.object({ type: z.literal('approval.result'), runId: z.string(), decision: ApprovalDecisionSchema }),
  /** The run.result was applied (or was already, for a resend); the worker may drop it from its outbox. */
  z.object({ type: z.literal('run.result.ack'), runId: z.string() }),
  z.object({ type: z.literal('integration.allowed'), runId: z.string(), ok: z.boolean(), reason: z.string().optional() }),
  /** Read the machine's Claude Code sessions (list, transcript page, open in a terminal); answered by `sessions.response`. */
  z.object({ type: z.literal('sessions.request'), requestId: z.string(), query: SessionsQuerySchema }),
  /** Start `claude` (with `--session-id` or `--resume`) under a PTY in `dir`; answered by `terminal.opened` or `terminal.error`. */
  z.object({
    type: z.literal('terminal.open'),
    terminalId: z.string().min(1),
    dir: z.string().min(1),
    claudeSessionId: z.string().min(1),
    resumeSessionId: z.string().optional(),
    /** with `resumeSessionId`: `--fork-session`, the copy gets `claudeSessionId`; the source may keep running */
    fork: z.boolean().default(false),
    /** background session (`claude agents`) to `claude attach`; no new session is created */
    attachId: z.string().optional(),
    ...TerminalSizeSchema.shape,
  }),
  z.object({ type: z.literal('terminal.input'), terminalId: z.string(), data: z.string().max(TERMINAL_INPUT_MAX) }),
  z.object({ type: z.literal('terminal.resize'), terminalId: z.string(), ...TerminalSizeSchema.shape }),
  z.object({ type: z.literal('terminal.close'), terminalId: z.string() }),
  /** The owner made a project on `path`: add it to the workspace roots (persisted on the worker); answered by `roots.changed`. */
  z.object({ type: z.literal('roots.add'), requestId: z.string(), path: z.string().min(1) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ApiToWorker = z.infer<typeof ApiToWorkerSchema>;

export const UiClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    topic: z.string().regex(/^(global|run:.+|task:.+|conversation:.+|mission:.+|project:.+|terminal:.+)$/),
    afterSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), topic: z.string() }),
  /** keystrokes for an Office terminal the owner is attached to (Phase 2) */
  z.object({ type: z.literal('terminal.input'), terminalId: z.string(), data: z.string().max(TERMINAL_INPUT_MAX) }),
  z.object({ type: z.literal('terminal.resize'), terminalId: z.string(), ...TerminalSizeSchema.shape }),
  /** take the keyboard from the tab that has it (subscribing takes it too) */
  z.object({ type: z.literal('terminal.control'), terminalId: z.string() }),
]);
export type UiClientMessage = z.infer<typeof UiClientMessageSchema>;

export const ApprovalViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  missionId: z.string().nullable(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  type: ApprovalTypeSchema,
  status: ApprovalStatusSchema,
  scope: ApprovalScopeSchema.nullable(),
  toolName: z.string().nullable(),
  input: z.unknown(),
  reason: z.string(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const UiServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), topic: z.string(), event: OfficeEventSchema }),
  z.object({
    type: z.literal('task.status.changed'),
    topic: z.string(),
    task: z.object({ id: z.string(), status: TaskStatus, updatedAt: z.iso.datetime() }),
  }),
  z.object({ type: z.literal('run.status.changed'), topic: z.string(), runId: z.string(), status: RunStatus }),
  z.object({ type: z.literal('message.created'), topic: z.string(), message: MessageViewSchema }),
  z.object({
    type: z.literal('memory.changed'),
    topic: z.literal('global'),
    entryId: z.string(),
    status: MemoryStatusSchema,
  }),
  z.object({ type: z.literal('approval.changed'), topic: z.string(), approval: ApprovalViewSchema }),
  z.object({
    type: z.literal('mission.status.changed'),
    topic: z.string(),
    mission: z.object({ id: z.string(), status: MissionStatusSchema, updatedAt: z.iso.datetime() }),
  }),
  z.object({ type: z.literal('replay.done'), topic: z.string(), lastSeq: z.number().int().nonnegative() }),
  /** base64 PTY output on `terminal:<id>`; the first message after a subscribe carries the scrollback */
  z.object({ type: z.literal('terminal.output'), topic: z.string(), data: z.string() }),
  z.object({ type: z.literal('terminal.exit'), topic: z.string(), exitCode: z.number().int().nullable() }),
  /** whether this socket holds the keyboard of the terminal; one tab types at a time */
  z.object({ type: z.literal('terminal.control'), topic: z.string(), yours: z.boolean() }),
  /** on `global`: a terminal started or ended, so lists refetch */
  z.object({ type: z.literal('terminal.changed'), topic: z.literal('global'), terminalId: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type UiServerMessage = z.infer<typeof UiServerMessageSchema>;
