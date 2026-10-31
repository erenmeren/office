import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactSecrets, type RuntimeAdapter } from '@office/runtime';
import type { EventBody, OfficeEvent, RunResult, RunSpec, WorkerToApi } from '@office/shared';

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

  constructor(
    private adapter: RuntimeAdapter,
    private send: (msg: WorkerToApi) => void,
    private workspaceRoots: string[],
  ) {}

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
    // one session per run, so the run-local counter is the session's seq
    let seq = 0;
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
    let result: RunResult;
    try {
      result = await this.adapter.run(spec, { emit }, signal);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emit({ type: 'agent.failed', payload: { error } });
      result = { status: 'failed', error, usage: NO_USAGE };
    }
    this.send({ type: 'run.result', runId: spec.runId, sessionId: spec.sessionId, result });
  }
}
