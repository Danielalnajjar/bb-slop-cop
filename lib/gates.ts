// Deterministic command check gates evaluated in an isolated git worktree.
//
// Uses only async `execFile` and `spawn` from `node:child_process` so existing
// plugin unit-test mocks stay compatible and slow checks never block the event
// loop.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTrust, isTrustedAuthor } from "./matcher";
import { expandHome } from "./paths";
import type { GateCheck, GateRunStatus, PullRequest } from "./types";

const GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SHA_RE = /^[a-f0-9]{40}$/i;

const repoQueues = new Map<string, Promise<void>>();

async function withRepoLock<T>(repoDir: string, work: () => Promise<T>): Promise<T> {
  const previous = repoQueues.get(repoDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  repoQueues.set(repoDir, previous.then(() => current, () => current));
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (repoQueues.get(repoDir) === current) {
      repoQueues.delete(repoDir);
    }
  }
}

function runGit(repoDir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repoDir, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`git ${args.slice(0, 2).join(" ")} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Process group already exited; fall back to direct child kill.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

function runShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(input.signal.reason ?? new Error("aborted"));
      return;
    }

    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combined = "";
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      error: Error | null,
      result?: { exitCode: number | null; timedOut: boolean; output: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
      input.signal?.removeEventListener("abort", onAbort);
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(result!);
    };

    const onAbort = () => {
      killProcessTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      finish(new Error("aborted"));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      forceSettleTimer = setTimeout(() => {
        finish(null, { exitCode: null, timedOut: true, output: combined });
      }, 250);
      forceSettleTimer.unref?.();
    }, input.timeoutMs);

    const append = (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      const slice =
        bytes + chunk.length > MAX_OUTPUT_BYTES
          ? chunk.subarray(0, MAX_OUTPUT_BYTES - bytes)
          : chunk;
      bytes += slice.length;
      combined += slice.toString("utf8");
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      killProcessTree(child);
      finish(null, { exitCode: code, timedOut, output: combined });
    });
  });
}

export interface EvaluateGateMatchResult {
  matched: boolean;
  blockedByTrust?: boolean;
  reason: string | null;
}

export function evaluateGate(
  gate: GateCheck,
  pullRequest: PullRequest,
  options: { includeDraft?: boolean } = {},
): EvaluateGateMatchResult {
  if (!gate.enabled) {
    return { matched: false, reason: "gate is disabled" };
  }
  if (pullRequest.isDraft && options.includeDraft !== true) {
    return { matched: false, reason: "pull request is a draft" };
  }
  if (!isTrustedAuthor(pullRequest.authorAssociation, gate.authorTrust)) {
    const login = pullRequest.author?.login ?? "unknown";
    return {
      matched: false,
      blockedByTrust: true,
      reason: `author @${login} is ${pullRequest.authorAssociation}, and this gate only runs for ${describeTrust(gate.authorTrust)}`,
    };
  }
  return { matched: true, reason: null };
}

export interface ExecuteGateResult {
  status: Exclude<GateRunStatus, "running">;
  baseSha: string;
  exitCode: number | null;
  output: string;
}

export async function executeGateCheck(input: {
  gate: GateCheck;
  pullRequest: PullRequest;
  runId: string;
  resolveMergeBase: (repo: string, baseRef: string, headSha: string) => Promise<string>;
  remoteName?: string;
  signal?: AbortSignal;
}): Promise<ExecuteGateResult> {
  const { gate, pullRequest, runId } = input;
  if (!isTrustedAuthor(pullRequest.authorAssociation, gate.authorTrust)) {
    const login = pullRequest.author?.login ?? "unknown";
    return {
      status: "skipped",
      baseSha: "",
      exitCode: null,
      output: `author @${login} is ${pullRequest.authorAssociation}, and this gate only runs for ${describeTrust(gate.authorTrust)}`,
    };
  }
  const remote = input.remoteName ?? "origin";
  const headSha = pullRequest.headRefOid.trim();
  const baseBranch = pullRequest.baseRefName.trim();

  if (!SHA_RE.test(headSha)) {
    return {
      status: "error",
      baseSha: "",
      exitCode: null,
      output: `invalid pull request head SHA '${headSha}'`,
    };
  }
  if (
    baseBranch.length === 0 ||
    baseBranch.startsWith("-") ||
    /[\0\s~^:?*[\\]/.test(baseBranch)
  ) {
    return {
      status: "error",
      baseSha: "",
      exitCode: null,
      output: `invalid pull request base branch '${baseBranch}'`,
    };
  }

  let baseSha: string;
  try {
    baseSha = await input.resolveMergeBase(gate.repo, baseBranch, headSha);
  } catch (error) {
    return {
      status: "error",
      baseSha: "",
      exitCode: null,
      output: error instanceof Error ? error.message : String(error),
    };
  }

  const repoDir = expandHome(gate.repoDir.trim());
  const safeRunRef = runId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const headRef = `refs/slopcop/gates/${safeRunRef}/head`;
  const baseRef = `refs/slopcop/gates/${safeRunRef}/base`;
  let worktreeDir: string | null = null;

  try {
    await withRepoLock(repoDir, async () => {
      await runGit(repoDir, [
        "fetch",
        "--no-tags",
        "--quiet",
        remote,
        `+refs/pull/${pullRequest.number}/head:${headRef}`,
        `+refs/heads/${baseBranch}:${baseRef}`,
      ]);
      const fetchedHead = (await runGit(repoDir, ["rev-parse", `${headRef}^{commit}`])).trim();
      if (fetchedHead.toLowerCase() !== headSha.toLowerCase()) {
        throw new Error(
          `pull request #${pullRequest.number} head moved during fetch (expected ${headSha}, fetched ${fetchedHead})`,
        );
      }
      try {
        await runGit(repoDir, ["cat-file", "-e", `${baseSha}^{commit}`]);
      } catch {
        await runGit(repoDir, ["fetch", "--no-tags", "--quiet", remote, baseSha]);
      }
      worktreeDir = await mkdtemp(join(tmpdir(), "slopcop-gate-"));
      await runGit(repoDir, ["worktree", "add", "--detach", "--quiet", worktreeDir, headSha]);
    });

    const result = await runShellCommand({
      command: gate.command,
      cwd: worktreeDir!,
      timeoutMs: gate.timeoutSeconds * 1_000,
      signal: input.signal,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        SLOPCOP_GATE_NAME: gate.name,
        SLOPCOP_REPO: gate.repo,
        SLOPCOP_PR_NUMBER: String(pullRequest.number),
        SLOPCOP_HEAD_SHA: headSha,
        SLOPCOP_BASE_REF: baseRef,
        SLOPCOP_BASE_SHA: baseSha,
        SLOPCOP_REPO_DIR: repoDir,
      },
    });

    if (result.timedOut) {
      return {
        status: "error",
        baseSha,
        exitCode: null,
        output: `command timed out after ${gate.timeoutSeconds}s\n${result.output}`.trim(),
      };
    }
    return {
      status: result.exitCode === 0 ? "passed" : "failed",
      baseSha,
      exitCode: result.exitCode,
      output: result.output,
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      status: "error",
      baseSha,
      exitCode: null,
      output: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await withRepoLock(repoDir, async () => {
      if (worktreeDir !== null) {
        await runGit(repoDir, ["worktree", "remove", "--force", worktreeDir]).catch(() => undefined);
        await rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
      }
      await runGit(repoDir, ["update-ref", "-d", headRef]).catch(() => undefined);
      await runGit(repoDir, ["update-ref", "-d", baseRef]).catch(() => undefined);
    }).catch(() => undefined);
  }
}
