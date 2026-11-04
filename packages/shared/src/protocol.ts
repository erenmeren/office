import { z } from 'zod';
import { ApprovalScopeSchema, ApprovalStatusSchema, ApprovalTypeSchema, MissionStatusSchema, RunStatus, TaskStatus } from './enums.js';
import { ApprovalDecisionSchema, ApprovalRequestSchema } from './approval.js';
import { MemoryStatusSchema } from './memory.js';
import { MessageViewSchema } from './messaging.js';
import { ToolCallResultSchema } from './office-tools.js';
import { OfficeEventSchema } from './events.js';
import { RunResultSchema, RunSpecSchema } from './run-spec.js';
import { SessionsErrorCodeSchema, SessionsQuerySchema, SessionsResultSchema } from './claude-sessions.js';

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
  /** Answer to `sessions.request` (external Claude Code sessions on this worker's machine). */
  z.object({
    type: z.literal('sessions.response'),
    requestId: z.string(),
    result: SessionsResultSchema.optional(),
    error: z.object({ code: SessionsErrorCodeSchema, message: z.string() }).optional(),
  }),
]);
export type WorkerToApi = z.infer<typeof WorkerToApiSchema>;

export const ApiToWorkerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), workerId: z.string(), credential: z.string().optional() }),
  z.object({ type: z.literal('run.assign'), spec: RunSpecSchema }),
  z.object({ type: z.literal('run.cancel'), runId: z.string() }),
  /** Owner "interrupt and send": end the SDK turn with a `suspended` result; the API resumes the run with the owner's message. */
  z.object({ type: z.literal('run.interrupt'), runId: z.string() }),
  z.object({ type: z.literal('tool.result'), callId: z.string(), result: ToolCallResultSchema }),
  z.object({ type: z.literal('approval.result'), runId: z.string(), decision: ApprovalDecisionSchema }),
  /** The run.result was applied (or was already, for a resend); the worker may drop it from its outbox. */
  z.object({ type: z.literal('run.result.ack'), runId: z.string() }),
  z.object({ type: z.literal('integration.allowed'), runId: z.string(), ok: z.boolean(), reason: z.string().optional() }),
  /** Read the machine's Claude Code sessions (list, transcript page, open in a terminal); answered by `sessions.response`. */
  z.object({ type: z.literal('sessions.request'), requestId: z.string(), query: SessionsQuerySchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ApiToWorker = z.infer<typeof ApiToWorkerSchema>;

export const UiClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    topic: z.string().regex(/^(global|run:.+|task:.+|conversation:.+|mission:.+|project:.+)$/),
    afterSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), topic: z.string() }),
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
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type UiServerMessage = z.infer<typeof UiServerMessageSchema>;
