import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  completeGateCheckRun,
  gateConclusionFor,
  gateOutputFor,
  startGateCheckRun,
} from "./checks";
import { createStore, MIGRATIONS } from "./db";
import { evaluateGate, executeGateCheck } from "./gates";
import { gateNameSchema, type GateCheck, type PullRequest } from "./types";
import plugin from "../server";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "Tighten startup instructions",
    isDraft: false,
    headRefOid: "a".repeat(40),
    headRefName: "feat/test",
    baseRefOid: "",
    baseRefName: "main",
    author: { login: "dana" },
    authorAssociation: "OWNER",
    labels: [],
    files: [],
    isCrossRepository: false,
    updatedAt: "2026-11-15T12:00:00Z",
    ...overrides,
  };
}

function makeGate(overrides: Partial<GateCheck> = {}): GateCheck {
  return {
    id: "gate_1",
    name: "startup-load",
    repo: "acme/skills",
    enabled: true,
    mode: "live",
    authorTrust: "write_access",
    repoDir: "/tmp/unused",
    command: "exit 0",
    timeoutSeconds: 30,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("gate schema, db admission, and check-run payloads", () => {
  it("reserves SlopCop for agent reviews and accepts standard check names", () => {
    expect(gateNameSchema.safeParse("startup-load").success).toBe(true);
    expect(gateNameSchema.safeParse("SlopCop").success).toBe(false);
    expect(gateNameSchema.safeParse("slopcop").success).toBe(false);
    expect(gateNameSchema.safeParse("has spaces").success).toBe(false);
  });

  it("deduplicates settled gate runs per head SHA, retries up to 3 errors, and honors force", () => {
    const db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    const store = createStore(db as never);
    store.upsertGate(makeGate());

    const headA = "1".repeat(40);
    const first = store.admitGateRun({
      id: "gr_1",
      gateId: "gate_1",
      gateName: "startup-load",
      repo: "acme/skills",
      prNumber: 12,
      headSha: headA,
      baseSha: "",
      status: "running",
      mode: "live",
      exitCode: null,
      output: "",
      checkRunId: null,
      attempts: 1,
      startedAt: 10,
      finishedAt: null,
    });
    expect(first.admitted).toBe(true);

    // While running or once passed/failed, duplicate admissions do not insert rows.
    const dupWhileRunning = store.admitGateRun({
      ...first.run,
      id: "gr_2",
      startedAt: 11,
    });
    expect(dupWhileRunning.admitted).toBe(false);
    expect(dupWhileRunning.run.id).toBe("gr_1");

    store.updateGateRun("gr_1", { status: "passed", exitCode: 0, finishedAt: 12 });
    const dupAfterPass = store.admitGateRun({
      ...first.run,
      id: "gr_3",
      startedAt: 13,
    });
    expect(dupAfterPass.admitted).toBe(false);
    expect(store.listGateRuns()).toHaveLength(1);

    // Force overrides deduplication.
    const forced = store.admitGateRun(
      { ...first.run, id: "gr_4", startedAt: 14 },
      true,
    );
    expect(forced.admitted).toBe(true);

    // Transient errors reuse the SAME row id + checkRunId up to 3 attempts, then stop automatically.
    const headB = "2".repeat(40);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const adm = store.admitGateRun({
        ...first.run,
        id: `err_${attempt}`,
        headSha: headB,
        startedAt: 20 + attempt,
      });
      expect(adm.admitted).toBe(true);
      expect(adm.run.id).toBe("err_1");
      expect(adm.run.attempts).toBe(attempt);
      if (attempt === 1) {
        store.updateGateRun(adm.run.id, { checkRunId: 888 });
      } else {
        expect(adm.run.checkRunId).toBe(888);
      }
      store.updateGateRun(adm.run.id, { status: "error", finishedAt: 30 + attempt });
    }
    const fourth = store.admitGateRun({
      ...first.run,
      id: "err_4",
      headSha: headB,
      startedAt: 40,
    });
    expect(fourth.admitted).toBe(false);
    expect(fourth.run.id).toBe("err_1");
    expect(fourth.run.attempts).toBe(3);
  });

  it("maps gate conclusions and posts named GitHub check runs", async () => {
    expect(gateConclusionFor("passed")).toBe("success");
    expect(gateConclusionFor("failed")).toBe("failure");
    expect(gateConclusionFor("error")).toBe("cancelled");
    expect(gateConclusionFor("skipped")).toBeNull();

    const calls: { method: string; endpoint: string; body: unknown }[] = [];
    const request = vi.fn(async (method: string, endpoint: string, body?: unknown) => {
      calls.push({ method, endpoint, body });
      return { id: 991 };
    });

    const checkRunId = await startGateCheckRun(request, {
      checkName: "startup-load",
      repo: "acme/skills",
      sha: "a".repeat(40),
      runId: "gr_9",
      prNumber: 12,
    });
    expect(checkRunId).toBe(991);

    await completeGateCheckRun(request, {
      checkName: "startup-load",
      repo: "acme/skills",
      sha: "a".repeat(40),
      runId: "gr_9",
      prNumber: 12,
      status: "failed",
      exitCode: 1,
      outputText: "FAIL  thread:bb-claude-captain: 101961 B exceeds budget 101661 B (+300 B over).",
      checkRunId,
    });

    expect(calls[0]).toMatchObject({
      method: "POST",
      endpoint: "repos/acme/skills/check-runs",
      body: expect.objectContaining({ name: "startup-load", status: "in_progress" }),
    });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      endpoint: "repos/acme/skills/check-runs/991",
      body: expect.objectContaining({
        name: "startup-load",
        status: "completed",
        conclusion: "failure",
      }),
    });
    expect(gateOutputFor({
      checkName: "startup-load",
      repo: "acme/skills",
      sha: "a".repeat(40),
      runId: "gr_9",
      prNumber: 12,
      status: "failed",
      exitCode: 1,
      outputText: "FAIL  over budget",
    }).summary).toContain("FAIL  over budget");
  });
});

describe("executeGateCheck against real git origin + local clone", () => {
  function setupOriginAndClone(): {
    originDir: string;
    cloneDir: string;
    baseSha: string;
    passHeadSha: string;
    failHeadSha: string;
  } {
    const root = makeTempDir("slopcop-git-test-");
    const originDir = join(root, "origin.git");
    const workDir = join(root, "work");
    const cloneDir = join(root, "clone");

    execFileSync("git", ["init", "--bare", "--initial-branch=main", originDir]);
    execFileSync("git", ["clone", originDir, workDir]);
    execFileSync("git", ["-C", workDir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", workDir, "config", "user.name", "Test"]);

    writeFileSync(join(workDir, "budget.txt"), "10\n");
    writeFileSync(join(workDir, "payload.txt"), "123456789\n");
    execFileSync("git", ["-C", workDir, "add", "."]);
    execFileSync("git", ["-C", workDir, "commit", "-m", "initial"]);
    execFileSync("git", ["-C", workDir, "push", "origin", "main"]);
    const baseSha = execFileSync("git", ["-C", workDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    // Passing PR ref (refs/pull/1/head): shrinks payload within base budget.
    execFileSync("git", ["-C", workDir, "checkout", "-b", "pr-pass", baseSha]);
    writeFileSync(join(workDir, "payload.txt"), "12345\n");
    execFileSync("git", ["-C", workDir, "commit", "-am", "shrink"]);
    const passHeadSha = execFileSync("git", ["-C", workDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", workDir, "push", "origin", `HEAD:refs/pull/1/head`]);

    // Failing PR ref (refs/pull/2/head): grows payload past base budget.
    execFileSync("git", ["-C", workDir, "checkout", "-b", "pr-fail", baseSha]);
    writeFileSync(join(workDir, "payload.txt"), "123456789012345\n");
    execFileSync("git", ["-C", workDir, "commit", "-am", "bloat"]);
    const failHeadSha = execFileSync("git", ["-C", workDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", workDir, "push", "origin", `HEAD:refs/pull/2/head`]);

    execFileSync("git", ["clone", originDir, cloneDir]);
    return { originDir, cloneDir, baseSha, passHeadSha, failHeadSha };
  }

  it("passes on compliant PR heads, fails on over-budget PR heads, leaves repoDir untouched, and skips untrusted authors", async () => {
    const { cloneDir, baseSha, passHeadSha, failHeadSha } = setupOriginAndClone();
    const command = [
      'base_limit=$(git show "$SLOPCOP_BASE_SHA:budget.txt" | tr -d "\\n")',
      "cur_bytes=$(wc -c < payload.txt | tr -d ' ')",
      'if [ "$cur_bytes" -gt "$base_limit" ]; then echo "FAIL: $cur_bytes > $base_limit"; exit 1; fi',
      'echo "OK: $cur_bytes <= $base_limit"',
    ].join("; ");

    const gate = makeGate({ repoDir: cloneDir, command });

    const passRes = await executeGateCheck({
      gate,
      pullRequest: makePr({ number: 1, headRefOid: passHeadSha }),
      runId: "gr_pass",
      resolveMergeBase: async () => baseSha,
    });
    expect(passRes.status).toBe("passed");
    expect(passRes.exitCode).toBe(0);
    expect(passRes.output).toContain("OK: 6 <= 10");

    const failRes = await executeGateCheck({
      gate,
      pullRequest: makePr({ number: 2, headRefOid: failHeadSha }),
      runId: "gr_fail",
      resolveMergeBase: async () => baseSha,
    });
    expect(failRes.status).toBe("failed");
    expect(failRes.exitCode).toBe(1);
    expect(failRes.output).toContain("FAIL: 16 > 10");

    //Untrusted fork author is skipped before git fetch or shell execution.
    const untrusted = evaluateGate(
      gate,
      makePr({ number: 2, headRefOid: failHeadSha, authorAssociation: "NONE" }),
    );
    expect(untrusted.matched).toBe(false);
    expect(untrusted.blockedByTrust).toBe(true);

    const forcedUntrusted = await executeGateCheck({
      gate,
      pullRequest: makePr({ number: 2, headRefOid: failHeadSha, authorAssociation: "CONTRIBUTOR" }),
      runId: "gr_untrusted",
      resolveMergeBase: async () => baseSha,
    });
    expect(forcedUntrusted.status).toBe("skipped");

    // Local clone branch, status, and refs/slopcop/* remain completely clean.
    const status = execFileSync("git", ["-C", cloneDir, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim();
    const refs = execFileSync("git", ["-C", cloneDir, "for-each-ref", "refs/slopcop"], {
      encoding: "utf8",
    }).trim();
    expect(status).toBe("");
    expect(refs).toBe("");
  });

  it("registers, lists, toggles, and removes gates through the plugin CLI", async () => {
    const host = createFakePluginHost();
    await plugin(host.bb);

    const added = await host.harness.behavior.runCli([
      "gates",
      "add",
      "--name",
      "startup-load",
      "--repo",
      "acme/skills",
      "--repo-dir",
      "/srv/skills",
      "--command",
      "python3 -B tools/check-startup-sizes.py",
      "--live",
    ]);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain("Created gate 'startup-load'");

    const listed = await host.harness.behavior.runCli(["gates", "--json"]);
    expect(listed.exitCode).toBe(0);
    const parsed = JSON.parse(listed.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "startup-load",
      repo: "acme/skills",
      mode: "live",
      enabled: true,
    });

    const disabled = await host.harness.behavior.runCli(["gates", "disable", "startup-load"]);
    expect(disabled.exitCode).toBe(0);

    const removed = await host.harness.behavior.runCli(["gates", "rm", "startup-load"]);
    expect(removed.exitCode).toBe(0);
  });

  it("runs gates through CLI gates run on real git refs and reconciles stranded running rows on reload", async () => {
    const { cloneDir, baseSha, passHeadSha, failHeadSha } = setupOriginAndClone();
    const ghWrapper = join(makeTempDir("slopcop-gh-stub-"), "gh-stub.mjs");
    const checkCallsFile = join(makeTempDir("slopcop-check-calls-"), "calls.jsonl");
    writeFileSync(
      ghWrapper,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("bot\\n");
  process.exit(0);
}
const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";
if (endpoint.includes("/pulls/1")) {
  process.stdout.write(JSON.stringify({
    number: 1, title: "Pass PR", draft: false,
    user: { login: "dana" }, author_association: "OWNER",
    head: { sha: "${passHeadSha}", ref: "pr-pass", repo: { full_name: "acme/skills" } },
    base: { ref: "main", repo: { full_name: "acme/skills" } },
    labels: [], updated_at: "2026-11-15T12:00:00Z"
  }));
  process.exit(0);
}
if (endpoint.includes("/pulls/2")) {
  process.stdout.write(JSON.stringify({
    number: 2, title: "Fail PR", draft: true,
    user: { login: "dana" }, author_association: "OWNER",
    head: { sha: "${failHeadSha}", ref: "pr-fail", repo: { full_name: "acme/skills" } },
    base: { ref: "main", repo: { full_name: "acme/skills" } },
    labels: [], updated_at: "2026-11-15T12:00:00Z"
  }));
  process.exit(0);
}
if (endpoint.includes("/compare/")) {
  process.stdout.write("${baseSha}\\n");
  process.exit(0);
}
if (endpoint.includes("/check-runs")) {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { body += c; });
  process.stdin.on("end", () => {
    appendFileSync(${JSON.stringify(checkCallsFile)}, JSON.stringify({ args, body: body ? JSON.parse(body) : null }) + "\\n");
    process.stdout.write(JSON.stringify({ id: 777 }));
    process.exit(0);
  });
} else {
  process.stdout.write("[]");
}
`,
      { mode: 0o755 },
    );

    const host = createFakePluginHost({
      settings: { ghPath: ghWrapper, pollSeconds: 60, maxConcurrentReviews: 3, botGhPath: "", defaultThreadSection: "" },
    });
    await plugin(host.bb);
    const store = createStore(host.bb.storage.database() as never);
    // Insert a stranded running gate row before watcher starts to verify startup reconciliation.
    store.admitGateRun({
      id: "gr_stranded",
      gateId: "gate_stranded",
      gateName: "startup-load",
      repo: "acme/skills",
      prNumber: 99,
      headSha: "f".repeat(40),
      baseSha: "",
      status: "running",
      mode: "shadow",
      exitCode: null,
      output: "",
      checkRunId: null,
      attempts: 1,
      startedAt: 1,
      finishedAt: null,
    });

    const service = host.harness.behavior.runService("watcher");
    await new Promise((r) => setTimeout(r, 150));
    expect(store.getGateRun("gr_stranded")?.status).toBe("error");

    const command = [
      'base_limit=$(git show "$SLOPCOP_BASE_SHA:budget.txt" | tr -d "\\n")',
      "cur_bytes=$(wc -c < payload.txt | tr -d ' ')",
      'test "$cur_bytes" -le "$base_limit"',
    ].join("; ");

    await host.harness.behavior.runCli([
      "gates",
      "add",
      "--name",
      "startup-load",
      "--repo",
      "acme/skills",
      "--repo-dir",
      cloneDir,
      "--command",
      command,
      "--live",
    ]);

    const passRun = await host.harness.behavior.runCli(["gates", "run", "startup-load", "1", "--json"]);
    expect(passRun.exitCode).toBe(0);
    expect(JSON.parse(passRun.stdout).run.status).toBe("passed");

    // Draft PR #2 fails until --include-draft is passed, then posts failure check run.
    const blockedDraft = await host.harness.behavior.runCli(["gates", "run", "startup-load", "2"]);
    expect(blockedDraft.exitCode).toBe(1);

    const failRun = await host.harness.behavior.runCli([
      "gates",
      "run",
      "startup-load",
      "2",
      "--include-draft",
      "--json",
    ]);
    expect(failRun.exitCode).toBe(0);
    expect(JSON.parse(failRun.stdout).run.status).toBe("failed");

    service.controller.abort();
    await service.done.catch(() => undefined);
  });

  it("terminates background descendants holding stdio open when a gate times out", async () => {
    const { cloneDir, baseSha, passHeadSha } = setupOriginAndClone();
    const startedAt = Date.now();
    const timedOutRes = await executeGateCheck({
      gate: makeGate({
        repoDir: cloneDir,
        timeoutSeconds: 1,
        command: "echo before-timeout; sleep 30 & wait",
      }),
      pullRequest: makePr({ number: 1, headRefOid: passHeadSha }),
      runId: "gr_timeout_tree",
      resolveMergeBase: async () => baseSha,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(timedOutRes.status).toBe("error");
    expect(timedOutRes.output).toContain("command timed out after 1s");
    expect(timedOutRes.output).toContain("before-timeout");
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it("reuses the original check_run_id on retry when completion reporting fails transiently", async () => {
    const { cloneDir, baseSha, passHeadSha } = setupOriginAndClone();
    const ghWrapper = join(makeTempDir("slopcop-gh-retry-"), "gh-retry.mjs");
    const stateFile = join(makeTempDir("slopcop-gh-retry-state-"), "state.json");
    writeFileSync(stateFile, JSON.stringify({ patchAttempts: 0, calls: [] }));
    writeFileSync(
      ghWrapper,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("bot\\n");
  process.exit(0);
}
const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";
if (endpoint.includes("/pulls/1")) {
  process.stdout.write(JSON.stringify({
    number: 1, title: "Pass PR", draft: false,
    user: { login: "dana" }, author_association: "OWNER",
    head: { sha: "${passHeadSha}", ref: "pr-pass", repo: { full_name: "acme/skills" } },
    base: { ref: "main", repo: { full_name: "acme/skills" } },
    labels: [], updated_at: "2026-11-15T12:00:00Z"
  }));
  process.exit(0);
}
if (endpoint.includes("/compare/")) {
  process.stdout.write("${baseSha}\\n");
  process.exit(0);
}
if (endpoint.includes("/check-runs")) {
  const methodIdx = args.indexOf("--method");
  const method = methodIdx >= 0 ? args[methodIdx + 1] : "GET";
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { body += c; });
  process.stdin.on("end", () => {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.calls.push({ method, endpoint, body: body ? JSON.parse(body) : null });
    if (method === "PATCH") {
      state.patchAttempts += 1;
      writeFileSync(statePath, JSON.stringify(state));
      if (state.patchAttempts === 1) {
        process.stderr.write("HTTP 502 Bad Gateway\\n");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ id: 901 }));
      process.exit(0);
    }
    writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({ id: 901 }));
    process.exit(0);
  });
} else {
  process.stdout.write("[]");
}
`,
      { mode: 0o755 },
    );

    const host = createFakePluginHost({
      settings: { ghPath: ghWrapper, pollSeconds: 60, maxConcurrentReviews: 3, botGhPath: "", defaultThreadSection: "" },
    });
    await plugin(host.bb);
    await host.harness.behavior.runCli([
      "gates",
      "add",
      "--name",
      "startup-load",
      "--repo",
      "acme/skills",
      "--repo-dir",
      cloneDir,
      "--command",
      "exit 0",
      "--live",
    ]);

    const first = await host.harness.behavior.runCli(["gates", "run", "startup-load", "1", "--json"]);
    expect(first.exitCode).toBe(0);
    const firstPayload = JSON.parse(first.stdout);
    expect(firstPayload.run.status).toBe("error");
    expect(firstPayload.run.checkRunId).toBe(901);

    const second = await host.harness.behavior.runCli(["gates", "run", "startup-load", "1", "--json"]);
    expect(second.exitCode).toBe(0);
    const secondPayload = JSON.parse(second.stdout);
    expect(secondPayload.run.id).toBe(firstPayload.run.id);
    expect(secondPayload.run.status).toBe("passed");
    expect(secondPayload.run.attempts).toBe(2);

    const recorded = JSON.parse(
      execFileSync("node", ["-e", `console.log(require("fs").readFileSync(${JSON.stringify(stateFile)}, "utf8"))`], {
        encoding: "utf8",
      }),
    ) as { calls: { method: string; endpoint: string; body: { status?: string; conclusion?: string } | null }[] };
    const posts = recorded.calls.filter((c) => c.method === "POST");
    const patches = recorded.calls.filter((c) => c.method === "PATCH");
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(2);
    expect(patches[1]?.endpoint).toBe("repos/acme/skills/check-runs/901");
    expect(patches[1]?.body).toMatchObject({ status: "completed", conclusion: "success" });
  });
});
