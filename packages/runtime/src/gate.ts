import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { DEFAULT_DESTRUCTIVE_PATTERNS, GIT_OPTIONS, evaluateToolCall, normalizeCommand, type ApprovalDecision, type RunSpec } from '@office/shared';
import type { EventSink, ToolBridge } from './types.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);

// read-only runs: only these git subcommands (prefix match on `<sub> <args>`)
const READ_ONLY_GIT = [
  'status', 'log', 'diff', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch --list',
  'worktree list', 'remote -v', 'describe', 'cat-file',
];
// every `git [-C dir | -c k=v ...] <sub> <args>` in a command line, up to the next shell separator or quote;
// `git` may follow a quote (`sh -c "git …"`) or a path (`/usr/bin/git`, `\git`)
const GIT_CALL = new RegExp(String.raw`(?:^|[\s;&|(\`"'/\\])git(${GIT_OPTIONS})\s+([^;&|\n)\`"']*)`, 'g');

/** The first git call in `command` that is not on the read-only list; any `-c k=v` (config override) counts. */
function writingGitCall(command: string): string | undefined {
  for (const m of command.matchAll(GIT_CALL)) {
    const call = m[2]!.trim().replace(/\s+/g, ' ');
    if (/(?:^|\s)-c\s/.test(m[1]!)) return `${m[1]!.trim().replace(/\s+/g, ' ')} ${call}`;
    if (!READ_ONLY_GIT.some((r) => call === r || call.startsWith(`${r} `))) return call;
  }
  return undefined;
}

// commands that write files or run code the gate cannot read: denied on read-only runs wherever they start a simple command
const WRITERS = /(?:^|[;&|(`]\s*|\b(?:sudo|xargs|nice|env|time)\s+)(?:cp|mv|rm|mkdir|rmdir|touch|chmod|chown|ln|dd|install|truncate|rsync|wget|eval|source|\.|curl\s+(?:-\S*[oO]|.*--output)|sed\s+(?:-\S*i|--in-place)|(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|rm|uninstall|link|update|up)|pip3?\s+install)(?=\s|$)/;
// a redirection writes unless it is a descriptor copy (`2>&1`, `>&2`); `->`, `>=`, `<>` are not redirections
const REDIRECT = /(?<![-=<>&\d])\d*>(?![=&])/;

function mayWrite(command: string): boolean {
  const c = normalizeCommand(command);
  const lower = c.toLowerCase();
  return (
    DEFAULT_DESTRUCTIVE_PATTERNS.some((p) => lower.includes(p.toLowerCase())) ||
    REDIRECT.test(c.replace(/\d*>&\d/g, '')) ||
    /(?:^|[\s;&|(])tee\s/.test(c) ||
    WRITERS.test(c) ||
    // an allowed git read can still write with --output
    /\bgit\b[^;&|]*--output(?:=|\s)/.test(c)
  );
}

const PATH_INPUTS = ['file_path', 'notebook_path', 'path'] as const;
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * A run in a worktree (`spec.git`) may read and write only there and in its skills dir: the file tools are
 * checked here, Bash by the SDK sandbox. Relative paths resolve against the worktree.
 */
function outsideWorktree(spec: RunSpec, toolName: string, input: Record<string, unknown>): string | undefined {
  if (!spec.git || !(WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName))) return undefined;
  const roots = [spec.cwd, spec.skillsDir].filter((r): r is string => !!r).map((r) => resolve(r));
  for (const key of PATH_INPUTS) {
    const raw = input[key];
    if (typeof raw !== 'string' || !raw) continue;
    const path = resolve(spec.cwd, raw);
    if (!roots.some((r) => under(path, r))) return path;
  }
  return undefined;
}

/** Read-only and approval-policy checks shared by both adapters; the allowedTools check stays with the caller. */
export async function gateToolCall(
  spec: RunSpec,
  sink: EventSink,
  tools: ToolBridge | undefined,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ allow: true } | { allow: false; message: string }> {
  const outside = outsideWorktree(spec, toolName, input);
  if (outside) return { allow: false, message: `${toolName} outside the worktree is not permitted: ${outside}` };
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
