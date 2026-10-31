import pino from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const config = loadConfig();
const app = await buildApp(config);
await app.listen({ port: config.port, host: config.host });
log.info({ host: config.host, port: config.port }, 'api listening');
