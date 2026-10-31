import { createAdapter } from '@office/runtime';
import { loadWorkerConfig } from './config.js';
import { WorkerConnection } from './connection.js';

const config = loadWorkerConfig(process.env);
const connection = new WorkerConnection(config, { adapter: createAdapter(config.runtime) });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void connection.stop().finally(() => process.exit(0));
  });
}

await connection.start();
