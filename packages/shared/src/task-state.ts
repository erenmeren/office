import type { TaskStatus } from './enums.js';

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  planned: ['ready', 'blocked', 'cancelled'],
  ready: ['queued', 'cancelled', 'blocked'],
  queued: ['running', 'ready', 'cancelled'],
  running: ['waiting_reply', 'waiting_approval', 'review', 'failed', 'cancelled', 'ready'],
  waiting_reply: ['running', 'failed', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancelled'],
  review: ['done', 'running', 'failed'],
  blocked: ['ready', 'cancelled'],
  done: [],
  failed: ['ready'], // explicit owner retry
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransitionTask(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}
