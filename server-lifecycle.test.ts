import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createStore } from "./lib/db";
import type { Run } from "./lib/types";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const THREAD_ID = "thr_review";

function makeReviewRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    ruleId: "rule_1",
    ruleName: "restraint-review",
    repo: "acme/widgets",
    prNumber: 42,
    prTitle: "Reconcile a stranded review",
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

/** Enough of `gh` for the watcher to authenticate; no rule is ever polled. */
function stubGhLogin(): void {
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    callback(null, "test-user", "");
    return undefined as never;
  }) as unknown as typeof execFile);
}

/**
 * `gh` for a watcher that actually polls: an empty API, or one PR that is a
 * draft on the first poll and ready on the second, which is the
 * `ready_for_review` transition a rule triggers on.
 */
function stubGh(options: { readyPullRequest?: boolean } = {}): void {
  let polls = 0;
  const pullRequest = {
    number: 7,
    title: "A PR nobody is reviewing yet",
    draft: false,
    head: { sha: "sha-7" },
    base: { ref: "main" },
    user: { login: "dana" },
    author_association: "MEMBER",
    labels: [],
  };
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    let response = "[]";
    if (args.includes("user")) response = "test-user";
    else if (args.includes("repos/acme/widgets/pulls/7")) {
      response = JSON.stringify(pullRequest);
    } else if (args.some((arg) => arg.includes("pulls?"))) {
      response =
        options.readyPullRequest === true
          ? JSON.stringify([{ ...pullRequest, draft: ++polls === 1 }])
          : "[]";
    }
    callback(null, response, "");
    return undefined as never;
  }) as unknown as typeof execFile);
}

async function setup(run: Partial<Run> = {}) {
  const host = createFakePluginHost();
  host.harness.inspection.sdk.stub("threads.queue.list", () => []);
  host.harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
  host.harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
  await plugin(host.bb);
  const store = createStore(host.bb.storage.database() as never);
  store.insertRun(makeReviewRun(run));
  return { ...host, store };
}

/** Run the watcher's start pass, then shut it down. */
async function startWatcher(
  harness: Awaited<ReturnType<typeof setup>>["harness"],
): Promise<void> {
  const service = harness.behavior.runService("watcher");
  await vi.advanceTimersByTimeAsync(0);
  service.controller.abort();
  await service.done;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("reconciling runs a restart stranded", () => {
  it("cancels a run whose thread errored while the plugin was not loaded", async () => {
    vi.useFakeTimers();
    stubGhLogin();
    const { harness, store } = await setup();
    harness.inspection.sdk.stub("threads.get", () =>
      makeThreadResponse({ id: THREAD_ID, status: "error" }),
    );
    harness.inspection.sdk.stub("threads.events.list", () => ({
      events: [{ type: "provider/error", message: "model rejected the request" }],
    }));

    try {
      await startWatcher(harness);

      // A thread that died three minutes in never reached a verdict, so the
      // run is cancelled, not failed.
      expect(store.getRun("run_1")).toMatchObject({
        status: "cancelled",
        detail: "provider/error: model rejected the request",
        finishedAt: expect.any(Number),
      });
      expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([
        [{ threadId: THREAD_ID }],
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("verifies a run whose thread went idle while the plugin was not loaded", async () => {
    vi.useFakeTimers();
    stubGhLogin();
    const { harness, store } = await setup();
    harness.inspection.sdk.stub("threads.get", () =>
      makeThreadResponse({ id: THREAD_ID, status: "idle" }),
    );
    const body =
      "🚨 `slopcop/restraint-review` — this compare is unauthenticated\n\n" +
      "<!-- slopcop:rule=restraint-review run=run_1 sha=abc123 kind=summary -->";
    harness.inspection.sdk.stub("threads.output", () => ({ output: body }));

    try {
      await startWatcher(harness);

      // Shadow mode: the recovered transcript is the review body itself, and
      // it goes through the same verification an announced finish gets.
      expect(store.getRun("run_1")).toMatchObject({
        status: "shadowed",
        finishedAt: expect.any(Number),
      });
      expect(store.listComments("run_1")).toMatchObject([
        { attribution: "marker", bodyExcerpt: "this compare is unauthenticated" },
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("leaves a run alone while its thread is still working", async () => {
    vi.useFakeTimers();
    stubGhLogin();
    const { harness, store } = await setup();
    harness.inspection.sdk.stub("threads.get", () =>
      makeThreadResponse({ id: THREAD_ID, status: "active" }),
    );

    try {
      await startWatcher(harness);

      expect(store.getRun("run_1")).toMatchObject({
        status: "reviewing",
        finishedAt: null,
      });
      expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("verifies a recovered live run without reading its transcript", async () => {
    vi.useFakeTimers();
    stubGh();
    const { harness, store } = await setup({ mode: "live" });
    harness.inspection.sdk.stub("threads.get", () =>
      makeThreadResponse({ id: THREAD_ID, status: "idle" }),
    );
    harness.inspection.sdk.stub("threads.output", () => {
      throw new Error("transcript unavailable");
    });

    try {
      const service = harness.behavior.runService("watcher");
      // Live verification retries a bare no_comment once, four seconds later.
      await vi.advanceTimersByTimeAsync(5_000);
      service.controller.abort();
      await service.done;

      // A live review is verified against GitHub, so an unreadable transcript
      // must not leave the run stranded at `reviewing`.
      expect(store.getRun("run_1")).toMatchObject({
        status: "no_comment",
        finishedAt: expect.any(Number),
      });
      expect(harness.inspection.sdk.callsTo("threads.output")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("leaves an errored thread open while a provider retry is queued", async () => {
    vi.useFakeTimers();
    stubGhLogin();
    const { harness, store } = await setup();
    harness.inspection.sdk.stub("threads.get", () =>
      makeThreadResponse({ id: THREAD_ID, status: "error" }),
    );
    harness.inspection.sdk.stub("threads.queue.list", () => [
      makeQueueEntry({
        id: "queued_retry",
        threadId: THREAD_ID,
        payload: {
          kind: "retry",
          attempt: 2,
          reason: "Provider overloaded",
          retryOfTurnRequestId: "request_1",
        },
      }),
    ]);

    try {
      await startWatcher(harness);

      // The retry will resume this review; finalizing and archiving it here
      // would kill it, exactly as the live `thread.failed` path avoids doing.
      expect(store.getRun("run_1")).toMatchObject({
        status: "reviewing",
        finishedAt: null,
      });
      expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("counts a recovered running review against the concurrency cap", async () => {
    vi.useFakeTimers();
    stubGh({ readyPullRequest: true });
    const { bb, harness } = createFakePluginHost({
      settings: { pollSeconds: 15, maxConcurrentReviews: 1 },
    });
    harness.inspection.sdk.stub("threads.queue.list", () => []);
    harness.inspection.sdk.stub("threads.get", () =>
      makeThreadResponse({ id: THREAD_ID, status: "active" }),
    );
    harness.inspection.sdk.stub("threads.spawn", () =>
      makeThreadResponse({ id: "thr_new" }),
    );

    try {
      await plugin(bb);
      createStore(bb.storage.database() as never).insertRun(makeReviewRun());
      await harness.behavior.callRpc("saveRule", {
        id: null,
        rule: {
          name: "restraint-review",
          repo: "acme/widgets",
          request: { projectId: "project", providerId: "codex", model: "test" },
        },
      });

      const service = harness.behavior.runService("watcher");
      await vi.advanceTimersByTimeAsync(0);
      // The second poll sees PR #7 become ready for review.
      await vi.advanceTimersByTimeAsync(15_000);
      service.controller.abort();
      await service.done;

      // The recovered review still occupies the only slot, so the poll that
      // sees PR #7 go ready has nothing to give it.
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("keeps a run open when BB can no longer describe its thread", async () => {
    vi.useFakeTimers();
    stubGhLogin();
    const { harness, store } = await setup();
    harness.inspection.sdk.stub("threads.get", () => {
      throw new Error("thread not found");
    });

    try {
      await startWatcher(harness);

      expect(store.getRun("run_1")).toMatchObject({
        status: "reviewing",
        finishedAt: null,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

describe("threads retired mid-review", () => {
  it("cancels a run whose thread is archived before it finishes", async () => {
    const { harness, store } = await setup();
    try {
      await harness.behavior.emitThreadEvent("thread.archived", {
        thread: makeThreadResponse({ id: THREAD_ID, status: "active" }),
      });

      expect(store.getRun("run_1")).toMatchObject({
        status: "cancelled",
        detail: "the review thread was archived before it reached a verdict",
        finishedAt: expect.any(Number),
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("cancels a run whose thread is deleted before it finishes", async () => {
    const { harness, store } = await setup();
    try {
      await harness.behavior.emitThreadEvent("thread.deleted", {
        thread: makeThreadResponse({ id: THREAD_ID, status: "active" }),
      });

      expect(store.getRun("run_1")).toMatchObject({
        status: "cancelled",
        detail: "the review thread was deleted before it reached a verdict",
        finishedAt: expect.any(Number),
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("does not re-open a finished run when SlopCop archives its own thread", async () => {
    const { harness, store } = await setup({
      status: "shadowed",
      finishedAt: 2,
    });
    try {
      await harness.behavior.emitThreadEvent("thread.archived", {
        thread: makeThreadResponse({ id: THREAD_ID, status: "idle" }),
      });

      expect(store.getRun("run_1")).toMatchObject({
        status: "shadowed",
        detail: null,
        finishedAt: 2,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

describe("bb slopcop runs cancel", () => {
  it("cancels a reviewing run and stops its thread", async () => {
    const { harness, store } = await setup();
    try {
      const result = await harness.behavior.runCli(["runs", "cancel", "run_1"]);

      expect(result.exitCode).toBe(0);
      expect(store.getRun("run_1")).toMatchObject({
        status: "cancelled",
        detail: "cancelled by operator",
        finishedAt: expect.any(Number),
      });
      expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([
        [{ threadId: THREAD_ID }],
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("keeps a cancellation that lands while the review is still spawning", async () => {
    stubGh({ readyPullRequest: true });
    const { bb, harness } = createFakePluginHost();
    harness.inspection.sdk.stub("threads.queue.list", () => []);
    harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
    harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    // The operator cancels in the only window where the run has no thread yet.
    harness.inspection.sdk.stub("threads.spawn", async () => {
      const pending = store.listRuns({ limit: 1 })[0];
      await harness.behavior.runCli(["runs", "cancel", pending.id]);
      return makeThreadResponse({ id: "thr_race" });
    });

    try {
      const { rule } = (await harness.behavior.callRpc("saveRule", {
        id: null,
        rule: {
          name: "race-review",
          repo: "acme/widgets",
          request: { projectId: "project", providerId: "codex", model: "test" },
        },
      })) as { rule: { id: string } };
      await harness.behavior.callRpc("dispatchNow", {
        ruleId: rule.id,
        prNumber: 7,
      });

      // The spawned agent is stopped and the run stays cancelled: writing
      // `reviewing` over it would leave it running with nothing to close it.
      expect(store.listRuns({ limit: 1 })[0]).toMatchObject({
        status: "cancelled",
        detail: "cancelled by operator",
        threadId: "thr_race",
        finishedAt: expect.any(Number),
      });
      expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([
        [{ threadId: "thr_race" }],
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("refuses a run that already reached a terminal status", async () => {
    const { harness, store } = await setup({
      status: "commented",
      commentCount: 2,
      finishedAt: 2,
    });
    try {
      const result = await harness.behavior.runCli(["runs", "cancel", "run_1"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("already finished as commented");
      expect(store.getRun("run_1")).toMatchObject({
        status: "commented",
        detail: null,
        finishedAt: 2,
      });
      expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("reports an unknown run instead of cancelling nothing", async () => {
    const { harness } = await setup();
    try {
      const result = await harness.behavior.runCli(["runs", "cancel", "run_x"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no such run 'run_x'");
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
