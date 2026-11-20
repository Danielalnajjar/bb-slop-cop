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
    expect(await retarget(conflictBase)).toMatchObject({ patchBase64: expect.any(String) });
    expect(await retarget(cleanBase)).toBeNull();
    git("switch", "-c", "diverged", conflictBase);
    write("rewritten.txt", "new lineage");
    const divergentHead = commit("replace feature history");

    const delta = (base: string, head: string) => harness.experimental_call("reviewDelta", {
      repo: "acme/widgets", sourcePath, prior, priorBase, base, head,
    });
    const patch = (result: NonNullable<Awaited<ReturnType<typeof delta>>>) =>
      Buffer.from(result.patchBase64, "base64").toString("utf8");
    expect(git("diff", "--name-only", prior + ".." + cleanHead)).toBe("base-only.txt");
    expect(await delta(cleanBase, cleanHead)).toMatchObject({ patchBase64: "", baseMerged: true });

    const resolved = patch((await delta(conflictBase, resolvedHead))!);
    expect(resolved.match(/^diff --git .*$/gm)).toEqual(["diff --git a/conflict.txt b/conflict.txt"]);
    expect(resolved).toContain("+the resolution");
    const mixed = patch((await delta(conflictBase, mixedHead))!);
    expect(mixed.match(/^diff --git .*$/gm)).toEqual([
      "diff --git a/conflict.txt b/conflict.txt", "diff --git a/new.txt b/new.txt",
    ]);
    expect(mixed).toContain("+the resolution");
    expect(mixed).toContain("+new PR-owned work");
    expect(await delta(conflictBase, divergentHead)).toBeNull();
    expect(git("diff", "--name-only", conflictBase + "..." + divergentHead)).toBe("rewritten.txt");
    expect(git("rev-parse", "HEAD")).toBe(divergentHead);
    expect(git("status", "--porcelain")).toBe("");
  } finally {
    await harness.experimental_dispose();
    rmSync(sourcePath, { recursive: true });
  }
});
