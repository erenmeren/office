// Opt-in real Claude smoke test for skill loading (spends real budget). Not part of `pnpm test`.
// Run: pnpm --filter @office/runtime exec tsx scripts/smoke-skills.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillChecksum, skillPromptSection, type EventBody, type RunSpec } from '@office/shared';
import { ClaudeAdapter } from '../src/claude/adapter.js';

const files = {
  'SKILL.md': [
    '---',
    'name: office-smoke',
    'description: Agent Office smoke-test skill. Invoke it when told to follow your instructions.',
    '---',
    '',
    'When invoked, reply with exactly: SKILL_OK',
    '',
  ].join('\n'),
};
const root = mkdtempSync(path.join(os.tmpdir(), 'office-smoke-skills-'));
const skillsDir = path.join(root, '.office');
const skillDir = path.join(skillsDir, '.claude', 'skills', 'office-smoke');
mkdirSync(skillDir, { recursive: true });
for (const [name, body] of Object.entries(files)) writeFileSync(path.join(skillDir, name), body);

const skills: RunSpec['skills'] = [
  { name: 'office-smoke', version: 1, checksum: skillChecksum(files), mode: 'eager', files },
];
const spec: RunSpec = {
  runId: 'smoke-run',
  sessionId: 'smoke-session',
  agentId: 'smoke-agent',
  projectId: 'smoke-project',
  cwd: root,
  prompt: 'Follow your instructions.',
  systemPrompt: skillPromptSection(skills),
  model: 'haiku',
  allowedTools: [],
  maxTurns: 4,
  maxBudgetUsd: 0.05,
  maxConcurrentSubagents: 4,
  maxSubagentDepth: 1,
  skills,
  subagents: [],
  skillsDir,
};

const events: EventBody[] = [];
const result = await new ClaudeAdapter().run(
  spec,
  {
    emit: (e) => {
      events.push(e);
      const p = e.payload as Record<string, unknown>;
      if (e.type === 'agent.started') console.log('event', e.type, JSON.stringify({ slashCommands: p.slashCommands, agents: p.agents }));
      else if (e.type === 'agent.skill.invoked') console.log('event', e.type, p.skill);
      else if (e.type === 'agent.tool.started') console.log('event', e.type, p.tool, JSON.stringify(p.input));
      else console.log('event', e.type);
    },
  },
  new AbortController().signal,
);
console.log('result', JSON.stringify(result, null, 2));
const invoked = events.some(
  (e) => e.type === 'agent.skill.invoked' && (e.payload as { skill?: string }).skill === 'office-smoke',
);
if (!invoked || result.status !== 'succeeded' || !result.resultText?.includes('SKILL_OK')) process.exitCode = 1;
