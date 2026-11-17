import { buildApp, type AppInstance } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';

let app: AppInstance | undefined;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);
  const timeout = setTimeout(() => {
    console.error('[server] Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 5000);
  timeout.unref(); // Don't let this timer itself prevent exit

  let exitCode = 0;
  try {
    if (app) {
      app.gameEngine.close();
      app.wsHub.close();
      await app.close();
    }
  } catch (err) {
    console.error('[server] Error during shutdown:', err);
    exitCode = 1;
  } finally {
    clearTimeout(timeout);
    process.exitCode = exitCode;
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  app = buildApp() as AppInstance;
  await app.listen({ port, host });
} catch (error) {
  console.error('Unable to initialize the MZP Quiz server.', error instanceof Error ? error.message : error);
  process.exit(1);
}
