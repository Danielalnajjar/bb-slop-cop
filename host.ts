import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { reviewDeltaContract, reviewSha } from "./lib/review-delta";

export default experimental_defineHostEntry({
  contract: reviewDeltaContract,
  handlers: {
    async reviewDelta({ repo, sourcePath, prior, priorBase, base, head }, context) {
      const signal = AbortSignal.any([context.signal, context.lifecycle.signal]);
      const run = (args: string[], allowConflict = false) => new Promise<{ stdout: Buffer; conflicted: boolean }>((resolve, reject) => {
        execFile("git", ["--no-replace-objects", "-C", sourcePath, ...args], {
          encoding: "buffer", timeout: 45_000, maxBuffer: 2 * 1024 * 1024, signal,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }, (error, stdout) => {
          if (error && !(allowConflict && error.code === 1)) reject(new Error("git " + args[0] + " failed"));
          else resolve({ stdout, conflicted: error?.code === 1 });
        });
      });
      const read = async (args: string[]) => (await run(args)).stdout.toString("utf8").trim();
      const remote = await read(["remote", "get-url", "origin"]);
      const remoteRepo = /^(?:git@github\.com:|(?:ssh:\/\/git@github\.com|https:\/\/github(?:\.com|\.int\.exe\.xyz))\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote)?.[1];
      if (remoteRepo?.toLowerCase() !== repo.toLowerCase()) throw new Error("project source origin does not match review repository");
      try {
        await run(["cat-file", "-e", head + "^{commit}"]);
      } catch {
        signal.throwIfAborted();
        await run(["fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance",
          "--no-prune", "--no-recurse-submodules", "--refmap=", "origin", head]);
      }
      // The prior review covered priorBase...prior. A base that moved backward or
      // elsewhere puts uncovered commits in the PR diff, so only a full review fits.
      if (await read(["merge-base", prior, head]) !== prior ||
          await read(["merge-base", base, head]) !== base ||
          await read(["merge-base", priorBase, base]) !== priorBase) return null;

      const baseMerged = await read(["merge-base", prior, base]) !== base;
      // Status 1 also produces a tree, with the unresolved merge as its content.
      const { stdout: merged, conflicted } = await run(["merge-tree", "--write-tree", "--no-messages", prior, base], true);
      const tree = reviewSha.parse(merged.toString("utf8").split("\n", 1)[0]?.trim());
      if (tree === await read(["rev-parse", head + "^{tree}"])) {
        return conflicted ? null : { tree, patchBase64: "", baseMerged };
      }
      const { stdout: patch } = await run(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color",
        "--ignore-submodules=none", tree, head, "--"]);
      return patch.length === 0 ? null : { tree, patchBase64: patch.toString("base64"), baseMerged };
    },
  },
});
