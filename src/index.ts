import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { runServer } from "./server.js";
import { runWorker } from "./worker.js";
import { initStore } from "./store.js";
import { sleep } from "./cli.js";
import { isShuttingDown, requestShutdown } from "./shutdown.js";

const log = createLogger("app");

function installSignalHandlers(): void {
  let forceQuitArmed = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (forceQuitArmed) {
      log.warn("already shutting down, forcing exit", { sig });
      process.exit(1);
    }
    forceQuitArmed = true;
    log.info("received signal, shutting down", { sig });
    requestShutdown();
    setTimeout(() => {
      log.warn("shutdown grace period elapsed, exiting");
      process.exit(0);
    }, 15_000).unref();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", (e) => {
    log.error("uncaughtException", { err: String(e?.stack ?? e) });
  });
  process.on("unhandledRejection", (e) => {
    log.error("unhandledRejection", { err: String(e) });
  });
}

/**
 * Wrap a long-running component in a restart loop. If it throws, back off
 * with exponential jitter and re-run. If we ask for shutdown, stop.
 */
async function supervise(name: string, run: () => Promise<void>): Promise<void> {
  let attempt = 0;
  while (!isShuttingDown()) {
    try {
      log.info(`${name} starting`);
      await run();
      log.info(`${name} exited normally`);
      return;
    } catch (err) {
      if (isShuttingDown()) return;
      attempt++;
      const backoffMs = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 500);
      log.error(`${name} crashed, restarting`, {
        attempt,
        backoffMs,
        err: String(err instanceof Error ? err.stack ?? err.message : err),
      });
      await sleep(backoffMs, isShuttingDown);
    }
  }
}

async function main(): Promise<void> {
  installSignalHandlers();
  log.info(`${config.appName} starting`, {
    pid: process.pid,
    node: process.versions.node,
    port: config.webPort,
    instructionsDir: config.instructionsDir,
    frontendDir: config.frontendDir,
  });

  try {
    await initStore();
  } catch (e) {
    log.error("initStore failed, continuing and letting supervisors retry", { err: String(e) });
  }

  await Promise.all([
    supervise("web server", runServer),
    supervise("worker", runWorker),
  ]);

  log.info(`${config.appName} stopped`);
  process.exit(0);
}

void main();
