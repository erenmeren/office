import { execFileSync } from 'node:child_process';
import type { Runtime } from '@office/shared';
import { ClaudeAdapter } from './claude/adapter.js';
import { CodexAdapter } from './codex/adapter.js';
import { FakeAdapter } from './fake/adapter.js';
import type { RuntimeAdapter } from './types.js';

export type { EventSink, RunControl, RuntimeAdapter, ToolBridge } from './types.js';
export { redactSecrets } from './redact.js';
export { machineId } from './machine-id.js';
export { FakeAdapter } from './fake/adapter.js';
export { FAKE_PLAN } from './fake/plan.js';
export { gateToolCall } from './gate.js';
export { ClaudeAdapter, buildQueryOptions, effectiveAllowedTools } from './claude/adapter.js';
export { buildChildEnv } from './claude/env.js';
export { claudeModels } from './claude/models.js';
export { normalizeSdkMessage } from './claude/normalize.js';

export { CodexAdapter, codexArgs, codexRefusal, codexUnenforceable } from './codex/adapter.js';
export { normalizeCodexEvent } from './codex/normalize.js';

/** Sends each run to the adapter of its `spec.runtime`. */
export class RoutedAdapter implements RuntimeAdapter {
  readonly name = 'routed' as const;
  constructor(private adapters: Partial<Record<Runtime, RuntimeAdapter>>) {}
  run(...args: Parameters<RuntimeAdapter['run']>) {
    const [spec, sink] = args;
    const adapter = this.adapters[spec.runtime];
    if (adapter) return adapter.run(...args);
    const error = `this worker has no ${spec.runtime} runtime`;
    sink.emit({ type: 'agent.failed', payload: { error } });
    return Promise.resolve({ status: 'failed' as const, error, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 } });
  }
}

/** True when the Codex CLI answers `--version` (installed; a login is checked only by a run). */
export function codexAvailable(bin = 'codex'): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** `fake` runs every runtime in tests; `claude` adds Codex when its CLI is installed. */
export function createAdapter(
  name: 'claude' | 'fake',
  codex?: { bin: string; timeoutMinutes: number },
): { adapter: RuntimeAdapter; runtimes: Runtime[] } {
  if (name === 'fake') return { adapter: new FakeAdapter(), runtimes: ['claude', 'codex'] };
  const codexAdapter = codex ? new CodexAdapter(codex.bin, codex.timeoutMinutes * 60_000) : undefined;
  return {
    adapter: new RoutedAdapter({ claude: new ClaudeAdapter(), ...(codexAdapter && { codex: codexAdapter }) }),
    runtimes: codexAdapter ? ['claude', 'codex'] : ['claude'],
  };
}
export { claudeSessionStore, type ClaudeSessionStore } from './claude/sessions.js';
