import { z } from 'zod';

export const TaskStatus = z.enum([
  'planned',
  'ready',
  'queued',
  'running',
  'waiting_reply',
  'waiting_approval',
  'review',
  'done',
  'failed',
  'cancelled',
  'blocked',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const RunStatus = z.enum([
  'queued',
  'running',
  'waiting_reply',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'lost',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunKind = z.enum(['task', 'inbox', 'plan', 'review', 'summary', 'chat']);
export type RunKind = z.infer<typeof RunKind>;

export const WorkerStatus = z.enum(['pending', 'online', 'offline', 'revoked']);
export type WorkerStatus = z.infer<typeof WorkerStatus>;

export const EventType = z.enum([
  'agent.started',
  'agent.thinking',
  'agent.text',
  'agent.tool.started',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.file.changed',
  'agent.command.executed',
  'agent.subagent.spawned',
  'agent.subagent.completed',
  'agent.message.sent',
  'agent.message.received',
  'agent.waiting_approval',
  'agent.approval.resolved',
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
  'task.status.changed',
  'run.status.changed',
  'run.lease.lost',
  'worker.connected',
  'worker.disconnected',
  'memory.proposed',
  'memory.verified',
]);
export type EventType = z.infer<typeof EventType>;
