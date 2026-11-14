import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelOption } from '@office/shared';
import { buildChildEnv } from './env.js';

/**
 * The models this machine's Claude login offers right now, asked of the Claude Code CLI itself: no prompt is sent and
 * nothing is spent. Empty when the CLI fails or does not answer in time.
 */
export async function claudeModels(base: NodeJS.ProcessEnv = process.env, timeoutMs = 20_000): Promise<ModelOption[]> {
  // a prompt stream that never yields: the session starts, answers control requests and waits
  const idle = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<never>(() => undefined);
  })();
  const q = query({ prompt: idle, options: { settingSources: [], env: buildChildEnv(base, { maxConcurrentSubagents: 0, maxSubagentDepth: 0 }) } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no answer')), timeoutMs);
      }),
    ]);
    // `default` names no model: it is whatever the CLI picks, and the list carries that model under its own id
    return models.filter((m) => m.value !== 'default').map((m) => ({ value: m.value, label: m.displayName, description: m.description }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
