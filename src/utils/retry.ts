/**
 * Retry an async operation with exponential backoff and jitter.
 *
 * Only retries transient-looking failures: network errors (no HTTP response),
 * 5xx responses, and 429. Other errors bubble up immediately — retrying a 400
 * or a 410 is just latency.
 */

import { logger } from "./logger.js";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

function isTransient(err: unknown): boolean {
  // Errors thrown by impersonateFetch include the status code in their
  // message when it's a non-2xx response (e.g. "AustLII returned HTTP 502").
  // For network/timeout/DNS/TLS failures the message will lack a status.
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  const statusMatch = msg.match(/HTTP (\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1]!, 10);
    return status >= 500 || status === 429 || status === 408;
  }
  // No status → treat as a transport failure and retry.
  return /timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|impersonate fetch failed/i.test(msg);
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
