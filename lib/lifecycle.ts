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
