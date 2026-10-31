import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { RunResult, RunSpec } from '@office/shared';
import { redactSecrets } from '../redact.js';
import type { EventSink, RuntimeAdapter } from '../types.js';
import { buildChildEnv } from './env.js';
import { normalizeSdkMessage } from './normalize.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 };
const BUILTIN_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'KillShell',
  'TodoWrite',
  'Skill',
];

/** spec.allowedTools plus Skill/Agent when skills/subagents are pinned, so pinning implies the grant. */
export function effectiveAllowedTools(spec: RunSpec): string[] {
  const tools = [...spec.allowedTools];
  const grant = (t: string) => !tools.includes(t) && tools.push(t);
  if (spec.skills.length > 0) grant('Skill');
  // the SDK calls the subagent tool Agent but lists it as Task in init; a disallowed Task removed it from the session
  if (spec.subagents.length > 0) ['Agent', 'Task'].forEach(grant);
  return tools;
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = 'claude' as const;

  async run(spec: RunSpec, sink: EventSink, signal: AbortSignal): Promise<RunResult> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) abortController.abort();

    const cancelled = (): RunResult => {
      sink.emit({ type: 'agent.cancelled', payload: {} });
      return { status: 'cancelled', usage: ZERO_USAGE };
    };

    const allowedTools = effectiveAllowedTools(spec);
    const agents = spec.subagents.length
      ? Object.fromEntries(
          spec.subagents.map(({ name, description, prompt, skills, tools, model, maxTurns }): [string, AgentDefinition] => [
            name,
            {
              description,
              prompt,
              skills,
              ...(tools && { tools }),
              ...(model && { model }),
              ...(maxTurns && { maxTurns }),
            },
          ]),
        )
      : undefined;

    let result: RunResult | undefined;
    try {
      const q = query({
        prompt: spec.prompt,
        options: {
          cwd: spec.cwd,
          model: spec.model,
          effort: spec.effort,
          systemPrompt: spec.systemPrompt,
          allowedTools,
          disallowedTools: BUILTIN_TOOLS.filter((t) => !allowedTools.includes(t)),
          permissionMode: 'default',
          maxTurns: spec.maxTurns,
          maxBudgetUsd: spec.maxBudgetUsd,
          // Project settings are trusted workspace content (owner-controlled repos); deny rules still cap the tool surface. See docs/security.md.
          settingSources: ['project'],
          resume: spec.resumeSdkSessionId,
          additionalDirectories: spec.skillsDir ? [spec.skillsDir] : undefined,
          skills: spec.skills.length ? spec.skills.map((s) => s.name) : undefined,
          agents,
          env: buildChildEnv(process.env, spec),
          abortController,
          // allowedTools auto-approves listed tools; disallowedTools blocks ungranted built-ins
          // ahead of project allow rules; this is the deny path for anything else that asks.
          canUseTool: async (toolName) =>
            allowedTools.includes(toolName)
              ? { behavior: 'allow' }
              : { behavior: 'deny', message: 'Tool not permitted by Agent Office policy' },
        },
      });
      for await (const msg of q) {
        for (const body of normalizeSdkMessage(msg)) sink.emit(body);
        if (msg.type !== 'result') continue;
        const usage = {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          costUsd: msg.total_cost_usd,
          numTurns: msg.num_turns,
          durationMs: msg.duration_ms,
        };
        result =
          msg.subtype === 'success'
            ? { status: 'succeeded', resultText: redactSecrets(msg.result), sdkSessionId: msg.session_id, usage }
            : {
                status: 'failed',
                error: redactSecrets(msg.errors.join('; ') || msg.subtype),
                sdkSessionId: msg.session_id,
                usage,
              };
      }
    } catch (err) {
      // The SDK throws on process exit after an error result; that result already produced agent.failed.
      if (result) return result;
      if (signal.aborted) return cancelled();
      const error = redactSecrets(err instanceof Error ? err.message : String(err));
      sink.emit({ type: 'agent.failed', payload: { error } });
      return { status: 'failed', error, usage: ZERO_USAGE };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (result) return result;
    if (signal.aborted) return cancelled();
    const error = 'SDK stream ended without a result message';
    sink.emit({ type: 'agent.failed', payload: { error } });
    return { status: 'failed', error, usage: ZERO_USAGE };
  }
}
