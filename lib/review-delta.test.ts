import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { expect, it } from "vitest";
import reviewHost from "../host";
import { REVIEW_GIT_OPTIONS } from "./review-delta";

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

it("returns an oversize patch's tree that another clone reproduces, and names other misses", async () => {
  const sourcePath = mkdtempSync(join(tmpdir(), "slopcop-delta-"));
  const clonePath = mkdtempSync(join(tmpdir(), "slopcop-clone-"));
  const harness = experimental_createHostEntryHarness(reviewHost);
  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const git = (...args: string[]) => gitIn(sourcePath, ...args);
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
    const prior = commit("prior reviewed head");
    git("switch", "master");
    write("conflict.txt", "from master");
    const base = commit("master edits the same line");
    git("switch", "feature");
    expect(() => git("merge", "--no-ff", "--no-edit", base)).toThrow();
    write("conflict.txt", "the resolution");
    commit("resolve merge");
    write("large.txt", Array.from({ length: 60_000 }, (_, index) => `generated line ${index} ${"x".repeat(32)}`).join("\n"));
    const head = commit("large push");
    const input = { repo: "acme/widgets", sourcePath, prior, priorBase, base, head };

    const result = await harness.experimental_call("reviewDelta", input);
    expect(result).toEqual({ kind: "oversize", tree: expect.stringMatching(/^[a-f0-9]{40}$/) });
    const { tree } = result as { tree: string };

    // The reviewer's checkout: no unreferenced merge tree, and a different conflict style.
    execFileSync("git", ["clone", "--quiet", "--no-local", "--no-checkout", sourcePath, clonePath]);
    gitIn(clonePath, "config", "merge.conflictStyle", "zdiff3");
    gitIn(clonePath, "checkout", "--quiet", "--detach", head);
    expect(() => gitIn(clonePath, ...REVIEW_GIT_OPTIONS, "cat-file", "-e", `${tree}^{tree}`)).toThrow();
    const mergeTree = (options: readonly string[]) => {
      const merged = spawnSync("git", ["-C", clonePath, ...options, "merge-tree", "--write-tree", "--no-messages", prior, base], {
        encoding: "utf8",
      });
      expect(merged.status).toBe(1);
      return merged.stdout.split("\n", 1)[0];
    };
    expect(mergeTree([])).not.toBe(tree);
    expect(mergeTree(REVIEW_GIT_OPTIONS)).toBe(tree);
    const diff = gitIn(clonePath, ...REVIEW_GIT_OPTIONS, "diff", "--no-ext-diff", "--no-textconv",
      "--ignore-submodules=none", tree, head, "--");
    expect(diff.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(diff.match(/^diff --git .*$/gm)).toEqual(["diff --git a/conflict.txt b/conflict.txt", "diff --git a/large.txt b/large.txt"]);
    expect(diff).toContain("+the resolution");

    git("switch", "--quiet", "--orphan", "unrelated");
    write("unrelated.txt", "no shared history");
    const unrelated = commit("unrelated root");
    expect(await harness.experimental_call("reviewDelta", { ...input, head: unrelated })).toEqual({
      kind: "miss", reason: "history_changed", detail: `reviewed head ${prior} is not an ancestor of ${unrelated}`,
    });
    const rewritten = "f".repeat(40);
    expect(await harness.experimental_call("reviewDelta", { ...input, prior: rewritten })).toEqual({
      kind: "miss", reason: "history_changed", detail: `reviewed head ${rewritten} is not an ancestor of ${head}`,
    });
    expect(await harness.experimental_call("reviewDelta", { ...input, repo: "acme/other" })).toEqual({
      kind: "miss", reason: "git_error", detail: "project source origin does not match review repository",
    });
    expect(await harness.experimental_call("reviewDelta", { ...input, sourcePath: join(sourcePath, "missing") })).toEqual({
      kind: "miss", reason: "git_error", detail: "git remote failed",
    });
  } finally {
    await harness.experimental_dispose();
    rmSync(sourcePath, { recursive: true });
    rmSync(clonePath, { recursive: true, force: true });
  }
});

it("carries conflict-free rebases with no PR-owned changes and widens rebases with edits or conflicts", async () => {
  const sourcePath = mkdtempSync(join(tmpdir(), "slopcop-rebase-"));
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
    write("base.txt", "initial");
    write("shared.txt", "shared v0");
    const priorBase = commit("initial");

    git("switch", "-c", "feature");
    write("feat.txt", "feature v1");
    const prior = commit("feature v1");

    git("switch", "master");
    write("base.txt", "main moved");
    const base = commit("advance main");

    git("switch", "-c", "rebased-clean", base);
    write("feat.txt", "feature v1");
    const cleanRebaseHead = commit("rebased feature cleanly");

    const delta = (p: string, pb: string, b: string, h: string) =>
      harness.experimental_call("reviewDelta", {
        repo: "acme/widgets", sourcePath, prior: p, priorBase: pb, base: b, head: h,
      });

    const cleanResult = await delta(prior, priorBase, base, cleanRebaseHead);
    expect(cleanResult).toMatchObject({
      kind: "patch",
      patchBase64: "",
      baseMerged: true,
      tree: git("rev-parse", `${cleanRebaseHead}^{tree}`),
    });

    write("feat.txt", "feature v1 + edit after rebase");
    const editedRebaseHead = commit("edit after rebase");
    expect(await delta(prior, priorBase, base, editedRebaseHead)).toEqual({
      kind: "miss",
      reason: "history_changed",
      detail: `reviewed head ${prior} is not an ancestor of ${editedRebaseHead}`,
    });

    git("switch", "-c", "feature-conflict", priorBase);
    write("shared.txt", "feature side");
    const conflictPrior = commit("feature shared edit");

    git("switch", "master");
    write("shared.txt", "main side");
    const conflictBase = commit("main shared edit");

    git("switch", "-c", "rebased-conflict", conflictBase);
    write("shared.txt", "resolved conflict");
    const conflictRebaseHead = commit("resolved rebase conflict");
    expect(await delta(conflictPrior, priorBase, conflictBase, conflictRebaseHead)).toEqual({
      kind: "miss",
      reason: "history_changed",
      detail: `reviewed head ${conflictPrior} is not an ancestor of ${conflictRebaseHead}`,
    });

    // Dropping two canceling commits (+x then -x) must widen, not carry.
    git("switch", "-c", "feature-cancel", priorBase);
    write("cancel.txt", "added");
    commit("add cancel");
    write("cancel.txt", "removed");
    const cancelPrior = commit("revert cancel");
    git("switch", "-c", "rebased-dropped", base);
    const droppedHead = git("rev-parse", "HEAD");
    expect(await delta(cancelPrior, priorBase, base, droppedHead)).toEqual({
      kind: "miss",
      reason: "history_changed",
      detail: `reviewed head ${cancelPrior} is not an ancestor of ${droppedHead}`,
    });

    // A per-commit conflict whose later commit cancels it out must widen on replay.
    git("switch", "-c", "feature-step-conflict", priorBase);
    write("shared.txt", "side A");
    commit("edit shared");
    write("shared.txt", "shared v0");
    const stepConflictPrior = commit("revert shared back");
    git("switch", "-c", "rebased-step-conflict", conflictBase);
    write("shared.txt", "temp manual conflict resolution");
    commit("re-apply conflicting edit manually");
    write("shared.txt", "main side");
    const stepConflictHead = commit("re-apply clean end");
    expect(await delta(stepConflictPrior, priorBase, conflictBase, stepConflictHead)).toEqual({
      kind: "miss",
      reason: "history_changed",
      detail: `reviewed head ${stepConflictPrior} is not an ancestor of ${stepConflictHead}`,
    });

    // Criss-cross multiple merge bases on a direct descendant must widen.
    git("switch", "-c", "cc-left", priorBase);
    write("left.txt", "left");
    const ccLeft = commit("cc left");
    git("switch", "-c", "cc-right", priorBase);
    write("right.txt", "right");
    const ccRight = commit("cc right");
    git("switch", "-c", "cc-a", ccLeft);
    git("merge", "--no-ff", "-m", "merge right into left", ccRight);
    const ccPrior = git("rev-parse", "HEAD");
    git("switch", "-c", "cc-b", ccRight);
    git("merge", "--no-ff", "-m", "merge left into right", ccLeft);
    const ccBase = git("rev-parse", "HEAD");
    git("switch", "-c", "cc-head", ccPrior);
    git("merge", "--no-ff", "-m", "merge ccBase into ccPrior", ccBase);
    const ccHead = git("rev-parse", "HEAD");
    expect(await delta(ccPrior, priorBase, ccBase, ccHead)).toEqual({
      kind: "miss",
      reason: "history_changed",
      detail: `multiple or missing merge bases between ${ccPrior} and ${ccBase}`,
    });
  } finally {
    await harness.experimental_dispose();
    rmSync(sourcePath, { recursive: true, force: true });
  }
});
