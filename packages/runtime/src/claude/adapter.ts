import { query } from '@anthropic-ai/claude-agent-sdk';
import type { RunResult, RunSpec } from '@office/shared';
import type { EventSink, RuntimeAdapter } from '../types.js';
import { buildChildEnv } from './env.js';
import { normalizeSdkMessage } from './normalize.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 };

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

    let result: RunResult | undefined;
    try {
      const q = query({
        prompt: spec.prompt,
        options: {
          cwd: spec.cwd,
          model: spec.model,
          effort: spec.effort,
          systemPrompt: spec.systemPrompt,
          allowedTools: spec.allowedTools,
          permissionMode: 'default',
          maxTurns: spec.maxTurns,
          maxBudgetUsd: spec.maxBudgetUsd,
          settingSources: ['project'],
          resume: spec.resumeSdkSessionId,
          env: buildChildEnv(process.env, spec),
          abortController,
          // allowedTools auto-approves listed tools; this is the deny path for everything else.
          canUseTool: async (toolName) =>
            spec.allowedTools.includes(toolName)
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
            ? { status: 'succeeded', resultText: msg.result, sdkSessionId: msg.session_id, usage }
            : { status: 'failed', error: msg.errors.join('; ') || msg.subtype, sdkSessionId: msg.session_id, usage };
      }
    } catch (err) {
      if (signal.aborted) return cancelled();
      const error = err instanceof Error ? err.message : String(err);
      sink.emit({ type: 'agent.failed', payload: { error } });
      return { status: 'failed', error, usage: result?.usage ?? ZERO_USAGE };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) return cancelled();
    if (result) return result;
    const error = 'SDK stream ended without a result message';
    sink.emit({ type: 'agent.failed', payload: { error } });
    return { status: 'failed', error, usage: ZERO_USAGE };
  }
}
