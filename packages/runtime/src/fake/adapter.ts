import { execFile as execFileCb } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { mcpToolName, type OfficeToolName, type RunResult, type RunSpec, type ToolCallResult } from '@office/shared';
import { gateToolCall } from '../gate.js';
import type { EventSink, RunControl, RuntimeAdapter, ToolBridge } from '../types.js';
import { FAKE_PLAN } from './plan.js';

const execFile = promisify(execFileCb);

const USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 1, durationMs: 0 };

/**
 * Deterministic adapter for tests. `FAIL` in the prompt fails; `SLOW` waits 2000 ms (abortable);
 * eager skills are invoked first; `SUBAGENT` spawns `spec.subagents[0]`.
 * With a tool bridge, line markers call office tools: `SEND:<slug>:<text>`, `ASK:<slug>:<text>`
 * (suspends), `INBOX` (also kind 'inbox'), `MEMO:<title>`; kind 'summary' submits a summary.
 * Orchestration markers: `PLAN` (or kind 'plan') returns FAKE_PLAN or $OFFICE_FAKE_PLAN as structured output;
 * `REVIEW:<id>,<id>` (or kind 'review') marks each task done and returns a review; `DANGER:<command>` and
 * `SECRETWRITE` go through the policy gate without running anything; `COMMIT:<path>:<text>` writes and commits.
 */
export class FakeAdapter implements RuntimeAdapter {
  readonly name = 'fake' as const;

  async run(spec: RunSpec, sink: EventSink, signal: AbortSignal, tools?: ToolBridge, control?: RunControl): Promise<RunResult> {
    sink.emit({ type: 'agent.started', payload: { model: spec.model } });
    for (const { name } of spec.skills.filter((s) => s.mode === 'eager')) {
      const toolUseId = 'fake-skill-' + name;
      sink.emit({ type: 'agent.tool.started', payload: { tool: 'Skill', toolUseId, input: { skill: name } } });
      sink.emit({ type: 'agent.skill.invoked', payload: { toolUseId, skill: name } });
      sink.emit({ type: 'agent.tool.completed', payload: { toolUseId, output: '' } });
    }
    let toolSeq = 0;
    const callTool = async (name: OfficeToolName, args: Record<string, unknown>): Promise<ToolCallResult> => {
      const toolUseId = `fake-office-${++toolSeq}`;
      sink.emit({ type: 'agent.tool.started', payload: { tool: mcpToolName(name), toolUseId, input: args } });
      const r = await tools!.call(name, args);
      if (r.ok) sink.emit({ type: 'agent.tool.completed', payload: { toolUseId, output: JSON.stringify(r.result) } });
      else sink.emit({ type: 'agent.tool.failed', payload: { toolUseId, output: r.code } });
      return r;
    };
    const failTool = (tool: string, input: Record<string, unknown>, output: string) => {
      const toolUseId = `fake-tool-${++toolSeq}`;
      sink.emit({ type: 'agent.tool.started', payload: { tool, toolUseId, input } });
      sink.emit({ type: 'agent.tool.failed', payload: { toolUseId, output } });
    };
    const gated = async (tool: string, input: Record<string, unknown>, onAllow: () => void) => {
      const toolUseId = `fake-tool-${++toolSeq}`;
      sink.emit({ type: 'agent.tool.started', payload: { tool, toolUseId, input } });
      const g = await gateToolCall(spec, sink, tools, tool, input);
      if (!g.allow) return sink.emit({ type: 'agent.tool.failed', payload: { toolUseId, output: 'denied: ' + g.message } });
      onAllow();
      sink.emit({ type: 'agent.tool.completed', payload: { toolUseId, output: '' } });
    };
    const commit = async (path: string, content: string) => {
      const cwd = spec.cwd;
      const input = { path };
      if (path.split(/[\\/]/).includes('..')) return failTool('Write', input, 'path escapes the working directory');
      try {
        await execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
      } catch {
        return failTool('Write', input, 'not a git repository: ' + cwd);
      }
      const file = join(cwd, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content.replaceAll('\\n', '\n'));
      // identity comes from the GIT_AUTHOR_*/GIT_COMMITTER_* env the worker sets
      const identity = process.env.GIT_AUTHOR_NAME ? [] : ['-c', 'user.name=fake', '-c', 'user.email=fake@example.invalid'];
      try {
        await execFile('git', ['add', '-A'], { cwd });
        await execFile('git', [...identity, 'commit', '-q', '-m', 'fake: ' + path], { cwd, env: process.env });
      } catch (err) {
        return failTool('Bash', { command: 'git commit' }, err instanceof Error ? err.message : String(err));
      }
      sink.emit({ type: 'agent.file.changed', payload: { path } });
      sink.emit({ type: 'agent.command.executed', payload: { command: 'git commit' } });
    };
    let structuredOutput: unknown;
    const suspendedResult = (): RunResult => ({ status: 'suspended', sdkSessionId: 'fake-' + spec.sessionId, usage: USAGE });
    if (tools && spec.resumeSdkSessionId === undefined) {
      const lines = spec.prompt.split('\n');
      for (const line of lines) {
        if (line.startsWith('SEND:') || line.startsWith('ASK:')) {
          const ask = line.startsWith('ASK:');
          const [, to = '', ...text] = line.split(':');
          const args = ask ? { to, body: text.join(':'), type: 'question', awaitReply: true } : { to, body: text.join(':') };
          const r = await callTool('send_message', args);
          if (ask && r.ok && r.suspend) {
            const messageId = (r.result as { messageId?: string } | null)?.messageId;
            sink.emit({ type: 'agent.waiting_reply', payload: { messageId, to } });
            return suspendedResult();
          }
        } else if (line.startsWith('MEMO:')) {
          await callTool('propose_memory', { type: 'lesson', title: line.slice(5), content: 'fake lesson', sources: [] });
        } else if (line.startsWith('REVIEW:')) {
          for (const taskId of line.slice(7).split(',').filter(Boolean)) {
            await callTool('review_task', { taskId, decision: 'done', note: 'fake review' });
          }
        } else if (line.startsWith('DANGER:')) {
          const command = line.slice(7);
          await gated('Bash', { command }, () => sink.emit({ type: 'agent.command.executed', payload: { command } }));
        } else if (line === 'SECRETWRITE') {
          // never written: the gate decides, nothing touches disk
          await gated('Write', { file_path: join(spec.cwd, '.env.local'), content: 'x' }, () => {});
        } else if (line.startsWith('COMMIT:')) {
          const [path = '', ...text] = line.slice(7).split(':');
          await commit(path, text.join(':'));
        }
      }
      if (spec.kind === 'plan' || lines.includes('PLAN')) {
        structuredOutput = process.env.OFFICE_FAKE_PLAN ? JSON.parse(process.env.OFFICE_FAKE_PLAN) : FAKE_PLAN;
      }
      if (spec.kind === 'review' || lines.some((l) => l === 'REVIEW' || l.startsWith('REVIEW:'))) {
        structuredOutput = { summary: 'fake review', tasks: [] };
      }
      if (spec.kind === 'inbox' || lines.includes('INBOX')) {
        const inbox = await callTool('read_inbox', {});
        const messages = inbox.ok ? ((inbox.result as { messages?: { id: string; type: string; body: string }[] })?.messages ?? []) : [];
        for (const m of messages.filter((m) => ['question', 'help_request', 'escalation'].includes(m.type))) {
          await callTool('reply_message', { messageId: m.id, body: 'fake reply: ' + m.body });
        }
      }
      if (spec.kind === 'summary') {
        await callTool('submit_summary', {
          summary: 'fake summary of ' + lines[0],
          proposals: [{ type: 'lesson', title: 'fake proposal', content: 'from summary', sources: [] }],
        });
      }
    }
    const sub = spec.subagents[0];
    if (spec.prompt.includes('SUBAGENT') && sub) {
      const input = { subagent_type: sub.name, description: 'fake subagent' };
      sink.emit({ type: 'agent.tool.started', payload: { tool: 'Agent', toolUseId: 'fake-sub-1', input } });
      sink.emit({
        type: 'agent.subagent.spawned',
        payload: { toolUseId: 'fake-sub-1', subagentType: sub.name, description: input.description },
      });
      sink.emit({
        type: 'agent.subagent.completed',
        payload: { toolUseId: 'fake-sub-1', status: 'completed', summary: 'done' },
      });
    }
    sink.emit({ type: 'agent.text', payload: { text: 'fake: ' + spec.prompt } });
    sink.emit({
      type: 'agent.tool.started',
      payload: { tool: 'Bash', toolUseId: 'fake-1', input: { command: 'echo ok' } },
    });
    sink.emit({ type: 'agent.tool.completed', payload: { toolUseId: 'fake-1', output: 'ok' } });

    if (control) {
      control.deliver = (messageId) => {
        sink.emit({ type: 'agent.message.received', payload: { count: 1, messageId } });
        return true;
      };
    }
    if (spec.prompt.includes('SLOW')) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        const done = () => (clearTimeout(t), resolve());
        signal.addEventListener('abort', done, { once: true });
        control?.interrupted.addEventListener('abort', done, { once: true });
      });
    }
    if (control) control.deliver = undefined;
    if (signal.aborted) {
      sink.emit({ type: 'agent.cancelled', payload: {} });
      return { status: 'cancelled', usage: USAGE };
    }
    if (control?.interrupted.aborted) {
      sink.emit({ type: 'agent.waiting_reply', payload: { reason: 'interrupted' } });
      return suspendedResult();
    }
    if (spec.prompt.includes('FAIL')) {
      sink.emit({ type: 'agent.failed', payload: { error: 'fake failure' } });
      return { status: 'failed', error: 'fake failure', usage: USAGE };
    }
    const resultText = 'fake result for: ' + spec.prompt;
    sink.emit({ type: 'agent.completed', payload: { resultText } });
    return {
      status: 'succeeded',
      resultText,
      sdkSessionId: 'fake-' + spec.sessionId,
      usage: USAGE,
      ...(structuredOutput !== undefined && { structuredOutput }),
    };
  }
}
