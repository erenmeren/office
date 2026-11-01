import { randomUUID } from 'node:crypto';
import { DEFAULT_DESTRUCTIVE_PATTERNS, evaluateToolCall, type ApprovalDecision, type RunSpec } from '@office/shared';
import type { EventSink, ToolBridge } from './types.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// read-only runs: only these git subcommands (prefix match on `<sub> <args>`)
const READ_ONLY_GIT = [
  'status', 'log', 'diff', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch --list',
  'worktree list', 'remote -v', 'describe', 'cat-file',
];
// every `git [-C dir | -c k=v ...] <sub> <args>` in a command line, up to the next shell separator
const GIT_CALL = /(?:^|[\s;&|(`])git(?:\s+(?:-[Cc]\s+\S+|--no-pager))*\s+([^;&|\n)`]*)/g;

/** The first git call in `command` that is not on the read-only list. */
function writingGitCall(command: string): string | undefined {
  for (const m of command.matchAll(GIT_CALL)) {
    const call = m[1]!.trim().replace(/\s+/g, ' ');
    if (!READ_ONLY_GIT.some((r) => call === r || call.startsWith(`${r} `))) return call;
  }
  return undefined;
}

function mayWrite(command: string): boolean {
  const lower = command.toLowerCase();
  return (
    DEFAULT_DESTRUCTIVE_PATTERNS.some((p) => lower.includes(p.toLowerCase())) ||
    [' > ', '>>', 'tee '].some((s) => command.includes(s))
  );
}

/** Read-only and approval-policy checks shared by both adapters; the allowedTools check stays with the caller. */
export async function gateToolCall(
  spec: RunSpec,
  sink: EventSink,
  tools: ToolBridge | undefined,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ allow: true } | { allow: false; message: string }> {
  if (spec.readOnlyCheckout) {
    if (WRITE_TOOLS.has(toolName)) return { allow: false, message: 'Read-only run: writes are not permitted' };
    if (toolName === 'Bash' && typeof input.command === 'string') {
      if (mayWrite(input.command)) return { allow: false, message: 'Read-only run: this command may write' };
      const git = writingGitCall(input.command);
      if (git !== undefined) return { allow: false, message: `Read-only run: git ${git} is not on the read-only git list` };
    }
  }
  if (!spec.approvalPolicy) return { allow: true };
  const v = evaluateToolCall(spec.approvalPolicy, toolName, input);
  if (v.verdict === 'allow') return { allow: true };
  if (v.verdict === 'block') return { allow: false, message: v.reason };
  const request = { requestId: randomUUID(), toolName, input, type: v.type, reason: v.reason };
  sink.emit({ type: 'agent.waiting_approval', payload: request });
  const d: ApprovalDecision = tools?.askApproval
    ? await tools.askApproval(request)
    : { requestId: request.requestId, decision: 'deny', message: 'No approval channel' };
  sink.emit({ type: 'agent.approval.resolved', payload: { requestId: request.requestId, decision: d.decision, message: d.message } });
  return d.decision === 'allow' ? { allow: true } : { allow: false, message: d.message ?? 'Denied by the owner' };
}
