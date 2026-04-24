/**
 * Retry an async operation with exponential backoff and jitter.
 *
 * Only retries transient-looking failures: network errors (no HTTP response),
 * 5xx responses, and 429. Other errors bubble up immediately — retrying a 400
 * or a 410 is just latency.
 */

import axios from "axios";

import { logger } from "./logger.js";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

function isTransient(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    // No response at all → network/DNS/TLS/timeout.
    if (!err.response) return true;
    const status = err.response.status;
    return status >= 500 || status === 429 || status === 408;
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const label = options.label ?? "request";

  let attempt = 0;
  // Classic for-loop so we can rethrow the last error outside the catch.
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) {
        throw err;
      }
      const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const jitter = Math.random() * expDelay * 0.3;
      const delay = Math.floor(expDelay + jitter);
      logger.warn(
        `${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`,
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
}
