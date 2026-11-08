import type { EventBody } from '@office/shared';
import { redactSecrets } from '../redact.js';

/** The JSONL events of `codex exec --json` (shapes as in @openai/codex-sdk's ThreadEvent). */
export type CodexItem =
  | { id: string; type: 'agent_message'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'command_execution'; command: string; aggregated_output: string; exit_code?: number; status: string }
  | { id: string; type: 'file_change'; changes: { path: string; kind: string }[]; status: string }
  | { id: string; type: 'mcp_tool_call'; server: string; tool: string; arguments: unknown; status: string; error?: { message: string } }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'todo_list'; items: unknown[] }
  | { id: string; type: 'error'; message: string };

export type CodexUsage = { input_tokens: number; cached_input_tokens?: number; output_tokens: number; reasoning_output_tokens?: number };

export type CodexEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: CodexUsage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; item: CodexItem }
  | { type: 'error'; message: string };

function itemEvents(phase: 'item.started' | 'item.updated' | 'item.completed', item: CodexItem): EventBody[] {
  const started = phase === 'item.started';
  const done = phase === 'item.completed';
  switch (item.type) {
    case 'agent_message':
      return done ? [{ type: 'agent.text', payload: { text: item.text } }] : [];
    case 'reasoning':
      return done ? [{ type: 'agent.thinking', payload: { chars: item.text.length } }] : [];
    case 'command_execution':
      if (started) {
        return [
          { type: 'agent.tool.started', payload: { toolUseId: item.id, tool: 'Bash', input: { command: item.command } } },
          { type: 'agent.command.executed', payload: { command: item.command } },
        ];
      }
      return done
        ? [{
            type: item.status === 'failed' || (item.exit_code ?? 0) !== 0 ? 'agent.tool.failed' : 'agent.tool.completed',
            payload: { toolUseId: item.id, output: item.aggregated_output, exitCode: item.exit_code },
          }]
        : [];
    case 'file_change':
      return done ? item.changes.map((c) => ({ type: 'agent.file.changed' as const, payload: { path: c.path, change: c.kind } })) : [];
    case 'mcp_tool_call':
      if (started) return [{ type: 'agent.tool.started', payload: { toolUseId: item.id, tool: `mcp__${item.server}__${item.tool}`, input: item.arguments } }];
      return done
        ? [{ type: item.status === 'failed' ? 'agent.tool.failed' : 'agent.tool.completed', payload: { toolUseId: item.id, output: item.error?.message ?? '' } }]
        : [];
    case 'web_search':
      if (started) return [{ type: 'agent.tool.started', payload: { toolUseId: item.id, tool: 'WebSearch', input: { query: item.query } } }];
      return done ? [{ type: 'agent.tool.completed', payload: { toolUseId: item.id, output: '' } }] : [];
    default:
      // todo_list and non-fatal error items: not events
      return [];
  }
}

/** Maps one Codex JSONL event to zero or more Office event bodies, with secrets redacted. Turn results are the adapter's. */
export function normalizeCodexEvent(e: CodexEvent, model?: string): EventBody[] {
  const events: EventBody[] =
    e.type === 'thread.started'
      ? [{ type: 'agent.started', payload: { runtime: 'codex', sdkSessionId: e.thread_id, ...(model && { model }) } }]
      : e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed'
        ? itemEvents(e.type, e.item)
        : [];
  return events.map((b) => ({ type: b.type, payload: redactSecrets(b.payload) }));
}
