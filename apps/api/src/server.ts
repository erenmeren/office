import pino from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const config = loadConfig();
const app = await buildApp(config);
await app.listen({ port: config.port, host: '0.0.0.0' });
log.info({ port: config.port }, 'api listening');
