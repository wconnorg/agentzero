import { errorMessage, log } from "./log.ts";
import { WebsiteError } from "./website.ts";

const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * The wait before the next run. After a success, the interval. After failures, the
 * interval doubled for each failure in a row beyond the first, up to 30 minutes, and never
 * less than the website asked for.
 */
export function nextDelayMs(intervalMs: number, failures: number, retryAfterMs?: number): number {
  const backoff = failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
  return Math.max(backoff, retryAfterMs ?? 0);
}

/** Runs `task` now and then again and again, never two at once. */
export function repeat(name: string, intervalMs: number, task: () => Promise<void>): { stop(): void } {
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  async function run() {
    let retryAfterMs: number | undefined;
    try {
      await task();
      failures = 0;
    } catch (error) {
      failures++;
      if (error instanceof WebsiteError) retryAfterMs = error.retryAfterMs;
      log.error(`${name} failed: ${errorMessage(error)}`);
    }
    if (stopped) return;
    const delay = nextDelayMs(intervalMs, failures, retryAfterMs);
    if (failures > 0) log.info(`${name}: next try in ${Math.ceil(delay / 60_000)} min`);
    timer = setTimeout(run, delay);
  }

  void run();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
