import type { EventBody, OfficeToolName, RunResult, RunSpec, ToolCallResult } from '@office/shared';

export interface EventSink {
  emit(body: EventBody): void;
}

export interface ToolBridge {
  call(name: OfficeToolName, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface RuntimeAdapter {
  readonly name: 'claude' | 'fake';
  run(spec: RunSpec, sink: EventSink, signal: AbortSignal, tools?: ToolBridge): Promise<RunResult>;
}
