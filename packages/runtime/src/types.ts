import type { ApprovalDecision, ApprovalRequest, EventBody, OfficeToolName, RunResult, RunSpec, ToolCallResult } from '@office/shared';

export interface EventSink {
  emit(body: EventBody): void;
}

export interface ToolBridge {
  call(name: OfficeToolName, args: Record<string, unknown>): Promise<ToolCallResult>;
  askApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface RuntimeAdapter {
  readonly name: 'claude' | 'fake';
  run(spec: RunSpec, sink: EventSink, signal: AbortSignal, tools?: ToolBridge): Promise<RunResult>;
}
