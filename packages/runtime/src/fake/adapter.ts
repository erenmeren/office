import { mcpToolName, type OfficeToolName, type RunResult, type RunSpec, type ToolCallResult } from '@office/shared';
import type { EventSink, RuntimeAdapter, ToolBridge } from '../types.js';

const USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 1, durationMs: 0 };

/**
 * Deterministic adapter for tests. `FAIL` in the prompt fails; `SLOW` waits 2000 ms (abortable);
 * eager skills are invoked first; `SUBAGENT` spawns `spec.subagents[0]`.
 * With a tool bridge, line markers call office tools: `SEND:<slug>:<text>`, `ASK:<slug>:<text>`
 * (suspends), `INBOX` (also kind 'inbox'), `MEMO:<title>`; kind 'summary' submits a summary.
 */
export class FakeAdapter implements RuntimeAdapter {
  readonly name = 'fake' as const;

  async run(spec: RunSpec, sink: EventSink, signal: AbortSignal, tools?: ToolBridge): Promise<RunResult> {
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
        }
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

    if (spec.prompt.includes('SLOW')) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });
    }
    if (signal.aborted) {
      sink.emit({ type: 'agent.cancelled', payload: {} });
      return { status: 'cancelled', usage: USAGE };
    }
    if (spec.prompt.includes('FAIL')) {
      sink.emit({ type: 'agent.failed', payload: { error: 'fake failure' } });
      return { status: 'failed', error: 'fake failure', usage: USAGE };
    }
    const resultText = 'fake result for: ' + spec.prompt;
    sink.emit({ type: 'agent.completed', payload: { resultText } });
    return { status: 'succeeded', resultText, sdkSessionId: 'fake-' + spec.sessionId, usage: USAGE };
  }
}
