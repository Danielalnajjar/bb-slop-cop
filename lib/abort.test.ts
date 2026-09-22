import { afterEach, expect, it, vi } from "vitest";
import { sleep, waitForAbort } from "./abort";

afterEach(() => vi.useRealTimers());

it("does not start work or a timer when the signal was already aborted", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  controller.abort();
  const work = vi.fn(async () => "late");
  await expect(waitForAbort(work, controller.signal)).rejects.toBe(controller.signal.reason);
  await expect(sleep(60_000, controller.signal)).rejects.toBe(controller.signal.reason);
  expect(work).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not consume a result when abort wins before the caller resumes", async () => {
  const controller = new AbortController();
  const result = waitForAbort(async () => "late", controller.signal);
  controller.abort();
  await expect(result).rejects.toBe(controller.signal.reason);
});

it("clears a sleeping timer on abort", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const result = sleep(60_000, controller.signal);
  controller.abort();
  await expect(result).rejects.toBe(controller.signal.reason);
  expect(vi.getTimerCount()).toBe(0);
});
