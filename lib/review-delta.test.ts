import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { expect, it } from "vitest";
import reviewHost from "../host";

it("computes PR-owned patches for clean, resolved, mixed and divergent pushes in a real repository", async () => {
  const sourcePath = mkdtempSync(join(tmpdir(), "slopcop-delta-"));
  const harness = experimental_createHostEntryHarness(reviewHost);
  const git = (...args: string[]) => execFileSync("git", ["-C", sourcePath, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const write = (file: string, text: string) => writeFileSync(join(sourcePath, file), text + "\n");
  const commit = (message: string) => {
    git("add", "--all");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--initial-branch=master");
    git("config", "user.name", "Review Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    write("conflict.txt", "initial");
    const priorBase = commit("initial");
    git("switch", "-c", "feature");
    write("conflict.txt", "from the PR");
    write("prior.txt", "already reviewed");
    const prior = commit("prior reviewed head");

    git("switch", "master");
    write("base-only.txt", "already reviewed in a different PR");
    const cleanBase = commit("independent master change");
    git("switch", "-c", "clean", prior);
    git("merge", "--no-ff", "--no-edit", cleanBase);
    const cleanHead = git("rev-parse", "HEAD");

    git("switch", "master");
    write("conflict.txt", "from master");
    const conflictBase = commit("master edits the same line");
    git("switch", "-c", "resolved", prior);
    expect(() => git("merge", "--no-ff", "--no-edit", conflictBase)).toThrow();
    write("conflict.txt", "the resolution");
    const resolvedHead = commit("resolve merge");
    write("new.txt", "new PR-owned work");
    const mixedHead = commit("new PR work after the merge");
    // A head reviewed against conflictBase, then retargeted to the older cleanBase:
    // conflictBase's own commit joins the PR diff, which that review never covered.
    git("switch", "-c", "retargeted", conflictBase);
    write("stacked.txt", "reviewed on the newer base");
    const stackedPrior = commit("stacked head reviewed against conflictBase");
    write("stacked.txt", "pushed after the retarget");
    const stackedHead = commit("push after the retarget");
    const retarget = (base: string) => harness.experimental_call("reviewDelta", {
      repo: "acme/widgets", sourcePath, prior: stackedPrior, priorBase: conflictBase, base, head: stackedHead,
    });
    expect(await retarget(conflictBase)).toMatchObject({ kind: "patch", patchBase64: expect.any(String) });
    expect(await retarget(cleanBase)).toEqual({
      kind: "miss", reason: "history_changed",
      detail: `reviewed base ${conflictBase} is not an ancestor of PR base ${cleanBase}`,
    });
    git("switch", "-c", "diverged", conflictBase);
    write("rewritten.txt", "new lineage");
    const divergentHead = commit("replace feature history");

    const delta = (base: string, head: string) => harness.experimental_call("reviewDelta", {
      repo: "acme/widgets", sourcePath, prior, priorBase, base, head,
    });
    const patch = (result: Awaited<ReturnType<typeof delta>>) => {
      if (result.kind !== "patch") throw new Error(`expected a patch, got ${result.kind}`);
      return Buffer.from(result.patchBase64, "base64").toString("utf8");
    };
    expect(git("diff", "--name-only", prior + ".." + cleanHead)).toBe("base-only.txt");
    expect(await delta(cleanBase, cleanHead)).toMatchObject({ kind: "patch", patchBase64: "", baseMerged: true });

    const resolved = patch(await delta(conflictBase, resolvedHead));
    expect(resolved.match(/^diff --git .*$/gm)).toEqual(["diff --git a/conflict.txt b/conflict.txt"]);
    expect(resolved).toContain("+the resolution");
    const mixed = patch(await delta(conflictBase, mixedHead));
    expect(mixed.match(/^diff --git .*$/gm)).toEqual([
      "diff --git a/conflict.txt b/conflict.txt", "diff --git a/new.txt b/new.txt",
    ]);
    expect(mixed).toContain("+the resolution");
    expect(mixed).toContain("+new PR-owned work");
    expect(await delta(conflictBase, divergentHead)).toEqual({
      kind: "miss", reason: "history_changed", detail: `reviewed head ${prior} is not an ancestor of ${divergentHead}`,
    });
    expect(git("diff", "--name-only", conflictBase + "..." + divergentHead)).toBe("rewritten.txt");
    expect(git("rev-parse", "HEAD")).toBe(divergentHead);
    expect(git("status", "--porcelain")).toBe("");
  } finally {
    await harness.experimental_dispose();
    rmSync(sourcePath, { recursive: true });
  }
});

it("returns an oversize patch's tree for the reviewer to diff, and names git errors", async () => {
  const sourcePath = mkdtempSync(join(tmpdir(), "slopcop-delta-"));
  const harness = experimental_createHostEntryHarness(reviewHost);
  const git = (...args: string[]) => execFileSync("git", ["-C", sourcePath, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const commit = (message: string) => {
    git("add", "--all");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--initial-branch=master");
    git("config", "user.name", "Review Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("remote", "add", "origin", "https://github.com/acme/widgets.git");
    writeFileSync(join(sourcePath, "base.txt"), "initial\n");
    const base = commit("initial");
    writeFileSync(join(sourcePath, "prior.txt"), "already reviewed\n");
    const prior = commit("prior reviewed head");
    const lines = Array.from({ length: 60_000 }, (_, index) => `generated line ${index} ${"x".repeat(32)}`);
    writeFileSync(join(sourcePath, "large.txt"), lines.join("\n") + "\n");
    const head = commit("large push");
    const input = { repo: "acme/widgets", sourcePath, prior, priorBase: base, base, head };

    const result = await harness.experimental_call("reviewDelta", input);
    const tree = git("merge-tree", "--write-tree", "--no-messages", prior, base).split("\n", 1)[0];
    expect(result).toEqual({ kind: "oversize", tree });
    // The commands the prompt gives the reviewer reproduce the same range.
    const diff = git("diff", "--no-ext-diff", "--no-textconv", tree!, head, "--");
    expect(diff.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(diff.match(/^diff --git .*$/gm)).toEqual(["diff --git a/large.txt b/large.txt"]);

    expect(await harness.experimental_call("reviewDelta", { ...input, repo: "acme/other" })).toEqual({
      kind: "miss", reason: "git_error", detail: "project source origin does not match review repository",
    });
    expect(await harness.experimental_call("reviewDelta", { ...input, sourcePath: join(sourcePath, "missing") })).toEqual({
      kind: "miss", reason: "git_error", detail: "git remote failed",
    });
  } finally {
    await harness.experimental_dispose();
    rmSync(sourcePath, { recursive: true });
  }
});
