import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import {
  createFakePluginHost,
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
