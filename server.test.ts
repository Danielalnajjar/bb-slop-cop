import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createStore } from "./lib/db";
import type { Run } from "./lib/types";

const THREAD_ID = "thr_review";

function makeReviewRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    ruleId: "rule_1",
    ruleName: "restraint-review",
    repo: "acme/widgets",
    prNumber: 42,
    prTitle: "Keep retries alive",
    prAuthor: "dana",
    headSha: "abc123",
    status: "reviewing",
    mode: "shadow",
    detail: null,
    threadId: THREAD_ID,
    commentCount: 0,
    startedAt: 1,
    finishedAt: null,
    ...overrides,
  };
}

async function setup() {
  const host = createFakePluginHost();
  host.harness.inspection.sdk.stub("threads.queue.list", () => []);
  host.harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
  await plugin(host.bb);
  const store = createStore(host.bb.storage.database() as never);
  store.insertRun(makeReviewRun());
  return { ...host, store };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("review retry lifecycle", () => {
  it("preserves the original failure after its retry already dispatched", async () => {
    vi.useFakeTimers();
    const { harness, store } = await setup();
    const retry = makeQueueEntry({
      id: "queued_retry",
      threadId: THREAD_ID,
      payload: {
        kind: "retry",
        attempt: 2,
        reason: "Provider overloaded",
        retryOfTurnRequestId: "request_1",
      },
    });

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: THREAD_ID,
        requestId: "request_1",
        errorInfo: { category: "overloaded", message: "busy" },
      }),
    );
    await harness.behavior.emitThreadEvent("message.queued", { entry: retry });
    await harness.behavior.emitThreadEvent("message.dispatched", {
      entry: retry,
    });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: THREAD_ID, status: "error" }),
      error: "provider overloaded",
    });

    expect(store.getRun("run_1")).toMatchObject({
      status: "reviewing",
      finishedAt: null,
    });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("preserves duplicate failure announcements for the same dispatched retry", async () => {
    vi.useFakeTimers();
    const { harness, store } = await setup();
    const retry = makeQueueEntry({
      id: "queued_retry",
      threadId: THREAD_ID,
      payload: {
        kind: "retry",
        attempt: 2,
        reason: "Provider overloaded",
        retryOfTurnRequestId: "request_1",
      },
    });
    const payload = {
      thread: makeThreadResponse({ id: THREAD_ID, status: "error" }),
      error: "provider overloaded",
    };

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: THREAD_ID, requestId: "request_1" }),
    );
    await harness.behavior.emitThreadEvent("message.queued", { entry: retry });
    await harness.behavior.emitThreadEvent("message.dispatched", {
      entry: retry,
    });
    await Promise.all([
      harness.behavior.emitThreadEvent("thread.failed", payload),
      harness.behavior.emitThreadEvent("thread.failed", payload),
    ]);

    expect(store.getRun("run_1")).toMatchObject({
      status: "reviewing",
      finishedAt: null,
    });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("finalizes when the next retry attempt fails without another retry", async () => {
    vi.useFakeTimers();
    const { harness, store } = await setup();
    const retry = makeQueueEntry({
      id: "queued_retry",
      threadId: THREAD_ID,
      payload: {
        kind: "retry",
        attempt: 2,
        reason: "Provider overloaded",
        retryOfTurnRequestId: "request_1",
      },
    });

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: THREAD_ID, requestId: "request_1" }),
    );
    await harness.behavior.emitThreadEvent("message.queued", { entry: retry });
    await harness.behavior.emitThreadEvent("message.dispatched", {
      entry: retry,
    });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: THREAD_ID, status: "error" }),
      error: "first attempt overloaded",
    });

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: THREAD_ID, requestId: "request_2" }),
    );
    const retryFailed = harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: THREAD_ID, status: "error" }),
      error: "retry was rejected",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await retryFailed;

    expect(store.getRun("run_1")).toMatchObject({
      status: "failed",
      detail: "retry was rejected",
      finishedAt: expect.any(Number),
    });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: THREAD_ID }],
    ]);
    await harness.lifecycle.dispose();
  });

  it("preserves a retry queued after thread.failed starts", async () => {
    vi.useFakeTimers();
    const { harness, store } = await setup();
    const retry = makeQueueEntry({
      id: "queued_retry",
      threadId: THREAD_ID,
      payload: {
        kind: "retry",
        attempt: 2,
        reason: "Provider overloaded",
        retryOfTurnRequestId: "request_1",
      },
    });

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: THREAD_ID, requestId: "request_1" }),
    );
    const failed = harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: THREAD_ID, status: "error" }),
      error: "provider overloaded",
    });
    await harness.behavior.emitThreadEvent("message.queued", { entry: retry });
    await failed;

    expect(store.getRun("run_1")).toMatchObject({
      status: "reviewing",
      finishedAt: null,
    });
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("finalizes duplicate failure announcements only once", async () => {
    vi.useFakeTimers();
    const { harness, store } = await setup();
    const payload = {
      thread: makeThreadResponse({ id: THREAD_ID, status: "error" }),
      error: "provider rejected the request",
    };

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({ threadId: THREAD_ID, requestId: "request_1" }),
    );
    const first = harness.behavior.emitThreadEvent("thread.failed", payload);
    const duplicate = harness.behavior.emitThreadEvent("thread.failed", payload);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, duplicate]);

    expect(store.getRun("run_1")?.status).toBe("failed");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([
      [{ threadId: THREAD_ID }],
    ]);
    await harness.lifecycle.dispose();
  });
});
