import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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

function stubCheckWrites(): Record<string, unknown>[] {
  const writes: Record<string, unknown>[] = [];
  vi.mocked(spawn).mockImplementation((() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter;
      stdin: { on: () => void; end: (body: string) => void }; kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { on: () => {}, end: (body) => {
      writes.push(JSON.parse(body));
      child.stdout.emit("data", Buffer.from('{"id":47}'));
      child.emit("close", 0);
    } };
    return child as never;
  }) as typeof spawn);
  return writes;
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

describe("watcher shutdown", () => {
  it.each(["check", "archive"])("resumes terminal cleanup after abort during %s", async (phase) => {
    vi.useFakeTimers();
    let releaseCheck: (() => void) | undefined;
    let blockCheck = phase === "check";
    let verificationReads = 0;
    vi.mocked(execFile).mockImplementation(((
      _file: string, args: string[], _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (args.some((arg) => arg.includes("check-runs"))) {
        const respond = () => callback(null, '{"check_runs":[{"id":47,"external_id":"run_1"}]}', "");
        if (blockCheck) releaseCheck = respond;
        else respond();
      } else {
        if (!args.includes("user")) verificationReads++;
        callback(null, args.includes("user") ? "test-user" : "[]", "");
      }
      return undefined as never;
    }) as unknown as typeof execFile);
    const writes = stubCheckWrites();
    const { harness, store } = await setup({ mode: "live" });
    harness.inspection.sdk.stub("threads.get", () => makeThreadResponse({ id: THREAD_ID, status: "idle" }));
    let releaseArchive: (() => void) | undefined;
    harness.inspection.sdk.stub("threads.archive", () => new Promise((resolve) => {
      releaseArchive = () => resolve({ ok: true });
    }));
    const service = harness.behavior.runService("watcher");
    let replacement: ReturnType<typeof createFakePluginHost> | undefined;
    let stopped = false;
    void service.done.then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      expect(phase === "check" ? releaseCheck : releaseArchive).toBeDefined();
      expect(store.getRun("run_1")).toMatchObject({ status: "no_comment" });
      expect((await harness.behavior.runCli(["runs", "cancel", "run_1"])).exitCode).toBe(1);
      service.controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
      await service.done;
      const readsBeforeReload = verificationReads;
      replacement = await harness.lifecycle.reload(plugin);
      blockCheck = false;
      replacement.harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
      const restarted = replacement.harness.behavior.runService("watcher");
      await vi.advanceTimersByTimeAsync(0);
      const reloadedStore = createStore(replacement.bb.storage.database() as never);
      expect(reloadedStore.getRun("run_1")).toMatchObject({ status: "no_comment", finishedAt: expect.any(Number) });
      expect(replacement.harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: THREAD_ID }]]);
      expect(verificationReads).toBe(readsBeforeReload);
      expect(writes.at(-1)).toMatchObject({ status: "completed", conclusion: "neutral" });
      const writesAfterReload = writes.length;
      releaseCheck?.();
      releaseArchive?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toHaveLength(writesAfterReload);
      restarted.controller.abort();
      await restarted.done;
    } finally {
      service.controller.abort();
      releaseCheck?.();
      releaseArchive?.();
      await (replacement?.harness ?? harness).lifecycle.dispose();
    }
  });

  it("completes an aborted dispatch check after reloading its threadless reservation", async () => {
    vi.useFakeTimers();
    const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15 } });
    const writes = stubCheckWrites();
    stubGh({ readyPullRequest: true });
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "restraint-review", repo: "acme/widgets", mode: "live",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } });
    harness.inspection.sdk.stub("threads.spawn", () => new Promise(() => {}));
    const service = harness.behavior.runService("watcher");
    let replacement: ReturnType<typeof createFakePluginHost> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ status: "in_progress" });
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      service.controller.abort();
      await service.done;
      const reserved = store.listRuns({})[0]!;
      expect(reserved).toMatchObject({ status: "cancelled", threadId: null });
      replacement = await harness.lifecycle.reload(plugin);
      vi.mocked(execFile).mockImplementation(((
        _file: string, args: string[], _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, args.includes("user") ? "test-user" : args.some((arg) => arg.includes("check-runs"))
          ? JSON.stringify({ check_runs: [{ id: 47, external_id: reserved.id }] }) : "[]", "");
        return undefined as never;
      }) as unknown as typeof execFile);
      const restarted = replacement.harness.behavior.runService("watcher");
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toMatchObject({ status: "completed", conclusion: "cancelled" });
      expect(vi.mocked(spawn).mock.calls[1]![1]).toContain("PATCH");
      expect(vi.mocked(spawn).mock.calls[1]![1]).toContain("repos/acme/widgets/check-runs/47");
      expect(createStore(replacement.bb.storage.database() as never).getRun(reserved.id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Number) });
      expect(replacement.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
      restarted.controller.abort();
      await restarted.done;
    } finally {
      service.controller.abort();
      await (replacement?.harness ?? harness).lifecycle.dispose();
    }
  });

  it.each(["login", "poll", "prior-comments", "spawn", "reconcile", "verify-retry", "poll-sleep"] as const)(
    "stops before the host deadline during %s and ignores late results",
    async (phase) => {
      vi.useFakeTimers();
      const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15 } });
      let release: (() => void) | undefined;
      let reached = false;
      let polls = 0;
      const pr = {
        number: 7, title: "Ready PR", draft: false,
        head: { sha: "sha-7" }, base: { ref: "main" },
        user: { login: "dana" }, author_association: "MEMBER", labels: [],
      };
      vi.mocked(execFile).mockImplementation(((
        _file: string, args: string[], _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const login = args.includes("user");
        const poll = args.some((arg) => arg.includes("pulls?"));
        const response = login ? "test-user" : poll
          ? JSON.stringify([{ ...pr, draft: ++polls === 1 }]) : "[]";
        if ((phase === "login" && login) || (phase === "poll" && poll) ||
          (phase === "prior-comments" && args.some((arg) => arg.includes("issues/7/comments")))) {
          reached = true;
          release = () => callback(null, response, "");
        } else {
          if (phase === "verify-retry" && args.some((arg) => arg.includes("reviews"))) reached = true;
          if (phase === "poll-sleep" && poll) reached = true;
          callback(null, response, "");
        }
        return undefined as never;
      }) as unknown as typeof execFile);
      harness.inspection.sdk.stub("threads.get", () => {
        if (phase === "reconcile") {
          reached = true;
          return new Promise((resolve) => {
            release = () => resolve(makeThreadResponse({ id: THREAD_ID, status: "idle" }));
          });
        }
        return makeThreadResponse({ id: THREAD_ID, status: "idle" });
      });
      harness.inspection.sdk.stub("threads.spawn", () => {
        reached = true;
        return new Promise((resolve) => {
          release = () => resolve(makeThreadResponse({ id: "thr_new" }));
        });
      });
      await plugin(bb);
      const store = createStore(bb.storage.database() as never);
      if (phase === "reconcile" || phase === "verify-retry") store.insertRun(makeReviewRun({ mode: "live" }));
      await harness.behavior.callRpc("saveRule", {
        id: null,
        rule: {
          name: "restraint-review", repo: "acme/widgets",
          request: { projectId: "project", providerId: "codex", model: "test" },
        },
      });
      const service = harness.behavior.runService("watcher");
      let stopped = false;
      void service.done.then(() => { stopped = true; });
      try {
        await vi.advanceTimersByTimeAsync(phase === "spawn" || phase === "prior-comments" ? 15_000 : 0);
        expect(reached).toBe(true);
        service.controller.abort();
        // BB's service stop deadline is 5,000 ms. No I/O is released here.
        await vi.advanceTimersByTimeAsync(1);
        expect(stopped).toBe(true);
        await service.done;
        const runsAtStop = store.listRuns({});
        if (phase === "spawn" || phase === "prior-comments") {
          expect(runsAtStop).toHaveLength(1);
          expect(runsAtStop[0]).toMatchObject({
            status: "cancelled", threadId: null, finishedAt: null,
            detail: "plugin stopped before dispatch completed",
          });
          expect(store.hasRunFor(runsAtStop[0]!.ruleId, "acme/widgets", 7, "sha-7")).toBe(false);
        }
        const callsAtStop = vi.mocked(execFile).mock.calls.length;
        release?.();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(store.listRuns({})).toEqual(runsAtStop);
        expect(vi.mocked(execFile).mock.calls).toHaveLength(callsAtStop);
        expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
      } finally {
        service.controller.abort();
        release?.();
        await harness.lifecycle.dispose();
      }
    },
  );
});
