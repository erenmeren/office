import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RunResult, RunSpec } from '@office/shared';
import { buildChildEnv } from '../claude/env.js';
import { redactSecrets } from '../redact.js';
import type { EventSink, RunControl, RuntimeAdapter } from '../types.js';
import { normalizeCodexEvent, type CodexEvent } from './normalize.js';

const CLAUDE_MODEL = /^(opus|sonnet|haiku)$|^claude/i;
const STDERR_KEEP = 4000;

/**
 * Why this run cannot go to Codex, or null. Codex has no per-call hook the platform can answer, so policies that need one
 * (destructive commands, sensitive paths) refuse it, and only task runs are supported (no office tools, no structured output).
 */
export function codexRefusal(spec: RunSpec): string | null {
  if (spec.kind !== 'task') return `the Codex runtime runs task runs only, not ${spec.kind} runs`;
  const p = spec.approvalPolicy;
  const unenforceable = p ? (['destructive_command', 'sensitive_path'] as const).filter((t) => p[t] !== 'auto') : [];
  if (unenforceable.length) {
    return `the project's approval policy for ${unenforceable.join(' and ')} is not "auto", and Codex has no per-command gate to enforce it; run this agent on Claude or set those policies to auto`;
  }
  return null;
}

/** Network only when nothing that needs it is gated: `open` access and auto `git_push` and `deploy` (Codex has no domain allowlist). */
export const codexNetwork = (spec: RunSpec) =>
  spec.networkAccess === 'open' && (!spec.approvalPolicy || (spec.approvalPolicy.git_push === 'auto' && spec.approvalPolicy.deploy === 'auto'));

/** `codex exec` argv: workspace-write sandbox, never asks, prompt on stdin. */
export function codexArgs(spec: RunSpec): string[] {
  const network = codexNetwork(spec);
  const model = spec.model && !CLAUDE_MODEL.test(spec.model) ? spec.model : undefined;
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '--cd', spec.cwd,
    '-c', 'approval_policy="never"',
    '-c', `sandbox_workspace_write.network_access=${network}`,
    '-c', `web_search="${network ? 'live' : 'disabled'}"`,
    // a worktree's commits are written to the repository's git dir
    ...(spec.gitDir ? ['--add-dir', spec.gitDir] : []),
    ...(model ? ['--model', model] : []),
    ...(spec.effort ? ['-c', `model_reasoning_effort="${spec.effort}"`] : []),
    ...(spec.resumeSdkSessionId ? ['resume', spec.resumeSdkSessionId] : []),
    '-',
  ];
}

/** Codex takes no system prompt on `exec`: a new thread gets the agent's instructions ahead of the task. */
export const codexPrompt = (spec: RunSpec) =>
  spec.resumeSdkSessionId
    ? spec.prompt
    : `${spec.systemPrompt}\n\nYou run under Agent Office without its messaging and memory tools; report everything in your final message.\n\n# Task\n\n${spec.prompt}`;

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 };

/**
 * Runs `codex exec --json` (the installed CLI, logged in on this machine). Interrupt and Pause stop the process and
 * return `suspended` with the thread id; the API resumes with `codex exec resume`. No live delivery, no office tools.
 * Usage is tokens only: cost stays 0 (a ChatGPT-plan login has no per-token price).
 */
export class CodexAdapter implements RuntimeAdapter {
  readonly name = 'codex' as const;
  constructor(private bin = 'codex') {}

  async run(spec: RunSpec, sink: EventSink, signal: AbortSignal, _tools?: unknown, control?: RunControl): Promise<RunResult> {
    const failed = (error: string, threadId?: string): RunResult => {
      sink.emit({ type: 'agent.failed', payload: { error } });
      return { status: 'failed', error, ...(threadId && { sdkSessionId: threadId }), usage: ZERO_USAGE };
    };
    const refusal = codexRefusal(spec);
    if (refusal) return failed(refusal);
    if (signal.aborted) {
      sink.emit({ type: 'agent.cancelled', payload: {} });
      return { status: 'cancelled', usage: ZERO_USAGE };
    }

    const started = Date.now();
    // own process group: the kill reaches the commands Codex started
    const child = spawn(this.bin, codexArgs(spec), { cwd: spec.cwd, env: buildChildEnv(process.env, spec), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stopped: 'cancelled' | 'suspended' | undefined;
    const stop = (why: 'cancelled' | 'suspended') => {
      stopped ??= why;
      if (why === 'suspended') sink.emit({ type: 'agent.waiting_reply', payload: { reason: 'interrupted' } });
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => stop('cancelled');
    const onInterrupt = () => stop('suspended');
    signal.addEventListener('abort', onAbort, { once: true });
    control?.interrupted.addEventListener('abort', onInterrupt, { once: true });

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-STDERR_KEEP)));
    const exited = new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        stderr += `\n${err.message}`;
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });
    child.stdin.on('error', () => {}); // a CLI that exits early closes stdin under us
    child.stdin.end(codexPrompt(spec));

    let threadId = spec.resumeSdkSessionId;
    let lastText = '';
    let turnFailed: string | undefined;
    let lastError: string | undefined;
    let completed = false;
    const usage = { ...ZERO_USAGE };
    for await (const line of createInterface({ input: child.stdout })) {
      let e: CodexEvent;
      try {
        e = JSON.parse(line) as CodexEvent;
      } catch {
        continue; // not an event line
      }
      for (const body of normalizeCodexEvent(e, spec.model)) sink.emit(body);
      if (e.type === 'thread.started') threadId = e.thread_id;
      else if (e.type === 'item.completed' && e.item.type === 'agent_message') lastText = e.item.text;
      else if (e.type === 'turn.completed') {
        completed = true;
        usage.inputTokens += e.usage.input_tokens;
        usage.outputTokens += e.usage.output_tokens + (e.usage.reasoning_output_tokens ?? 0);
        usage.numTurns += 1;
      } else if (e.type === 'turn.failed') turnFailed = e.error.message;
      else if (e.type === 'error') lastError = e.message;
    }
    const code = await exited;
    signal.removeEventListener('abort', onAbort);
    control?.interrupted.removeEventListener('abort', onInterrupt);
    usage.durationMs = Date.now() - started;

    if (stopped === 'cancelled') {
      sink.emit({ type: 'agent.cancelled', payload: {} });
      return { status: 'cancelled', ...(threadId && { sdkSessionId: threadId }), usage };
    }
    if (stopped === 'suspended') {
      return threadId ? { status: 'suspended', sdkSessionId: threadId, usage } : failed('interrupted before Codex started a thread');
    }
    if (completed && !turnFailed && code === 0) {
      const resultText = redactSecrets(lastText);
      sink.emit({ type: 'agent.completed', payload: { resultText, costUsd: 0, numTurns: usage.numTurns, durationMs: usage.durationMs } });
      return { status: 'succeeded', resultText, ...(threadId && { sdkSessionId: threadId }), usage };
    }
    const why = turnFailed ?? lastError ?? (stderr.trim().split('\n').at(-1) || `codex exited with code ${code}`);
    const result = failed(redactSecrets(`codex: ${why}`), threadId);
    return { ...result, usage };
  }
}
