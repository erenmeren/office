import type { OfficeEvent, RunStatus, TaskStatus } from '@office/shared';

// Hub message shapes; Task 7 moves the UI-facing schemas into @office/shared.
export type RunStatusChanged = { type: 'run.status.changed'; runId: string; status: RunStatus };
export type TaskStatusChanged = {
  type: 'task.status.changed';
  task: { id: string; status: TaskStatus; updatedAt: string };
};
export type HubMessage = OfficeEvent | RunStatusChanged | TaskStatusChanged;

type Listener = (message: unknown) => void;

/** In-process pub/sub. Topics: `run:<runId>`, `task:<taskId>`, `global`. */
export class EventHub {
  private topics = new Map<string, Set<Listener>>();

  publish(topic: string, message: unknown): void {
    for (const fn of this.topics.get(topic) ?? []) {
      try {
        fn(message);
      } catch {
        // a broken subscriber must not break the publisher
      }
    }
  }

  subscribe(topic: string, fn: Listener): () => void {
    let set = this.topics.get(topic);
    if (!set) this.topics.set(topic, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.topics.delete(topic);
    };
  }
}
