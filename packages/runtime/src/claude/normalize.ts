import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventBody } from '@office/shared';
import { redactSecrets } from '../redact.js';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

type Payload = Record<string, unknown>;

function isRecord(v: unknown): v is Payload {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** tool_result content is a string or an array of blocks; keep only the text. */
function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Payload => isRecord(b) && b.type === 'text')
    .map((b) => str(b.text) ?? '')
    .join('\n');
}

function toolUseEvents(id: string, tool: string, rawInput: unknown): EventBody[] {
  const input = isRecord(rawInput) ? rawInput : {};
  const events: EventBody[] = [{ type: 'agent.tool.started', payload: { toolUseId: id, tool, input } }];
  if (SUBAGENT_TOOLS.has(tool)) {
    events.push({
      type: 'agent.subagent.spawned',
      payload: { toolUseId: id, description: str(input.description), subagentType: str(input.subagent_type) },
    });
  }
  if (FILE_TOOLS.has(tool)) {
    events.push({ type: 'agent.file.changed', payload: { path: str(input.file_path) ?? str(input.notebook_path) } });
  }
  if (tool === 'Bash') {
    events.push({ type: 'agent.command.executed', payload: { command: str(input.command) } });
  }
  return events;
}

function rawEvents(msg: SDKMessage): EventBody[] {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        return [{ type: 'agent.started', payload: { model: msg.model, tools: msg.tools, sdkSessionId: msg.session_id } }];
      }
      if (msg.subtype === 'task_notification') {
        return [
          {
            type: 'agent.subagent.completed',
            payload: { toolUseId: msg.tool_use_id, status: msg.status, summary: msg.summary },
          },
        ];
      }
      return [];
    case 'assistant': {
      const events: EventBody[] = [];
      for (const block of msg.message.content) {
        if (block.type === 'text') events.push({ type: 'agent.text', payload: { text: block.text } });
        else if (block.type === 'thinking') {
          events.push({ type: 'agent.thinking', payload: { chars: block.thinking.length } });
        } else if (block.type === 'tool_use') events.push(...toolUseEvents(block.id, block.name, block.input));
      }
      return events;
    }
    case 'user': {
      const content = msg.message.content;
      if (typeof content === 'string') return [];
      const events: EventBody[] = [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        events.push({
          type: block.is_error ? 'agent.tool.failed' : 'agent.tool.completed',
          payload: { toolUseId: block.tool_use_id, output: toolOutput(block.content) },
        });
      }
      return events;
    }
    case 'result':
      if (msg.subtype === 'success') {
        return [
          {
            type: 'agent.completed',
            payload: {
              resultText: msg.result,
              costUsd: msg.total_cost_usd,
              numTurns: msg.num_turns,
              durationMs: msg.duration_ms,
            },
          },
        ];
      }
      return [{ type: 'agent.failed', payload: { subtype: msg.subtype, errors: msg.errors } }];
    default:
      return [];
  }
}

/** Maps one SDK message to zero or more Office event bodies, with secrets redacted. */
export function normalizeSdkMessage(msg: SDKMessage): EventBody[] {
  const parent = 'parent_tool_use_id' in msg ? str(msg.parent_tool_use_id) : undefined;
  return rawEvents(msg).map((e) => ({
    type: e.type,
    payload: redactSecrets(parent ? { ...e.payload, parentToolUseId: parent } : e.payload),
  }));
}
