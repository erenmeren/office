import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { removeRunRoot, materializeSkills } from './skills.js';
import { redactSecrets, type RuntimeAdapter, type ToolBridge } from '@office/runtime';
import type { EventBody, OfficeEvent, OfficeToolName, RunResult, RunSpec, ToolCallResult, WorkerToApi } from '@office/shared';

const TOOL_TIMEOUT_MS = 30_000;
// message type of each messaging tool; send_message takes it from its args
const SENT_TYPES: Partial<Record<OfficeToolName, string>> = {
  send_message: 'message',
  reply_message: 'reply',
  request_help: 'help_request',
  handoff_task: 'handoff',
  escalate_to_chief: 'escalation',
};

/** The event recorded after a successful office tool call, if any. */
function derivedEvent(name: OfficeToolName, args: Record<string, unknown>, result: unknown): EventBody | null {
  const r = (result ?? {}) as Record<string, unknown>;
  const sentType = SENT_TYPES[name];
  if (sentType) {
    const to = typeof args.to === 'string' ? args.to : undefined;
    const type = typeof args.type === 'string' ? args.type : sentType;
    return { type: 'agent.message.sent', payload: { messageId: r.messageId, conversationId: r.conversationId, to, type } };
  }
  if (name === 'read_inbox') {
    return { type: 'agent.message.received', payload: { count: Array.isArray(r.messages) ? r.messages.length : 0 } };
  }
  if (name === 'propose_memory') return { type: 'memory.proposed', payload: { entryId: r.entryId } };
  return null;
}

const NO_USAGE: RunResult['usage'] = { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 };

/** True if `path` is `root` or inside it, compared by path segment (`/a/bc` is not under `/a/b`). */
function isUnderRoot(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : r + '/');
}

function realCwd(cwd: string): string | null {
  try {
    return realpathSync(cwd);
  } catch {
    return null;
  }
}

export class RunExecutor {
  private active = new Map<string, AbortController>();
  private pendingTools = new Map<string, { resolve: (r: ToolCallResult) => void; timer: NodeJS.Timeout }>();

  constructor(
    private adapter: RuntimeAdapter,
    private send: (msg: WorkerToApi) => void,
    private workspaceRoots: string[],
    private runsDir: string,
    private toolTimeoutMs = TOOL_TIMEOUT_MS,
  ) {}

  /** Settles a pending office tool call with the API's answer; unknown or late call ids are ignored. */
  resolveTool(callId: string, result: ToolCallResult): void {
    const pending = this.pendingTools.get(callId);
    if (!pending) return;
    this.pendingTools.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /** The socket closed: every pending call fails now, its answer could no longer arrive. */
  failPendingTools(): void {
    for (const callId of [...this.pendingTools.keys()]) {
      this.resolveTool(callId, { ok: false, code: 'disconnected', error: 'worker disconnected' });
    }
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  cancel(runId: string): void {
    this.active.get(runId)?.abort();
  }

  accept(spec: RunSpec): void {
    if (this.active.has(spec.runId)) return;
    // symlinks are resolved so a link inside a root cannot point the run outside it
    const cwd = realCwd(spec.cwd);
    if (!cwd || !this.workspaceRoots.some((r) => isUnderRoot(cwd, r))) {
      this.send({ type: 'run.rejected', runId: spec.runId, reason: 'cwd outside allowed roots' });
      return;
    }
    const controller = new AbortController();
    this.active.set(spec.runId, controller);
    this.send({ type: 'run.accepted', runId: spec.runId });
    void this.execute(spec, controller.signal).finally(() => this.active.delete(spec.runId));
  }

  private async execute(spec: RunSpec, signal: AbortSignal) {
    // one session per run; a resumed run continues the session's seq after the API's startSeq
    let seq = spec.startSeq ?? 0;
    const emit = (body: EventBody) => {
      const event: OfficeEvent = {
        ...body,
        seq: ++seq,
        ts: new Date().toISOString(),
        sessionId: spec.sessionId,
        runId: spec.runId,
        agentId: spec.agentId,
        projectId: spec.projectId,
      };
      this.send({ type: 'run.event', event: redactSecrets(event) });
    };
    const tools: ToolBridge = {
      call: async (name, args) => {
        const callId = randomUUID();
        const result = await new Promise<ToolCallResult>((resolve) => {
          const timer = setTimeout(
            () => this.resolveTool(callId, { ok: false, code: 'timeout', error: 'tool call timed out' }),
            this.toolTimeoutMs,
          );
          this.pendingTools.set(callId, { resolve, timer });
          this.send({ type: 'tool.call', runId: spec.runId, sessionId: spec.sessionId, callId, name, args });
        });
        const derived = result.ok ? derivedEvent(name, args, result.result) : null;
        if (derived) emit(derived);
        return result;
      },
    };
    let result: RunResult;
    try {
      // summary runs need no skills, so no run root is created for them
      const skillsDir = spec.kind === 'summary' ? undefined : await materializeSkills(this.runsDir, spec.runId, spec.skills);
      result = await this.adapter.run(skillsDir ? { ...spec, skillsDir } : spec, { emit }, signal, tools);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emit({ type: 'agent.failed', payload: { error } });
      result = { status: 'failed', error, usage: NO_USAGE };
    } finally {
      await removeRunRoot(this.runsDir, spec.runId).catch(() => {});
    }
    this.send({ type: 'run.result', runId: spec.runId, sessionId: spec.sessionId, result });
  }
}
