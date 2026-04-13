let stopping = false;
const listeners: Array<() => void> = [];

export function requestShutdown(): void {
  if (stopping) return;
  stopping = true;
  for (const fn of listeners.splice(0)) {
    try { fn(); } catch {}
  }
}

export function isShuttingDown(): boolean {
  return stopping;
}

/**
 * Resolve when shutdown is requested. If already shutting down, resolves immediately.
 */
export function waitForShutdown(): Promise<void> {
  if (stopping) return Promise.resolve();
  return new Promise((resolve) => listeners.push(resolve));
}
