import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { MAX_ATTACHED_PATCH_BYTES, reviewDeltaContract, reviewSha } from "./lib/review-delta";

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
        execFile("git", ["--no-replace-objects", "-C", sourcePath, ...args], {
          encoding: "buffer", timeout: 45_000, maxBuffer: MAX_ATTACHED_PATCH_BYTES, signal,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }, (error, stdout) => {
          if (error && !(allowConflict && error.code === 1)) {
            reject(new GitFailure(args[0], error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"));
          } else resolve({ stdout, conflicted: error?.code === 1 });
        });
      });
      const read = async (args: string[]) => (await run(args)).stdout.toString("utf8").trim();
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
        // The prior review covered priorBase...prior. A base that moved backward or
        // elsewhere puts uncovered commits in the PR diff, so only a full review fits.
        if (await read(["merge-base", prior, head]) !== prior) {
          return { kind: "miss", reason: "history_changed", detail: `reviewed head ${prior} is not an ancestor of ${head}` };
        }
        if (await read(["merge-base", base, head]) !== base) {
          return { kind: "miss", reason: "history_changed", detail: `PR base ${base} is not an ancestor of ${head}` };
        }
        if (await read(["merge-base", priorBase, base]) !== priorBase) {
          return { kind: "miss", reason: "history_changed", detail: `reviewed base ${priorBase} is not an ancestor of PR base ${base}` };
        }

        const baseMerged = await read(["merge-base", prior, base]) !== base;
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
