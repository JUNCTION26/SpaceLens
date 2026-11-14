/**
 * SpaceLens API server. Holds the Gemini key so the app works on any device without one.
 * Node 22+ built-ins only. Start with `node server/index.mjs`.
 */
import { createServer } from 'node:http';
import { ConfigError, loadConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createLogger } from './log.mjs';

const SHUTDOWN_GRACE_MS = 10_000;

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}

const log = createLogger({ level: config.logLevel });
const app = createApp(config, { logger: log });
const server = createServer({ requestTimeout: config.upstreamTimeoutMs + 15_000, headersTimeout: 15_000 }, (req, res) => {
  app.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
});
server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  log.info('listening', {
    port,
    models: config.modelAllowlist.length,
    origins: config.allowedOrigins.length,
    rateLimit: config.rateLimit,
    maxBodyBytes: config.maxBodyBytes,
  });
});

/** Stop taking new connections, let running answers finish, then exit. */
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  server.close(() => { log.info('stopped'); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => {
    log.warn('forcing close', { graceMs: SHUTDOWN_GRACE_MS });
    server.closeAllConnections();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
