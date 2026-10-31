// Opt-in real Claude smoke test (spends real budget). Not part of `pnpm test`.
// Run: pnpm --filter @office/runtime exec tsx scripts/smoke-claude.ts
import os from 'node:os';
import type { RunSpec } from '@office/shared';
import { ClaudeAdapter } from '../src/claude/adapter.js';

const spec: RunSpec = {
  runId: 'smoke-run',
  sessionId: 'smoke-session',
  agentId: 'smoke-agent',
  projectId: 'smoke-project',
  cwd: os.tmpdir(),
  prompt: 'Reply with exactly: RUNTIME_OK',
  systemPrompt: '',
  model: 'haiku',
  allowedTools: [],
  maxTurns: 1,
  maxBudgetUsd: 0.05,
  maxConcurrentSubagents: 4,
  maxSubagentDepth: 1,
};

const result = await new ClaudeAdapter().run(
  spec,
  { emit: (e) => console.log('event', e.type) },
  new AbortController().signal,
);
console.log('result', JSON.stringify(result, null, 2));
if (result.status !== 'succeeded' || !result.resultText?.includes('RUNTIME_OK')) process.exitCode = 1;
