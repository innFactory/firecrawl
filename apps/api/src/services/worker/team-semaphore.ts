import { isSelfHosted } from "../../lib/deployment";
import { ScrapeJobTimeoutError, TransportableError } from "../../lib/error";
import { logger as _logger } from "../../lib/logger";
import { nuqRedis, semaphoreKeys } from "./redis";
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";

const stats = {
  active_semaphores: 0,
  semaphore_retries: 0,
  semaphore_failures: 0,
  semaphore_timeouts: 0,
  semaphore_aborts: 0,
};

const semaphoreAcquireHistogram = createHistogram();
const semaphoreProcessHistogram = createHistogram();

const histogram = monitorEventLoopDelay();
histogram.enable();

setInterval(() => {
  const lagMs = histogram.mean / 1e6;
  const m = process.memoryUsage();

  _logger.info("api health check monitor", {
    lag_ms: lagMs.toFixed(2),
    rss_mb: (m.rss / 1024 / 1024).toFixed(1),
    heap_used_mb: (m.heapUsed / 1024 / 1024).toFixed(1),
    external_mb: (m.external / 1024 / 1024).toFixed(1),

    active_semaphores: stats.active_semaphores,
    semaphore_retries: stats.semaphore_retries,
    semaphore_failures: stats.semaphore_failures,
    semaphore_timeouts: stats.semaphore_timeouts,
    semaphore_aborts: stats.semaphore_aborts,

    acquire_hist: {
      count: histogram.count,
      min: histogram.min,
      max: histogram.max,
      mean: histogram.mean,
      stddev: histogram.stddev,
      p50_ms: histogram.percentile(50) / 1e6,
      p90_ms: histogram.percentile(90) / 1e6,
      p95_ms: histogram.percentile(95) / 1e6,
      p99_ms: histogram.percentile(99) / 1e6,
    },

    process_hist: {
      count: semaphoreProcessHistogram.count,
      min: semaphoreProcessHistogram.min,
      max: semaphoreProcessHistogram.max,
      mean: semaphoreProcessHistogram.mean,
      stddev: semaphoreProcessHistogram.stddev,
      p50_ms: semaphoreProcessHistogram.percentile(50) / 1e6,
      p90_ms: semaphoreProcessHistogram.percentile(90) / 1e6,
      p95_ms: semaphoreProcessHistogram.percentile(95) / 1e6,
      p99_ms: semaphoreProcessHistogram.percentile(99) / 1e6,
    },
  });
}, 10_000);

setInterval(() => {
  _logger.info("api health check semaphore", {
    active_semaphores: stats.active_semaphores,
    semaphore_retries: stats.semaphore_retries,
    semaphore_failures: stats.semaphore_failures,
    semaphore_timeouts: stats.semaphore_timeouts,
    semaphore_aborts: stats.semaphore_aborts,

    acquire_hist: {
      count: histogram.count,
      min: histogram.min,
      max: histogram.max,
      mean: histogram.mean,
      stddev: histogram.stddev,
      p50_ms: histogram.percentile(50) / 1e6,
      p90_ms: histogram.percentile(90) / 1e6,
      p95_ms: histogram.percentile(95) / 1e6,
      p99_ms: histogram.percentile(99) / 1e6,
    },

    process_hist: {
      count: semaphoreProcessHistogram.count,
      min: semaphoreProcessHistogram.min,
      max: semaphoreProcessHistogram.max,
      mean: semaphoreProcessHistogram.mean,
      stddev: semaphoreProcessHistogram.stddev,
      p50_ms: semaphoreProcessHistogram.percentile(50) / 1e6,
      p90_ms: semaphoreProcessHistogram.percentile(90) / 1e6,
      p95_ms: semaphoreProcessHistogram.percentile(95) / 1e6,
      p99_ms: semaphoreProcessHistogram.percentile(99) / 1e6,
    },
  });

  stats.semaphore_retries = 0;
  stats.semaphore_failures = 0;
  stats.semaphore_timeouts = 0;
  stats.semaphore_aborts = 0;

  semaphoreAcquireHistogram.reset();
  semaphoreProcessHistogram.reset();
}, 60_000);

const { scripts, runScript, ensure } = nuqRedis;

const SEMAPHORE_TTL = 30 * 1000;

async function acquire(
  teamId: string,
  holderId: string,
  limit: number,
): Promise<{ granted: boolean; count: number; removed: number }> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  const [granted, count, removed] = await runScript<[number, number, number]>(
    scripts.semaphore.acquire,
    [keys.leases],
    [holderId, limit, SEMAPHORE_TTL],
  );

  return {
    granted: granted === 1,
    count,
    removed,
  };
}

async function acquireBlocking(
  teamId: string,
  holderId: string,
  limit: number,
  options: {
    base_delay_ms: number;
    max_delay_ms: number;
    timeout_ms: number;
    signal: AbortSignal;
  },
): Promise<{ limited: boolean; removed: number }> {
  await ensure();

  const deadline = Date.now() + options.timeout_ms;
  const keys = semaphoreKeys(teamId);

  let delay = options.base_delay_ms;
  let totalRemoved = 0;
  let failedOnce = false;

  let start = process.hrtime.bigint();

  do {
    if (options.signal.aborted) {
      stats.semaphore_aborts++;
      throw new ScrapeJobTimeoutError("Scrape timed out");
    }

    if (deadline < Date.now()) {
      stats.semaphore_timeouts++;
      throw new ScrapeJobTimeoutError("Scrape timed out");
    }

    const [granted, _count, _removed] = await runScript<
      [number, number, number]
    >(
      scripts.semaphore.acquire,
      [keys.leases],
      [holderId, limit, SEMAPHORE_TTL],
    );

    totalRemoved++;

    if (granted === 1) {
      const duration = process.hrtime.bigint() - start;
      semaphoreAcquireHistogram.record(duration);

      return { limited: failedOnce, removed: totalRemoved };
    }

    stats.semaphore_retries++;

    failedOnce = true;

    const jitter = Math.floor(
      Math.random() * Math.max(1, Math.floor(delay / 4)),
    );
    await new Promise(r => setTimeout(r, delay + jitter));

    delay = Math.min(options.max_delay_ms, Math.floor(delay * 1.5));
  } while (true);
}

async function heartbeat(teamId: string, holderId: string): Promise<boolean> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  return (
    (await runScript<number>(
      scripts.semaphore.heartbeat,
      [keys.leases],
      [holderId, SEMAPHORE_TTL],
    )) === 1
  );
}

async function release(teamId: string, holderId: string): Promise<void> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  await runScript<number>(scripts.semaphore.release, [keys.leases], [holderId]);
}

async function count(teamId: string): Promise<number> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  const count = await nuqRedis.zcard(keys.leases);
  return count;
}

function startHeartbeat(teamId: string, holderId: string, intervalMs: number) {
  let stopped = false;

  const promise = (async () => {
    while (!stopped) {
      const ok = await heartbeat(teamId, holderId);
      if (!ok) {
        throw new TransportableError("SCRAPE_TIMEOUT", "heartbeat_failed");
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return Promise.reject(
      new Error("heartbeat loop stopped unexpectedly"),
    ) as never;
  })();

  return {
    promise,
    stop() {
      stopped = true;
    },
  };
}

async function withSemaphore<T>(
  teamId: string,
  holderId: string,
  limit: number,
  signal: AbortSignal,
  timeoutMs: number,
  func: (limited: boolean) => Promise<T>,
): Promise<T> {
  if (isSelfHosted() && limit <= 1) {
    _logger.debug(`Bypassing concurrency limit for ${teamId}`, {
      teamId,
      jobId: holderId,
    });
    return await func(false);
  }

  const { limited } = await acquireBlocking(teamId, holderId, limit, {
    base_delay_ms: 25,
    max_delay_ms: 250,
    timeout_ms: timeoutMs,
    signal,
  });

  if (limited) {
    stats.semaphore_failures++;
  }

  const hb = startHeartbeat(teamId, holderId, SEMAPHORE_TTL / 2);
  const start = process.hrtime.bigint();

  stats.active_semaphores++;
  try {
    const result = await Promise.race([func(limited), hb.promise]);
    return result;
  } finally {
    stats.active_semaphores--;
    hb.stop();

    await release(teamId, holderId).catch(() => {});

    const duration = process.hrtime.bigint() - start;
    semaphoreProcessHistogram.record(duration);
  }
}

export const teamConcurrencySemaphore = {
  acquire,
  release,
  withSemaphore,
  count,
};
