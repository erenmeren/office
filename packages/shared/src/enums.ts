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
export const RunKindSchema = RunKind;

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
  'agent.skill.invoked',
  'agent.subagent.spawned',
  'agent.subagent.completed',
  'agent.message.sent',
  'agent.message.received',
  'agent.waiting_approval',
  'agent.waiting_reply',
  'agent.resumed',
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
  'agent.check.completed',
  'agent.integration.failed',
  'run.resume.failed',
  'mission.status.changed',
]);
export type EventType = z.infer<typeof EventType>;

export const TaskKindSchema = z.enum(['code', 'analysis', 'review']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const MissionStatusSchema = z.enum([
  'planning',
  'plan_failed',
  'awaiting_approval',
  'approved',
  'running',
  'review',
  'done',
  'failed',
  'cancelled',
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const ApprovalTypeSchema = z.enum([
  'plan',
  'git_push',
  'merge',
  'deploy',
  'destructive_command',
  'sensitive_path',
  'budget_exceeded',
]);
export type ApprovalType = z.infer<typeof ApprovalTypeSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalScopeSchema = z.enum(['once', 'task']);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const CheckStatusSchema = z.enum(['passed', 'failed', 'timeout', 'skipped']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const IntegrationStatusSchema = z.enum(['none', 'fast_forwarded', 'needs_integration']);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;
