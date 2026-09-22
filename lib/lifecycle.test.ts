import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  archiveReviewThread,
  reviewThreadOutcome,
  THREAD_ARCHIVED_REASON,
  THREAD_DELETED_REASON,
} from "./lifecycle";

describe("review thread lifecycle", () => {
  it("archives a completed review thread", async () => {
    const calls: unknown[] = [];
    const bb = {
      sdk: {
        threads: {
          archive: async (args: unknown) => {
            calls.push(args);
          },
        },
      },
      log: { warn: () => undefined },
    } as unknown as BbPluginApi;

    await archiveReviewThread(bb, "thr_review");

    expect(calls).toEqual([{ threadId: "thr_review" }]);
  });

  it("logs an archive failure without changing the completed run", async () => {
    const warnings: string[] = [];
    const bb = {
      sdk: {
        threads: {
          archive: async () => {
            throw new Error("host unavailable");
          },
        },
      },
      log: { warn: (message: string) => warnings.push(message) },
    } as unknown as BbPluginApi;

    await expect(
      archiveReviewThread(bb, "thr_review"),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([
      "could not archive completed review thread thr_review: host unavailable",
    ]);
  });
});

describe("what a review thread already became", () => {
  it.each([
    // A deleted or archived thread reports whatever status it last held, so
    // the retirement is read before the status.
    [{ status: "active", deletedAt: 5 }, { kind: "failed", reason: THREAD_DELETED_REASON }],
    [{ status: "active", archivedAt: 5 }, { kind: "failed", reason: THREAD_ARCHIVED_REASON }],
    // An errored thread's detail lives in its event log, not in the row.
    [{ status: "error" }, { kind: "failed", reason: null }],
    [{ status: "error", archivedAt: 5 }, { kind: "failed", reason: null }],
    [{ status: "idle" }, { kind: "finished" }],
    [{ status: "idle", archivedAt: 5 }, { kind: "finished" }],
    [{ status: "active" }, { kind: "running" }],
    [{ status: "starting" }, { kind: "running" }],
    [{ status: "pending" }, { kind: "running" }],
    [{ status: "stopping" }, { kind: "running" }],
  ])("reads %o as %o", (thread, outcome) => {
    expect(reviewThreadOutcome(thread)).toEqual(outcome);
  });
});
