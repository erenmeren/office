// Opt-in real Claude smoke test for native subagents (spends real budget). Not part of `pnpm test`.
// Run: pnpm --filter @office/runtime exec tsx scripts/smoke-subagent.ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventBody, RunSpec } from '@office/shared';
import { ClaudeAdapter } from '../src/claude/adapter.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'office-smoke-subagent-'));
const spec: RunSpec = {
  runId: 'smoke-run',
  sessionId: 'smoke-session',
  agentId: 'smoke-agent',
  projectId: 'smoke-project',
  cwd: root,
  prompt: 'Use the echoer subagent and return exactly what it replies.',
  systemPrompt: 'Delegate to the echoer subagent; do not answer yourself.',
  model: 'haiku',
  allowedTools: [],
  maxTurns: 6,
  maxBudgetUsd: 0.1,
  maxConcurrentSubagents: 4,
  maxSubagentDepth: 1,
  skills: [],
  subagents: [
    { name: 'echoer', description: 'Use for any echo request', prompt: 'Reply with exactly: SUBAGENT_OK', skills: [], model: 'haiku' },
  ],
};

const events: EventBody[] = [];
const result = await new ClaudeAdapter().run(
  spec,
  {
    emit: (e) => {
      events.push(e);
      const p = e.payload as Record<string, unknown>;
      if (e.type === 'agent.started') console.log('event', e.type, JSON.stringify({ tools: p.tools, agents: p.agents }));
      else if (e.type === 'agent.completed') console.log('event', e.type, JSON.stringify(p));
      else if (e.type.startsWith('agent.subagent.')) console.log('event', e.type, JSON.stringify(p));
      else if (e.type === 'agent.tool.started') console.log('event', e.type, p.tool, JSON.stringify(p.input));
      else console.log('event', e.type);
    },
  },
  new AbortController().signal,
);
console.log('result', JSON.stringify(result, null, 2));
const started = events.find((e) => e.type === 'agent.started');
const tools = ((started?.payload as { tools?: string[] } | undefined)?.tools ?? []) as string[];
const spawned = events.some((e) => e.type === 'agent.subagent.spawned');
// the SDK lists the subagent tool as Task in init and calls it Agent
const subagentTool = tools.includes('Agent') || tools.includes('Task');
console.log('check', JSON.stringify({ subagentTool, spawned }));
if (!subagentTool || !spawned || !result.resultText?.includes('SUBAGENT_OK')) process.exitCode = 1;
