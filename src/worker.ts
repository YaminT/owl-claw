import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { sleep } from "./cli.ts";
import {
  claimForRun,
  getTask,
  pickNextWaiting,
  reconcile,
  type TaskStatus,
} from "./store.ts";
import { runPipeline } from "./pipeline.ts";
import { isShuttingDown } from "./shutdown.ts";

const log = createLogger("worker");

export interface WorkerStatus {
  running: boolean;
  currentFile: string | null;
  currentStage: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastOutcome: Extract<TaskStatus, "DONE_SUCCESS" | "DONE_FAILED"> | null;
  lastError: string | null;
  processedCount: number;
  startedAt: string;
}

const status: WorkerStatus = {
  running: false,
  currentFile: null,
  currentStage: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastOutcome: null,
  lastError: null,
  processedCount: 0,
  startedAt: new Date().toISOString(),
};

export function getWorkerStatus(): WorkerStatus {
  return { ...status };
}

/**
 * Main worker loop. Runs forever.
 *
 * Error strategy:
 * - Per-task errors are caught here and translated into DONE_FAILED by the
 *   pipeline itself. We continue to the next task.
 * - Errors from reconcile/claim surface as thrown here so the index.ts
 *   supervisor can restart the whole loop after a backoff.
 */
export async function runWorker(): Promise<void> {
  log.info("worker starting", {
    instructionsDir: config.instructionsDir,
    frontendDir: config.frontendDir,
    pollIntervalMs: config.pollIntervalMs,
    maxRetries: config.maxRetries,
    retryIntervalSec: config.retryIntervalSec,
    promptRuns: config.promptRuns,
  });

  while (!isShuttingDown()) {
    try {
      const nextName = await pickNextWaiting();
      if (!nextName) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      const claimed = await claimForRun(nextName);
      if (!claimed) {
        log.debug("claim lost, continuing", { nextName });
        await sleep(250);
        continue;
      }

      const task = await getTask(nextName);
      if (!task) {
        log.warn("claimed task vanished", { nextName });
        continue;
      }

      status.running = true;
      status.currentFile = task.filename;
      status.currentStage = "starting";
      status.lastStartedAt = new Date().toISOString();
      status.lastError = null;
      log.info("task start", { filename: task.filename });

      const outcome = await runPipeline(task, {
        shouldAbort: () => isShuttingDown(),
        onStage: (stage, note) => {
          status.currentStage = note ? `${stage}: ${note}` : stage;
        },
      });

      status.running = false;
      status.currentFile = null;
      status.currentStage = null;
      status.lastFinishedAt = new Date().toISOString();
      status.lastOutcome = outcome.status;
      status.lastError = outcome.error;
      status.processedCount += 1;
      log.info("task end", { filename: task.filename, outcome: outcome.status });
    } catch (err) {
      status.running = false;
      status.currentFile = null;
      status.currentStage = null;
      log.error("worker loop error", { err: String(err) });
      await sleep(5_000);
      try {
        await reconcile();
      } catch (e) {
        log.error("reconcile after error failed", { err: String(e) });
      }
    }
  }

  log.info("worker stop");
}
