import { codexAvailable, createAdapter } from '@office/runtime';
import { loadWorkerConfig } from './config.js';
import { WorkerConnection } from './connection.js';

const config = loadWorkerConfig(process.env);
const codex = config.runtime === 'claude' && codexAvailable(config.codexBin) ? config.codexBin : undefined;
const { adapter, runtimes } = createAdapter(config.runtime, codex);
const connection = new WorkerConnection(config, { adapter, runtimes });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void connection.stop().finally(() => process.exit(0));
  });
}

await connection.start();
