import type { EventBody, RunResult, RunSpec } from '@office/shared';

export interface EventSink {
  emit(body: EventBody): void;
}

export interface RuntimeAdapter {
  readonly name: 'claude' | 'fake';
  run(spec: RunSpec, sink: EventSink, signal: AbortSignal): Promise<RunResult>;
}
