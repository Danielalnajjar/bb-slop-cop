// The no-findings summary, end to end through the plugin host.
//
// SlopCop owns that body: the agent posts findings as line comments and ends a
// clean review with the summary as its final message. `gh` is the only seam
// that matters here, so `node:child_process` is mocked and the plugin drives
// its real gh client.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createStore } from "./lib/db";
import { decorateBody } from "./lib/marker";
import type { Run } from "./lib/types";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const THREAD_ID = "thr_review";
const RUN_ID = "run_1";

const summaryBody = (run = RUN_ID, sha = "abc123") =>
  decorateBody("Nothing survives the review.", "summary", {
    rule: "restraint-review",
    run,
    sha,
    kind: "summary",
  });

function liveRun(): Run {
  return {
    id: RUN_ID,
    ruleId: "rule_1",
    ruleName: "restraint-review",
    repo: "acme/widgets",
    prNumber: 42,
    prTitle: "Keep retries alive",
    prAuthor: "dana",
    headSha: "abc123",
    status: "reviewing",
    mode: "live",
    detail: null,
    threadId: THREAD_ID,
    commentCount: 0,
    startedAt: 1,
    finishedAt: null,
  };
}

/** Endpoints written to, in order, with the body each carried. */
let writes: { endpoint: string; body: unknown }[];
/** Issue comments GitHub currently returns. Grows when the plugin posts one. */
let issueComments: unknown[];
/** Inline review comments GitHub currently returns — the agent's findings. */
let reviewComments: unknown[];

beforeEach(() => {
  writes = [];
  issueComments = [];
  reviewComments = [];

  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const endpoint = args[args.length - 1] ?? "";
    if (args.includes("user")) {
      callback(null, "slopcop-bot\n", "");
      return undefined as never;
    }
    const rows = endpoint.includes("/issues/42/comments")
      ? issueComments
      : endpoint.includes("/pulls/42/comments")
        ? reviewComments
        : [];
    callback(null, JSON.stringify(rows), "");
    return undefined as never;
  }) as never);

  vi.mocked(spawn).mockImplementation(((_file: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { on: () => void; end: (body: string) => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const endpoint = args[args.indexOf("--input") - 1] ?? "";
    child.stdin = {
      on: () => {},
      end: (body: string) => {
        const parsed: unknown = JSON.parse(body);
        writes.push({ endpoint, body: parsed });
        if (endpoint.includes("/issues/42/comments")) {
          issueComments.push({
            id: 7,
            body: (parsed as { body: string }).body,
            html_url: "https://github.com/acme/widgets/pull/42#issuecomment-7",
            user: { login: "slopcop-bot" },
            created_at: new Date(2_000).toISOString(),
          });
        }
        child.stdout.emit("data", Buffer.from("{}"));
        child.emit("close", 0);
      },
    };
    return child as never;
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function finishThreadWith(finalMessage: string | null) {
  vi.useFakeTimers();
  const { bb, harness } = createFakePluginHost();
  harness.inspection.sdk.stub("threads.queue.list", () => []);
  harness.inspection.sdk.stub("threads.archive", () => ({ ok: true }));
  await plugin(bb);
  const store = createStore(bb.storage.database() as never);
  store.insertRun(liveRun());

  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: THREAD_ID, status: "idle" }),
    lastAssistantText: finalMessage,
  });
  // One retry sleep separates the two no_comment verifications.
  await vi.advanceTimersByTimeAsync(10_000);
  return { store, harness };
}

it("posts the no-findings summary from the agent's final message", async () => {
  const { store, harness } = await finishThreadWith(summaryBody());
  try {
    expect(
      writes.filter((write) => write.endpoint.includes("/issues/42/comments")),
    ).toEqual([{ endpoint: "repos/acme/widgets/issues/42/comments", body: { body: summaryBody() } }]);

    const run = store.findRunByThread(THREAD_ID);
    expect(run?.status).toBe("commented");
    expect(run?.commentCount).toBe(1);

    const check = writes.find((write) => write.endpoint.includes("check-runs"));
    expect(check?.body).toMatchObject({ conclusion: "success" });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("posts no summary when the agent posted findings as line comments", async () => {
  reviewComments.push({
    id: 91,
    body: decorateBody("Speculative retry layer.", "inline", {
      rule: "restraint-review",
      run: RUN_ID,
      sha: "abc123",
      kind: "inline",
    }),
    path: "lib/retry.ts",
    line: 12,
    html_url: "https://github.com/acme/widgets/pull/42#discussion_r91",
    user: { login: "slopcop-bot" },
    created_at: new Date(2_000).toISOString(),
  });

  const { store, harness } = await finishThreadWith(
    "Posted 1 line comment: https://github.com/acme/widgets/pull/42#discussion_r91",
  );
  try {
    expect(
      writes.filter((write) => write.endpoint.includes("/issues/42/comments")),
    ).toEqual([]);
    const run = store.findRunByThread(THREAD_ID);
    expect(run?.status).toBe("commented");
    expect(run?.commentCount).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("stamps the canonical marker over a run id the agent mistyped", async () => {
  // The observed failure: one character dropped from the run id.
  const { store, harness } = await finishThreadWith(
    summaryBody(RUN_ID.slice(0, -1)),
  );
  try {
    expect(
      writes.filter((write) => write.endpoint.includes("/issues/42/comments")),
    ).toEqual([
      {
        endpoint: "repos/acme/widgets/issues/42/comments",
        body: { body: summaryBody() },
      },
    ]);
    expect(store.findRunByThread(THREAD_ID)?.status).toBe("commented");
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("stamps the canonical marker over a sha the agent mistyped", async () => {
  const { store, harness } = await finishThreadWith(
    summaryBody(RUN_ID, "abc12"),
  );
  try {
    expect(
      writes.filter((write) => write.endpoint.includes("/issues/42/comments")),
    ).toEqual([
      {
        endpoint: "repos/acme/widgets/issues/42/comments",
        body: { body: summaryBody() },
      },
    ]);
    expect(store.findRunByThread(THREAD_ID)?.status).toBe("commented");
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("posts nothing for a marker of another kind or another rule", async () => {
  for (const finalMessage of [
    decorateBody("Speculative retry layer.", "inline", {
      rule: "restraint-review",
      run: RUN_ID,
      sha: "abc123",
      kind: "inline",
    }),
    decorateBody("Nothing survives the review.", "summary", {
      rule: "some-other-rule",
      run: RUN_ID,
      sha: "abc123",
      kind: "summary",
    }),
  ]) {
    const { store, harness } = await finishThreadWith(finalMessage);
    try {
      expect(
        writes.filter((write) =>
          write.endpoint.includes("/issues/42/comments"),
        ),
      ).toEqual([]);
      expect(store.findRunByThread(THREAD_ID)?.status).toBe("no_comment");
    } finally {
      await harness.lifecycle.dispose();
    }
  }
});

it("stays no_comment when nothing posted and the final message has no marker", async () => {
  const { store, harness } = await finishThreadWith(
    "🚨 **SLOP COP** 🚨 · `restraint-review`\n\nClean, but the marker is gone.",
  );
  try {
    expect(
      writes.filter((write) => write.endpoint.includes("/issues/42/comments")),
    ).toEqual([]);
    expect(store.findRunByThread(THREAD_ID)?.status).toBe("no_comment");
  } finally {
    await harness.lifecycle.dispose();
  }
});
