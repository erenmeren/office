import { claudeModels, codexAvailable, createAdapter } from '@office/runtime';
import { loadWorkerConfig } from './config.js';
import { WorkerConnection } from './connection.js';

const config = loadWorkerConfig(process.env);
const codex =
  config.runtime === 'claude' && codexAvailable(config.codexBin) ? { bin: config.codexBin, timeoutMinutes: config.codexTimeoutMinutes } : undefined;
const { adapter, runtimes } = createAdapter(config.runtime, codex);
// what this machine's Claude login offers today, for the agent form's model list; the fake runtime has none
const models = config.runtime === 'claude' ? await claudeModels() : [];
const connection = new WorkerConnection(config, { adapter, runtimes, models });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void connection.stop().finally(() => process.exit(0));
  });
}

await connection.start();
