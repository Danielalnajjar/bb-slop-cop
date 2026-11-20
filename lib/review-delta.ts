import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const reviewSha = z.string().regex(/^[a-f0-9]{40}$/);
/** Largest patch the host returns for attachment; a larger one is read by the reviewer. */
export const MAX_ATTACHED_PATCH_BYTES = 2 * 1024 * 1024;
/**
 * Git options for every comparison command, on the host and in the reviewer's
 * worktree. Pinning merge settings lets either side's user config produce the
 * same comparison tree, including the conflict markers of an unresolved merge.
 */
export const REVIEW_GIT_OPTIONS = [
  "--no-replace-objects", "-c", "merge.conflictStyle=merge", "-c", "merge.renames=true",
  "-c", "merge.directoryRenames=conflict",
] as const;

/** Why a review with an earlier verified head did not get an attached incremental patch. */
export type IncrementalMiss =
  | "oversize"
  | "host_unavailable"
  | "missing_base"
  | "git_error"
  | "history_changed"
  | "base_conflict"
  | "base_moved"
  | "forced";

export function formatIncrementalMiss(reason: IncrementalMiss, detail: string): string {
  return `${reason}: ${detail}`;
}

export const reviewDeltaContract = defineRpcContract({
  reviewDelta: {
    input: z.object({
      repo: z.string(),
      sourcePath: z.string(),
      prior: reviewSha,
      priorBase: reviewSha,
      base: reviewSha,
      head: reviewSha,
    }),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("patch"),
        tree: reviewSha,
        patchBase64: z.base64(),
        baseMerged: z.boolean(),
      }),
      // The patch exists but is too large to return; the reviewer recomputes it.
      z.object({ kind: z.literal("oversize"), tree: reviewSha }),
      z.object({
        kind: z.literal("miss"),
        reason: z.enum(["git_error", "history_changed", "base_conflict"]),
        detail: z.string(),
      }),
    ]),
  },
});
/** A comparison the review can use: an attached patch, or one the reviewer reads itself. */
export type ReviewDelta = Exclude<z.infer<typeof reviewDeltaContract.reviewDelta.output>, { kind: "miss" }>;
