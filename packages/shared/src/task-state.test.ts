import { describe, expect, it } from 'vitest';
import { TaskStatus } from './enums.js';
import { InvalidTransitionError, TASK_TRANSITIONS, canTransitionTask, transitionTask } from './task-state.js';

describe('task state machine', () => {
  it('allows the happy path', () => {
    expect(transitionTask('ready', 'queued')).toBe('queued');
    expect(transitionTask('queued', 'running')).toBe('running');
    expect(transitionTask('running', 'review')).toBe('review');
    expect(transitionTask('review', 'done')).toBe('done');
  });

  it('allows waiting states to resume running', () => {
    expect(transitionTask('running', 'waiting_reply')).toBe('waiting_reply');
    expect(transitionTask('waiting_reply', 'running')).toBe('running');
    expect(transitionTask('running', 'waiting_approval')).toBe('waiting_approval');
    expect(transitionTask('waiting_approval', 'running')).toBe('running');
  });

  it('allows running -> ready (lease lost, retry) and running -> failed', () => {
    expect(transitionTask('running', 'ready')).toBe('ready');
    expect(transitionTask('running', 'failed')).toBe('failed');
  });

  it('allows queued -> failed (run lost or failed before it started, no attempts left)', () => {
    expect(transitionTask('queued', 'failed')).toBe('failed');
  });

  it('allows planned -> ready, planned -> blocked, ready -> cancelled', () => {
    expect(transitionTask('planned', 'ready')).toBe('ready');
    expect(transitionTask('planned', 'blocked')).toBe('blocked');
    expect(transitionTask('ready', 'cancelled')).toBe('cancelled');
  });

  it('rejects done -> running, failed -> done and ready -> done', () => {
    expect(() => transitionTask('done', 'running')).toThrow(InvalidTransitionError);
    expect(() => transitionTask('failed', 'done')).toThrow(InvalidTransitionError);
    expect(() => transitionTask('ready', 'done')).toThrow('Invalid task transition: ready -> done');
    expect(canTransitionTask('ready', 'done')).toBe(false);
    expect(canTransitionTask('failed', 'ready')).toBe(true);
  });

  it('allows review -> ready (reopen)', () => {
    expect(TASK_TRANSITIONS.review).toContain('ready');
    expect(transitionTask('review', 'ready')).toBe('ready');
  });

  it('every status appears as a key in TASK_TRANSITIONS', () => {
    for (const s of TaskStatus.options) expect(TASK_TRANSITIONS).toHaveProperty(s);
  });
});
