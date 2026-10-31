import type { RunResult, RunSpec } from '@office/shared';
import type { EventSink, RuntimeAdapter } from '../types.js';

const USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 1, durationMs: 0 };

/** Deterministic adapter for tests. `FAIL` in the prompt fails; `SLOW` waits 2000 ms (abortable). */
export class FakeAdapter implements RuntimeAdapter {
  readonly name = 'fake' as const;

  async run(spec: RunSpec, sink: EventSink, signal: AbortSignal): Promise<RunResult> {
    sink.emit({ type: 'agent.started', payload: { model: spec.model } });
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
