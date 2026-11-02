import type { ApprovalDecision, ApprovalRequest, EventBody, OfficeToolName, RunResult, RunSpec, ToolCallResult } from '@office/shared';

export interface EventSink {
  emit(body: EventBody): void;
}

export interface ToolBridge {
  call(name: OfficeToolName, args: Record<string, unknown>): Promise<ToolCallResult>;
  askApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/** `interrupted` fires on the owner's "interrupt and send": the adapter ends the turn with a `suspended` result. */
export interface RunControl {
  interrupted: AbortSignal;
}

export interface RuntimeAdapter {
  readonly name: 'claude' | 'fake';
  run(spec: RunSpec, sink: EventSink, signal: AbortSignal, tools?: ToolBridge, control?: RunControl): Promise<RunResult>;
}
