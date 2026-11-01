import type { OfficeEvent } from './events.js';

/** One-line description of an event for logs and activity feeds; falls back to the event type, never throws. */
export function summarizeEvent(e: OfficeEvent): string {
  const p = (e.payload ?? {}) as {
    tool?: unknown;
    input?: { command?: unknown; path?: unknown };
    text?: unknown;
    skill?: unknown;
    subagentType?: unknown;
    command?: unknown;
    path?: unknown;
  };
  if (e.type === 'agent.skill.invoked') return `skill ${typeof p.skill === 'string' ? p.skill : ''}`.trim();
  if (e.type === 'agent.subagent.spawned') return `subagent ${typeof p.subagentType === 'string' ? p.subagentType : ''}`.trim();
  if (typeof p.tool === 'string') {
    const arg = p.input?.command ?? p.input?.path;
    return `${p.tool} ${typeof arg === 'string' ? arg.slice(0, 80) : ''}`;
  }
  if (typeof p.text === 'string') return p.text.slice(0, 120);
  if (e.type === 'agent.command.executed' && typeof p.command === 'string') return `$ ${p.command.slice(0, 80)}`;
  if (e.type === 'agent.file.changed' && typeof p.path === 'string') return `changed ${p.path}`;
  return e.type;
}
