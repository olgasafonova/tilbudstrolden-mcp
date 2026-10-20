/**
 * Unit tests for src/http.ts — the retrying fetch wrapper and the concurrency
 * limiter used to fan out batched API calls.
 *
 * fetch is stubbed (no network) and fake timers drive the backoff sleeps, so
 * retry timing is asserted exactly without slowing the suite down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson, MAX_CONCURRENT, withConcurrencyLimit } from "./http.js";
import { SERVER_VERSION } from "./version.js";

const URL_ = "https://api.example.test/v2/offers";

type Reply = { status: number; body?: unknown } | Error;

/** Stub fetch to answer with each reply in turn; the last reply repeats. */
function stubFetch(...replies: Reply[]) {
  let call = 0;
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const reply = replies[Math.min(call++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Run fetchJson to completion, letting every backoff sleep elapse. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  // Observe the outcome now so a rejection is never briefly unhandled while
  // the timers run, then replay it to the caller.
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  it("returns the parsed body on the first successful response", async () => {
    const fetchMock = stubFetch({ status: 200, body: [{ id: "a" }] });
    await expect(settle(fetchJson(URL_))).resolves.toEqual([{ id: "a" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("identifies itself with a versioned User-Agent and a timeout signal", async () => {
    const fetchMock = stubFetch({ status: 200, body: {} });
    await settle(fetchJson(URL_));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init?.headers).toEqual({ "User-Agent": `tilbudstrolden-mcp/${SERVER_VERSION}` });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a server error and returns the later success", async () => {
    const fetchMock = stubFetch({ status: 503 }, { status: 200, body: { ok: true } });
    await expect(settle(fetchJson(URL_))).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a rate limit (429)", async () => {
    const fetchMock = stubFetch({ status: 429 }, { status: 429 }, { status: 200, body: 1 });
    await expect(settle(fetchJson(URL_))).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("backs off exponentially between retryable attempts", async () => {
    const fetchMock = stubFetch({ status: 500 }, { status: 500 }, { status: 200, body: "ok" });
    const result = fetchJson(URL_);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 500 ms after the first attempt
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // a further 1000 ms
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toBe("ok");
  });

  it("gives up after three attempts and reports the last status", async () => {
    const fetchMock = stubFetch({ status: 502 });
    await expect(settle(fetchJson(URL_))).rejects.toThrow("API returned 502");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails a client error immediately without retrying", async () => {
    const fetchMock = stubFetch({ status: 404 });
    const start = Date.now();
    await expect(settle(fetchJson(URL_))).rejects.toThrow("API request failed (404)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBe(0); // no backoff sleep
  });

  it("retries a network failure and rethrows it when every attempt fails", async () => {
    const fetchMock = stubFetch(new TypeError("fetch failed"));
    await expect(settle(fetchJson(URL_))).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recovers when a network failure is followed by a success", async () => {
    stubFetch(new TypeError("socket hang up"), { status: 200, body: { id: 7 } });
    await expect(settle(fetchJson(URL_))).resolves.toEqual({ id: 7 });
  });

  it("wraps a non-Error rejection in an Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "boom";
      }),
    );
    const err = await settle(fetchJson(URL_)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
  });
});

describe("withConcurrencyLimit", () => {
  /** A task that resolves after `ms` and records how many tasks ran at once. */
  function trackedTasks(delays: number[]) {
    let inFlight = 0;
    let peak = 0;
    const tasks = delays.map((ms, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return i;
    });
    return { tasks, peak: () => peak };
  }

  it("returns an empty array for no tasks", async () => {
    await expect(withConcurrencyLimit([], 4)).resolves.toEqual([]);
  });

  it("keeps results in task order even when later tasks finish first", async () => {
    const { tasks } = trackedTasks([30, 10, 20, 5, 1]);
    await expect(settle(withConcurrencyLimit(tasks, 2))).resolves.toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs more tasks at once than the limit", async () => {
    const { tasks, peak } = trackedTasks(Array.from({ length: 10 }, (_, i) => 10 + (i % 3)));
    const run = withConcurrencyLimit(tasks, MAX_CONCURRENT);
    await vi.runAllTimersAsync();
    await run;
    expect(peak()).toBe(MAX_CONCURRENT);
  });

  it("runs tasks one at a time with a limit of 1", async () => {
    const { tasks, peak } = trackedTasks([5, 5, 5]);
    const run = withConcurrencyLimit(tasks, 1);
    await vi.runAllTimersAsync();
    await expect(run).resolves.toEqual([0, 1, 2]);
    expect(peak()).toBe(1);
  });

  it("starts every task at once when the limit exceeds the task count", async () => {
    const { tasks, peak } = trackedTasks([5, 5, 5]);
    const run = withConcurrencyLimit(tasks, 10);
    await vi.runAllTimersAsync();
    await run;
    expect(peak()).toBe(3);
  });

  it("rejects when a task fails in the same tick as an earlier success", async () => {
    const tasks = [
      async () => 1,
      async () => {
        throw new Error("x");
      },
      async () => 3,
    ];
    await expect(withConcurrencyLimit(tasks, 2)).rejects.toThrow("x");
  });

  it("stops starting new tasks after a failure", async () => {
    const started: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) => async () => {
      started.push(i);
      if (i === 0) throw new Error("first failed");
      return i;
    });
    await expect(withConcurrencyLimit(tasks, 1)).rejects.toThrow("first failed");
    expect(started).toEqual([0]);
  });

  it("rejects when the first task to settle rejects", async () => {
    const tasks = [
      async () => {
        throw new Error("task 1 failed");
      },
      async () => 2,
      async () => 3,
    ];
    await expect(withConcurrencyLimit(tasks, 2)).rejects.toThrow("task 1 failed");
  });

  it("rejects when a task still running at the end rejects", async () => {
    const tasks = [
      async () => 1,
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("slow task failed");
      },
    ];
    await expect(settle(withConcurrencyLimit(tasks, 4))).rejects.toThrow("slow task failed");
  });
});
