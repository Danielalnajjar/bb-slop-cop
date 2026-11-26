import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { MAX_ATTACHED_PATCH_BYTES, REVIEW_GIT_OPTIONS, reviewDeltaContract, reviewSha } from "./lib/review-delta";

class GitFailure extends Error {
  constructor(command: string, readonly oversize: boolean) {
    super(oversize ? `git ${command} output exceeded ${MAX_ATTACHED_PATCH_BYTES} bytes` : `git ${command} failed`);
  }
}

export default experimental_defineHostEntry({
  contract: reviewDeltaContract,
  handlers: {
    async reviewDelta({ repo, sourcePath, prior, priorBase, base, head }, context) {
      const signal = AbortSignal.any([context.signal, context.lifecycle.signal]);
      const run = (args: string[], allowConflict = false) => new Promise<{ stdout: Buffer; conflicted: boolean }>((resolve, reject) => {
        execFile("git", [...REVIEW_GIT_OPTIONS, "-C", sourcePath, ...args], {
          encoding: "buffer", timeout: 45_000, maxBuffer: MAX_ATTACHED_PATCH_BYTES, signal,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }, (error, stdout) => {
          if (error && !(allowConflict && error.code === 1)) {
            reject(new GitFailure(args[0], error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"));
          } else resolve({ stdout, conflicted: error?.code === 1 });
        });
      });
      const read = async (args: string[]) => (await run(args)).stdout.toString("utf8").trim();
      // Exit 1 means not an ancestor, unrelated histories included.
      const isAncestor = async (ancestor: string, descendant: string) =>
        !(await run(["merge-base", "--is-ancestor", ancestor, descendant], true)).conflicted;
      try {
        const remote = await read(["remote", "get-url", "origin"]);
        const remoteRepo = /^(?:git@github\.com:|(?:ssh:\/\/git@github\.com|https:\/\/github(?:\.com|\.int\.exe\.xyz))\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote)?.[1];
        if (remoteRepo?.toLowerCase() !== repo.toLowerCase()) {
          return { kind: "miss", reason: "git_error", detail: "project source origin does not match review repository" };
        }
        try {
          await run(["cat-file", "-e", head + "^{commit}"]);
        } catch {
          signal.throwIfAborted();
          await run(["fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance",
            "--no-prune", "--no-recurse-submodules", "--refmap=", "origin", head]);
        }
        // Check PR base is an ancestor of head, and reviewed base is an ancestor of PR base.
        // Fetch prior if absent so merge refreshes and conflict-free rebases can be checked.
        const ensurePresent = async (commit: string) => {
          const exists = await run(["cat-file", "-e", commit + "^{commit}"]).then(() => true, () => false);
          if (exists) return true;
          signal.throwIfAborted();
          try {
            await run(["fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance",
              "--no-prune", "--no-recurse-submodules", "--refmap=", "origin", commit]);
            return true;
          } catch {
            signal.throwIfAborted();
            return false;
          }
        };
        const priorPresent = await ensurePresent(prior);
        signal.throwIfAborted();
        if (!priorPresent) {
          return { kind: "miss", reason: "history_changed", detail: `reviewed head ${prior} is not an ancestor of ${head}` };
        }
        const isDirectDescendant = await isAncestor(prior, head);
        if (!isDirectDescendant) {
          if (!await isAncestor(base, head) || !await isAncestor(priorBase, base)) {
            return { kind: "miss", reason: "history_changed", detail: `reviewed head ${prior} is not an ancestor of ${head}` };
          }
          const priorMergeBase = await read(["merge-base", "--all", prior, base]).catch(() => "");
          if (priorMergeBase !== priorBase) {
            return { kind: "miss", reason: "history_changed", detail: `reviewed head ${prior} is not an ancestor of ${head}` };
          }
          const baseMerged = priorMergeBase !== base;
          const { stdout: merged, conflicted } = await run(["merge-tree", "--write-tree", "--no-messages", prior, base], true);
          const tree = reviewSha.parse(merged.toString("utf8").split("\n", 1)[0]?.trim());
          if (!conflicted && tree === await read(["rev-parse", head + "^{tree}"])) {
            return { kind: "patch", tree, patchBase64: "", baseMerged };
          }
          return { kind: "miss", reason: "history_changed", detail: `reviewed head ${prior} is not an ancestor of ${head}` };
        }
        if (!await isAncestor(base, head)) {
          return { kind: "miss", reason: "history_changed", detail: `PR base ${base} is not an ancestor of ${head}` };
        }
        if (!await isAncestor(priorBase, base)) {
          return { kind: "miss", reason: "history_changed", detail: `reviewed base ${priorBase} is not an ancestor of PR base ${base}` };
        }

        const baseMerged = (await read(["merge-base", "--all", prior, base]).catch(() => "")) !== base;
        // Status 1 also produces a tree, with the unresolved merge as its content.
        const { stdout: merged, conflicted } = await run(["merge-tree", "--write-tree", "--no-messages", prior, base], true);
        const tree = reviewSha.parse(merged.toString("utf8").split("\n", 1)[0]?.trim());
        if (tree === await read(["rev-parse", head + "^{tree}"])) {
          return conflicted
            ? { kind: "miss", reason: "base_conflict", detail: `head ${head} matches the conflicted merge of ${prior} and ${base}` }
            : { kind: "patch", tree, patchBase64: "", baseMerged };
        }
        let patch: Buffer;
        try {
          ({ stdout: patch } = await run(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color",
            "--ignore-submodules=none", tree, head, "--"]));
        } catch (error) {
          if (error instanceof GitFailure && error.oversize) return { kind: "oversize", tree };
          throw error;
        }
        return patch.length === 0
          ? { kind: "miss", reason: "git_error", detail: `git diff of differing trees ${tree} and ${head} was empty` }
          : { kind: "patch", tree, patchBase64: patch.toString("base64"), baseMerged };
      } catch (error) {
        signal.throwIfAborted();
        return { kind: "miss", reason: "git_error", detail: error instanceof Error ? error.message : String(error) };
      }
    },
  },
});
