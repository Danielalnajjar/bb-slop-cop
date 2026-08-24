import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { archiveReviewThread } from "./lifecycle";

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
