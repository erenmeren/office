import { createSdkMcpServer, query, tool, type AgentDefinition, type Options } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, OFFICE_TOOLS, mcpToolName, type OfficeToolName, type RunResult, type RunSpec } from '@office/shared';
import { gateToolCall } from '../gate.js';
import { redactSecrets } from '../redact.js';
import type { EventSink, RuntimeAdapter, ToolBridge } from '../types.js';
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
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
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

/** Everything passed to the SDK except abortController. The office MCP server exists only when tools are served. */
export function buildQueryOptions(
  spec: RunSpec,
  tools: ToolBridge | undefined,
  onSuspend: (info: { messageId?: string; to: string }) => void,
  sink: EventSink = { emit: () => {} },
): Options {
  const served = tools ? (spec.tools as OfficeToolName[]) : [];
  const allowedTools = [...effectiveAllowedTools(spec), ...served.map(mcpToolName)];
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
  const server =
    tools && served.length
      ? createSdkMcpServer({
          name: MCP_SERVER_NAME,
          version: '1.0.0',
          tools: served.map((name) =>
            tool(name, OFFICE_TOOLS[name].description, OFFICE_TOOLS[name].input, async (args) => {
              const r = await tools.call(name, args as Record<string, unknown>);
              if (!r.ok) return { content: [{ type: 'text' as const, text: `Error ${r.code}: ${r.error}` }], isError: true };
              if (r.suspend) {
                const messageId = (r.result as { messageId?: string } | null)?.messageId;
                onSuspend({ messageId, to: typeof (args as { to?: unknown }).to === 'string' ? (args as { to: string }).to : 'chief' });
              }
              return { content: [{ type: 'text' as const, text: JSON.stringify(r.result) }] };
            }),
          ),
        })
      : undefined;
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    systemPrompt: spec.systemPrompt,
    allowedTools,
    // strictMcpConfig keeps every MCP server except the in-process office one out of the session
    disallowedTools: BUILTIN_TOOLS.filter((t) => !allowedTools.includes(t)),
    ...(server && { mcpServers: { [MCP_SERVER_NAME]: server } }),
    strictMcpConfig: true,
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
    // allowedTools auto-approves listed tools; disallowedTools blocks ungranted built-ins
    // ahead of project allow rules; this is the deny path for anything else that asks.
    // then read-only and approval-policy gating, which may wait for the owner
    canUseTool: async (toolName, input) => {
      if (!allowedTools.includes(toolName)) return { behavior: 'deny', message: 'Tool not permitted by Agent Office policy' };
      const g = await gateToolCall(spec, sink, tools, toolName, input);
      return g.allow ? { behavior: 'allow' } : { behavior: 'deny', message: g.message };
    },
    ...(spec.outputFormat && { outputFormat: spec.outputFormat }),
  };
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = 'claude' as const;

  async run(spec: RunSpec, sink: EventSink, signal: AbortSignal, tools?: ToolBridge): Promise<RunResult> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) abortController.abort();

    const cancelled = (): RunResult => {
      sink.emit({ type: 'agent.cancelled', payload: {} });
      return { status: 'cancelled', usage: ZERO_USAGE };
    };

    let result: RunResult | undefined;
    let q: ReturnType<typeof query> | undefined;
    let suspended = false;
    let initSessionId: string | undefined;
    try {
      q = query({
        prompt: spec.prompt,
        options: {
          ...buildQueryOptions(spec, tools, (info) => {
            suspended = true;
            sink.emit({ type: 'agent.waiting_reply', payload: info });
            // after the tool result has been returned to the CLI
            setTimeout(() => void q?.interrupt().catch(() => {}), 0);
          }, sink),
          abortController,
        },
      });
      for await (const msg of q) {
        // an interrupted result of a suspended run is not a failure
        if (!(suspended && msg.type === 'result')) for (const body of normalizeSdkMessage(msg)) sink.emit(body);
        if (msg.type === 'system' && msg.subtype === 'init') initSessionId = msg.session_id;
        if (msg.type !== 'result') continue;
        const usage = {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          costUsd: msg.total_cost_usd,
          numTurns: msg.num_turns,
          durationMs: msg.duration_ms,
        };
        result = suspended
          ? { status: 'suspended', sdkSessionId: msg.session_id, usage }
          : msg.subtype === 'success'
            ? {
                status: 'succeeded',
                resultText: redactSecrets(msg.result),
                sdkSessionId: msg.session_id,
                usage,
                ...(msg.structured_output !== undefined && { structuredOutput: msg.structured_output }),
              }
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
      if (suspended && initSessionId) return { status: 'suspended', sdkSessionId: initSessionId, usage: ZERO_USAGE };
      const error = redactSecrets(err instanceof Error ? err.message : String(err));
      sink.emit({ type: 'agent.failed', payload: { error } });
      return { status: 'failed', error, usage: ZERO_USAGE };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (result) return result;
    if (signal.aborted) return cancelled();
    if (suspended && initSessionId) return { status: 'suspended', sdkSessionId: initSessionId, usage: ZERO_USAGE };
    const error = 'SDK stream ended without a result message';
    sink.emit({ type: 'agent.failed', payload: { error } });
    return { status: 'failed', error, usage: ZERO_USAGE };
  }
}
