// SlopCop — configurable PR review rules that dispatch BB agents.
//
// Flow: a watcher polls each watched repo with `gh`, detects the
// draft -> ready-for-review edge, matches PRs against enabled rules, and spawns
// a review thread per match. When that thread goes idle, SlopCop verifies the
// outcome against GitHub itself rather than trusting the agent's transcript.
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import { sleep, waitForAbort } from "./lib/abort";
import { z } from "zod";
import { createGhClient, type GhClient } from "./lib/gh";
import { createStore, MIGRATIONS, SUPERSEDED_DETAIL, WAITING_CANCELLED_DETAIL, type ProvisionDispatchOptions, type Store } from "./lib/db";
import { buildPrompt, buildThreadTitle, type DispatchContext } from "./lib/dispatch";
import { buildReviewEnvironment } from "./lib/review-input";
import {
  archiveReviewThread,
  reviewThreadOutcome,
  THREAD_ARCHIVED_REASON,
  THREAD_DELETED_REASON,
} from "./lib/lifecycle";
import { markerRuleName } from "./lib/marker";
import { collectPriorComments } from "./lib/prior";
import { resolveThreadSectionId } from "./lib/sections";
import { expandHome, homeRelative } from "./lib/paths";
import {
  computeTriggers,
  describeTrust,
  evaluateRule,
  isDangerousCombination,
} from "./lib/matcher";
import {
  incompleteReviewReason,
  liveVerifyBlockReason,
  summaryToPost,
  verifyLive,
  verifyShadow,
} from "./lib/verify";
import {
  completeCheckRun,
  completeGateCheckRun,
  startCheckRun,
  startGateCheckRun,
  type CompleteCheckInput,
} from "./lib/checks";
import { evaluateGate, executeGateCheck } from "./lib/gates";
import type { GateCheck, GateRun, Run } from "./lib/types";
import {
  authorTrustSchema,
  conditionSchema,
  dedupeSchema,
  gateNameSchema,
  reviewStrategySchema,
  settleMinutesSchema,
  ruleModeSchema,
  threadRequestSchema,
  triggerSchema,
  visibilitySchema,
  type PullRequest,
  type Rule,
  type Trigger,
} from "./lib/types";

const pollSecondsSchema = z.number().int().min(15);
const maxConcurrentReviewsSchema = z.number().int().min(1);
const maxConcurrentProvisionsPerHostSchema = z.number().int().min(1);
const PROVISION_CAPACITY_DETAIL = "waiting for review provisioning capacity";

const RUNS_CHANNEL = "runs-changed";

const ruleInputSchema = z.object({
  name: z.string().min(1),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  enabled: z.boolean().default(true),
  mode: ruleModeSchema.default("shadow"),
  triggers: z.array(triggerSchema).min(1).default(["ready_for_review"]),
  conditions: z.array(conditionSchema).default([]),
  authorTrust: authorTrustSchema.default("write_access"),
  prompt: z.string().default(""),
  request: threadRequestSchema.nullable().default(null),
  dedupe: dedupeSchema.default("once_per_pr"),
  settleMinutes: settleMinutesSchema.default(0),
  reviewStrategy: reviewStrategySchema.default("update"),
  visibility: visibilitySchema.default("visible"),
});

const gateInputSchema = z.object({
  name: gateNameSchema,
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  enabled: z.boolean().default(true),
  mode: ruleModeSchema.default("shadow"),
  authorTrust: authorTrustSchema.default("write_access"),
  repoDir: z.string().min(1),
  command: z.string().min(1),
  timeoutSeconds: z.number().int().min(5).max(600).default(60),
});

const ruleOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  repo: z.string(),
  enabled: z.boolean(),
  mode: z.string(),
  triggers: z.array(z.string()),
  conditions: z.array(z.unknown()),
  authorTrust: z.string(),
  prompt: z.string(),
  request: z.unknown().nullable(),
  dedupe: z.string(),
  settleMinutes: z.number(),
  reviewStrategy: z.string(),
  visibility: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  dangerous: z.boolean(),
});

const runOutputSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  repo: z.string(),
  prNumber: z.number(),
  prTitle: z.string(),
  prAuthor: z.string(),
  headSha: z.string(),
  status: z.string(),
  mode: z.string(),
  detail: z.string().nullable(),
  threadId: z.string().nullable(),
  commentCount: z.number(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});

const commentOutputSchema = z.object({
  githubId: z.string().nullable(),
  kind: z.string(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  url: z.string().nullable(),
  bodyExcerpt: z.string(),
  attribution: z.string(),
});

export const rpcContract = defineRpcContract({
  listRules: {
    input: z.null(),
    output: z.object({ rules: z.array(ruleOutputSchema) }),
  },
  saveRule: {
    input: z.object({ id: z.string().nullable(), rule: ruleInputSchema }),
    output: z.object({ rule: ruleOutputSchema }),
  },
  deleteRule: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  setRuleEnabled: {
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  listRuns: {
    input: z.object({
      ruleId: z.string().nullable().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    output: z.object({ runs: z.array(runOutputSchema) }),
  },
  getRunComments: {
    input: z.object({ runId: z.string() }),
    output: z.object({ comments: z.array(commentOutputSchema) }),
  },
  checkPr: {
    input: z.object({ ruleId: z.string(), prNumber: z.number().int() }),
    output: z.object({
      matched: z.boolean(),
      reason: z.string().nullable(),
      prTitle: z.string(),
      prAuthor: z.string(),
      association: z.string(),
    }),
  },
  dispatchNow: {
    input: z.object({
      ruleId: z.string(),
      prNumber: z.number().int(),
      force: z.boolean().optional(),
    }),
    output: z.object({
      runId: z.string().nullable(),
      threadId: z.string().nullable(),
      blockedReason: z.string().nullable(),
    }),
  },
  status: {
    input: z.null(),
    output: z.object({
      ghAvailable: z.boolean(),
      ghLogin: z.string().nullable(),
      watchedRepos: z.array(z.string()),
      pollSeconds: z.number(),
      defaultThreadSection: z.string(),
    }),
  },
});

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function toRuleOutput(rule: Rule) {
  return { ...rule, dangerous: isDangerousCombination(rule) };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    pollSeconds: {
      type: "number",
      label: "Poll interval (seconds)",
      default: 60,
      experimental_schema: pollSecondsSchema,
    },
    maxConcurrentReviews: {
      type: "number",
      label: "Max concurrent review threads",
      default: 3,
      experimental_schema: maxConcurrentReviewsSchema,
    },
    maxConcurrentProvisionsPerHost: {
      type: "number",
      label: "Max concurrent review provisions per host",
      description: "Review launches on the same host wait until a provisioning slot frees.",
      default: 4,
      experimental_schema: maxConcurrentProvisionsPerHostSchema,
    },
    ghPath: { type: "string", label: "Path to the gh binary", default: "gh" },
    botGhPath: {
      type: "string",
      label: "Bot gh wrapper",
      description:
        "Absolute path to a wrapper that exports a bot GH_TOKEN and execs gh. When set, SlopCop reads, verifies, and posts as the bot instead of your own gh login. Leave empty to use your own login.",
      default: "",
    },
    defaultThreadSection: {
      type: "string",
      label: "Default review thread section",
      description:
        "Use a section name or ID. Leave this field empty to create unsectioned review threads.",
      default: "",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store: Store = createStore(db as never);

  let gh: GhClient = createGhClient("gh");
  let ghLogin: string | null = null;
  const inFlight = new Set<string>();
  const spawning = new Set<string>();

  let watcherSignal: AbortSignal | undefined;
  let recoveringReviews: Promise<void> | undefined;
  let provisionDrainRequested = false;
  let wakeProvisionDrain: (() => void) | undefined;
  const waitForWork = <T>(work: () => Promise<T>): Promise<T> =>
    waitForAbort(work, watcherSignal);

  const readSettings = async () => {
    const values = await waitForWork(() => settings.get());
    // Stored values bypass save-time validation, so validate before scheduling.
    const pollSeconds = pollSecondsSchema.parse(values.pollSeconds);
    const maxConcurrent = maxConcurrentReviewsSchema.parse(
      values.maxConcurrentReviews,
    );
    const botGhPath = values.botGhPath.trim();
    return {
      pollSeconds,
      maxConcurrent,
      maxProvisionsPerHost: maxConcurrentProvisionsPerHostSchema.parse(values.maxConcurrentProvisionsPerHost),
      // One switch turns on bot mode. The backend client and the agent's write
      // command must resolve to the same identity, or `verifyLive`'s
      // account-based fallback would look for comments from the wrong login.
      //
      // `execFile` does not expand `~`, but the agent's shell does — and the
      // two often run on different hosts with different home directories, so
      // an absolute path cannot serve both. Render the own-home prefix as ~/
      // for the worker and keep the expanded path for backend execution.
      ghPath: expandHome(botGhPath) || values.ghPath.trim() || "gh",
      botGhPath: homeRelative(botGhPath),
      defaultThreadSection: values.defaultThreadSection.trim(),
    };
  };

  const announce = () => {
    bb.realtime.publish(RUNS_CHANNEL, { at: Date.now() });
  };

  // A superseding dispatch can land while the old check's POST is in flight.
  // Complete must wait for its ID rather than race an eventually consistent list.
  const checkWrites = new Map<string, Promise<boolean>>();

  function reportCheck(
    kind: "queued" | "start" | "complete",
    run: Run,
    complete: Pick<CompleteCheckInput, "status" | "commentCount" | "detail"> = run,
    wasWaiting = false,
  ): Promise<boolean> {
    if (run.mode !== "live" || run.headSha.length === 0) return Promise.resolve(true);
    const write = async () => {
      const request: GhClient["request"] = (...args) => waitForWork(() => gh.request(...args));
      const base = { repo: run.repo, sha: run.headSha, runId: run.id, ruleName: run.ruleName, prNumber: run.prNumber };
      try {
        const checkRunId = store.getCheckRunId(run.id);
        if (kind === "complete") {
          await completeCheckRun(request, { ...base, ...complete, checkRunId });
        } else {
          const current = store.getRun(run.id);
          const queued = kind === "queued";
          if (current === null || (queued ? current.status !== "waiting" : !isReviewInProgress(current))) return true;
          const id = await startCheckRun(request, base, { queued, checkRunId, recover: queued || wasWaiting });
          if (id !== null) store.setCheckRunId(run.id, id);
        }
        return true;
      } catch (error) {
        watcherSignal?.throwIfAborted();
        bb.log.warn(
          `check run ${kind} failed for ${run.repo}#${run.prNumber}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    };
    const pending = (checkWrites.get(run.id) ?? Promise.resolve()).then(write).finally(() => {
      if (checkWrites.get(run.id) === pending) checkWrites.delete(run.id);
    });
    checkWrites.set(run.id, pending);
    return pending;
  }

  /**
   * REST does not return a PR's changed files inline, so they are fetched only
   * when a rule actually filters on paths — which keeps the common poll pass to
   * a single API call per repo.
   */
  async function hydrateFiles(
    rules: Rule[],
    repo: string,
    pullRequest: PullRequest,
  ): Promise<boolean> {
    if (!rules.some(hasPathFilter) || pullRequest.files.length > 0) return true;
    try {
      pullRequest.files = await waitForWork(() => gh.listFiles(repo, pullRequest.number));
      return true;
    } catch (error) {
      watcherSignal?.throwIfAborted();
      bb.log.warn(
        `could not list files for ${repo}#${pullRequest.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  function hasPathFilter(rule: Rule): boolean {
    return rule.conditions.some(condition => condition.kind === "paths");
  }

  /**
   * Creates the run row and spawns the review thread. Returns the run id so a
   * manual dispatch can report it even when the spawn itself fails.
   */
  async function dispatch(
    rule: Rule,
    pullRequest: PullRequest,
    options: Partial<ProvisionDispatchOptions> = {},
  ): Promise<{ runId: string; threadId: string | null }> {
    if (recoveringReviews !== undefined) await recoveringReviews;
    const { number: prNumber, headRefOid: headSha } = pullRequest;
    const trigger = options.trigger ?? "manual";
    const scope = { ruleId: rule.id, repo: rule.repo, prNumber, headSha };
    const deferred = () => store.getDeferredReview(rule.id, rule.repo, prNumber);
    const values = await readSettings();
    const dispatchOptions: ProvisionDispatchOptions = { trigger: "manual", ...options };
    // A poll snapshot can age while a gate or path lookup runs. Recheck before
    // promoting a wait or cancelling work on what might really be a newer SHA.
    if (deferred()?.waiting || store.listOlderActiveRuns(scope).length > 0) {
      const latest = await waitForWork(() => gh.getPullRequest(rule.repo, prNumber));
      if (latest.headRefOid !== headSha) {
        const detail = supersededBy(latest.headRefOid);
        const pending = deferred();
        if (pending?.waiting?.headSha === headSha) {
          const skipped = { ...pending.waiting, status: "skipped" as const, detail };
          store.replaceWaitingHead(pending.waiting, pending.trigger, latest.headRefOid, detail, Date.now());
          announce();
          await finalizeRun(skipped);
          return { runId: skipped.id, threadId: null };
        }
        const skipped = recordSkip(rule, pullRequest, detail);
        announce();
        return { runId: skipped.id, threadId: null };
      }
    }
    const previousVerifiedHead = store.latestVerifiedHead(rule.id, rule.repo, prNumber);
    let incrementalBase: string | null = null;
    if (trigger === "new_commits" && previousVerifiedHead !== null && previousVerifiedHead !== headSha) {
      try {
        const mergeBase = await waitForWork(() => gh.resolveMergeBase(rule.repo, previousVerifiedHead, headSha));
        if (mergeBase === previousVerifiedHead) incrementalBase = previousVerifiedHead;
      } catch {
        // An unavailable comparison is not evidence that the older head is safe to exclude.
        watcherSignal?.throwIfAborted();
      }
    }
    const reviewScope = incrementalBase === null ? "full" : "incremental";
    const pending = deferred();
    if (trigger !== "manual" && (
      pending?.trigger !== trigger ||
      (pending.headSha !== null && pending.headSha !== headSha) ||
      store.getRule(rule.id)?.updatedAt !== rule.updatedAt
    )) return { runId: "", threadId: null };
    const waiting = pending?.waiting ?? null;
    const promoted = waiting?.headSha === headSha && waiting.mode === rule.mode;
    const runId = promoted ? waiting.id : newId("run");
    const replaced: Run[] = [];
    // A forced run bypassed a gate the rule would otherwise have honoured, so
    // record why on the run itself — otherwise the activity feed shows a
    // perfectly ordinary review and the override is invisible in hindsight.
    const forcedReason = options.forcedReason ?? null;
    const reservation = store.atomic(() => {
      const admitted = store.admitRun({
        ...newRun(rule, pullRequest, "dispatched", runId),
        detail: forcedReason === null ? null : `forced past the gate — ${forcedReason}`,
      }, {
        dedupe: rule.dedupe, scope: reviewScope, trigger,
        isDraft: pullRequest.isDraft, force: options.force, promoted,
      });
      if (waiting !== null && !promoted) {
        store.discardDeferredReview(rule.id, rule.repo, prNumber,
          waiting.headSha !== headSha ? supersededBy(headSha) : "rule mode changed while waiting");
        replaced.push(store.getRun(waiting.id)!);
      } else {
        store.clearDeferredReview(rule.id, rule.repo, prNumber);
      }
      if (admitted.status !== "skipped") {
        for (const older of store.listOlderActiveRuns(scope)) {
          // An idle event that already selected verification owns its verdict.
          if (older.threadId !== null && finalizing.has(older.threadId)) continue;
          const cancelled = { ...older, status: "cancelled" as const, detail: supersededBy(headSha) };
          store.updateRun(older.id, { status: cancelled.status, detail: cancelled.detail });
          if (older.status === "waiting") store.clearProvisioning(older.id);
          replaced.push(cancelled);
        }
      }
      return admitted;
    });
    for (const run of replaced) inFlight.delete(run.id);
    announce();
    if (reservation.status === "skipped") {
      if (promoted) replaced.push(reservation);
      await Promise.all(replaced.map(run => finalizeRun(run)));
      return { runId, threadId: null };
    }
    await Promise.all(replaced.map(run => finalizeRun(run)));
    return startReview(rule, pullRequest, reservation, dispatchOptions, values, promoted, incrementalBase);
  }

  async function startReview(
    rule: Rule,
    pullRequest: PullRequest,
    reservation: Run,
    options: ProvisionDispatchOptions,
    { botGhPath, defaultThreadSection, maxProvisionsPerHost }: Awaited<ReturnType<typeof readSettings>>,
    promoted: boolean,
    incrementalBase: string | null = null,
  ): Promise<{ runId: string; threadId: string | null }> {
    const runId = reservation.id;
    const wasQueued = reservation.status === "waiting";
    const { trigger } = options;
    const previousVerifiedHead = store.latestVerifiedHead(rule.id, rule.repo, pullRequest.number);
    const reviewScope = incrementalBase === null ? "full" : "incremental";
    const stillExpected = () => {
      const current = store.getRun(runId);
      return current !== null && (isReviewInProgress(current) ||
        (wasQueued && current.status === "waiting"));
    };
    const throwIfDispatchAborted = () => {
      if (!watcherSignal?.aborted) return;
      const reserved = store.getRun(runId);
      if (reserved?.status === "dispatched") {
        store.updateRun(runId, {
          status: "cancelled",
          detail: "plugin stopped before dispatch completed",
          finishedAt: null,
        });
        announce();
      }
      watcherSignal.throwIfAborted();
    };

    if (!stillExpected()) return { runId, threadId: null };
    if (rule.request === null) {
      const detail = "rule has no agent configuration — open it in the SlopCop panel and save it once";
      store.updateRun(runId, {
        status: "failed",
        detail,
        finishedAt: promoted || wasQueued ? null : Date.now(),
      });
      if (wasQueued) store.clearProvisioning(runId);
      announce();
      if (promoted || wasQueued) await finalizeRun({ ...reservation, status: "failed", detail });
      return { runId, threadId: null };
    }

    let priorComments: ReturnType<typeof collectPriorComments> = [];
    try {
      const [issues, review, reviews] = await waitForWork(() => Promise.all([
        gh.listIssueComments(rule.repo, pullRequest.number),
        gh.listReviewComments(rule.repo, pullRequest.number),
        gh.listReviews(rule.repo, pullRequest.number),
      ]));
      priorComments = collectPriorComments(
        [...issues, ...review, ...reviews],
        rule.name,
      );
    } catch (error) {
      throwIfDispatchAborted();
      bb.log.warn(
        `could not list prior comments for ${rule.repo}#${pullRequest.number}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let preparingInputs = false;
    try {
      // `spawn` takes prompt XOR input. The composer stores its draft under
      // `input`, so it must be dropped here — the prompt SlopCop builds from
      // the rule + PR context is what actually runs.
      const { input: _draftInput, ...execution } = rule.request as Record<
        string,
        unknown
      >;
      // `executionInputSources` tells the server which fields the caller chose
      // explicitly; anything not marked explicit falls back to the project's
      // remembered default. The composer omits `providerId` there, so replaying
      // its request verbatim silently dropped our provider and resolved the
      // project's instead — which then rejected the (valid) model as unknown.
      // Anything we actually send is by definition an explicit choice.
      const sources: Record<string, string> = {
        ...((execution.executionInputSources as Record<string, string>) ?? {}),
      };
      for (const field of [
        "providerId",
        "model",
        "reasoningLevel",
        "serviceTier",
        "permissionMode",
      ]) {
        if (execution[field] !== undefined) sources[field] = "explicit";
      }
      execution.executionInputSources = sources;
      const sectionId = resolveThreadSectionId(
        defaultThreadSection,
        defaultThreadSection.length > 0
          ? await waitForWork(() => bb.sdk.threadSections.list())
          : [],
      );
      // thread.idle / thread.failed already run finishRun concurrently.
      if (!stillExpected()) return { runId, threadId: null };
      if (!wasQueued) await reportCheck("start", reservation, undefined, promoted);
      preparingInputs = true;
      const reviewPullRequest = {
        ...pullRequest,
        baseRefOid: incrementalBase ?? await waitForWork(() =>
          gh.resolveMergeBase(rule.repo, pullRequest.baseRefName, pullRequest.headRefOid),
        ),
      };
      const environment = await waitForWork(() =>
        buildReviewEnvironment(bb.sdk, rule.request!, reviewPullRequest),
      );
      const context: DispatchContext = {
        rule,
        pullRequest: reviewPullRequest,
        trigger,
        reviewScope,
        previousVerifiedHead,
        runId,
        ghCommand: botGhPath,
        priorComments,
      };
      if (!stillExpected()) return { runId, threadId: null };
      const hostId = environment.machine.type === "existing" ? environment.machine.hostId : null;
      const admitted = store.atomic(() => {
        if (hostId !== null && !store.canProvision(hostId, maxProvisionsPerHost)) {
          store.setProvisioning(runId, hostId, options);
          store.updateRun(runId, { status: "waiting", detail: PROVISION_CAPACITY_DETAIL });
          return false;
        }
        if (hostId !== null) store.setProvisioning(runId, hostId, null);
        else if (wasQueued) store.clearProvisioning(runId);
        if (wasQueued) store.updateRun(runId, {
          status: "dispatched",
          detail: options.forcedReason == null ? null : `forced past the gate — ${options.forcedReason}`,
        });
        return true;
      });
      if (!admitted) {
        announce();
        return { runId, threadId: null };
      }
      const dispatchSignal = watcherSignal;
      const logInfo = bb.log.info;
      spawning.add(runId);
      const thread = await waitForWork(async () => {
        const thread = await bb.sdk.threads.spawn({
          ...execution,
          environment,
          prompt: buildPrompt(context),
          title: buildThreadTitle(context),
          visibility: rule.visibility,
          ...(sectionId === undefined ? {} : { sectionId }),
        } as never);
        if (dispatchSignal?.aborted) {
          logInfo(`run ${runId}: ignored spawn result after shutdown (thread ${(thread as { id?: string }).id ?? "unknown"})`);
          return thread;
        }
        store.updateRun(runId, { threadId: (thread as { id: string }).id });
        return thread;
      }).finally(() => spawning.delete(runId));
      preparingInputs = false;
      const threadId = (thread as { id: string }).id;
      const pending = pendingFinish.get(threadId);
      // The terminal event may have arrived before spawn returned the ID.
      if (hostId !== null) {
        if (pending !== undefined || reviewThreadOutcome(thread).kind !== "running") releaseProvision(runId);
        else void observeProvisioningEnd(threadId);
      }
      pendingFinish.delete(threadId);
      // `runs cancel` can finalize this run while it still has no thread. The
      // cancellation stays; writing `reviewing` over it here would leave the
      // agent running with no event able to close the run again.
      const reserved = store.getRun(runId);
      if (reserved !== null && !isReviewInProgress(reserved)) {
        store.updateRun(runId, { threadId });
        if (reserved.detail?.startsWith(SUPERSEDED_DETAIL)) {
          await finalizeRun({ ...reserved, threadId });
        } else {
          await stopReviewThread(threadId);
        }
        bb.log.info(
          `run ${runId} was cancelled before ${threadId} spawned; stopped it`,
        );
        return { runId, threadId };
      }
      store.updateRun(runId, { status: "reviewing", threadId });
      inFlight.add(runId);
      announce();
      bb.log.info(
        `dispatched ${rule.name} for ${rule.repo}#${pullRequest.number} (${rule.mode}) -> ${threadId}`,
      );
      if (pending !== undefined) {
        await finishRun(threadId, pending.finalMessage, pending.noVerdict);
      }
      return { runId, threadId };
    } catch (error) {
      throwIfDispatchAborted();
      if (store.getRun(runId)?.threadId === null) releaseProvision(runId);
      if (!stillExpected()) return { runId, threadId: null };
      store.updateRun(runId, {
        status: preparingInputs ? "cancelled" : "failed",
        detail: error instanceof Error ? error.message : String(error),
        finishedAt: null,
      });
      announce();
      await finalizeRun(store.getRun(runId)!);
      return { runId, threadId: null };
    }
  }

  function newRun(rule: Rule, pullRequest: PullRequest, status: Run["status"], id = newId("run")): Run {
    return {
      id,
      ruleId: rule.id,
      ruleName: rule.name,
      repo: rule.repo,
      prNumber: pullRequest.number,
      prTitle: pullRequest.title,
      prAuthor: pullRequest.author?.login ?? "",
      headSha: pullRequest.headRefOid,
      status,
      mode: rule.mode,
      detail: null,
      threadId: null,
      commentCount: 0,
      startedAt: Date.now(),
      finishedAt: null,
    };
  }

  function recordSkip(rule: Rule, pullRequest: PullRequest, reason: string): Run {
    const run = { ...newRun(rule, pullRequest, "skipped"), detail: reason, finishedAt: Date.now() };
    store.insertRun(run);
    return run;
  }

  function supersededBy(headSha: string): string {
    return SUPERSEDED_DETAIL + headSha;
  }

  /**
   * Deterministic command gate execution. Admits at most one settled run per
   * `(gateId, repo, headSha)` unless `force` is set, and records `"error"` if
   * reporting the completed check run to GitHub fails so the next poll retries.
   */
  async function dispatchGate(
    gate: GateCheck,
    pullRequest: PullRequest,
    options: { force?: boolean; includeDraft?: boolean } = {},
  ): Promise<{ run: GateRun | null; executed: boolean; blockedReason: string | null }> {
    const match = evaluateGate(gate, pullRequest, {
      includeDraft: options.includeDraft,
    });
    if (!match.matched) {
      if (match.blockedByTrust) {
        const now = Date.now();
        const skipped = store.admitGateRun(
          {
            id: newId("grun"),
            gateId: gate.id,
            gateName: gate.name,
            repo: gate.repo,
            prNumber: pullRequest.number,
            headSha: pullRequest.headRefOid,
            baseSha: "",
            status: "skipped",
            mode: gate.mode,
            exitCode: null,
            output: match.reason ?? "blocked by author trust",
            checkRunId: null,
            attempts: 1,
            startedAt: now,
            finishedAt: now,
          },
          options.force,
        );
        announce();
        return {
          run: skipped.run,
          executed: false,
          blockedReason: match.reason,
        };
      }
      return { run: null, executed: false, blockedReason: match.reason };
    }

    const candidateId = newId("grun");
    const startedAt = Date.now();
    const admission = store.admitGateRun(
      {
        id: candidateId,
        gateId: gate.id,
        gateName: gate.name,
        repo: gate.repo,
        prNumber: pullRequest.number,
        headSha: pullRequest.headRefOid,
        baseSha: "",
        status: "running",
        mode: gate.mode,
        exitCode: null,
        output: "",
        checkRunId: null,
        attempts: 1,
        startedAt,
        finishedAt: null,
      },
      options.force,
    );
    if (!admission.admitted) {
      return { run: admission.run, executed: false, blockedReason: null };
    }
    const runId = admission.run.id;
    announce();

    const request: GhClient["request"] = (...args) =>
      waitForWork(() => gh.request(...args));
    let checkRunId: number | null = admission.run.checkRunId;
    if (
      gate.mode === "live" &&
      pullRequest.headRefOid.length > 0 &&
      checkRunId === null
    ) {
      try {
        checkRunId = await waitForWork(() =>
          startGateCheckRun(request, {
            checkName: gate.name,
            repo: gate.repo,
            sha: pullRequest.headRefOid,
            runId,
            prNumber: pullRequest.number,
            reuseExisting: admission.run.attempts > 1,
          }),
        );
        if (checkRunId !== null) {
          store.updateGateRun(runId, { checkRunId });
        }
      } catch (error) {
        watcherSignal?.throwIfAborted();
        bb.log.warn(
          `gate check start failed for ${gate.repo}#${pullRequest.number} (${gate.name}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    let execution: Awaited<ReturnType<typeof executeGateCheck>>;
    try {
      execution = await executeGateCheck({
        gate,
        pullRequest,
        runId,
        resolveMergeBase: (repo, baseRef, headSha) =>
          waitForWork(() => gh.resolveMergeBase(repo, baseRef, headSha)),
        signal: watcherSignal,
      });
    } catch (error) {
      if (watcherSignal?.aborted) {
        store.updateGateRun(runId, {
          status: "error",
          output: "plugin stopped while gate was running",
          finishedAt: Date.now(),
        });
        announce();
      }
      throw error;
    }

    if (gate.mode === "live" && pullRequest.headRefOid.length > 0) {
      try {
        await waitForWork(() =>
          completeGateCheckRun(request, {
            checkName: gate.name,
            repo: gate.repo,
            sha: pullRequest.headRefOid,
            runId,
            prNumber: pullRequest.number,
            status: execution.status,
            exitCode: execution.exitCode,
            outputText: execution.output,
            checkRunId,
          }),
        );
      } catch (error) {
        watcherSignal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        bb.log.warn(
          `gate check completion failed for ${gate.repo}#${pullRequest.number} (${gate.name}): ${message}`,
        );
        store.updateGateRun(runId, {
          baseSha: execution.baseSha,
          status: "error",
          exitCode: execution.exitCode,
          output: `failed to post GitHub check run: ${message}\n${execution.output}`.trim(),
          finishedAt: Date.now(),
        });
        announce();
        return {
          run: store.getGateRun(runId),
          executed: true,
          blockedReason: null,
        };
      }
    }

    store.updateGateRun(runId, {
      baseSha: execution.baseSha,
      status: execution.status,
      exitCode: execution.exitCode,
      output: execution.output,
      finishedAt: Date.now(),
    });
    announce();
    bb.log.info(
      `gate ${gate.name} finished for ${gate.repo}#${pullRequest.number} (${gate.mode}): ${execution.status}`,
    );
    return {
      run: store.getGateRun(runId),
      executed: true,
      blockedReason: null,
    };
  }

  /**
   * One polling pass. Detects the ready-for-review edge per PR, then evaluates
   * every rule watching that repo.
   */
  async function poll(maxConcurrent: number): Promise<void> {
    const rules = store.listRules().filter((rule) => rule.enabled);
    const gates = store.listGates().filter((gate) => gate.enabled);
    const repos = [
      ...new Set([
        ...rules.map((rule) => rule.repo),
        ...gates.map((gate) => gate.repo),
      ]),
    ];

    for (const repo of repos) {
      let pullRequests: PullRequest[];
      try {
        pullRequests = await waitForWork(() => gh.listOpenPullRequests(repo));
      } catch (error) {
        watcherSignal?.throwIfAborted();
        bb.log.warn(
          `poll failed for ${repo}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      // First pass over a repo only records what is already open, so enabling a
      // rule never reviews the backlog. Every later unseen PR is genuinely new.
      const repoBootstrapped = store.isBootstrapped(repo);
      if (!repoBootstrapped && rules.some((candidate) => candidate.repo === repo)) {
        bb.log.info(
          `bootstrapping ${repo}: recording ${pullRequests.length} open PR(s) as backlog`,
        );
      }

      const repoRules = rules.filter((candidate) => candidate.repo === repo);
      const repoGates = gates.filter((candidate) => candidate.repo === repo);
      for (const pending of store.listDeferredReviews(repo)) {
        if (!pullRequests.some(pr => pr.number === pending.prNumber && !pr.isDraft)) {
          store.atomic(() => store.discardDeferredReview(
            pending.ruleId, repo, pending.prNumber, "pull request closed or returned to draft",
          ));
        }
      }

      for (const pullRequest of pullRequests) {
        const { number: prNumber, headRefOid: headSha } = pullRequest;
        const observedAt = Date.now();
        store.atomic(() => {
          const triggers = computeTriggers({
            seen: store.getSeen(repo, prNumber),
            isDraft: pullRequest.isDraft,
            headSha,
            repoBootstrapped,
          });
          for (const rule of repoRules) {
            const trigger = triggers.find(candidate => rule.triggers.includes(candidate));
            if (trigger !== undefined) store.deferReview(rule.id, repo, prNumber, trigger, headSha, observedAt);
          }
          // A reload cannot consume a head edge without first recording its work.
          store.markSeen(repo, prNumber, headSha, pullRequest.isDraft, observedAt);
        });
        if (!pullRequest.isDraft) {
          for (const gate of repoGates) {
            await dispatchGate(gate, pullRequest);
          }
        }
        const pendingRules = repoRules.filter(rule => store.getDeferredReview(rule.id, repo, prNumber) !== null);
        if (pendingRules.length === 0) continue;
        const filesAvailable = await hydrateFiles(pendingRules, repo, pullRequest);
        for (const rule of pendingRules) {
          if (!filesAvailable && hasPathFilter(rule)) continue;
          await dispatchDeferred(rule, pullRequest, maxConcurrent);
        }
      }

      store.markBootstrapped(repo, Date.now());
    }
    for (const run of store.listReviewCleanupRuns()) await finalizeRun(run);
  }

  async function dispatchDeferred(observedRule: Rule, pullRequest: PullRequest, maxConcurrent: number): Promise<void> {
    const { number: prNumber, headRefOid: headSha } = pullRequest;
    const rule = store.getRule(observedRule.id);
    if (rule === null || rule.repo !== observedRule.repo || rule.updatedAt !== observedRule.updatedAt) return;
    const ruleId = rule.id;
    let pending = store.getDeferredReview(ruleId, rule.repo, prNumber);
    if (pending === null) return; // An explicit dispatch may have consumed it.
    if (pending.headSha !== null && pending.headSha !== headSha) {
      // A single-PR lookup may have seen a push before the repo list caught up.
      // Don't recreate the old wait from the older list response.
      const latest = await waitForWork(() => gh.getPullRequest(rule.repo, prNumber));
      if (latest.headRefOid !== headSha || store.getRule(ruleId)?.updatedAt !== rule.updatedAt) return;
      pending = store.getDeferredReview(ruleId, rule.repo, prNumber);
      if (pending === null) return;
      store.deferReview(ruleId, rule.repo, prNumber, pending.trigger, headSha, Date.now());
      pending = store.getDeferredReview(ruleId, rule.repo, prNumber)!;
    }
    const { trigger, waiting } = pending;
    const result = evaluateRule(rule, pullRequest, trigger);
    const replaced = waiting !== null && waiting.headSha !== headSha;
    if (!result.matched) {
      const detail = replaced ? supersededBy(headSha) : result.reason;
      store.atomic(() => store.discardDeferredReview(ruleId, rule.repo, prNumber, detail));
      if (result.blockedByTrust) recordSkip(rule, pullRequest, result.reason);
      if (waiting !== null || result.blockedByTrust) announce();
      return;
    }

    const dedupeHead = rule.dedupe === "once_per_head_sha" ? headSha : null;
    if (trigger === "new_commits" && rule.settleMinutes > 0 &&
        !store.hasSettlingDuplicate(ruleId, rule.repo, prNumber, dedupeHead, headSha)) {
      let current = waiting;
      if (current === null || replaced || current.mode !== rule.mode) {
        const next = {
          ...newRun(rule, pullRequest, "waiting"),
          detail: "waiting to settle",
          startedAt: pending.firstObservedAt ?? Date.now(),
        };
        store.atomic(() => {
          if (waiting !== null) {
            store.discardDeferredReview(ruleId, rule.repo, prNumber,
              replaced ? supersededBy(headSha) : "rule mode changed while waiting");
            store.deferReview(ruleId, rule.repo, prNumber, trigger, headSha, next.startedAt);
          }
          store.insertRun(next);
          store.attachWaitingRun(next);
        });
        current = next;
        announce();
      }
      if (store.getCheckRunId(current.id) === null) await reportCheck("queued", current);
      if (Date.now() - current.startedAt < rule.settleMinutes * 60_000) return;
    }

    if (inFlight.size >= maxConcurrent) {
      // The replacement can take the slot it will free, but not if dedupe
      // rejects it or the old thread is already finishing.
      const replacesInFlight = store.listOlderActiveRuns({ ruleId, repo: rule.repo, prNumber, headSha }).some(run =>
        inFlight.has(run.id) && run.threadId !== null && !finalizing.has(run.threadId));
      if (!replacesInFlight) return;
    }
    await dispatch(rule, pullRequest, { trigger });
  }

  async function drainProvisioningQueue(values: Awaited<ReturnType<typeof readSettings>>) {
    const provisions = store.listProvisioning();
    await Promise.all(provisions.flatMap(({ run, waiting }) =>
      waiting === null && run.threadId !== null ? [observeProvisioningEnd(run.threadId, true)] : [],
    ));
    for (const { run, hostId, waiting } of provisions) {
      if (waiting === null || !store.isWaitingForProvisioning(run.id)) continue;
      if (!store.canProvision(hostId, values.maxProvisionsPerHost)) continue;
      if (waiting.trigger !== "manual" && inFlight.size >= values.maxConcurrent) continue;
      try {
        const rule = store.getRule(run.ruleId);
        if (rule === null || rule.repo !== run.repo || rule.mode !== run.mode || rule.name !== run.ruleName) {
          await discardProvisionWait(run, "rule changed while waiting for provisioning");
          continue;
        }
        const pullRequest = await waitForWork(() => gh.getPullRequest(run.repo, run.prNumber));
        if (pullRequest.isClosed) {
          await discardProvisionWait(run, "pull request closed while waiting for provisioning");
          continue;
        }
        if (pullRequest.headRefOid !== run.headSha) {
          const replacement = waiting.trigger !== "manual" && !pullRequest.isDraft
            ? { headSha: pullRequest.headRefOid, trigger: waiting.trigger }
            : undefined;
          await discardProvisionWait(run, supersededBy(pullRequest.headRefOid), replacement);
          continue;
        }
        if (!waiting.force) {
          if (!await hydrateFiles([rule], run.repo, pullRequest)) continue;
          const match = evaluateRule(rule, pullRequest, waiting.trigger, waiting);
          if (!match.matched) {
            await discardProvisionWait(run, match.reason);
            continue;
          }
        }
        if (!store.isWaitingForProvisioning(run.id) || store.getRule(rule.id)?.updatedAt !== rule.updatedAt) continue;
        await startReview(rule, pullRequest, run, waiting, values, false);
      } catch (error) {
        watcherSignal?.throwIfAborted();
        bb.log.warn(`could not resume review ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function waitForNextPoll(pollSeconds: number): Promise<void> {
    const pollAt = Date.now() + pollSeconds * 1_000;
    while (Date.now() < pollAt) {
      if (provisionDrainRequested) {
        provisionDrainRequested = false;
        await drainProvisioningQueue(await readSettings());
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await waitForWork(() => new Promise<void>(resolve => {
            wakeProvisionDrain = resolve;
            timer = setTimeout(resolve, Math.max(0, pollAt - Date.now()));
          }));
        } finally {
          clearTimeout(timer);
          wakeProvisionDrain = undefined;
        }
      }
    }
  }

  function releaseProvision(runId: string): void {
    if (!store.clearProvisioning(runId)) return;
    provisionDrainRequested = true;
    wakeProvisionDrain?.();
  }

  async function discardProvisionWait(run: Run, detail: string, replacement?: { headSha: string; trigger: Trigger }) {
    if (!store.isWaitingForProvisioning(run.id)) return;
    store.atomic(() => {
      store.clearProvisioning(run.id);
      store.updateRun(run.id, { status: "skipped", detail });
      if (replacement !== undefined &&
          store.getDeferredReview(run.ruleId, run.repo, run.prNumber)?.headSha !== replacement.headSha) {
        store.deferReview(run.ruleId, run.repo, run.prNumber, replacement.trigger, replacement.headSha, Date.now());
      }
    });
    announce();
    await finalizeRun({ ...run, status: "skipped", detail });
  }

  async function observeProvisioningEnd(threadId: string, reconcile = false): Promise<void> {
    if (watcherSignal?.aborted) return;
    const runId = store.findProvisioningRun(threadId);
    if (runId === null) return;
    try {
      const [event] = await waitForWork(() => bb.sdk.threads.events.list({
        threadId, types: ["system/thread-provisioning"], order: "desc", limit: "1",
      }));
      if (event?.type === "system/thread-provisioning" && event.data.status !== "active") {
        releaseProvision(runId);
      } else if (reconcile) {
        const thread = await waitForWork(() => bb.sdk.threads.get({ threadId }));
        if (reviewThreadOutcome(thread).kind !== "running") releaseProvision(runId);
      }
    } catch (error) {
      if (watcherSignal?.aborted) return;
      bb.log.warn(`could not read provisioning state of ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // A pre-start thread can fail or be stopped before BB writes a provisioning
  // row. Its terminal lifecycle event still releases the reservation.
  function releaseTerminatedProvision(threadId: string): void {
    const runId = store.findProvisioningRun(threadId);
    if (runId !== null) releaseProvision(runId);
  }

  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (thread.originPluginId === bb.pluginId) return observeProvisioningEnd(thread.id);
  });

  // --- verification ------------------------------------------------------

  // Host delivers thread.idle/failed on setImmediate; that can beat spawn's
  // HTTP response, so finishRun stashes until dispatch stores threadId.
  const pendingFinish = new Map<
    string,
    { finalMessage: string | null; noVerdict: string | null }
  >();

  // provider-retry and SlopCop both observe a failed turn. Correlate the
  // failed request with the public retry row so dispatching that row cannot
  // erase the evidence before thread.failed arrives.
  const RETRY_QUEUE_GRACE_MS = 1_000;
  type QueueEntry = PluginThreadEventPayloads["message.queued"]["entry"];
  const failedRequestByThread = new Map<string, string>();
  const preservedRequestByThread = new Map<string, string>();
  const retriedRequestsByThread = new Map<string, Set<string>>();
  const retryQueueWaiters = new Map<
    string,
    {
      promise: Promise<boolean>;
      timer: ReturnType<typeof setTimeout>;
      resolve: (queued: boolean) => void;
    }
  >();
  const finalizing = new Map<string, Promise<void>>();

  function retryKey(threadId: string, requestId: string): string {
    return `${threadId}\u0000${requestId}`;
  }

  function settleRetryQueueWaiter(
    threadId: string,
    requestId: string,
    queued: boolean,
  ): void {
    const key = retryKey(threadId, requestId);
    const waiter = retryQueueWaiters.get(key);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    retryQueueWaiters.delete(key);
    waiter.resolve(queued);
  }

  function noteRetry(entry: QueueEntry): void {
    if (entry.payload.kind !== "retry") return;
    const requestId = entry.payload.retryOfTurnRequestId;
    const requests = retriedRequestsByThread.get(entry.threadId) ?? new Set();
    requests.add(requestId);
    retriedRequestsByThread.set(entry.threadId, requests);
    settleRetryQueueWaiter(entry.threadId, requestId, true);
  }

  function hasRetry(threadId: string, requestId: string): boolean {
    return retriedRequestsByThread.get(threadId)?.has(requestId) ?? false;
  }

  async function readRetryQueue(
    threadId: string,
    requestId: string,
  ): Promise<boolean> {
    try {
      const entries = await waitForWork(() => bb.sdk.threads.queue.list({ threadId }));
      for (const entry of entries) {
        noteRetry(entry);
      }
      return retriedRequestsByThread.get(threadId)?.has(requestId) ?? false;
    } catch (error) {
      watcherSignal?.throwIfAborted();
      bb.log.warn(
        `could not inspect retry queue for ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return false;
  }

  /**
   * Whether the thread's queue still holds a retry. The correlated check needs
   * the failed request id, which no longer exists after a restart, so the
   * reconcile pass asks the weaker question the persistent queue can answer.
   */
  async function retryQueuedFor(threadId: string): Promise<boolean> {
    try {
      const entries = await waitForWork(() => bb.sdk.threads.queue.list({ threadId }));
      return entries.some((entry) => entry.payload.kind === "retry");
    } catch (error) {
      watcherSignal?.throwIfAborted();
      bb.log.warn(
        `could not inspect retry queue for ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  async function retryExistsFor(
    threadId: string,
    requestId: string,
  ): Promise<boolean> {
    if (hasRetry(threadId, requestId)) return true;
    if (await readRetryQueue(threadId, requestId)) return true;
    if (hasRetry(threadId, requestId)) return true;

    const key = retryKey(threadId, requestId);
    const existing = retryQueueWaiters.get(key);
    if (existing !== undefined) return existing.promise;

    let settle!: (queued: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      retryQueueWaiters.delete(key);
      settle(false);
    }, RETRY_QUEUE_GRACE_MS);
    retryQueueWaiters.set(key, { promise, timer, resolve: settle });
    const queued = await promise;
    return queued || hasRetry(threadId, requestId) || readRetryQueue(threadId, requestId);
  }

  function clearFailureCorrelation(threadId: string): void {
    failedRequestByThread.delete(threadId);
    preservedRequestByThread.delete(threadId);
    retriedRequestsByThread.delete(threadId);
  }

  bb.onDispose(() => {
    for (const waiter of retryQueueWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    retryQueueWaiters.clear();
  });

  bb.events.on("turn.failed", (event) => {
    retriedRequestsByThread.delete(event.threadId);
    failedRequestByThread.set(event.threadId, event.requestId);
    preservedRequestByThread.delete(event.threadId);
  });

  bb.events.on("message.queued", ({ entry }) => noteRetry(entry));
  bb.events.on("message.dispatched", ({ entry }) => noteRetry(entry));

  function isReviewInProgress(run: Run): boolean {
    return run.status === "dispatched" || run.status === "reviewing";
  }

  const runCleanup = new Map<string, Promise<void>>();

  function finalizeRun(run: Run): Promise<void> {
    const existing = runCleanup.get(run.id);
    if (existing !== undefined) return existing;
    const cleanup = finalizeRunOnce(run).finally(() => runCleanup.delete(run.id));
    runCleanup.set(run.id, cleanup);
    return cleanup;
  }

  async function finalizeRunOnce(run: Run): Promise<void> {
    if (store.getRun(run.id)?.finishedAt !== null) return;
    const superseded = run.detail?.startsWith(SUPERSEDED_DETAIL) === true;
    const awaitingCleanup = superseded || run.status === "skipped" || run.detail === WAITING_CANCELLED_DETAIL;
    let threadId = run.threadId;
    let stopped = true;
    if (superseded && threadId !== null) stopped = await stopReviewThread(threadId);
    const reported = await reportCheck("complete", run);
    if (superseded && threadId === null) {
      threadId = store.getRun(run.id)?.threadId ?? null;
      if (threadId !== null) stopped = await stopReviewThread(threadId);
      else if (spawning.has(run.id)) return;
    }
    if (!stopped) return;
    if (threadId !== null) await waitForWork(() => archiveReviewThread(bb, threadId));
    // Reload and later polls retry terminal check writes for obsolete heads.
    if (reported || !awaitingCleanup) {
      store.updateRun(run.id, { finishedAt: Date.now() });
      announce();
    }
  }

  async function finishRunOnce(
    threadId: string,
    finalMessage: string | null,
    noVerdict: string | null,
    recoverLiveOutput = false,
  ): Promise<void> {
    const run = store.findRunByThread(threadId);
    if (run === null) {
      pendingFinish.set(threadId, { finalMessage, noVerdict });
      return;
    }
    if (run.finishedAt !== null) return;
    if (!isReviewInProgress(run)) {
      await finalizeRun(run);
      return;
    }
    inFlight.delete(run.id);

    const runVerify = () =>
      verifyLive({
        gh,
        repo: run.repo,
        prNumber: run.prNumber,
        ruleName: run.ruleName,
        otherRuleNames: otherRuleNames(run),
        isRecordedRun: (id) => store.getRun(id) !== null,
        runId: run.id,
        startedAt: run.startedAt,
        authenticatedLogin: ghLogin,
      });
    const incompleteComments = async () => {
      try {
        const verified = await waitForWork(runVerify);
        return verified.comments.filter(comment => comment.attribution === "marker");
      } catch (error) {
        watcherSignal?.throwIfAborted();
        bb.log.warn(`could not record incomplete run ${run.id} comments: ${error instanceof Error ? error.message : String(error)}`);
        return store.listComments(run.id);
      }
    };
    try {
      const incomplete = incompleteReviewReason(finalMessage);
      noVerdict ??= incomplete;
      // The thread ended, errored, was retired, or was cancelled before
      // producing anything to verify. That is `cancelled`, however it happened
      // and whenever SlopCop learned of it: `failed` belongs to a review that
      // produced a result and then failed on it.
      if (noVerdict !== null) {
        store.updateRun(run.id, {
          status: "cancelled",
          detail: noVerdict,
          finishedAt: null,
        });
        announce();
        if (incomplete !== null && run.mode === "live") {
          const comments = await incompleteComments();
          store.replaceComments(run.id, comments);
          store.updateRun(run.id, { commentCount: comments.length });
          announce();
        }
        return;
      }

      const result =
        run.mode === "shadow"
          ? verifyShadow({ runId: run.id, finalMessage })
          : await (async () => {
              // GitHub's list endpoints can lag a just-submitted review, so a
              // bare no_comment gets one retry before it is believed.
              const first = await waitForWork(() => runVerify());
              if (recoverLiveOutput && !first.comments.some(comment => comment.kind === "summary" && comment.attribution === "marker")) {
                try {
                  finalMessage = (await waitForWork(() => bb.sdk.threads.output({ threadId }))).output;
                } catch (error) {
                  watcherSignal?.throwIfAborted();
                  bb.log.warn(`could not read recovered run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
                }
                const incomplete = incompleteReviewReason(finalMessage);
                if (incomplete !== null) {
                  store.updateRun(run.id, { status: "cancelled", detail: incomplete, finishedAt: null });
                  announce();
                  return { status: "cancelled" as const, detail: incomplete, comments: await incompleteComments() };
                }
              }
              if (first.status !== "no_comment") return first;
              await sleep(4_000, watcherSignal);
              const second = await waitForWork(() => runVerify());
              // SlopCop owns the no-findings summary: the agent posts findings
              // as line comments and ends a clean review with the summary as
              // its final message. Nothing on the PR plus that body means the
              // review is clean, so post it — carrying this run's canonical
              // marker, not the agent's transcription of it — and re-verify,
              // because GitHub stays the source of truth for what landed.
              if (second.comments.length > 0) return second;
              const body = summaryToPost({
                rule: run.ruleName,
                runId: run.id,
                sha: run.headSha,
                finalMessage,
              });
              if (body === null) return second;
              await waitForWork(() => gh.request(
                "POST",
                `repos/${run.repo}/issues/${run.prNumber}/comments`,
                { body },
              ));
              bb.log.info(`run ${run.id}: posted the no-findings summary`);
              return waitForWork(() => runVerify());
            })();

      store.replaceComments(run.id, result.comments);
      store.updateRun(run.id, {
        status: result.status,
        detail: result.detail,
        commentCount: result.comments.length,
        finishedAt: null,
      });
      announce();
      bb.log.info(
        `run ${run.id} (${run.ruleName} #${run.prNumber}) -> ${result.status}`,
      );
    } catch (error) {
      watcherSignal?.throwIfAborted();
      const detail = error instanceof Error ? error.message : String(error);
      store.updateRun(run.id, {
        status: "failed",
        detail,
        finishedAt: null,
      });
      announce();
      bb.log.error(
        `verification failed: ${detail}`,
      );
    } finally {
      const selected = store.getRun(run.id);
      if (selected !== null && !isReviewInProgress(selected) && !watcherSignal?.aborted) {
        await finalizeRun(selected);
      }
    }
  }

  function finishRun(
    threadId: string,
    finalMessage: string | null,
    noVerdict: string | null,
    recoverLiveOutput = false,
  ): Promise<void> {
    const inProgress = finalizing.get(threadId);
    if (inProgress !== undefined) return inProgress;
    const promise = finishRunOnce(threadId, finalMessage, noVerdict, recoverLiveOutput).finally(() => {
      finalizing.delete(threadId);
    });
    finalizing.set(threadId, promise);
    return promise;
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (thread.originPluginId === bb.pluginId) releaseTerminatedProvision(thread.id);
    clearFailureCorrelation(thread.id);
    void finishRun(thread.id, lastAssistantText, null).catch(
      (error: unknown) => {
        bb.log.error(
          `verification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  });

  /**
   * `thread.failed`'s `error` is only the latest system/error message, so a
   * provider-level rejection (bad model, auth, cold-start) arrives as null and
   * the run would record a useless "it failed". Recover the real message from
   * the event log, which is where provider/error actually lands.
   */
  async function describeThreadFailure(
    threadId: string,
    reported: string | null,
  ): Promise<string> {
    if (reported !== null && reported.trim().length > 0) return reported;
    try {
      const result = (await waitForWork(() => bb.sdk.threads.events.list({
        threadId,
      } as never))) as { events?: unknown[] };
      const events = Array.isArray(result.events) ? result.events : [];
      for (const raw of [...events].reverse()) {
        const event = raw as { type?: unknown; message?: unknown; error?: unknown };
        const type = typeof event.type === "string" ? event.type : "";
        if (!type.includes("error")) continue;
        const message =
          typeof event.message === "string"
            ? event.message
            : typeof event.error === "string"
              ? event.error
              : JSON.stringify(event).slice(0, 400);
        if (message.length > 0) return `${type}: ${message}`;
      }
    } catch (error) {
      watcherSignal?.throwIfAborted();
      bb.log.warn(
        `could not read failure detail for ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return "the review thread failed (no error detail recorded — open the thread)";
  }

  bb.events.on("thread.failed", async ({ thread, error }) => {
    if (thread.originPluginId === bb.pluginId) releaseTerminatedProvision(thread.id);
    const requestId = failedRequestByThread.get(thread.id);
    if (
      requestId !== undefined &&
      preservedRequestByThread.get(thread.id) === requestId
    ) {
      return;
    }

    const detail = describeThreadFailure(thread.id, error);
    if (requestId !== undefined) {
      const retryQueued = await retryExistsFor(thread.id, requestId);
      if (retryQueued) {
        preservedRequestByThread.set(thread.id, requestId);
        return;
      }
    }

    clearFailureCorrelation(thread.id);
    await finishRun(thread.id, null, await detail);
  });

  function hasReviewInProgress(threadId: string): boolean {
    const run = store.findRunByThread(threadId);
    return run !== null && isReviewInProgress(run);
  }

  /**
   * A review thread can also end without its turn ever failing: someone
   * archives or deletes it mid-review. Neither announces `thread.idle` or
   * `thread.failed`, so without these the run sits at `reviewing` forever.
   *
   * Every archive and delete in BB reaches these handlers, including the
   * archive `finishRun` itself performs, so both answer only for a run that is
   * still open.
   */
  bb.events.on("thread.archived", async ({ thread }) => {
    if (thread.originPluginId === bb.pluginId) releaseTerminatedProvision(thread.id);
    if (!hasReviewInProgress(thread.id)) return;
    await finishRun(thread.id, null, THREAD_ARCHIVED_REASON);
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    if (thread.originPluginId === bb.pluginId) releaseTerminatedProvision(thread.id);
    if (!hasReviewInProgress(thread.id)) return;
    await finishRun(thread.id, null, THREAD_DELETED_REASON);
  });

  async function findDispatchedThreads(run: Run): Promise<string[]> {
    const title = buildThreadTitle({
      runId: run.id,
      rule: { name: run.ruleName, mode: run.mode },
      pullRequest: { number: run.prNumber },
    });
    const matches = new Set<string>();
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 100) {
        const threads = await waitForWork(() => bb.sdk.threads.list({
          originPluginId: bb.pluginId, includeHidden: true, archived, limit: 100, offset,
        }));
        for (const thread of threads) {
          if (thread.originPluginId === bb.pluginId && thread.title === title) matches.add(thread.id);
        }
        if (matches.size > 1 || threads.length < 100) break;
      }
      if (matches.size > 1) break;
    }
    return [...matches];
  }

  /**
   * Those announcements are process-local. A review thread that reached its
   * terminal state while this plugin was not loaded — a BB restart, a plugin
   * reload, a crash — has no event left to fire, and its run stayed at
   * `reviewing` indefinitely with no way to close it. One pass when the
   * watcher starts asks BB what those threads actually became and replays the
   * missed transition through `finishRun`, so a reconciled run is recorded by
   * exactly the code an announced one is.
   */
  async function reconcileUnfinishedRuns(): Promise<void> {
    for (const gateRun of store.listRunningGateRuns()) {
      const detail = "plugin reloaded before gate finished";
      store.updateGateRun(gateRun.id, {
        status: "error",
        output: gateRun.output ? `${gateRun.output}\n${detail}` : detail,
        finishedAt: Date.now(),
      });
      if (gateRun.mode === "live" && gateRun.headSha.length > 0) {
        try {
          const request: GhClient["request"] = (...args) =>
            waitForWork(() => gh.request(...args));
          await waitForWork(() =>
            completeGateCheckRun(request, {
              checkName: gateRun.gateName,
              repo: gateRun.repo,
              sha: gateRun.headSha,
              runId: gateRun.id,
              prNumber: gateRun.prNumber,
              status: "error",
              exitCode: null,
              outputText: detail,
              checkRunId: gateRun.checkRunId,
            }),
          );
        } catch (error) {
          watcherSignal?.throwIfAborted();
          bb.log.warn(
            `could not cancel stranded gate check ${gateRun.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    const reserved = new Set(store.listProvisioning().filter(provision => provision.waiting === null)
      .map(provision => provision.run.id));
    let runningHosts: Map<string, string | null> | undefined;
    for (let run of store.listUnfinishedRuns()) {
      let threadId = run.threadId;
      try {
        const superseded = run.detail?.startsWith(SUPERSEDED_DETAIL) === true;
        if (threadId === null && run.status === "cancelled" &&
            (superseded || (reserved.has(run.id) && run.detail !== "plugin stopped before dispatch completed"))) {
          // The old loader may have been stopped before spawn returned its ID.
          const matches = await findDispatchedThreads(run);
          if (matches.length === 1) {
            threadId = matches[0]!;
            store.updateRun(run.id, { threadId });
            run = { ...run, threadId };
            if (!superseded) await stopReviewThread(threadId);
          } else if (matches.length > 1) {
            bb.log.warn(`could not recover superseded run ${run.id}: multiple matching threads`);
            continue;
          } else {
            store.clearProvisioning(run.id);
          }
        }
        if (threadId === null && (isReviewInProgress(run) ||
            run.detail === "plugin stopped before dispatch completed")) {
          const matches = await findDispatchedThreads(run);
          if (matches.length !== 1) {
            run = { ...run, status: "cancelled", detail: matches.length === 0
              ? "dispatch recovery found no matching thread"
              : "dispatch recovery found multiple matching threads" };
            store.updateRun(run.id, run);
            if (matches.length === 0) store.clearProvisioning(run.id);
            await finalizeRun(run);
            continue;
          }
          threadId = matches[0]!;
          run = { ...run, threadId, status: "reviewing", detail: null };
          store.updateRun(run.id, run);
          announce();
        }
        if (!isReviewInProgress(run)) {
          if (threadId === null) await finalizeRun(run);
          else {
            if (reserved.has(run.id)) {
              const thread = await waitForWork(() => bb.sdk.threads.get({ threadId: threadId! }));
              if (reviewThreadOutcome(thread).kind !== "running") releaseTerminatedProvision(threadId);
            }
            await finishRun(threadId, null, null);
          }
          continue;
        }
        if (threadId === null) continue;
        const recoveredThreadId = threadId;
        const thread = (await waitForWork(() => bb.sdk.threads.get({ threadId: recoveredThreadId }))) as {
          status: string;
          archivedAt?: number | null;
          deletedAt?: number | null;
        };
        const outcome = reviewThreadOutcome(thread);
        if (outcome.kind === "running") {
          inFlight.add(run.id);
          if (thread.status === "starting" && !reserved.has(run.id)) {
            // The first load after upgrading can inherit a start from the
            // old plugin, before a reservation was recorded for its host.
            runningHosts ??= new Map((await waitForWork(() => bb.sdk.threads.listRunning()))
              .map(({ id, hostId }) => [id, hostId]));
            const hostId = runningHosts.get(threadId);
            if (hostId != null) store.setProvisioning(run.id, hostId, null);
          }
          continue;
        }
        releaseTerminatedProvision(threadId);
        bb.log.info(
          `reconciling ${run.id} (${run.ruleName} #${run.prNumber}): its thread is ${thread.status}`,
        );
        if (outcome.kind === "finished") {
          // Clean live summaries remain in the transcript until we post them.
          // finishRun reads live output only after GitHub verification finds no
          // comments to use; an unavailable transcript must not strand the run.
          const finalMessage =
            run.mode === "shadow"
              ? (await waitForWork(() => bb.sdk.threads.output({ threadId: recoveredThreadId }))).output
              : null;
          await finishRun(threadId, finalMessage, null, run.mode === "live");
          continue;
        }
        // The live `thread.failed` path leaves an errored thread alone while a
        // provider retry is queued for it; a restart inside that window must
        // not finalize and archive the review the retry is about to resume.
        if (thread.status === "error" && (await retryQueuedFor(threadId))) {
          bb.log.info(
            `leaving run ${run.id} open: a retry is queued for ${threadId}`,
          );
          continue;
        }
        await finishRun(
          threadId,
          null,
          outcome.reason ?? (await describeThreadFailure(threadId, null)),
        );
      } catch (error) {
        watcherSignal?.throwIfAborted();
        // A run left behind by a thread BB can no longer describe stays open
        // for `bb slopcop runs cancel`; guessing its outcome would be worse.
        bb.log.warn(
          `could not reconcile run ${run.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async function stopReviewThread(threadId: string): Promise<boolean> {
    try {
      await waitForWork(() => bb.sdk.threads.stop({ threadId }));
      return true;
    } catch (error) {
      watcherSignal?.throwIfAborted();
      bb.log.warn(
        `could not stop review thread ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  const CANCELLED_DETAIL = "cancelled by operator";

  /**
   * The operator's way out of a run nothing else can close. The run is
   * assigned its terminal verdict before the thread is stopped: BB can announce
   * `thread.idle` during cleanup, which must not overwrite that verdict.
   */
  async function cancelRun(run: Run): Promise<void> {
    if (run.threadId === null) {
      const waiting = run.status === "waiting";
      const detail = waiting ? WAITING_CANCELLED_DETAIL : CANCELLED_DETAIL;
      store.atomic(() => {
        if (waiting) {
          if (store.isWaitingForProvisioning(run.id)) store.clearProvisioning(run.id);
          else store.clearDeferredReview(run.ruleId, run.repo, run.prNumber);
        }
        store.updateRun(run.id, { status: "cancelled", detail, finishedAt: null });
      });
      announce();
      await finalizeRun({ ...run, status: "cancelled", detail });
      return;
    }
    await finishRun(run.threadId, null, CANCELLED_DETAIL);
    await stopReviewThread(run.threadId);
  }

  // --- shared helpers for rpc + cli ---------------------------------------

  function resolveRule(idOrName: string): Rule {
    const rule = store.getRule(idOrName) ?? store.findRuleByName(idOrName);
    if (rule === null) throw new Error(`no rule named '${idOrName}'`);
    return rule;
  }

  function resolveGate(idOrName: string): GateCheck {
    const gate = store.getGate(idOrName) ?? store.findGateByName(idOrName);
    if (gate === null) throw new Error(`no gate named '${idOrName}'`);
    return gate;
  }

  function saveGate(
    id: string | null,
    input: z.infer<typeof gateInputSchema>,
  ): GateCheck {
    const now = Date.now();
    const existing = id === null ? null : store.getGate(id);
    const clash = store
      .listGates()
      .find(
        (gate) =>
          gate.id !== existing?.id &&
          gate.name.toLowerCase() === input.name.toLowerCase(),
      );
    if (clash !== undefined) {
      throw new Error(`gate '${clash.name}' already uses the name '${input.name}'`);
    }
    const gate: GateCheck = {
      id: existing?.id ?? newId("gate"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...input,
    };
    store.upsertGate(gate);
    return gate;
  }

  async function waitForPullRequestHead(
    repo: string,
    prNumber: number,
    expectedHead?: string,
  ): Promise<PullRequest> {
    if (expectedHead === undefined) {
      return gh.getPullRequest(repo, prNumber);
    }
    const timeout = new AbortController();
    let observedHead = "not observed";
    const timer = setTimeout(() => timeout.abort(new Error(
      `PR #${prNumber} head did not match within 60 seconds: expected ${expectedHead}, observed ${observedHead}. No run created.`,
    )), 60_000);
    const signal = watcherSignal === undefined
      ? timeout.signal
      : AbortSignal.any([watcherSignal, timeout.signal]);
    try {
      while (true) {
        const pullRequest = await waitForAbort(
          () => gh.getPullRequest(repo, prNumber),
          signal,
        );
        observedHead = pullRequest.headRefOid;
        if (observedHead === expectedHead) return pullRequest;
        await sleep(2_000, signal);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkPr(
    rule: Rule,
    prNumber: number,
    expectedHead?: string,
    options: { includeDraft?: boolean } = {},
  ) {
    let pullRequest: PullRequest;
    if (expectedHead === undefined) {
      pullRequest = await gh.getPullRequest(rule.repo, prNumber);
    } else {
      const timeout = new AbortController();
      let observedHead = "not observed";
      const timer = setTimeout(() => timeout.abort(new Error(
        `PR #${prNumber} head did not match within 60 seconds: expected ${expectedHead}, observed ${observedHead}. No run created.`,
      )), 60_000);
      const signal = watcherSignal === undefined
        ? timeout.signal
        : AbortSignal.any([watcherSignal, timeout.signal]);
      try {
        while (true) {
          pullRequest = await waitForAbort(() => gh.getPullRequest(rule.repo, prNumber), signal);
          observedHead = pullRequest.headRefOid;
          if (observedHead === expectedHead) break;
          await sleep(2_000, signal);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    await hydrateFiles([rule], rule.repo, pullRequest);
    const result = evaluateRule(rule, pullRequest, "manual", options);
    return { pullRequest, result };
  }

  function otherRuleNames(run: Run): string[] {
    return store
      .listRules()
      .filter((rule) => rule.repo === run.repo && rule.name !== run.ruleName)
      .map((rule) => rule.name);
  }

  function saveRule(
    id: string | null,
    input: z.infer<typeof ruleInputSchema>,
  ): Rule {
    const now = Date.now();
    const existing = id === null ? null : store.getRule(id);
    // Comments name their rule, so two rules sharing a name could claim each
    // other's reviews.
    const clash = store
      .listRules()
      .find(
        (rule) =>
          rule.id !== existing?.id &&
          markerRuleName(rule.name) === markerRuleName(input.name),
      );
    if (clash !== undefined) {
      throw new Error(`rule '${clash.name}' already uses the name '${input.name}'`);
    }
    const rule: Rule = {
      id: existing?.id ?? newId("rule"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...input,
    };
    store.upsertRule(rule);
    if (isDangerousCombination(rule)) {
      bb.log.warn(
        `rule '${rule.name}' reviews PRs from ANY author with a non-restricted permission mode — untrusted code will run with full access`,
      );
    }
    return rule;
  }

  // --- rpc -----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    listRules: () => ({ rules: store.listRules().map(toRuleOutput) }),

    saveRule: ({ id, rule }) => ({ rule: toRuleOutput(saveRule(id, rule)) }),

    deleteRule: ({ id }) => {
      store.deleteRule(id);
      announce();
      return { ok: true };
    },

    setRuleEnabled: ({ id, enabled }) => {
      const rule = store.getRule(id);
      if (rule === null) throw new Error("rule not found");
      store.upsertRule({ ...rule, enabled, updatedAt: Date.now() });
      announce();
      return { ok: true };
    },

    listRuns: ({ ruleId, limit }) => ({
      runs: store.listRuns({ ruleId: ruleId ?? undefined, limit }),
    }),

    getRunComments: ({ runId }) => ({
      comments: store
        .listComments(runId)
        .map(({ runId: _runId, ...rest }) => rest),
    }),

    checkPr: async ({ ruleId, prNumber }) => {
      const rule = resolveRule(ruleId);
      const { pullRequest, result } = await checkPr(rule, prNumber);
      return {
        matched: result.matched,
        reason: result.matched ? null : result.reason,
        prTitle: pullRequest.title,
        prAuthor: pullRequest.author?.login ?? "",
        association: String(pullRequest.authorAssociation),
      };
    },

    dispatchNow: async ({ ruleId, prNumber, force }) => {
      const rule = resolveRule(ruleId);
      const { pullRequest, result } = await checkPr(rule, prNumber);
      if (!result.matched && force !== true) {
        // Refuse rather than silently reviewing: the caller gets the reason and
        // can re-issue with force once a human has judged it.
        return { runId: null, threadId: null, blockedReason: result.reason };
      }
      const dispatched = await dispatch(rule, pullRequest, {
        forcedReason: result.matched ? null : result.reason,
        force,
      });
      const run = store.getRun(dispatched.runId);
      const rejected = dispatched.threadId === null && run !== null &&
        (run.status === "cancelled" || run.status === "failed" || run.status === "skipped");
      return {
        ...dispatched,
        blockedReason: rejected ? run.detail ?? "review preparation was rejected" : null,
      };
    },

    status: async () => {
      const values = await readSettings();
      return {
        ghAvailable: ghLogin !== null,
        ghLogin,
        watchedRepos: [
          ...new Set([
            ...store
              .listRules()
              .filter((rule) => rule.enabled)
              .map((rule) => rule.repo),
            ...store
              .listGates()
              .filter((gate) => gate.enabled)
              .map((gate) => gate.repo),
          ]),
        ],
        pollSeconds: values.pollSeconds,
        defaultThreadSection: values.defaultThreadSection,
      };
    },
  });

  // --- cli -----------------------------------------------------------------

  bb.cli.register({
    name: "slopcop",
    summary: "Configure automated PR review rules",
    commands: [
      {
        name: "rules",
        summary: "List rules",
        usage: "bb slopcop rules [--json]",
      },
      {
        name: "rules-add",
        summary: "Create a rule",
        usage:
          "bb slopcop rules add --name <n> --repo <owner/repo> --project <name> [--model <m>] [--provider <p>] [--permission <mode>] [--prompt <text>] [--paths <glob,…>] [--base <branch>] [--label <l>] [--skip-label <l>] [--trust write_access|past_contributors|anyone] [--settle-minutes <N>] [--live] [--hidden]",
      },
      {
        name: "rules-edit",
        summary: "Update a rule",
        usage: "bb slopcop rules edit <id|name> [same flags as add]",
      },
      {
        name: "rules-toggle",
        summary: "Toggle or delete a rule",
        usage: "bb slopcop rules enable <id|name>",
      },
      {
        name: "gates",
        summary: "List deterministic command check gates",
        usage: "bb slopcop gates [--json]",
      },
      {
        name: "gates-add",
        summary: "Create or update a deterministic command check gate",
        usage:
          "bb slopcop gates add --name <check-name> --repo <owner/repo> --repo-dir <path> --command <cmd> [--timeout <sec>] [--trust write_access|past_contributors|anyone] [--live|--shadow]",
      },
      {
        name: "gates-run",
        summary: "Run a command check gate against a PR now",
        usage:
          "bb slopcop gates run <id|name> <pr-number> [--force] [--include-draft] [--head <sha>] [--json]",
      },
      {
        name: "gates-runs",
        summary: "Recent command check gate runs",
        usage: "bb slopcop gates runs [--gate <id|name>] [--limit N] [--json]",
      },
      {
        name: "runs",
        summary: "Recent review runs",
        usage: "bb slopcop runs [--rule <id|name>] [--limit N] [--json]",
      },
      {
        name: "runs-cancel",
        summary: "Cancel an unfinished run and stop its thread if it started",
        usage: "bb slopcop runs cancel <run-id>",
      },
      {
        name: "check",
        summary: "Dry-run a rule against a PR and explain the outcome",
        usage: "bb slopcop check <id|name> <pr-number> [--include-draft]",
      },
      {
        name: "dispatch",
        summary: "Run a rule against a PR now",
        usage: "bb slopcop dispatch <id|name> <pr-number> [--force] [--include-draft] [--head <sha>]",
      },
      {
        name: "verify",
        summary:
          "Re-check a finished live run against GitHub and complete its check",
        usage: "bb slopcop verify [run-id] [--json]",
      },
      {
        name: "show",
        summary: "Show a run and the review body it produced",
        usage: "bb slopcop show [run-id] [--json]",
      },
      {
        name: "status",
        summary: "Show gh auth and watched repos",
        usage: "bb slopcop status",
      },
    ],
    async run(argv) {
      const flag = (name: string): string | undefined => {
        const index = argv.indexOf(`--${name}`);
        return index >= 0 ? argv[index + 1] : undefined;
      };
      const has = (name: string) => argv.includes(`--${name}`);
      const json = has("json");
      const ok = (stdout: string) => ({ exitCode: 0, stdout });
      const fail = (stderr: string) => ({ exitCode: 1, stderr });

      try {
        const [command, rawSub] = argv;
        // A leading flag is not a subcommand: `rules --json` must list, not
        // fall through to the usage error.
        const sub =
          rawSub !== undefined && rawSub.startsWith("--") ? undefined : rawSub;

        if (command === "status") {
          const values = await readSettings();
          const repos = [
            ...new Set([
              ...store
                .listRules()
                .filter((rule) => rule.enabled)
                .map((rule) => rule.repo),
              ...store
                .listGates()
                .filter((gate) => gate.enabled)
                .map((gate) => gate.repo),
            ]),
          ];
          const payload = {
            ghLogin,
            ghAvailable: ghLogin !== null,
            watchedRepos: repos,
            pollSeconds: values.pollSeconds,
            defaultThreadSection: values.defaultThreadSection,
            rules: store.listRules().length,
            gates: store.listGates().length,
          };
          return ok(
            json
              ? JSON.stringify(payload, null, 2)
              : `gh: ${ghLogin ?? "NOT AUTHENTICATED"}\nwatching: ${
                  repos.join(", ") || "(no enabled rules or gates)"
                }\npolling every ${values.pollSeconds}s\ndefault section: ${
                  values.defaultThreadSection || "(unsectioned)"
                }\n${payload.rules} rule(s), ${payload.gates} gate(s)`,
          );
        }

        if (command === "rules" && (sub === undefined || sub === "list")) {
          const rules = store.listRules();
          if (json) return ok(JSON.stringify(rules.map(toRuleOutput), null, 2));
          if (rules.length === 0) return ok("No rules yet.");
          return ok(
            rules
              .map((rule) => {
                const flags = [
                  rule.enabled ? "enabled" : "disabled",
                  rule.mode,
                  ...(rule.visibility === "hidden" ? ["hidden threads"] : []),
                  describeTrust(rule.authorTrust),
                  `settle: ${rule.settleMinutes} min`,
                ];
                return `${rule.name}  ${rule.repo}  [${flags.join(" · ")}]  ${rule.id}`;
              })
              .join("\n"),
          );
        }

        if (command === "rules" && (sub === "add" || sub === "edit")) {
          const existing = sub === "edit" ? resolveRule(argv[2] ?? "") : null;
          const list = (name: string) =>
            flag(name)
              ?.split(",")
              .map((value) => value.trim())
              .filter((value) => value.length > 0);

          const conditions = existing?.conditions.slice() ?? [];
          const paths = list("paths");
          if (paths !== undefined) {
            const index = conditions.findIndex((c) => c.kind === "paths");
            const next = { kind: "paths" as const, globs: paths };
            if (index >= 0) conditions[index] = next;
            else conditions.push(next);
          }
          const base = flag("base");
          if (base !== undefined) {
            const index = conditions.findIndex((c) => c.kind === "base_branch");
            const next = { kind: "base_branch" as const, globs: [base] };
            if (index >= 0) conditions[index] = next;
            else conditions.push(next);
          }
          const label = list("label");
          if (label !== undefined) {
            conditions.push({ kind: "has_label", labels: label });
          }
          const skipLabel = list("skip-label");
          if (skipLabel !== undefined) {
            conditions.push({ kind: "missing_label", labels: skipLabel });
          }

          const settleMinutes = flag("settle-minutes");
          if (has("settle-minutes") && (settleMinutes === undefined || !/^\d+$/.test(settleMinutes))) {
            return fail("--settle-minutes requires a whole number of minutes (0 or more)");
          }
          const parsed = ruleInputSchema.parse({
            name: flag("name") ?? existing?.name,
            repo: flag("repo") ?? existing?.repo,
            enabled: has("disabled") ? false : (existing?.enabled ?? true),
            mode: has("live")
              ? "live"
              : has("shadow")
                ? "shadow"
                : (existing?.mode ?? "shadow"),
            triggers: list("trigger") ??
              existing?.triggers ?? ["ready_for_review"],
            conditions,
            authorTrust:
              flag("trust") ?? existing?.authorTrust ?? "write_access",
            prompt: flag("prompt") ?? existing?.prompt ?? "",
            request: existing?.request ?? null,
            dedupe: flag("dedupe") ?? existing?.dedupe ?? "once_per_pr",
            settleMinutes: settleMinutes === undefined ? existing?.settleMinutes : Number(settleMinutes),
            reviewStrategy:
              flag("strategy") ?? existing?.reviewStrategy ?? "update",
            visibility: has("hidden")
              ? "hidden"
              : has("visible")
                ? "visible"
                : (existing?.visibility ?? "visible"),
          });

          // Agent configuration from the CLI, so another BB agent can create a
          // dispatchable rule without opening the panel.
          const projectFlag = flag("project");
          let request = existing?.request ?? null;
          if (projectFlag !== undefined || flag("model") !== undefined) {
            const projects = await bb.sdk.projects.list();
            const project =
              projectFlag === undefined
                ? null
                : (projects.find((entry) => entry.id === projectFlag) ??
                  projects.find((entry) => entry.name === projectFlag) ??
                  null);
            if (projectFlag !== undefined && project === null) {
              return fail(
                `no project named '${projectFlag}'. Available: ${projects
                  .map((entry) => entry.name)
                  .join(", ")}`,
              );
            }
            const previous = (request ?? {}) as Record<string, unknown>;
            request = {
              ...previous,
              projectId: project?.id ?? (previous.projectId as string),
              providerId: flag("provider") ?? previous.providerId ?? "claude-code",
              model: flag("model") ?? previous.model ?? "claude-opus-5-5[1m]",
              reasoningLevel:
                flag("reasoning") ?? previous.reasoningLevel ?? "high",
              // BB's permission modes are full | auto | accept-edits — there is
              // no read-only tier, so `auto` is the narrowest sensible default.
              permissionMode:
                flag("permission") ?? previous.permissionMode ?? "auto",
              executionInputSources: previous.executionInputSources ?? {
                providerId: "explicit",
                model: "explicit",
                reasoningLevel: "explicit",
                permissionMode: "explicit",
              },
              environment: previous.environment ?? { type: "project-default" },
            } as never;
          }
          parsed.request = request as never;

          const rule = saveRule(existing?.id ?? null, parsed);
          announce();
          const warning = isDangerousCombination(rule)
            ? "\nWARNING: this rule reviews PRs from ANY author without a restricted permission mode."
            : "";
          const unconfigured =
            rule.request === null
              ? "\nNote: no agent configured yet — open the rule in the SlopCop panel and save it once before it can dispatch."
              : "";
          return ok(
            json
              ? JSON.stringify(toRuleOutput(rule), null, 2)
              : `${sub === "add" ? "Created" : "Updated"} '${rule.name}' (${rule.id}) in ${rule.mode} mode.${unconfigured}${warning}`,
          );
        }

        if (
          command === "rules" &&
          (sub === "enable" || sub === "disable" || sub === "rm")
        ) {
          const rule = resolveRule(argv[2] ?? "");
          if (sub === "rm") {
            store.deleteRule(rule.id);
            announce();
            return ok(`Deleted '${rule.name}'.`);
          }
          store.upsertRule({
            ...rule,
            enabled: sub === "enable",
            updatedAt: Date.now(),
          });
          announce();
          return ok(
            `${sub === "enable" ? "Enabled" : "Disabled"} '${rule.name}'.`,
          );
        }

        if (command === "runs" && sub === "cancel") {
          const runId = argv[2] ?? "";
          if (runId === "") return fail("Usage: bb slopcop runs cancel <run-id>");
          const run = store.getRun(runId);
          if (run === null) return fail(`no such run '${runId}'`);
          if (run.status !== "waiting" && !isReviewInProgress(run)) {
            return fail(
              `run ${run.id} already finished as ${run.status} — nothing to cancel`,
            );
          }
          await cancelRun(run);
          const cancelled = store.getRun(run.id);
          if (json) return ok(JSON.stringify(cancelled, null, 2));
          // A verification already under way for this thread finishes the run
          // on its own verdict; say which one won rather than claiming this.
          if (cancelled !== null && cancelled.status !== "cancelled") {
            return ok(
              `Run ${run.id} (${run.ruleName} #${run.prNumber}) finished as ${cancelled.status} before the cancellation landed.`,
            );
          }
          return ok(
            `Cancelled ${run.id} (${run.ruleName} #${run.prNumber}) — ${cancelled?.detail ?? CANCELLED_DETAIL}.`,
          );
        }

        if (command === "runs") {
          const ruleFlag = flag("rule");
          const rule = ruleFlag === undefined ? null : resolveRule(ruleFlag);
          const limitFlag = Number.parseInt(flag("limit") ?? "20", 10);
          const runs = store.listRuns({
            ruleId: rule?.id,
            limit: Number.isFinite(limitFlag) ? limitFlag : 20,
          });
          if (json) return ok(JSON.stringify(runs, null, 2));
          if (runs.length === 0) return ok("No runs yet.");
          return ok(
            runs
              .map(
                (run) =>
                  `${run.status.padEnd(24)} ${run.ruleName}  #${run.prNumber} ${run.prTitle}` +
                  (run.commentCount > 0
                    ? `  (${run.commentCount} comment(s))`
                    : "") +
                  (run.detail === null ? "" : `\n    ${run.detail}`),
              )
              .join("\n"),
          );
        }

        if (command === "verify") {
          const target = argv[1] ?? "";
          const run =
            (target === "" ? null : store.getRun(target)) ??
            store.listRuns({ limit: 1 })[0];
          if (run === undefined || run === null) return fail("no such run");
          const blocked = liveVerifyBlockReason(run);
          if (blocked !== null) return fail(blocked);
          const result = await verifyLive({
            gh,
            repo: run.repo,
            prNumber: run.prNumber,
            ruleName: run.ruleName,
            otherRuleNames: otherRuleNames(run),
            isRecordedRun: (id) => store.getRun(id) !== null,
            runId: run.id,
            startedAt: run.startedAt,
            authenticatedLogin: ghLogin,
          });
          store.replaceComments(run.id, result.comments);
          store.updateRun(run.id, {
            status: result.status,
            detail: result.detail,
            commentCount: result.comments.length,
          });
          announce();
          await reportCheck("complete", run, {
            status: result.status,
            commentCount: result.comments.length,
            detail: result.detail,
          });
          return ok(
            json
              ? JSON.stringify(result, null, 2)
              : `${run.id}: ${result.status} (${result.comments.length} comment(s))${
                  result.detail === null ? "" : `\n${result.detail}`
                }`,
          );
        }

        if (command === "show") {
          const runId = argv[1] ?? "";
          const run = store.getRun(runId) ?? store.listRuns({ limit: 1 })[0];
          if (run === undefined || run === null) return fail("no such run");
          const comments = store.listComments(run.id);
          if (json) return ok(JSON.stringify({ run, comments }, null, 2));
          const header =
            `${run.ruleName} — ${run.repo}#${run.prNumber} ${run.prTitle}\n` +
            `status: ${run.status}${run.mode === "shadow" ? " (shadow — nothing was posted)" : ""}` +
            (run.detail === null ? "" : `\ndetail: ${run.detail}`);
          const bodies = comments
            .map(
              (comment) =>
                `\n--- ${comment.kind}${
                  comment.path === null ? "" : ` ${comment.path}:${comment.line ?? ""}`
                } [${comment.attribution}]${comment.url === null ? "" : ` ${comment.url}`} ---\n${comment.bodyExcerpt}`,
            )
            .join("\n");
          return ok(`${header}\n${bodies || "\n(no comments recorded)"}`);
        }

        if (command === "check" || command === "dispatch") {
          const rule = resolveRule(argv[1] ?? "");
          const prNumber = Number.parseInt(argv[2] ?? "", 10);
          if (!Number.isFinite(prNumber)) return fail("expected a PR number");
          const includeDraft = has("include-draft");

          if (command === "check") {
            const { pullRequest, result } = await checkPr(rule, prNumber, undefined, { includeDraft });
            const pending = store.getDeferredReview(rule.id, rule.repo, prNumber)?.waiting;
            const waiting = pending?.headSha === pullRequest.headRefOid ? pending : null;
            const settleUntil = waiting === null ? null : waiting.startedAt + rule.settleMinutes * 60_000;
            const superseded = store.latestSupersededRun(rule.id, rule.repo, prNumber);
            const payload = {
              matched: result.matched,
              reason: result.matched ? null : result.reason,
              settleUntil,
              superseded: superseded === null ? null : {
                headSha: superseded.headSha, status: superseded.status, reason: superseded.detail,
              },
              pr: {
                number: pullRequest.number,
                title: pullRequest.title,
                author: pullRequest.author?.login ?? "",
                association: pullRequest.authorAssociation,
              },
            };
            const match = result.matched
              ? `MATCH — '${rule.name}' would review #${prNumber} (${pullRequest.title}) in ${rule.mode} mode.`
              : `NO MATCH — ${result.reason}`;
            const details = [
              waiting === null || settleUntil === null ? null : Date.now() < settleUntil
                ? `Head ${waiting.headSha} is waiting to settle (a ${rule.settleMinutes}-minute window).`
                : `Head ${waiting.headSha} has settled and is waiting for dispatch.`,
              superseded === null ? null
                : `Head ${superseded.headSha} was ${superseded.status}: ${superseded.detail}.`,
            ];
            return ok(
              json
                ? JSON.stringify(payload, null, 2)
                : [match, ...details.filter(detail => detail !== null)].join("\n"),
            );
          }

          const expectedHead = flag("head");
          if (has("head") && (!expectedHead || expectedHead.startsWith("--"))) {
            return fail("--head requires the exact pushed commit SHA");
          }
          const { pullRequest, result } = await checkPr(rule, prNumber, expectedHead, { includeDraft });
          if (!result.matched && !has("force")) {
            return fail(
              `'${rule.name}' does not match PR #${prNumber}: ${result.reason}\nRe-run with --force to dispatch anyway.`,
            );
          }
          const dispatched = await dispatch(rule, pullRequest, {
            forcedReason: result.matched ? null : result.reason,
            force: has("force"),
            includeDraft,
          });
          const run = store.getRun(dispatched.runId);
          const skippedReason = run?.status === "skipped" ? run.detail : null;
          return ok(
            json
              ? JSON.stringify({ ...dispatched, headSha: pullRequest.headRefOid, skippedReason }, null, 2)
              : skippedReason !== null
                ? `Skipped ${rule.name} for #${prNumber}. head=${pullRequest.headRefOid} run=${dispatched.runId}: ${skippedReason}`
                : run?.status === "waiting"
                  ? `Queued ${rule.name} for #${prNumber}. head=${pullRequest.headRefOid} run=${dispatched.runId}: ${run.detail}`
                : `Dispatched ${rule.name} for #${prNumber} (${rule.mode} mode). head=${pullRequest.headRefOid} run=${dispatched.runId} thread=${dispatched.threadId ?? "none"}`,
          );
        }

        if (command === "gates" && (sub === undefined || sub === "list")) {
          const gates = store.listGates();
          if (json) return ok(JSON.stringify(gates, null, 2));
          if (gates.length === 0) return ok("No gates yet.");
          return ok(
            gates
              .map((gate) => {
                const flags = [
                  gate.enabled ? "enabled" : "disabled",
                  gate.mode,
                  describeTrust(gate.authorTrust),
                  `${gate.timeoutSeconds}s`,
                ];
                return `${gate.name}  ${gate.repo}  [${flags.join(" · ")}]  ${gate.id}\n  dir: ${gate.repoDir}\n  cmd: ${gate.command}`;
              })
              .join("\n"),
          );
        }

        if (command === "gates" && (sub === "add" || sub === "edit")) {
          const existing = sub === "edit" ? resolveGate(argv[2] ?? "") : null;
          const timeoutRaw = flag("timeout");
          const timeoutParsed =
            timeoutRaw === undefined
              ? (existing?.timeoutSeconds ?? 60)
              : Number.parseInt(timeoutRaw, 10);
          const parsed = gateInputSchema.parse({
            name: flag("name") ?? existing?.name,
            repo: flag("repo") ?? existing?.repo,
            enabled: has("disabled") ? false : (existing?.enabled ?? true),
            mode: has("live")
              ? "live"
              : has("shadow")
                ? "shadow"
                : (existing?.mode ?? "shadow"),
            authorTrust:
              flag("trust") ?? existing?.authorTrust ?? "write_access",
            repoDir: flag("repo-dir") ?? existing?.repoDir,
            command: flag("command") ?? existing?.command,
            timeoutSeconds: timeoutParsed,
          });
          const gate = saveGate(existing?.id ?? null, parsed);
          announce();
          return ok(
            json
              ? JSON.stringify(gate, null, 2)
              : `${sub === "add" ? "Created" : "Updated"} gate '${gate.name}' (${gate.id}) in ${gate.mode} mode.`,
          );
        }

        if (
          command === "gates" &&
          (sub === "enable" || sub === "disable" || sub === "rm")
        ) {
          const gate = resolveGate(argv[2] ?? "");
          if (sub === "rm") {
            store.deleteGate(gate.id);
            announce();
            return ok(`Deleted gate '${gate.name}'.`);
          }
          store.upsertGate({
            ...gate,
            enabled: sub === "enable",
            updatedAt: Date.now(),
          });
          announce();
          return ok(
            `${sub === "enable" ? "Enabled" : "Disabled"} gate '${gate.name}'.`,
          );
        }

        if (command === "gates" && sub === "runs") {
          const gateFlag = flag("gate");
          const gate = gateFlag === undefined ? null : resolveGate(gateFlag);
          const limitFlag = Number.parseInt(flag("limit") ?? "20", 10);
          const runs = store.listGateRuns({
            gateId: gate?.id,
            limit: Number.isFinite(limitFlag) ? limitFlag : 20,
          });
          if (json) return ok(JSON.stringify(runs, null, 2));
          if (runs.length === 0) return ok("No gate runs yet.");
          return ok(
            runs
              .map(
                (run) =>
                  `${run.status.padEnd(10)} ${run.gateName}  #${run.prNumber} ${run.headSha.slice(0, 12)}` +
                  (run.exitCode === null ? "" : `  (exit ${run.exitCode})`) +
                  (run.output.trim().length === 0
                    ? ""
                    : `\n    ${run.output.trim().split("\n")[0]}`),
              )
              .join("\n"),
          );
        }

        if (command === "gates" && sub === "run") {
          const gate = resolveGate(argv[2] ?? "");
          const prNumber = Number.parseInt(argv[3] ?? "", 10);
          if (!Number.isFinite(prNumber)) return fail("expected a PR number");
          const expectedHead = flag("head");
          if (has("head") && (!expectedHead || expectedHead.startsWith("--"))) {
            return fail("--head requires the exact pushed commit SHA");
          }
          const includeDraft = has("include-draft");
          const force = has("force");
          gh = createGhClient((await readSettings()).ghPath);
          const pullRequest = await waitForPullRequestHead(
            gate.repo,
            prNumber,
            expectedHead,
          );
          const match = evaluateGate(gate, pullRequest, { includeDraft });
          if (!match.matched && !force) {
            return fail(
              `gate '${gate.name}' does not match PR #${prNumber}: ${match.reason}`,
            );
          }
          const outcome = await dispatchGate(
            force && !gate.enabled ? { ...gate, enabled: true } : gate,
            pullRequest,
            { force, includeDraft: includeDraft || force },
          );
          if (json) {
            return ok(
              JSON.stringify(
                { ...outcome, headSha: pullRequest.headRefOid },
                null,
                2,
              ),
            );
          }
          if (outcome.run === null) {
            return fail(outcome.blockedReason ?? "gate did not run");
          }
          return ok(
            `Gate ${gate.name} on #${prNumber} (${gate.mode}): ${outcome.run.status}` +
              ` head=${pullRequest.headRefOid} run=${outcome.run.id}` +
              (outcome.run.output.trim().length === 0
                ? ""
                : `\n${outcome.run.output.trim()}`),
          );
        }

        return fail(
          "Usage: bb slopcop <rules|gates|runs|show|verify|check|dispatch|status> …\nRun `bb slopcop rules` or `bb slopcop gates` to list entries.",
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  // --- watcher -------------------------------------------------------------

  bb.background.service("watcher", {
    async start(signal) {
      watcherSignal = signal;
      try {
        const initial = await readSettings();
        gh = createGhClient(initial.ghPath);
        ghLogin = await waitForWork(() => gh.authenticatedLogin());
        if (ghLogin === null) {
          bb.status.needsConfiguration(
            "`gh` is not authenticated on this machine. Run `gh auth login`, then reload the plugin.",
          );
          return;
        }
        bb.log.info(`gh authenticated as ${ghLogin}`);
        recoveringReviews = reconcileUnfinishedRuns();
        try {
          await recoveringReviews;
        } finally {
          recoveringReviews = undefined;
        }

        while (!signal.aborted) {
          const values = await readSettings();
          try {
            provisionDrainRequested = false;
            await drainProvisioningQueue(values);
            await poll(values.maxConcurrent);
          } catch (error) {
            signal.throwIfAborted();
            bb.log.error(
              `poll pass failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await waitForNextPoll(values.pollSeconds);
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
