import { ClaudeAdapter } from './claude/adapter.js';
import { FakeAdapter } from './fake/adapter.js';
import type { RuntimeAdapter } from './types.js';

export type { EventSink, RuntimeAdapter, ToolBridge } from './types.js';
export { redactSecrets } from './redact.js';
export { machineId } from './machine-id.js';
export { FakeAdapter } from './fake/adapter.js';
export { FAKE_PLAN } from './fake/plan.js';
export { gateToolCall } from './gate.js';
export { ClaudeAdapter, buildQueryOptions, effectiveAllowedTools } from './claude/adapter.js';
export { buildChildEnv } from './claude/env.js';
export { normalizeSdkMessage } from './claude/normalize.js';

export function createAdapter(name: 'claude' | 'fake'): RuntimeAdapter {
  return name === 'claude' ? new ClaudeAdapter() : new FakeAdapter();
}
