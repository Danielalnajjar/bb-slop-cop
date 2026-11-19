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
import { buildThreadTitle } from "./lib/dispatch";
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
function stubGh(options: {
  readyPullRequest?: boolean;
  unrelatedDraft?: boolean;
  heads?: string[];
  baseSha?: string | null;
  association?: string;
  fork?: boolean;
  draft?: boolean;
  pollHead?: () => string;
  pollDraft?: () => boolean;
  detailHead?: () => string;
  pollOpen?: () => boolean;
  pollFiles?: () => string[] | null;
  priorComparison?: (base: string, head: string) => string | null;
  reviewComments?: () => { id: number; body: string; path: string; line: number }[];
  existingChecks?: () => { id: number; status: string; external_id: string }[];
} = {}): void {
  let polls = 0;
  let reads = 0;
  let capturedHead = options.heads?.[0] ?? "sha-7";
  const pullRequest = {
    number: 7,
    title: "A PR nobody is reviewing yet",
    draft: options.draft ?? false,
    head: { sha: "sha-7", ref: "feature-7", repo: { full_name: options.fork ? "dana/widgets" : "acme/widgets" } },
    base: { ref: "main", sha: "stale-base", repo: { full_name: "acme/widgets" } },
    user: { login: "dana" },
    author_association: options.association ?? "MEMBER",
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
    else if (args.some((arg) => arg.includes("/compare/"))) {
      const comparison = args[1]!.split("/compare/")[1]!;
      const [base, head] = comparison.split("...") as [string, string];
      const mergeBase = base === "main" && head === capturedHead
        ? options.baseSha ?? "7777777777777777777777777777777777777777"
        : options.priorComparison?.(base, head);
      if (mergeBase === null || mergeBase === undefined) {
        callback(new Error("could not compare those commits"), "", "");
        return undefined as never;
      }
      response = base === "main" && options.baseSha === null ? "" : mergeBase;
    } else if (args.includes("repos/acme/widgets/pulls/7")) {
      capturedHead = options.heads?.[Math.min(reads++, options.heads.length - 1)] ?? options.detailHead?.() ?? options.pollHead?.() ?? "sha-7";
      response = JSON.stringify({ ...pullRequest, head: { ...pullRequest.head, sha: capturedHead } });
    } else if (args.some(arg => arg.includes("/pulls/7/files?"))) {
      const files = options.pollFiles === undefined ? [] : options.pollFiles();
      if (files === null) {
        callback(new Error("temporary GitHub file-list failure"), "", "");
        return undefined as never;
      }
      response = JSON.stringify(files.map(filename => ({ filename })));
    } else if (options.existingChecks && args.some(arg => arg.includes("/check-runs?"))) {
      response = JSON.stringify({ check_runs: options.existingChecks() });
    } else if (options.reviewComments && args.some(arg => arg.includes("/pulls/7/comments?"))) {
      response = JSON.stringify(options.reviewComments());
    } else if (args.some((arg) => arg.includes("pulls?"))) {
      capturedHead = options.pollHead?.() ?? "sha-7";
      response =
        options.readyPullRequest === true && options.pollOpen?.() !== false
          ? JSON.stringify([
            { ...pullRequest, head: { ...pullRequest.head, sha: capturedHead }, draft: options.pollDraft?.() ?? ++polls === 1 },
            ...(options.unrelatedDraft ? [{ ...pullRequest, number: 8, draft: true,
              base: { ref: "deleted-stack" }, head: { sha: "unrelated-head" } }] : []),
          ])
          : "[]";
    }
    callback(null, response, "");
    return undefined as never;
  }) as unknown as typeof execFile);
}

function stubCheckWrites(distinctIds = false): Record<string, unknown>[] {
  const writes: Record<string, unknown>[] = [];
  let nextId = 47;
  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter;
      stdin: { on: () => void; end: (body: string) => void }; kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { on: () => {}, end: (body) => {
      writes.push({ ...JSON.parse(body), endpoint: args[3] });
      const id = distinctIds && args.includes("POST") ? nextId++ : 47;
      child.stdout.emit("data", Buffer.from(JSON.stringify({ id })));
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

function reviewProvisioningEvent(threadId: string, status: "active" | "completed" | "failed" | "cancelled") {
  return {
    id: `${threadId}-provision`,
    threadId,
    scope: { kind: "thread" },
    type: "system/thread-provisioning",
    seq: 1,
    createdAt: 1,
    data: { status, provisioningId: `provision-${threadId}`, environmentId: null, entries: [] },
  } as const;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it.each(["completed", "failed", "cancelled"] as const)(
  "queues only the same host and releases its slot when provisioning is %s",
  async (terminalStatus) => {
    vi.useFakeTimers();
    stubGh();
    const writes = stubCheckWrites(true);
    const { bb, harness } = createFakePluginHost({
      settings: { pollSeconds: 15, maxConcurrentProvisionsPerHost: 1 },
    });
    let finishFirstSpawn!: () => void;
    let firstStatus: "active" | typeof terminalStatus = "active";
    harness.inspection.sdk.stub("threads.spawn", ({ title }) => {
      if (title?.includes("first")) return new Promise(resolve => {
        finishFirstSpawn = () => resolve(makeThreadResponse({ id: "thr_first", status: "starting" }));
      });
      const id = title?.includes("same-host") ? "thr_same_host" : "thr_other_host";
      return makeThreadResponse({ id, status: "starting" });
    });
    harness.inspection.sdk.stub("threads.events.list", ({ threadId }) => [
      reviewProvisioningEvent(threadId, threadId === "thr_first" ? firstStatus : "active"),
    ]);
    await plugin(bb);
    const service = harness.behavior.runService("watcher");
    try {
      for (const [name, hostId, mode] of [
        ["first", "host_a", "live"],
        ["same-host", "host_a", "live"],
        ["other-host", "host_b", "shadow"],
      ]) {
        await harness.behavior.callRpc("saveRule", { id: null, rule: {
          name, repo: "acme/widgets", mode,
          request: { projectId: "project", providerId: "codex", model: "test",
            environment: { type: "host", hostId, workspace: { type: "project-checkout" } } },
        } });
      }
      const first = harness.behavior.runCli(["dispatch", "first", "7"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      const queued = await harness.behavior.runCli(["dispatch", "same-host", "7", "--force"]);
      expect(queued).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("Queued same-host") });
      expect((await harness.behavior.runCli(["dispatch", "other-host", "7"])).stdout).toContain("thread=thr_other_host");
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
      expect(writes.map(write => write.status)).toEqual(["in_progress", "in_progress"]);
      finishFirstSpawn();
      expect((await first).stdout).toContain("thread=thr_first");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);

      firstStatus = terminalStatus;
      await harness.behavior.emitThreadEvent("experimental_thread.events", {
        thread: makeThreadResponse({ id: "thr_first", status: "starting", originPluginId: bb.pluginId }), sequence: 1,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(3);
      expect(await harness.behavior.callRpc("listRuns", {})).toMatchObject({
        runs: expect.arrayContaining([
          expect.objectContaining({ ruleName: "first", status: "reviewing" }),
          expect.objectContaining({ ruleName: "same-host", status: "reviewing", threadId: "thr_same_host" }),
        ]),
      });
      expect(writes.map(write => write.status)).toEqual(["in_progress", "in_progress"]);
    } finally {
      finishFirstSpawn?.();
      service.controller.abort();
      await service.done;
      await harness.lifecycle.dispose();
    }
  },
);

it.each([false, true])(
  "reconciles an automatic provisioning wait after reload (head changed: %s)",
  async (headChanged) => {
    vi.useFakeTimers();
    let head = "sha-7";
    stubGh({ readyPullRequest: true, pollHead: () => head });
    const writes = stubCheckWrites(true);
    let host = createFakePluginHost({
      settings: { pollSeconds: 15, maxConcurrentProvisionsPerHost: 1 },
    });
    let firstReady = false;
    const configure = () => {
      host.harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_a", isDefault: true }] }));
      host.harness.inspection.sdk.stub("threads.get", ({ threadId }) => makeThreadResponse({ id: threadId, status: "starting" }));
      host.harness.inspection.sdk.stub("threads.spawn", ({ title }) =>
        makeThreadResponse({ id: title?.includes("manual") ? "thr_manual" : "thr_automatic", status: "starting" }));
      host.harness.inspection.sdk.stub("threads.events.list", ({ threadId }) => [
        reviewProvisioningEvent(threadId, threadId === "thr_manual" && firstReady ? "completed" : "active"),
      ]);
    };
    const runs = () => host.harness.behavior.callRpc("listRuns", {}) as Promise<{ runs: Run[] }>;
    configure();
    await plugin(host.bb);
    const rule = { repo: "acme/widgets", request: { projectId: "project", providerId: "codex", model: "test" } };
    try {
      await host.harness.behavior.callRpc("saveRule", { id: null, rule: {
        ...rule, name: "manual", triggers: ["new_commits"],
      } });
      await host.harness.behavior.callRpc("saveRule", { id: null, rule: {
        ...rule, name: "automatic", mode: "live",
      } });
      expect((await host.harness.behavior.runCli(["dispatch", "manual", "7"])).stdout).toContain("thread=thr_manual");
      const original = host.harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(15_000);
      } finally {
        original.controller.abort();
        await original.done;
      }
      const queued = (await runs()).runs.find(run => run.ruleName === "automatic");
      expect(queued).toMatchObject({ status: "waiting", threadId: null });
      expect(writes).toMatchObject([{ status: "in_progress", external_id: queued?.id }]);

      host = await host.harness.lifecycle.reload(plugin);
      configure();
      const restarted = host.harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
        expect((await runs()).runs).toContainEqual(queued);

        if (headChanged) head = "sha-8";
        firstReady = true; // The persisted event is enough; no live callback.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
        if (headChanged) {
          expect((await runs()).runs).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: queued?.id, status: "skipped", detail: "superseded by newer head sha-8" }),
            expect.objectContaining({ ruleName: "automatic", headSha: "sha-8", status: "reviewing", threadId: "thr_automatic" }),
          ]));
          expect(writes.map(write => write.status)).toEqual(["in_progress", "completed", "in_progress"]);
        } else {
          expect((await runs()).runs).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: queued?.id, status: "reviewing", threadId: "thr_automatic" }),
            expect.objectContaining({ ruleName: "manual", status: "reviewing" }),
          ]));
          expect(writes).toMatchObject([{ status: "in_progress", external_id: queued?.id }]);
        }
      } finally {
        restarted.controller.abort();
        await restarted.done;
      }
    } finally {
      await host.harness.lifecycle.dispose();
    }
  },
);

it("does not let the automatic review limit hold a free provisioning slot", async () => {
  vi.useFakeTimers();
  stubGh({ readyPullRequest: true });
  const { bb, harness } = createFakePluginHost({
    settings: { pollSeconds: 15, maxConcurrentReviews: 2, maxConcurrentProvisionsPerHost: 1 },
  });
  let firstReady = false;
  let spawned = 0;
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: `thr_${++spawned}`, status: "starting" }));
  harness.inspection.sdk.stub("threads.events.list", ({ threadId }) => [
    reviewProvisioningEvent(threadId, threadId === "thr_1" && firstReady ? "completed" : "active"),
  ]);
  harness.inspection.sdk.stub("threads.get", ({ threadId }) => makeThreadResponse({ id: threadId, status: "starting" }));
  await plugin(bb);
  const service = harness.behavior.runService("watcher");
  try {
    for (const [name, hostId, trigger] of [
      ["manual", "host_a", "new_commits"],
      ["filler", "host_b", "new_commits"],
      ["automatic", "host_a", "ready_for_review"],
    ]) {
      await harness.behavior.callRpc("saveRule", { id: null, rule: {
        name, repo: "acme/widgets", triggers: [trigger],
        request: { projectId: "project", providerId: "codex", model: "test",
          environment: { type: "host", hostId, workspace: { type: "project-checkout" } } },
      } });
    }
    expect((await harness.behavior.runCli(["dispatch", "manual", "7"])).stdout).toContain("thread=thr_1");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await harness.behavior.callRpc("listRuns", {})).toMatchObject({
      runs: expect.arrayContaining([expect.objectContaining({ ruleName: "automatic", status: "waiting" })]),
    });
    expect((await harness.behavior.runCli(["dispatch", "filler", "7"])).stdout).toContain("thread=thr_2");
    firstReady = true;
    await harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thr_1", originPluginId: bb.pluginId, status: "starting" }), sequence: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await harness.behavior.runCli(["dispatch", "manual", "7", "--force"])).stdout).toContain("thread=thr_3");
    expect(await harness.behavior.callRpc("listRuns", {})).toMatchObject({
      runs: expect.arrayContaining([expect.objectContaining({ ruleName: "automatic", status: "waiting" })]),
    });
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("does not open a settle check for a head already queued by manual dispatch", async () => {
  vi.useFakeTimers();
  let head = "sha-7";
  stubGh({ readyPullRequest: true, pollHead: () => head });
  const writes = stubCheckWrites(true);
  const { bb, harness } = createFakePluginHost({
    settings: { pollSeconds: 15, maxConcurrentProvisionsPerHost: 1 },
  });
  harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_a", isDefault: true }] }));
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: "thr_blocker", status: "starting" }));
  harness.inspection.sdk.stub("threads.events.list", () => [reviewProvisioningEvent("thr_blocker", "active")]);
  harness.inspection.sdk.stub("threads.get", ({ threadId }) => makeThreadResponse({ id: threadId, status: "starting" }));
  await plugin(bb);
  const service = harness.behavior.runService("watcher");
  const rule = { repo: "acme/widgets", request: { projectId: "project", providerId: "codex", model: "test" } };
  try {
    await harness.behavior.callRpc("saveRule", { id: null, rule: { ...rule, name: "blocker", enabled: false } });
    await harness.behavior.callRpc("saveRule", { id: null, rule: {
      ...rule, name: "settling", mode: "live", triggers: ["new_commits"], settleMinutes: 1,
    } });
    expect((await harness.behavior.runCli(["dispatch", "blocker", "7", "--force"])).stdout).toContain("thread=thr_blocker");
    await vi.advanceTimersByTimeAsync(15_000);
    head = "sha-8";
    expect((await harness.behavior.runCli(["dispatch", "settling", "7"])).stdout).toContain("Queued settling");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(writes).toMatchObject([{ status: "in_progress", head_sha: "sha-8" }]);
    const { runs } = await harness.behavior.callRpc("listRuns", {}) as { runs: Run[] };
    expect(runs.filter(run => run.ruleName === "settling" && run.status === "waiting")).toHaveLength(1);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it.each(["pre-start failure", "spawn rejection"] as const)(
  "releases the slot for queued work after %s without a provisioning record",
  async (failure) => {
    vi.useFakeTimers();
    stubGh();
    const { bb, harness } = createFakePluginHost({
      settings: { pollSeconds: 15, maxConcurrentProvisionsPerHost: 1 },
    });
    let finishFirstSpawn!: () => void;
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_a", isDefault: true }] }));
    harness.inspection.sdk.stub("threads.spawn", () => {
      if (finishFirstSpawn) return makeThreadResponse({ id: "thr_waiting", status: "starting" });
      return new Promise((resolve, reject) => {
        finishFirstSpawn = failure === "pre-start failure"
          ? () => resolve(makeThreadResponse({ id: "thr_early_error", status: "starting" }))
          : () => reject(new Error("spawn rejected"));
      });
    });
    harness.inspection.sdk.stub("threads.events.list", () => []);
    harness.inspection.sdk.stub("threads.get", ({ threadId }) => makeThreadResponse({ id: threadId, status: "starting" }));
    await plugin(bb);
    const service = harness.behavior.runService("watcher");
    try {
      await harness.behavior.callRpc("saveRule", { id: null, rule: {
        name: "review", repo: "acme/widgets",
        request: { projectId: "project", providerId: "codex", model: "test" },
      } });
      const first = harness.behavior.runCli(["dispatch", "review", "7"]);
      await vi.advanceTimersByTimeAsync(0);
      expect((await harness.behavior.runCli(["dispatch", "review", "7", "--force"])).stdout).toContain("Queued review");
      if (failure === "pre-start failure") {
        await harness.behavior.emitThreadEvent("thread.failed", {
          thread: makeThreadResponse({ id: "thr_early_error", status: "error", originPluginId: bb.pluginId }),
          error: "startup failed before provisioning",
        });
      }
      finishFirstSpawn();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(await harness.behavior.callRpc("listRuns", {})).toMatchObject({
        runs: expect.arrayContaining([
          expect.objectContaining({ status: "cancelled" }),
          expect.objectContaining({ status: "reviewing", threadId: "thr_waiting" }),
        ]),
      });
    } finally {
      finishFirstSpawn?.();
      service.controller.abort();
      await service.done;
      await harness.lifecycle.dispose();
    }
  },
);

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

  it("finalizes a recovered live run when its transcript is unavailable", async () => {
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
      expect(harness.inspection.sdk.callsTo("threads.output")).toHaveLength(1);
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

  it.each(["once_per_pr", "once_per_head_sha"] as const)("retries capacity-skipped rules without duplicate reviews (%s)", async (dedupe) => {
    vi.useFakeTimers();
    let headSha = "sha-7";
    stubGh({ readyPullRequest: true, pollHead: () => headSha });
    const { bb, harness } = createFakePluginHost({
      settings: { pollSeconds: 15, maxConcurrentReviews: 1 },
    });
    harness.inspection.sdk.stub("threads.queue.list", () => []);
    harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
    harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    harness.inspection.sdk.stub("threads.get", () =>
      makeThreadResponse({ id: THREAD_ID, status: "active" }),
    );
    let spawned = 0;
    harness.inspection.sdk.stub("threads.spawn", () =>
      makeThreadResponse({ id: `thr_new_${++spawned}` }),
    );

    try {
      await plugin(bb);
      const store = createStore(bb.storage.database() as never);
      store.insertRun(makeReviewRun());
      for (const name of ["first-review", "second-review"]) {
        await harness.behavior.callRpc("saveRule", {
          id: null,
          rule: {
            name,
            repo: "acme/widgets",
            dedupe,
            triggers: ["ready_for_review", "new_commits"],
            request: { projectId: "project", providerId: "codex", model: "test" },
          },
        });
      }

      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(0);
        // Bootstrap is a draft. The ready transition hits a full cap twice.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
        expect((await harness.behavior.runCli(["runs", "cancel", "run_1"])).exitCode).toBe(0);

        // Unchanged PR/head: one rule at a time gets the newly available slot.
        for (const name of ["first-review", "second-review"]) {
          await vi.advanceTimersByTimeAsync(15_000);
          const run = store.listRuns({}).find(run => run.ruleName === name && run.status === "reviewing");
          expect(run).toMatchObject({ prNumber: 7, headSha: "sha-7", threadId: expect.any(String) });
          await harness.behavior.emitThreadEvent("thread.idle", {
            thread: makeThreadResponse({ id: run!.threadId!, status: "idle" }),
            lastAssistantText: `🚨 \`slopcop/${name}\` — No issues found.\n\n<!-- slopcop:rule=${name} run=${run!.id} sha=sha-7 kind=summary -->`,
          });
          await vi.advanceTimersByTimeAsync(0);
          expect(store.getRun(run!.id)).toMatchObject({ status: "shadowed", finishedAt: expect.any(Number) });
        }
        await vi.advanceTimersByTimeAsync(30_000);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
        expect(store.listRuns({}).filter(run => run.prNumber === 7).map(run => run.status)).toEqual(["shadowed", "shadowed"]);

        headSha = "sha-8";
        for (const name of ["first-review", "second-review"]) {
          await vi.advanceTimersByTimeAsync(15_000);
          if (dedupe === "once_per_head_sha") {
            const run = store.listRuns({}).find(run => run.ruleName === name && run.status === "reviewing")!;
            expect(run).toMatchObject({ headSha: "sha-8" });
            await harness.behavior.emitThreadEvent("thread.idle", {
              thread: makeThreadResponse({ id: run.threadId!, status: "idle" }),
              lastAssistantText: `🚨 \`slopcop/${name}\` — No issues found.\n\n<!-- slopcop:rule=${name} run=${run.id} sha=sha-8 kind=summary -->`,
            });
            await vi.advanceTimersByTimeAsync(0);
          }
        }
        await vi.advanceTimersByTimeAsync(30_000);
        const runs = store.listRuns({}).filter(run => run.prNumber === 7);
        expect(runs).toHaveLength(4);
        expect(runs.filter(run => run.status === "shadowed")).toHaveLength(dedupe === "once_per_pr" ? 2 : 4);
        expect(runs.filter(run => run.status === "skipped")).toHaveLength(dedupe === "once_per_pr" ? 2 : 0);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(dedupe === "once_per_pr" ? 2 : 4);
      } finally {
        service.controller.abort();
        await service.done;
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("does not respawn a cancelled rule while a sibling waits for capacity", async () => {
    vi.useFakeTimers();
    stubGh({ readyPullRequest: true });
    const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15, maxConcurrentReviews: 1 } });
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
    harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
    let spawned = 0;
    harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: `thr_new_${++spawned}` }));
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    try {
      for (const name of ["first-review", "second-review"]) {
        await harness.behavior.callRpc("saveRule", { id: null, rule: {
          name, repo: "acme/widgets",
          request: { projectId: "project", providerId: "codex", model: "test" },
        } });
      }
      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(15_000);
        const first = store.listRuns({})[0]!;
        expect(first).toMatchObject({ ruleName: "first-review", status: "reviewing" });
        expect((await harness.behavior.runCli(["runs", "cancel", first.id])).exitCode).toBe(0);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(store.listRuns({})).toMatchObject([
          { ruleName: "second-review", status: "reviewing" },
          { ruleName: "first-review", status: "cancelled" },
        ]);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
      } finally {
        service.controller.abort();
        await service.done;
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("retains a fresh commit trigger while a ready rule is capacity-deferred across reload", async () => {
    vi.useFakeTimers();
    let headSha = "sha-7";
    stubGh({ readyPullRequest: true, pollHead: () => headSha });
    let host = createFakePluginHost({ settings: { pollSeconds: 15, maxConcurrentReviews: 1 } });
    let spawned = 0;
    const configure = () => {
      host.harness.inspection.sdk.stub("threads.queue.list", () => []);
      host.harness.inspection.sdk.stub("threads.get", () => makeThreadResponse({ id: THREAD_ID, status: "active" }));
      host.harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
      host.harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
      host.harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
      host.harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: `thr_reload_${++spawned}` }));
    };
    configure();
    await plugin(host.bb);
    try {
      createStore(host.bb.storage.database() as never).insertRun(makeReviewRun());
      for (const [name, trigger] of [["a-ready", "ready_for_review"], ["b-commits", "new_commits"]]) {
        await host.harness.behavior.callRpc("saveRule", { id: null, rule: {
          name, repo: "acme/widgets", triggers: [trigger],
          request: { projectId: "project", providerId: "codex", model: "test" },
        } });
      }
      const service = host.harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      } finally {
        service.controller.abort();
        await service.done;
      }
      host = await host.harness.lifecycle.reload(plugin);
      configure();
      headSha = "sha-8";
      const restarted = host.harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
        expect((await host.harness.behavior.runCli(["runs", "cancel", "run_1"])).exitCode).toBe(0);
        const store = createStore(host.bb.storage.database() as never);
        for (const name of ["a-ready", "b-commits"]) {
          await vi.advanceTimersByTimeAsync(15_000);
          const run = store.listRuns({}).find(run => run.ruleName === name)!;
          expect(run).toMatchObject({ status: "reviewing", headSha: "sha-8" });
          expect((await host.harness.behavior.runCli(["runs", "cancel", run.id])).exitCode).toBe(0);
        }
        await vi.advanceTimersByTimeAsync(30_000);
        expect(store.listRuns({}).filter(run => run.prNumber === 7)).toHaveLength(2);
        expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
      } finally {
        restarted.controller.abort();
        await restarted.done;
      }
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it.each(["closed", "disabled", "trigger-removed"] as const)("discards capacity deferrals when %s before a slot frees", async (change) => {
    vi.useFakeTimers();
    let open = true;
    stubGh({ readyPullRequest: true, pollOpen: () => open });
    const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15, maxConcurrentReviews: 1 } });
    harness.inspection.sdk.stub("threads.queue.list", () => []);
    harness.inspection.sdk.stub("threads.get", () => makeThreadResponse({ id: THREAD_ID, status: "active" }));
    harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
    harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: "thr_unwanted" }));
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    try {
      store.insertRun(makeReviewRun());
      const rule = {
        name: "ready-review", repo: "acme/widgets",
        request: { projectId: "project", providerId: "codex", model: "test" },
      };
      await harness.behavior.callRpc("saveRule", { id: null, rule });
      const id = store.listRules()[0]!.id;
      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(15_000);
        if (change === "closed") open = false;
        else if (change === "disabled") await harness.behavior.callRpc("setRuleEnabled", { id, enabled: false });
        else await harness.behavior.callRpc("saveRule", { id, rule: { ...rule, triggers: ["new_commits"] } });
        await vi.advanceTimersByTimeAsync(15_000);
        open = true;
        if (change === "disabled") await harness.behavior.callRpc("setRuleEnabled", { id, enabled: true });
        expect((await harness.behavior.runCli(["runs", "cancel", "run_1"])).exitCode).toBe(0);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
        expect(store.listRuns({}).filter(run => run.prNumber === 7)).toEqual([]);
      } finally {
        service.controller.abort();
        await service.done;
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.each(["rpc", "cli", "during-hydration"] as const)("consumes a capacity deferral on manual dispatch before cancellation (%s)", async (entry) => {
    vi.useFakeTimers();
    stubGh({ readyPullRequest: true });
    const ghReply = vi.mocked(execFile).getMockImplementation()!;
    let blockHydration = false;
    let releaseHydration: (() => void) | undefined;
    vi.mocked(execFile).mockImplementation(((
      file: string, args: string[], options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (args.some(arg => arg.includes("/pulls/7/files"))) {
        const respond = () => callback(null, '[{"filename":"src/index.ts"}]', "");
        if (blockHydration) {
          blockHydration = false;
          releaseHydration = respond;
        } else respond();
        return undefined as never;
      }
      return Reflect.apply(ghReply, undefined, [file, args, options, callback]);
    }) as unknown as typeof execFile);
    const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15, maxConcurrentReviews: 1 } });
    harness.inspection.sdk.stub("threads.queue.list", () => []);
    harness.inspection.sdk.stub("threads.get", () => makeThreadResponse({ id: THREAD_ID, status: "active" }));
    harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
    harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: "thr_manual" }));
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    try {
      store.insertRun(makeReviewRun());
      await harness.behavior.callRpc("saveRule", { id: null, rule: {
        name: "ready-review", repo: "acme/widgets",
        conditions: [{ kind: "paths", globs: ["src/**"] }],
        request: { projectId: "project", providerId: "codex", model: "test" },
      } });
      const ruleId = store.listRules()[0]!.id;
      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
        if (entry === "during-hydration") {
          blockHydration = true;
          await vi.advanceTimersByTimeAsync(15_000);
          expect(releaseHydration).toBeDefined();
        }
        if (entry === "cli") {
          expect((await harness.behavior.runCli(["dispatch", ruleId, "7"])).exitCode).toBe(0);
        } else {
          expect(await harness.behavior.callRpc("dispatchNow", { ruleId, prNumber: 7 }))
            .toMatchObject({ threadId: "thr_manual", blockedReason: null });
        }
        const manual = store.listRuns({}).find(run => run.prNumber === 7)!;
        expect((await harness.behavior.runCli(["runs", "cancel", manual.id])).exitCode).toBe(0);
        expect((await harness.behavior.runCli(["runs", "cancel", "run_1"])).exitCode).toBe(0);
        releaseHydration?.();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(store.listRuns({}).filter(run => run.prNumber === 7)).toMatchObject([
          { id: manual.id, status: "cancelled" },
        ]);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      } finally {
        service.controller.abort();
        releaseHydration?.();
        await service.done;
      }
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
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
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

  it.each(["before", "after", "after-dispose"] as const)("ignores a spawn result delivered %s abort without stale storage access", async (timing) => {
    vi.useFakeTimers();
    stubGh({ readyPullRequest: true });
    const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15 } });
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "restraint-review", repo: "acme/widgets", mode: "shadow",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } });
    let release!: () => void;
    harness.inspection.sdk.stub("threads.spawn", () => new Promise((resolve) => {
      release = () => resolve(makeThreadResponse({ id: THREAD_ID }));
    }));
    const service = harness.behavior.runService("watcher");
    let replacement: ReturnType<typeof createFakePluginHost> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(release).toBeTypeOf("function");
      if (timing === "before") release();
      service.controller.abort();
      await service.done;
      const reserved = store.listRuns({})[0]!;
      if (timing === "after") release();
      if (timing === "after-dispose") replacement = await harness.lifecycle.reload(plugin);
      if (timing === "after-dispose") release();
      await vi.advanceTimersByTimeAsync(0);
      const currentStore = replacement === undefined ? store : createStore(replacement.bb.storage.database() as never);
      expect(currentStore.getRun(reserved.id)).toEqual(reserved);
      expect(reserved.threadId).toBeNull();
      expect(harness.inspection.logEntries.filter((entry) => entry.message.includes("ignored spawn result"))).toEqual([
        { level: "info", message: `run ${reserved.id}: ignored spawn result after shutdown (thread ${THREAD_ID})` },
      ]);
    } finally {
      service.controller.abort();
      await (replacement?.harness ?? harness).lifecycle.dispose();
    }
  });

  it("stops a late spawn after reload without reopening the cancelled run", async () => {
    vi.useFakeTimers();
    stubGh({ readyPullRequest: true });
    const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15 } });
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "restraint-review", repo: "acme/widgets", mode: "shadow",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } });
    let release!: () => void;
    harness.inspection.sdk.stub("threads.spawn", () => new Promise((resolve) => {
      release = () => resolve(makeThreadResponse({ id: THREAD_ID }));
    }));
    const service = harness.behavior.runService("watcher");
    let replacement: ReturnType<typeof createFakePluginHost> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      const reserved = store.listRuns({})[0]!;
      await harness.behavior.runCli(["runs", "cancel", reserved.id]);
      const finalized = store.getRun(reserved.id)!;
      expect(finalized).toMatchObject({
        status: "cancelled", threadId: null, finishedAt: expect.any(Number),
      });
      service.controller.abort();
      await service.done;
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getRun(reserved.id)).toEqual(finalized);
      replacement = await harness.lifecycle.reload(plugin);
      const title = buildThreadTitle({ runId: reserved.id,
        rule: { name: "restraint-review", mode: "shadow" }, pullRequest: { number: 7 } });
      replacement.harness.inspection.sdk.stub("threads.list", () => [
        makeThreadResponse({ id: THREAD_ID, title, originPluginId: bb.pluginId }),
      ]);
      replacement.harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
      replacement.harness.inspection.sdk.stub("threads.get", () => makeThreadResponse({ id: THREAD_ID, status: "idle" }));
      await startWatcher(replacement.harness);
      expect(createStore(replacement.bb.storage.database() as never).getRun(reserved.id)).toEqual({
        ...finalized, threadId: THREAD_ID,
      });
      expect(replacement.harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: THREAD_ID }]]);
    } finally {
      service.controller.abort();
      await service.done;
      await (replacement?.harness ?? harness).lifecycle.dispose();
    }
  });

  it.each([0, 1, 2])("recovers a threadless dispatch with %i matching plugin threads", async (count) => {
    vi.useFakeTimers();
    stubGhLogin();
    const { bb, harness, store } = await setup({
      status: "cancelled", threadId: null, detail: "plugin stopped before dispatch completed",
    });
    const title = buildThreadTitle({ runId: "run_1", rule: { name: "restraint-review", mode: "shadow" }, pullRequest: { number: 42 } });
    harness.inspection.sdk.stub("threads.list", (args) => args.archived ? [] : count === 1 && args.offset === 0
      ? Array.from({ length: 100 }, (_, i) => makeThreadResponse({ id: `unrelated_${i}`, title: "another review", originPluginId: bb.pluginId })) : [
      // A same-title thread from another plugin must never be adopted.
      makeThreadResponse({ id: "foreign", title, originPluginId: "another-plugin" }),
      ...Array.from({ length: count }, (_, i) => makeThreadResponse({ id: `thr_match_${i}`, title, originPluginId: bb.pluginId })),
    ]);
    harness.inspection.sdk.stub("threads.get", ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    harness.inspection.sdk.stub("threads.output", () => ({ output: "No findings.\n<!-- slopcop:rule=restraint-review run=run_1 sha=abc123 kind=summary -->" }));
    try {
      await startWatcher(harness);
      const run = store.getRun("run_1")!;
      if (count === 1) {
        expect(run).toMatchObject({ threadId: "thr_match_0", status: "shadowed", finishedAt: expect.any(Number) });
        expect(harness.inspection.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_match_0" }]]);
      } else {
        expect(run).toMatchObject({ threadId: null, status: "cancelled", finishedAt: expect.any(Number),
          detail: count === 0 ? "dispatch recovery found no matching thread" : "dispatch recovery found multiple matching threads" });
        expect(store.hasSettlingDuplicate("rule_1", "acme/widgets", 42, "abc123", "shadow")).toBe(false);
      }
      expect(harness.inspection.sdk.callsTo("threads.list")[0]).toEqual([
        { originPluginId: bb.pluginId, includeHidden: true, archived: false, limit: 100, offset: 0 },
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("completes an aborted dispatch check after reloading its threadless reservation", async () => {
    vi.useFakeTimers();
    const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15 } });
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
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
      replacement.harness.inspection.sdk.stub("threads.list", () => []);
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

  it.each(["login", "poll", "prior-comments", "merge-base", "spawn", "reconcile", "reconcile-output", "verify-retry", "poll-sleep"] as const)(
    "stops before the host deadline during %s and ignores late results",
    async (phase) => {
      vi.useFakeTimers();
      const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15 } });
      harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
      let release: (() => void) | undefined;
      let reached = false;
      let polls = 0;
      const pr = {
        number: 7, title: "Ready PR", draft: false,
        head: { sha: "sha-7" }, base: { ref: "main", sha: "7777777777777777777777777777777777777777" },
        user: { login: "dana" }, author_association: "MEMBER", labels: [],
      };
      vi.mocked(execFile).mockImplementation(((
        _file: string, args: string[], _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const login = args.includes("user");
        const poll = args.some((arg) => arg.includes("pulls?"));
        const response = login ? "test-user" : args.some((arg) => arg.includes("/compare/")) ? "7777777777777777777777777777777777777777" : poll
          ? JSON.stringify([{ ...pr, draft: ++polls === 1 }]) : "[]";
        if ((phase === "login" && login) || (phase === "poll" && poll) ||
          (phase === "prior-comments" && args.some((arg) => arg.includes("issues/7/comments"))) ||
          (phase === "merge-base" && args.some((arg) => arg.includes("/compare/")))) {
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
      harness.inspection.sdk.stub("threads.output", () => {
        reached = true;
        return new Promise((resolve) => {
          release = () => resolve({ output: "No findings." });
        });
      });
      await plugin(bb);
      const store = createStore(bb.storage.database() as never);
      if (phase === "reconcile" || phase === "reconcile-output" || phase === "verify-retry") store.insertRun(makeReviewRun({ mode: "live" }));
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
        await vi.advanceTimersByTimeAsync(phase === "spawn" || phase === "prior-comments" || phase === "merge-base" ? 15_000 : phase === "reconcile-output" ? 4_000 : 0);
        expect(reached).toBe(true);
        service.controller.abort();
        // BB's service stop deadline is 5,000 ms. No I/O is released here.
        await vi.advanceTimersByTimeAsync(1);
        expect(stopped).toBe(true);
        await service.done;
        const runsAtStop = store.listRuns({});
        if (phase === "spawn" || phase === "prior-comments" || phase === "merge-base") {
          expect(runsAtStop).toHaveLength(1);
          expect(runsAtStop[0]).toMatchObject({
            status: "cancelled", threadId: null, finishedAt: null,
            detail: "plugin stopped before dispatch completed",
          });
          expect(store.hasSettlingDuplicate(runsAtStop[0]!.ruleId, "acme/widgets", 7, "sha-7", "shadow")).toBe(false);
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


describe("manual dispatch head selection", () => {
  it.each([
    { name: "waits for the pushed head before reserving", heads: ["old", "old", "pushed"], expected: "pushed", success: true },
    { name: "refuses an unobserved head without reserving", heads: ["old"], expected: "pushed", success: false },
    { name: "prints the dispatched head without --head", heads: ["old"], expected: undefined, success: true },
  ])("$name", async ({ heads, expected, success }) => {
    vi.useFakeTimers();
    stubGh({ heads });
    const { bb, harness } = createFakePluginHost();
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
    await plugin(bb);
    const store = createStore(bb.storage.database() as never);
    try {
      await harness.behavior.callRpc("saveRule", { id: null, rule: {
        name: "head-review", repo: "acme/widgets",
        request: { projectId: "project", providerId: "codex", model: "test" },
      } });
      const pending = harness.behavior.runCli([
        "dispatch", "head-review", "7", ...(expected ? ["--head", expected] : []),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      if (expected) expect(store.listRuns({ limit: 10 })).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;
      expect(result.exitCode).toBe(success ? 0 : 1);
      if (success) {
        expect(store.listRuns({ limit: 10 })).toMatchObject([{ headSha: expected ?? "old", status: "reviewing" }]);
        expect(result.stdout).toContain(`head=${expected ?? "old"}`);
      } else {
        expect(store.listRuns({ limit: 10 })).toEqual([]);
        expect(result.stderr).toContain("expected pushed");
        expect(result.stderr).toContain("observed old");
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

it.each([["cli", "cli"], ["rpc", "rpc"], ["rpc", "cli"]] as const)("admits only one concurrent %s/%s dispatch for the same rule/PR/head", async (firstSurface, secondSurface) => {
  stubGh();
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "dedupe-review", repo: "acme/widgets", dedupe: "once_per_head_sha",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } }) as { rule: { id: string } };
    const [first, second] = await Promise.all([
      firstSurface === "rpc"
        ? harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 })
        : harness.behavior.runCli(["dispatch", "dedupe-review", "7"]),
      secondSurface === "rpc"
        ? harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 })
        : harness.behavior.runCli(["dispatch", "dedupe-review", "7"]),
    ]);
    const runs = store.listRuns();
    expect(runs.filter(run => run.status === "reviewing")).toHaveLength(1);
    expect(runs.filter(run => run.status === "skipped")).toHaveLength(1);
    const winner = runs.find(run => run.status === "reviewing")!;
    const loser = runs.find(run => run.status === "skipped")!;
    expect(loser).toMatchObject({ threadId: null, finishedAt: expect.any(Number), detail: expect.stringContaining(winner.id) });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    // The losing caller can distinguish a recorded skip from a dispatched review.
    const responses = JSON.stringify([first, second]);
    expect(responses).toContain(loser.id);
    expect(responses).toContain(loser.detail!);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("records a poller's duplicate skip while a manual review is still preparing", async () => {
  vi.useFakeTimers();
  stubGh({ readyPullRequest: true });
  const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15 } });
  let releasePreparation!: (value: unknown) => void;
  harness.inspection.sdk.stub("projects.get", () => new Promise(resolve => { releasePreparation = resolve; }));
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  const service = harness.behavior.runService("watcher");
  try {
    await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "dedupe-review", repo: "acme/widgets", dedupe: "once_per_head_sha",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } });
    await vi.advanceTimersByTimeAsync(0); // Bootstrap with the draft PR.
    const manual = harness.behavior.runCli(["dispatch", "dedupe-review", "7"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.listRuns()).toMatchObject([{ status: "dispatched" }]);
    const winner = store.listRuns()[0]!;
    await vi.advanceTimersByTimeAsync(15_000); // PR becomes ready during preparation.
    expect(store.listRuns().filter(run => run.status === "skipped")).toMatchObject([
      { detail: expect.stringContaining(winner.id), threadId: null },
    ]);
    releasePreparation({ sources: [{ hostId: "host_default", isDefault: true }] });
    await manual;
    expect(store.getRun(winner.id)?.status).toBe("reviewing");
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("admits a re-review after cancelling the previous run on the same head", async () => {
  stubGh();
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
  harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "dedupe-review", repo: "acme/widgets", dedupe: "once_per_head_sha",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } }) as { rule: { id: string } };
    const first = await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 }) as { runId: string };
    expect((await harness.behavior.runCli(["runs", "cancel", first.runId])).exitCode).toBe(0);
    expect(store.getRun(first.runId)?.status).toBe("cancelled");
    const second = await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 }) as { runId: string };
    expect(store.getRun(second.runId)?.status).toBe("reviewing");
    expect(store.listRuns().filter(run => run.status === "skipped")).toEqual([]);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each(["cli", "rpc"] as const)("allows an explicit forced %s re-review of an already admitted head", async (surface) => {
  stubGh();
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "dedupe-review", repo: "acme/widgets", dedupe: "once_per_head_sha",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } }) as { rule: { id: string } };
    await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 });
    if (surface === "cli") {
      expect((await harness.behavior.runCli(["dispatch", "dedupe-review", "7", "--force"])).exitCode).toBe(0);
    } else {
      expect(await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7, force: true })).toMatchObject({ threadId: THREAD_ID, blockedReason: null });
    }
    expect(store.listRuns()).toHaveLength(2);
    expect(store.listRuns().every(run => run.status === "reviewing")).toBe(true);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("reviews a draft by hand only with --include-draft", async () => {
  stubGh({ draft: true });
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "draft-review", repo: "acme/widgets",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } });
    expect((await harness.behavior.runCli(["check", "draft-review", "7"])).stdout)
      .toBe("NO MATCH — pull request is a draft");
    expect((await harness.behavior.runCli(["check", "draft-review", "7", "--include-draft"])).stdout)
      .toContain("MATCH — 'draft-review' would review #7");
    const refused = await harness.behavior.runCli(["dispatch", "draft-review", "7"]);
    expect(refused.exitCode).toBe(1);
    expect(store.listRuns({ limit: 10 })).toEqual([]);
    const dispatched = await harness.behavior.runCli(["dispatch", "draft-review", "7", "--include-draft"]);
    expect(dispatched.exitCode).toBe(0);
    expect(store.listRuns({ limit: 10 })).toMatchObject([{ headSha: "sha-7", detail: null }]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

describe("automatic review ranges", () => {
  const priorHead = "a".repeat(40);
  const pushedHead = "b".repeat(40);
  const fullBase = "7".repeat(40);
  const ruleName = "scoped-review";
  const testPath = "test/full-pr-only.ts";

  function reviewHost() {
    const host = createFakePluginHost({ settings: { pollSeconds: 15 } });
    const { sdk } = host.harness.inspection;
    sdk.stub("threads.queue.list", () => []);
    sdk.stub("threads.archive", () => ({ ok: true }));
    sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    let spawns = 0;
    sdk.stub("threads.spawn", () => makeThreadResponse({ id: `thr_scoped_${++spawns}` }));
    return host;
  }

  async function saveRule(harness: ReturnType<typeof reviewHost>["harness"], overrides: Record<string, unknown> = {}) {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: ruleName, repo: "acme/widgets", dedupe: "once_per_head_sha",
      triggers: ["new_commits", "ready_for_review"],
      prompt: "Review the changes for this rule.",
      request: { projectId: "project", providerId: "codex", model: "test" },
      ...overrides,
    } }) as { rule: { id: string } };
    return rule.id;
  }

  function promptAt(harness: ReturnType<typeof reviewHost>["harness"], index: number): string {
    return (harness.inspection.sdk.callsTo("threads.spawn")[index]?.[0] as { prompt: string }).prompt;
  }

  it.each([
    { case: "confirmed ancestor of an already-observed commit", comparison: priorHead, verified: true, scope: "incremental" },
    { case: "force-push", comparison: "f".repeat(40), verified: true, scope: "full" },
    { case: "failed compare", comparison: null, verified: true, scope: "full" },
    { case: "malformed compare", comparison: "not-a-sha", verified: true, scope: "full" },
    { case: "only shadow history", comparison: priorHead, verified: false, scope: "full" },
  ])("uses $scope review for $case", async ({ comparison, verified, scope }) => {
    vi.useFakeTimers();
    let head = priorHead;
    stubGh({
      readyPullRequest: true, pollHead: () => head, pollDraft: () => false,
      priorComparison: (base, target) => base === priorHead && target === pushedHead ? comparison : null,
      pollFiles: () => ["src/changed.ts", testPath],
    });
    const { bb, harness } = reviewHost();
    try {
      await plugin(bb);
      const store = createStore(bb.storage.database() as never);
      const ruleId = await saveRule(harness, { conditions: [{ kind: "paths", globs: ["src/**"] }] });
      if (verified) store.insertRun(makeReviewRun({
        id: "run_verified", ruleId, ruleName, prNumber: 7, headSha: priorHead,
        mode: "live", status: "commented_partial", threadId: null, finishedAt: 2,
      }));
      for (const [index, status] of (["cancelled", "failed", "skipped", "shadowed"] as const).entries()) {
        store.insertRun(makeReviewRun({
          id: `run_${status}`, ruleId, ruleName, prNumber: 7,
          headSha: status === "cancelled" ? pushedHead : "c".repeat(40),
          status, threadId: null, startedAt: 3 + index, finishedAt: 4 + index,
        }));
      }
      for (const status of ["no_comment", "commented_unmarked", "commented_unattributed"] as const) {
        store.insertRun(makeReviewRun({
          id: `run_shadow_${status}`, ruleId, ruleName, prNumber: 7, headSha: priorHead,
          status, mode: "shadow", threadId: null, startedAt: 10, finishedAt: 11,
        }));
      }
      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(0);
        head = pushedHead;
        await vi.advanceTimersByTimeAsync(15_000);
        const prompt = promptAt(harness, 0);
        expect(prompt).toContain("- Trigger: `new_commits`");
        expect(prompt).toContain(`- Previous verified head: ${verified ? "`" + priorHead + "`" : "none"}`);
        expect(prompt).toContain(`- Review scope: ${scope}`);
        if (scope === "incremental") {
          expect(prompt).toContain(`Inspect only \`git diff ${priorHead}..${pushedHead}\``);
          expect(prompt).toContain(`git merge-base --is-ancestor ${priorHead} ${pushedHead}`);
          expect(prompt).toContain("requirements that apply to those changes");
          expect(prompt).not.toContain(testPath);
          expect(prompt).not.toContain(`git diff ${fullBase}...${pushedHead}`);
        } else {
          expect(prompt).toContain(`Inspect \`git diff ${fullBase}...${pushedHead}\` and full files`);
          expect(prompt).toContain(testPath);
        }
      } finally {
        service.controller.abort();
        await service.done;
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("does not settle or spawn a second review when a manual full review already covers the pushed head", async () => {
    vi.useFakeTimers();
    let head = priorHead;
    stubGh({
      readyPullRequest: true, pollHead: () => head, pollDraft: () => false,
      priorComparison: (base, target) => base === priorHead && target === pushedHead ? priorHead : null,
    });
    const { bb, harness } = reviewHost();
    try {
      await plugin(bb);
      const ruleId = await saveRule(harness, { settleMinutes: 1 });
      const store = createStore(bb.storage.database() as never);
      store.insertRun(makeReviewRun({
        id: "run_verified", ruleId, ruleName, prNumber: 7, headSha: priorHead,
        mode: "live", status: "commented", threadId: null, finishedAt: 2,
      }));
      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(0);
        head = pushedHead;
        expect(await harness.behavior.callRpc("dispatchNow", { ruleId, prNumber: 7 }))
          .toMatchObject({ threadId: "thr_scoped_1", blockedReason: null });
        await vi.advanceTimersByTimeAsync(15_000);
        const runs = store.listRuns().filter(run => run.headSha === pushedHead);
        const full = runs.find(run => run.status === "reviewing");
        expect(runs).toHaveLength(2);
        expect(runs.find(run => run.status === "skipped")?.detail).toContain(full!.id);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      } finally {
        service.controller.abort();
        await service.done;
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("runs a full readiness review after a same-head draft review", async () => {
    vi.useFakeTimers();
    let draft = true;
    stubGh({ readyPullRequest: true, draft: true, pollHead: () => pushedHead, pollDraft: () => draft });
    const { bb, harness } = reviewHost();
    try {
      await plugin(bb);
      await saveRule(harness);
      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect((await harness.behavior.runCli(["dispatch", ruleName, "7", "--include-draft"])).exitCode).toBe(0);
        const store = createStore(bb.storage.database() as never);
        const [run] = store.listRuns();
        await harness.behavior.emitThreadEvent("thread.idle", {
          thread: makeThreadResponse({ id: run!.threadId!, status: "idle" }),
          lastAssistantText: `🚨 \`slopcop/${ruleName}\` — No issues found.\n\n<!-- slopcop:rule=${ruleName} run=${run!.id} sha=${pushedHead} kind=summary -->`,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(store.getRun(run!.id)?.status).toBe("shadowed");
        draft = false;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(promptAt(harness, 1)).toContain("- Trigger: `ready_for_review`");
        expect(promptAt(harness, 1)).toContain(`- Review range: \`${fullBase}...${pushedHead}\``);
      } finally {
        service.controller.abort();
        await service.done;
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("skips a replayed verified incremental head but still runs readiness in full", async () => {
    vi.useFakeTimers();
    let head = priorHead;
    let draft = false;
    let verifiedRunId: string | null = null;
    stubGh({
      readyPullRequest: true, pollHead: () => head, pollDraft: () => draft,
      priorComparison: (base, target) => base === priorHead && target === pushedHead ? priorHead : null,
      reviewComments: () => verifiedRunId === null ? [] : [{
        id: 1, path: "src/changed.ts", line: 4,
        body: `🚨 \`slopcop/${ruleName}\` — **Unused write.**\n\nRemove the unused write.\n\n<!-- slopcop:rule=${ruleName} run=${verifiedRunId} sha=${pushedHead} kind=inline -->`,
      }],
    });
    stubCheckWrites(true);
    const { bb, harness } = reviewHost();
    try {
      await plugin(bb);
      const store = createStore(bb.storage.database() as never);
      const ruleId = await saveRule(harness, { mode: "live" });
      store.insertRun(makeReviewRun({
        id: "run_verified", ruleId, ruleName, prNumber: 7, headSha: priorHead,
        mode: "live", status: "no_comment", threadId: null, finishedAt: 2,
      }));
      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(0);
        head = pushedHead;
        await vi.advanceTimersByTimeAsync(15_000);
        const run = store.listRuns().find(run => run.headSha === pushedHead)!;
        expect(promptAt(harness, 0)).toContain("- Review scope: incremental");
        verifiedRunId = run.id;
        await harness.behavior.emitThreadEvent("thread.idle", {
          thread: makeThreadResponse({ id: run.threadId!, status: "idle" }), lastAssistantText: "One finding",
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(store.getRun(run.id)?.status).toBe("commented");
        head = priorHead;
        await vi.advanceTimersByTimeAsync(15_000);
        head = pushedHead;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
        expect(store.listRuns().find(run => run.headSha === pushedHead && run.status === "skipped")?.detail).toContain(run.id);

        draft = true;
        await vi.advanceTimersByTimeAsync(15_000);
        draft = false;
        await vi.advanceTimersByTimeAsync(15_000);
        const prompt = promptAt(harness, 1);
        expect(prompt).toContain("- Trigger: `ready_for_review`");
        expect(prompt).toContain("- Review scope: full");
        expect(prompt).toContain(`- Review range: \`${fullBase}...${pushedHead}\``);
        expect(prompt).toContain('"title":"Unused write.","summary":"Remove the unused write."');
      } finally {
        service.controller.abort();
        await service.done;
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("does not let a push replace outstanding readiness work", async () => {
    vi.useFakeTimers();
    let draft = true;
    let head = priorHead;
    stubGh({
      readyPullRequest: true, pollHead: () => head, pollDraft: () => draft,
      pollFiles: () => head === priorHead ? null : ["src/changed.ts"],
      priorComparison: () => priorHead,
    });
    const { bb, harness } = reviewHost();
    try {
      await plugin(bb);
      const ruleId = await saveRule(harness, { conditions: [{ kind: "paths", globs: ["src/**"] }] });
      const store = createStore(bb.storage.database() as never);
      store.insertRun(makeReviewRun({
        id: "run_verified", ruleId, ruleName, prNumber: 7, headSha: priorHead,
        mode: "live", status: "commented", threadId: null, finishedAt: 2,
      }));
      const service = harness.behavior.runService("watcher");
      try {
        await vi.advanceTimersByTimeAsync(0);
        draft = false;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
        head = pushedHead;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(promptAt(harness, 0)).toContain("- Trigger: `ready_for_review`");
        expect(promptAt(harness, 0)).toContain(`- Review range: \`${fullBase}...${pushedHead}\``);
      } finally {
        service.controller.abort();
        await service.done;
      }
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

it.each([
  { name: "implicit project default", environment: undefined, machine: { type: "existing", hostId: "host_configured_default" }, usesDefault: true },
  { name: "project default", environment: { type: "project-default" }, machine: { type: "existing", hostId: "host_configured_default" }, usesDefault: true },
  { name: "host without hostId", environment: { type: "host", workspace: { type: "unmanaged", path: "/owner/dirty" } }, machine: { type: "existing", hostId: "host_configured_default" }, usesDefault: true },
  { name: "provider without machine", environment: { type: "provider", environmentProviderId: "git-worktree" }, machine: { type: "existing", hostId: "host_configured_default" }, usesDefault: true },
  { name: "host checkout", environment: { type: "host", hostId: "host_air", workspace: { type: "unmanaged", path: "/owner/dirty" } }, machine: { type: "existing", hostId: "host_air" } },
  { name: "provider existing path", environment: { type: "provider", environmentProviderId: "git-worktree", inputs: { kind: "existing", path: "/owner/dirty" }, machine: { type: "existing", hostId: "host_air" } }, machine: { type: "existing", hostId: "host_air" } },
  { name: "reused environment", environment: { type: "reuse", environmentId: "env_owner" }, machine: { type: "existing", hostId: "host_air" } },
  { name: "new machine selection", environment: { type: "provider", environmentProviderId: "project-checkout", machine: { type: "new", machineProviderId: "cloud", inputs: { region: "west" } } }, machine: { type: "new", machineProviderId: "cloud", inputs: { region: "west" } } },
])("pins the captured fork head in a fresh worktree instead of $name", async ({ environment, machine, usesDefault }) => {
  const head = "d2759ef1b6fe51657eda5a45a3cc7a4ad1638394";
  const base = "c875a8e02967cb885eaf1e28147479238a2da522";
  stubGh({ heads: [head, "later-head"], baseSha: base, fork: true });
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("threads.spawn", (request) => {
    const selection = (request as { environment: { machine?: unknown } }).environment;
    if (selection.machine === undefined) throw new Error("HTTP 400: git-worktree requires a machine selection");
    return makeThreadResponse({ id: THREAD_ID });
  });
  harness.inspection.sdk.stub("projects.get", () => ({ sources: [
    { hostId: "host_first", isDefault: false },
    { hostId: "host_configured_default", isDefault: true },
    { hostId: "host_last", isDefault: false },
  ] }));
  harness.inspection.sdk.stub("environments.get", () => ({ projectId: "project", hostId: "host_air" }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "exact-review", repo: "acme/widgets", visibility: "hidden",
      request: { projectId: "project", providerId: "codex", model: "test", reasoningLevel: "high", permissionMode: "full", input: [{ type: "text", text: "old draft" }], ...(environment === undefined ? {} : { environment }) },
    } }) as { rule: { id: string } };
    const dispatched = await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 });
    expect(dispatched).toMatchObject({ threadId: THREAD_ID, blockedReason: null });
    const spawns = harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    const request = spawns[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({
      projectId: "project", providerId: "codex", model: "test", reasoningLevel: "high", permissionMode: "full", visibility: "hidden",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" },
    });
    expect(request.environment).toEqual({
      type: "provider", environmentProviderId: "git-worktree",
      inputs: { branch: { kind: "named", name: head } },
      machine,
    });
    expect(harness.inspection.sdk.callsTo("projects.get")).toEqual(usesDefault ? [[{ projectId: "project" }]] : []);
    expect(request).not.toHaveProperty("input");
    // Prompt and diff use the captured merge base and head, not PR base.sha or a later head.
    expect(request.prompt).toContain(`- Base SHA: ${base}`);
    expect(request.prompt).toContain(`git diff ${base}...${head}`);
    expect(request.prompt).toContain("- From a fork: yes");
    expect(store.listRuns({ limit: 1 })[0]).toMatchObject({ headSha: head, status: "reviewing", threadId: THREAD_ID });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each(["spawn rejects", "provisioning fails after spawn"])("keeps the captured-head review unreviewed when %s, without falling back", async (failure) => {
  stubGh();
  const writes = stubCheckWrites();
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
  harness.inspection.sdk.stub("threads.queue.list", () => []);
  harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
  harness.inspection.sdk.stub("threads.spawn", () => {
    if (failure === "spawn rejects") throw new Error("captured head is unavailable");
    return makeThreadResponse({ id: THREAD_ID });
  });
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "exact-review", repo: "acme/widgets", mode: "live",
      request: { projectId: "project", providerId: "codex", model: "test", environment: { type: "project-default" } },
    } }) as { rule: { id: string } };
    const dispatched = await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 });
    expect(dispatched).toMatchObject({
      blockedReason: failure === "spawn rejects" ? expect.stringContaining("captured head is unavailable") : null,
    });
    if (failure === "provisioning fails after spawn") {
      await harness.behavior.emitThreadEvent("thread.failed", {
        thread: makeThreadResponse({ id: THREAD_ID, status: "error" }), error: "captured head is unavailable",
      });
    }
    expect(store.listRuns({ limit: 1 })[0]).toMatchObject({ status: "cancelled", commentCount: 0, finishedAt: expect.any(Number) });
    const spawns = harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    // A same-repo head is named by its origin branch so the provider fetches it.
    expect(spawns[0]![0]).toMatchObject({ environment: { type: "provider", environmentProviderId: "git-worktree", inputs: { branch: { kind: "named", name: "origin/feature-7" } } } });
    expect(writes).toContainEqual(expect.objectContaining({ conclusion: "cancelled" }));
    expect(writes.some(write => "body" in write)).toBe(false);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each([
  { name: "missing merge base", baseSha: null, environment: undefined },
  { name: "malformed machine selection", baseSha: "7777777777777777777777777777777777777777", environment: { type: "provider", environmentProviderId: "git-worktree", machine: { type: "existing", hostId: 7 } } },
  { name: "unavailable reused environment", baseSha: "7777777777777777777777777777777777777777", environment: { type: "reuse", environmentId: "env_missing" } },
])("does not launch on fallback input after $name", async ({ baseSha, environment }) => {
  stubGh({ baseSha });
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  harness.inspection.sdk.stub("environments.get", () => { throw new Error("environment is unavailable"); });
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "exact-review", repo: "acme/widgets",
      request: { projectId: "project", providerId: "codex", model: "test", ...(environment === undefined ? {} : { environment }) },
    } }) as { rule: { id: string } };
    await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 });
    expect(store.listRuns({ limit: 1 })[0]).toMatchObject({ status: "cancelled", threadId: null, commentCount: 0, finishedAt: expect.any(Number) });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each(["write_access", "anyone"] as const)("does not execute managed preparation for an untrusted fork with %s trust, even when forced", async (authorTrust) => {
  stubGh({ association: "CONTRIBUTOR", fork: true });
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "exact-review", repo: "acme/widgets", authorTrust,
      request: { projectId: "project", providerId: "codex", model: "test" },
    } }) as { rule: { id: string } };
    const dispatched = await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7, force: true });
    expect(dispatched).toMatchObject({ threadId: null, blockedReason: expect.stringContaining("write-access trusted") });
    expect(store.listRuns({ limit: 1 })[0]).toMatchObject({ status: "cancelled", detail: expect.stringContaining("write-access trusted"), threadId: null });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("does not start preparation after cancellation during reused-machine resolution", async () => {
  stubGh();
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  let resolveMachine!: (value: unknown) => void;
  let machineRequested!: () => void;
  const requested = new Promise<void>(resolve => { machineRequested = resolve; });
  harness.inspection.sdk.stub("environments.get", () => new Promise(resolve => {
    resolveMachine = resolve;
    machineRequested();
  }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "exact-review", repo: "acme/widgets",
      request: { projectId: "project", providerId: "codex", model: "test", environment: { type: "reuse", environmentId: "env_owner" } },
    } }) as { rule: { id: string } };
    const dispatch = harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 });
    await requested;
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    await harness.behavior.runCli(["runs", "cancel", runId]);
    resolveMachine({ projectId: "project", hostId: "host_air" });
    await dispatch;
    expect(store.getRun(runId)).toMatchObject({ status: "cancelled", threadId: null, finishedAt: expect.any(Number) });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each([
  { name: "missing default", sources: [{ hostId: "host_other", isDefault: false }] },
  { name: "no project sources", sources: [] },
  { name: "ambiguous defaults", sources: [{ hostId: "host_a", isDefault: true }, { hostId: "host_b", isDefault: true }] },
  { name: "default without a host", sources: [{ hostId: "", isDefault: true }] },
  { name: "unavailable project", sources: null },
])("cancels preparation on $name instead of choosing a fallback host", async ({ sources }) => {
  stubGh();
  const writes = stubCheckWrites();
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("projects.get", () => {
    if (sources === null) throw new Error("configured project is unavailable");
    return { sources };
  });
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    const { rule } = await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "default-machine-review", repo: "acme/widgets", mode: "live",
      request: { projectId: "configured-project", providerId: "codex", model: "test" },
    } }) as { rule: { id: string } };
    await harness.behavior.callRpc("dispatchNow", { ruleId: rule.id, prNumber: 7 });
    expect(harness.inspection.sdk.callsTo("projects.get")).toEqual([[{ projectId: "configured-project" }]]);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(store.listRuns({ limit: 1 })[0]).toMatchObject({
      status: "cancelled", threadId: null, commentCount: 0, finishedAt: expect.any(Number),
      detail: expect.stringContaining(sources === null ? "unavailable" : "default project source"),
    });
    expect(writes).toContainEqual(expect.objectContaining({ conclusion: "cancelled" }));
    expect(writes.some(write => "body" in write)).toBe(false);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("reviews a ready PR without comparing an unrelated draft or idle poll", async () => {
  vi.useFakeTimers();
  stubGh({ readyPullRequest: true, unrelatedDraft: true });
  const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: 15 } });
  harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: THREAD_ID }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  try {
    await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "matched-only", repo: "acme/widgets",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } });
    expect(await harness.behavior.callRpc("checkPr", { ruleId: store.listRules()[0]!.id, prNumber: 7 }))
      .toMatchObject({ matched: true });
    const service = harness.behavior.runService("watcher");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(store.listRuns({})).toEqual([]);
      expect(vi.mocked(execFile).mock.calls.some(call => call[1].some(arg => arg.includes("/compare/")))).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(store.listRuns({})).toMatchObject([{ prNumber: 7, status: "reviewing", threadId: THREAD_ID }]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(vi.mocked(execFile).mock.calls.filter(call => call[1].some(arg => arg.includes("/compare/")))).toHaveLength(1);
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await harness.lifecycle.dispose();
  }
});

async function setupSettling(settleMinutes = 1, options: Parameters<typeof stubGh>[0] = {}) {
  vi.useFakeTimers();
  let head = "sha-7";
  stubGh({ ...options, readyPullRequest: true, pollHead: () => head });
  const writes = stubCheckWrites(true);
  let spawned = 0;
  const configure = ({ harness }: ReturnType<typeof createFakePluginHost>) => {
    harness.inspection.sdk.stub("threads.stop", () => ({ ok: true }));
    harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
    harness.inspection.sdk.stub("threads.get", () => makeThreadResponse({ status: "active" }));
    harness.inspection.sdk.stub("projects.get", () => ({ sources: [{ hostId: "host_default", isDefault: true }] }));
    harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: `thr_settle_${++spawned}` }));
  };
  const host = createFakePluginHost({ settings: { pollSeconds: 15, maxConcurrentReviews: 1 } });
  configure(host);
  await plugin(host.bb);
  const { rule } = await host.harness.behavior.callRpc("saveRule", { id: null, rule: {
    name: "settling-review", repo: "acme/widgets", dedupe: "once_per_head_sha",
    triggers: ["ready_for_review", "new_commits"], mode: "live", settleMinutes,
    request: { projectId: "project", providerId: "codex", model: "test" },
  } }) as { rule: { id: string } };
  return { ...host, rule, writes, configure, push: (sha: string) => { head = sha; } };
}

it("supersedes only unfinished runs of this rule, PR and older heads", async () => {
  const { bb, harness, rule, writes, push } = await setupSettling(0);
  const store = createStore(bb.storage.database() as never);
  const service = harness.behavior.runService("watcher");
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    const old = store.listRuns()[0]!;
    store.insertRun(makeReviewRun({ id: "same", ruleId: rule.id, prNumber: 7, headSha: "sha-8", mode: "live", status: "dispatched", threadId: null, finishedAt: null }));
    // Force admission later so the same-head run can coexist with the new one.
    store.insertRun(makeReviewRun({ id: "finished", ruleId: rule.id, prNumber: 7, mode: "live", status: "commented", finishedAt: 1 }));
    store.insertRun(makeReviewRun({ id: "other-rule", prNumber: 7, threadId: "thr_other_rule" }));
    store.insertRun(makeReviewRun({ id: "other-pr", ruleId: rule.id, threadId: "thr_other_pr" }));
    push("sha-8");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.getRun(old.id)?.status).toBe("reviewing"); // A dedupe skip is not admission.
    const result = await harness.behavior.runCli(["dispatch", "settling-review", "7", "--force"]);
    expect(result.exitCode).toBe(0);
    expect(store.getRun(old.id)).toMatchObject({ status: "cancelled", detail: expect.stringContaining("sha-8") });
    expect(store.getRun("same")?.status).toBe("dispatched");
    expect(store.getRun("finished")?.status).toBe("commented");
    expect(store.getRun("other-rule")?.status).toBe("reviewing");
    expect(store.getRun("other-pr")?.status).toBe("reviewing");
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    expect(writes).toContainEqual(expect.objectContaining({
      endpoint: "repos/acme/widgets/check-runs/47", status: "completed", conclusion: "cancelled",
      output: expect.objectContaining({ summary: expect.stringContaining("sha-8") }),
    }));
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("restarts a live settle wait on a push, retires its queued check, and dispatches the replacement once", async () => {
  const { bb, harness, writes, push } = await setupSettling();
  const store = createStore(bb.storage.database() as never);
  const service = harness.behavior.runService("watcher");
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    push("sha-8");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toContainEqual(expect.objectContaining({ head_sha: "sha-8", status: "queued" }));
    const check = await harness.behavior.runCli(["check", "settling-review", "7"]);
    expect(check.stdout).toContain("waiting to settle");
    push("sha-9");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(store.listRuns()).toEqual(expect.arrayContaining([
      expect.objectContaining({ headSha: "sha-8", status: "skipped", detail: expect.stringContaining("sha-9") }),
      expect.objectContaining({ headSha: "sha-9", status: "waiting" }),
    ]));
    const replaced = await harness.behavior.runCli(["check", "settling-review", "7"]);
    expect(replaced.stdout).toContain("skipped");
    expect(writes).toContainEqual(expect.objectContaining({
      endpoint: "repos/acme/widgets/check-runs/48", status: "completed", conclusion: "neutral",
      output: expect.objectContaining({ summary: expect.stringContaining("sha-9") }),
    }));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(store.listRuns().filter(run => run.headSha === "sha-9")).toMatchObject([{ status: "reviewing" }]);
    expect(writes.filter(write => write.head_sha === "sha-9")).toMatchObject([{ status: "queued" }]);
    expect(writes.filter(write => write.endpoint === "repos/acme/widgets/check-runs/49")).toMatchObject([{ status: "in_progress" }]);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it.each([false, true])("promotes the same waiting run and check after reload (check ID lost: %s)", async (loseId) => {
  let runId = "";
  const first = await setupSettling(1, {
    existingChecks: () => [{ id: 48, status: "queued", external_id: runId }],
  });
  let host: Pick<typeof first, "bb" | "harness"> = first;
  try {
    const service = host.harness.behavior.runService("watcher");
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      first.push("sha-8");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(first.writes.filter(write => write.head_sha === "sha-8")).toMatchObject([{ status: "queued" }]);
      const db = host.bb.storage.database();
      runId = createStore(db as never).listRuns().find(run => run.headSha === "sha-8")!.id;
      // GitHub may have created the check just before loss of the local POST acknowledgment.
      if (loseId) db.prepare("UPDATE runs SET check_run_id = NULL WHERE id = ?").run(runId);
    } finally {
      service.controller.abort();
      await service.done;
    }
    host = await host.harness.lifecycle.reload(plugin);
    first.configure(host);
    const restarted = host.harness.behavior.runService("watcher");
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000); // The original deadline, before a reset would expire.
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      expect(first.writes.filter(write => write.head_sha === "sha-8")).toMatchObject([{ status: "queued" }]);
      expect(first.writes.filter(write => write.endpoint === "repos/acme/widgets/check-runs/48")).toMatchObject([{ status: "in_progress" }]);
      expect(createStore(host.bb.storage.database() as never).listRuns().filter(run => run.headSha === "sha-8")).toMatchObject([{ status: "reviewing" }]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    } finally {
      restarted.controller.abort();
      await restarted.done;
    }
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("dispatches readiness and an explicit manual dispatch without waiting", async () => {
  const { harness, writes, push } = await setupSettling();
  const service = harness.behavior.runService("watcher");
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(writes[0]).toMatchObject({ head_sha: "sha-7", status: "in_progress" });
    push("sha-8");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(writes).toContainEqual(expect.objectContaining({ head_sha: "sha-8", status: "queued" }));
    expect((await harness.behavior.runCli(["dispatch", "settling-review", "7"])).exitCode).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(writes.filter(write => write.head_sha === "sha-8")).toMatchObject([{ status: "queued" }]);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("sets and lists settle minutes through the CLI without resetting them on a later edit", async () => {
  const { harness } = await setupSettling(0);
  try {
    const list = () => harness.behavior.runCli(["rules", "--json"]);
    expect(JSON.parse((await list()).stdout!)).toMatchObject([{ settleMinutes: 0 }]);
    expect((await harness.behavior.runCli(["rules", "edit", "settling-review", "--settle-minutes", "3"])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["rules", "edit", "settling-review", "--prompt", "Review the patch"])).exitCode).toBe(0);
    expect(JSON.parse((await list()).stdout!)).toMatchObject([{ settleMinutes: 3 }]);
    expect((await harness.behavior.runCli(["rules", "edit", "settling-review", "--settle-minutes", "1.5"])).exitCode).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("retains a path-filtered wait when GitHub temporarily fails to list changed files", async () => {
  let files: string[] | null = ["src/feature.ts"];
  const { bb, harness, push, writes } = await setupSettling(1, { pollFiles: () => files });
  const store = createStore(bb.storage.database() as never);
  const service = harness.behavior.runService("watcher");
  try {
    expect((await harness.behavior.runCli(["rules", "edit", "settling-review", "--paths", "src/**"])).exitCode).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    push("sha-8");
    await vi.advanceTimersByTimeAsync(15_000);
    files = null;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.listRuns().filter(run => run.headSha === "sha-8")).toMatchObject([{ status: "waiting" }]);
    expect(writes.filter(write => write.endpoint === "repos/acme/widgets/check-runs/48")).toHaveLength(0);
    files = ["src/feature.ts"];
    await vi.advanceTimersByTimeAsync(45_000);
    expect(store.listRuns().filter(run => run.headSha === "sha-8")).toMatchObject([{ status: "reviewing" }]);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("retires exactly the existing wait when admission discovers a newer head than the poll", async () => {
  let currentHead = "sha-7";
  const { bb, harness, push, writes } = await setupSettling(1, { detailHead: () => currentHead });
  const store = createStore(bb.storage.database() as never);
  const service = harness.behavior.runService("watcher");
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    push("sha-8");
    currentHead = "sha-8";
    await vi.advanceTimersByTimeAsync(60_000);
    currentHead = "sha-9";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.listRuns().filter(run => run.headSha === "sha-8")).toMatchObject([
      { status: "skipped", detail: "superseded by newer head sha-9", finishedAt: expect.any(Number) },
    ]);
    expect(writes.filter(write => write.endpoint === "repos/acme/widgets/check-runs/48")).toMatchObject([
      { status: "completed", conclusion: "neutral", output: { summary: expect.stringContaining("sha-9") } },
    ]);
    await vi.advanceTimersByTimeAsync(15_000); // The repo list is still behind the single-PR lookup.
    expect(store.listRuns().filter(run => run.headSha === "sha-8")).toHaveLength(1);
    push("sha-9");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(store.listRuns().filter(run => run.headSha === "sha-9")).toMatchObject([{ status: "reviewing" }]);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("closes a discarded queued check without claiming a review ran", async () => {
  let open = true;
  const { harness, push, writes } = await setupSettling(1, { pollOpen: () => open });
  const service = harness.behavior.runService("watcher");
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    push("sha-8");
    await vi.advanceTimersByTimeAsync(15_000);
    open = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(writes.filter(write => write.endpoint === "repos/acme/widgets/check-runs/48")).toMatchObject([
      { status: "completed", conclusion: "neutral", output: {
        title: "Review skipped",
        summary: expect.stringContaining("closed or returned to draft"),
      } },
    ]);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("retries a failed stop of a superseded thread discovered during reload recovery", async () => {
  vi.useFakeTimers();
  stubGhLogin();
  const detail = "superseded by newer head sha-8";
  const { bb, harness, store } = await setup({ status: "cancelled", detail, threadId: null });
  const title = buildThreadTitle({
    runId: "run_1", rule: { name: "restraint-review", mode: "shadow" }, pullRequest: { number: 42 },
  });
  harness.inspection.sdk.stub("threads.list", ({ archived }) => archived ? [] : [
    makeThreadResponse({ id: THREAD_ID, title, originPluginId: bb.pluginId }),
  ]);
  let attempted = 0;
  harness.inspection.sdk.stub("threads.stop", () => {
    if (++attempted === 1) throw new Error("temporary BB stop failure");
    return { ok: true };
  });
  try {
    await startWatcher(harness);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(2);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect(store.getRun("run_1")).toMatchObject({ status: "cancelled", threadId: THREAD_ID, detail, finishedAt: expect.any(Number) });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("allows an operator to cancel an unfinished wait and close its queued check", async () => {
  const { bb, harness, push, writes } = await setupSettling();
  const store = createStore(bb.storage.database() as never);
  const service = harness.behavior.runService("watcher");
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    push("sha-8");
    await vi.advanceTimersByTimeAsync(15_000);
    const waiting = store.listRuns().find(run => run.headSha === "sha-8")!;
    expect((await harness.behavior.runCli(["runs", "cancel", waiting.id])).exitCode).toBe(0);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(store.getRun(waiting.id)).toMatchObject({ status: "cancelled", threadId: null });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(writes.filter(write => write.endpoint === "repos/acme/widgets/check-runs/48")).toMatchObject([
      { status: "completed", conclusion: "cancelled", output: { summary: expect.stringContaining("waiting") } },
    ]);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("stops an older thread whose spawn finishes after supersession", async () => {
  const { bb, harness, push } = await setupSettling(0);
  let releaseOldSpawn!: () => void;
  let attempt = 0;
  harness.inspection.sdk.stub("threads.spawn", () => {
    if (++attempt === 1) return new Promise(resolve => {
      releaseOldSpawn = () => resolve(makeThreadResponse({ id: "thr_late" }));
    });
    return makeThreadResponse({ id: "thr_replacement" });
  });
  const store = createStore(bb.storage.database() as never);
  const service = harness.behavior.runService("watcher");
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    const old = store.listRuns()[0]!;
    expect(old).toMatchObject({ status: "dispatched", threadId: null });
    push("sha-8");
    expect((await harness.behavior.runCli(["dispatch", "settling-review", "7"])).exitCode).toBe(0);
    expect(store.getRun(old.id)).toMatchObject({ status: "cancelled", threadId: null, finishedAt: null });
    releaseOldSpawn();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_late" }]]);
    expect(store.getRun(old.id)).toMatchObject({ status: "cancelled", threadId: "thr_late", finishedAt: expect.any(Number) });
    expect(store.listRuns().filter(run => run.headSha === "sha-8")).toMatchObject([
      { status: "reviewing", threadId: "thr_replacement" },
    ]);
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});

it("leaves a finished thread's verdict alone while it is being verified", async () => {
  const { bb, harness, push } = await setupSettling(0);
  const store = createStore(bb.storage.database() as never);
  const service = harness.behavior.runService("watcher");
  try {
    await vi.advanceTimersByTimeAsync(29_000);
    const old = store.listRuns()[0]!;
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: old.threadId!, status: "idle" }),
      lastAssistantText: "",
    });
    push("sha-8");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(store.getRun(old.id)?.status).toBe("reviewing");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    expect(store.getRun(old.id)).toMatchObject({ status: "no_comment", finishedAt: expect.any(Number) });
  } finally {
    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  }
});
