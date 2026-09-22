import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Archive a terminal review thread so BB can retire its managed worktree. */
export async function archiveReviewThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<void> {
  try {
    await bb.sdk.threads.archive({ threadId });
  } catch (error) {
    bb.log.warn(
      `could not archive completed review thread ${threadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Why a run was finished without its thread ever announcing an outcome.
 * `thread.archived` / `thread.deleted` carry no reason of their own, and a
 * reconciled thread has no event left to read one from.
 */
export const THREAD_ARCHIVED_REASON =
  "the review thread was archived before it reached a verdict";
export const THREAD_DELETED_REASON =
  "the review thread was deleted before it reached a verdict";

/**
 * What a review thread has already become, read from the thread row rather
 * than from the lifecycle event that announced it. `reason` is null for a
 * thread in `error`, whose detail lives in its event log.
 */
export type ReviewThreadOutcome =
  | { kind: "running" }
  | { kind: "finished" }
  | { kind: "failed"; reason: string | null };

export function reviewThreadOutcome(thread: {
  status: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
}): ReviewThreadOutcome {
  if (thread.deletedAt != null) {
    return { kind: "failed", reason: THREAD_DELETED_REASON };
  }
  if (thread.status === "error") return { kind: "failed", reason: null };
  if (thread.status === "idle") return { kind: "finished" };
  // Archive is terminal for a thread that never reached idle or error: BB
  // retires the worktree, so the review will not resume on its own.
  if (thread.archivedAt != null) {
    return { kind: "failed", reason: THREAD_ARCHIVED_REASON };
  }
  return { kind: "running" };
}
