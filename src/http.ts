// HTTP transport for the etilbudsavis.dk / Tjek API: request timeouts, retries
// with exponential backoff, and a concurrency limiter for fanned-out batches.

import { SERVER_VERSION } from "./version.js";

const USER_AGENT = `tilbudstrolden-mcp/${SERVER_VERSION}`;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

/** Upper bound on in-flight requests when fanning out a batch. */
export const MAX_CONCURRENT = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff: 500ms, 1s, 2s... */
const backoffDelay = (attempt: number) => RETRY_BASE_MS * 2 ** attempt;

type FetchAttempt<T> = { retryable: false; body: T } | { retryable: true; error: Error };

/**
 * One request attempt. Rate limits and server errors come back as retryable;
 * any other non-OK status throws, since retrying will not help.
 */
async function attemptFetch<T>(url: string): Promise<FetchAttempt<T>> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT },
  });

  if (res.status === 429 || res.status >= 500) {
    return { retryable: true, error: new Error(`API returned ${res.status}`) };
  }
  if (!res.ok) {
    throw new Error(`API request failed (${res.status})`);
  }
  return { retryable: false, body: (await res.json()) as T };
}

export async function fetchJson<T>(url: string): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await attemptFetch<T>(url);
      if (!result.retryable) return result.body;
      lastError = result.error;
      await sleep(backoffDelay(attempt));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await sleep(backoffDelay(attempt));
      }
    }
  }

  throw lastError ?? new Error("API request failed after retries");
}

/**
 * Run tasks with at most `limit` in flight, returning results in task order.
 * Rejects with the first task error; no new tasks start after a failure.
 */
export async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (!failed && next < tasks.length) {
      const idx = next++;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  const workerCount = Math.min(Math.max(1, limit), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
