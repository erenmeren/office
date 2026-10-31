import { ClaudeAdapter } from './claude/adapter.js';
import { FakeAdapter } from './fake/adapter.js';
import type { RuntimeAdapter } from './types.js';

export type { EventSink, RuntimeAdapter } from './types.js';
export { redactSecrets } from './redact.js';
export { FakeAdapter } from './fake/adapter.js';
export { ClaudeAdapter, effectiveAllowedTools } from './claude/adapter.js';
export { buildChildEnv } from './claude/env.js';
export { normalizeSdkMessage } from './claude/normalize.js';

export function createAdapter(name: 'claude' | 'fake'): RuntimeAdapter {
  return name === 'claude' ? new ClaudeAdapter() : new FakeAdapter();
}
