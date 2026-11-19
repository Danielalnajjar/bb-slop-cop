// Persistence. Migrations are append-only by statement index — never reorder
// or edit a shipped statement, only push new ones.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  GateCheck,
  GateRun,
  GateRunStatus,
  ReviewScope,
  Rule,
  Run,
  RunComment,
  RunStatus,
  Condition,
  Trigger,
  ThreadRequest,
} from "./types";

// The plugin SDK's database handle is better-sqlite3; typed structurally so
// this module stays unit-testable without importing the driver.
export interface Database {
  transaction<T>(work: () => T): () => T;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS rules (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     repo TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     mode TEXT NOT NULL DEFAULT 'shadow',
     triggers TEXT NOT NULL,
     conditions TEXT NOT NULL,
     author_trust TEXT NOT NULL DEFAULT 'write_access',
     prompt TEXT NOT NULL DEFAULT '',
     request TEXT,
     dedupe TEXT NOT NULL DEFAULT 'once_per_pr',
     review_strategy TEXT NOT NULL DEFAULT 'update',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     rule_id TEXT NOT NULL,
     rule_name TEXT NOT NULL,
     repo TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     pr_title TEXT NOT NULL DEFAULT '',
     pr_author TEXT NOT NULL DEFAULT '',
     head_sha TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     mode TEXT NOT NULL DEFAULT 'shadow',
     detail TEXT,
     thread_id TEXT,
     comment_count INTEGER NOT NULL DEFAULT 0,
     started_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS run_comments (
     run_id TEXT NOT NULL,
     github_id TEXT,
     kind TEXT NOT NULL,
     path TEXT,
     line INTEGER,
     url TEXT,
     body_excerpt TEXT NOT NULL DEFAULT '',
     attribution TEXT NOT NULL DEFAULT 'marker'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_rule ON runs(rule_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_pr ON runs(repo, pr_number)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_run ON run_comments(run_id)`,
  // Seen-PR cursor: distinguishes "newly ready" from "was already ready when
  // the rule was created", so enabling a rule does not review the backlog.
  `CREATE TABLE IF NOT EXISTS seen_prs (
     repo TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     head_sha TEXT NOT NULL,
     was_draft INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (repo, pr_number)
   )`,
  // APPEND ONLY, and never renumber. Migrations are keyed by statement INDEX,
  // so an inserted statement inherits an already-applied index and is silently
  // skipped — which happened twice while adding `visibility` below. Both slots
  // it briefly occupied are now burned on existing installs, so it lives at the
  // end and everything before it must stay put.
  `CREATE INDEX IF NOT EXISTS idx_rules_repo ON rules(repo)`,
  `ALTER TABLE rules ADD COLUMN visibility TEXT NOT NULL DEFAULT 'visible'`,
  // Per-repo backlog watermark. Without this, "first sighting is not a trigger"
  // cannot distinguish a PR that predates watching from one just opened.
  `CREATE TABLE IF NOT EXISTS watched_repos (
     repo TEXT PRIMARY KEY,
     bootstrapped_at INTEGER NOT NULL
   )`,
  // Capacity deferrals belong to a rule, not the shared PR observation cursor.
  `CREATE TABLE IF NOT EXISTS deferred_reviews (
     rule_id TEXT NOT NULL,
     repo TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     trigger TEXT NOT NULL,
     PRIMARY KEY (rule_id, repo, pr_number)
   )`,
  `CREATE TABLE IF NOT EXISTS gate_checks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     repo TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     mode TEXT NOT NULL DEFAULT 'shadow',
     author_trust TEXT NOT NULL DEFAULT 'write_access',
     repo_dir TEXT NOT NULL,
     command TEXT NOT NULL,
     timeout_seconds INTEGER NOT NULL DEFAULT 60,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS gate_runs (
     id TEXT PRIMARY KEY,
     gate_id TEXT NOT NULL,
     gate_name TEXT NOT NULL,
     repo TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     head_sha TEXT NOT NULL,
     base_sha TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     mode TEXT NOT NULL DEFAULT 'shadow',
     exit_code INTEGER,
     output TEXT NOT NULL DEFAULT '',
     check_run_id INTEGER,
     attempts INTEGER NOT NULL DEFAULT 1,
     started_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gate_runs_lookup ON gate_runs(gate_id, repo, head_sha, started_at DESC)`,
  `ALTER TABLE rules ADD COLUMN settle_minutes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE deferred_reviews ADD COLUMN waiting_run_id TEXT`,
  `ALTER TABLE deferred_reviews ADD COLUMN first_observed_at INTEGER`,
  `ALTER TABLE runs ADD COLUMN check_run_id INTEGER`,
  `ALTER TABLE deferred_reviews ADD COLUMN head_sha TEXT`,
  `CREATE TABLE review_provisioning (
     run_id TEXT PRIMARY KEY REFERENCES runs(id),
     host_id TEXT NOT NULL,
     waiting_options TEXT
   )`,
  `CREATE INDEX idx_review_provisioning_host ON review_provisioning(host_id)`,
  `CREATE INDEX idx_runs_thread ON runs(thread_id)`,
  `ALTER TABLE runs ADD COLUMN review_scope TEXT NOT NULL DEFAULT 'full'`,
  `ALTER TABLE runs ADD COLUMN was_draft INTEGER NOT NULL DEFAULT 0`,
];

type Row = Record<string, unknown>;
const REVIEW_DEDUPE_WINNER = `(
  status NOT IN ('waiting', 'skipped', 'cancelled', 'failed')
  OR (status = 'waiting' AND head_sha = ? AND EXISTS (
    SELECT 1 FROM review_provisioning WHERE run_id = runs.id
  ))
)`;

export interface ProvisionDispatchOptions {
  trigger: Trigger;
  force?: boolean;
  forcedReason?: string | null;
  includeDraft?: boolean;
  reviewInputs?: {
    baseRefOid: string;
    previousVerifiedHead: string | null;
    incremental?: {
      tree: string;
      patch: Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["attachments"]["upload"]>>;
      projectId: string;
    };
  };
}

export const SUPERSEDED_DETAIL = "superseded by newer head ";
export const WAITING_CANCELLED_DETAIL = "cancelled by operator while waiting";
// Shadow verification can also return no_comment and degraded comment statuses.
const VERIFIED_REVIEW = `(mode = 'live' AND status IN ('commented', 'commented_partial',
  'commented_unmarked', 'commented_unattributed', 'no_comment'))`;
const FULL_NON_DRAFT_REVIEW = `(review_scope = 'full' AND was_draft = 0)`;
const COVERED_PUSH = `(${VERIFIED_REVIEW} OR (mode = ? AND status = 'no_pr_changes'))`;

function text(row: Row, key: string, fallback = ""): string {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
}
function num(row: Row, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === "number" ? value : fallback;
}
function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToRule(row: Row): Rule {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    repo: text(row, "repo"),
    enabled: num(row, "enabled") === 1,
    mode: text(row, "mode", "shadow") === "live" ? "live" : "shadow",
    triggers: parseJson<Trigger[]>(row.triggers, ["ready_for_review"]),
    conditions: parseJson<Condition[]>(row.conditions, []),
    authorTrust: text(row, "author_trust", "write_access") as Rule["authorTrust"],
    prompt: text(row, "prompt"),
    request: parseJson<ThreadRequest | null>(row.request, null),
    dedupe: text(row, "dedupe", "once_per_pr") as Rule["dedupe"],
    settleMinutes: num(row, "settle_minutes"),
    reviewStrategy: text(
      row,
      "review_strategy",
      "update",
    ) as Rule["reviewStrategy"],
    visibility: text(row, "visibility", "visible") === "hidden"
      ? "hidden"
      : "visible",
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export function rowToRun(row: Row): Run {
  return {
    id: text(row, "id"),
    ruleId: text(row, "rule_id"),
    ruleName: text(row, "rule_name"),
    repo: text(row, "repo"),
    prNumber: num(row, "pr_number"),
    prTitle: text(row, "pr_title"),
    prAuthor: text(row, "pr_author"),
    headSha: text(row, "head_sha"),
    status: text(row, "status", "dispatched") as RunStatus,
    mode: text(row, "mode", "shadow") === "live" ? "live" : "shadow",
    detail: typeof row.detail === "string" ? row.detail : null,
    threadId: typeof row.thread_id === "string" ? row.thread_id : null,
    commentCount: num(row, "comment_count"),
    startedAt: num(row, "started_at"),
    finishedAt: typeof row.finished_at === "number" ? row.finished_at : null,
  };
}

export function rowToGateCheck(row: Row): GateCheck {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    repo: text(row, "repo"),
    enabled: num(row, "enabled") === 1,
    mode: text(row, "mode", "shadow") === "live" ? "live" : "shadow",
    authorTrust: text(row, "author_trust", "write_access") as GateCheck["authorTrust"],
    repoDir: text(row, "repo_dir"),
    command: text(row, "command"),
    timeoutSeconds: num(row, "timeout_seconds", 60),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export function rowToGateRun(row: Row): GateRun {
  return {
    id: text(row, "id"),
    gateId: text(row, "gate_id"),
    gateName: text(row, "gate_name"),
    repo: text(row, "repo"),
    prNumber: num(row, "pr_number"),
    headSha: text(row, "head_sha"),
    baseSha: text(row, "base_sha"),
    status: text(row, "status", "running") as GateRunStatus,
    mode: text(row, "mode", "shadow") === "live" ? "live" : "shadow",
    exitCode: typeof row.exit_code === "number" ? row.exit_code : null,
    output: text(row, "output"),
    checkRunId: typeof row.check_run_id === "number" ? row.check_run_id : null,
    attempts: num(row, "attempts", 1),
    startedAt: num(row, "started_at"),
    finishedAt: typeof row.finished_at === "number" ? row.finished_at : null,
  };
}

export function createStore(db: Database) {
  function discardWaiting(where: string, params: unknown[], detail: string): void {
    db.prepare(
      `UPDATE runs SET status = 'skipped', detail = ?
       WHERE status = 'waiting' AND id IN (
         SELECT waiting_run_id FROM deferred_reviews WHERE ${where}
       )`,
    ).run(detail, ...params);
    db.prepare(`DELETE FROM deferred_reviews WHERE ${where}`).run(...params);
  }

  return {
    canProvision(hostId: string, limit: number): boolean {
      // A waiting review owns no slot; the drain tries waiters in arrival order.
      const row = db.prepare(
        `SELECT count(*) AS occupied FROM review_provisioning
         WHERE host_id = ? AND waiting_options IS NULL`,
      ).get(hostId) as Row;
      return num(row, "occupied") < limit;
    },

    setProvisioning(runId: string, hostId: string, waiting: ProvisionDispatchOptions | null): void {
      db.prepare(
        `INSERT INTO review_provisioning (run_id, host_id, waiting_options) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET host_id = excluded.host_id, waiting_options = excluded.waiting_options`,
      ).run(runId, hostId, waiting === null ? null : JSON.stringify(waiting));
    },

    clearProvisioning(runId: string): boolean {
      const result = db.prepare(`DELETE FROM review_provisioning WHERE run_id = ?`).run(runId) as { changes: number };
      return result.changes > 0;
    },

    findProvisioningRun(threadId: string): string | null {
      const row = db.prepare(
        `SELECT runs.id FROM runs JOIN review_provisioning AS provisions ON provisions.run_id = runs.id
         WHERE runs.thread_id = ? AND provisions.waiting_options IS NULL`,
      ).get(threadId) as Row | undefined;
      return row === undefined ? null : text(row, "id");
    },

    listProvisioning(): { run: Run; hostId: string; waiting: ProvisionDispatchOptions | null }[] {
      return (db.prepare(
        `SELECT runs.*, provisions.host_id, provisions.waiting_options
         FROM review_provisioning AS provisions JOIN runs ON runs.id = provisions.run_id
         ORDER BY provisions.rowid`,
      ).all() as Row[]).map(row => ({
        run: rowToRun(row),
        hostId: text(row, "host_id"),
        waiting: parseJson<ProvisionDispatchOptions | null>(row.waiting_options, null),
      }));
    },

    isWaitingForProvisioning(runId: string): boolean {
      return db.prepare(
        `SELECT 1 FROM review_provisioning WHERE run_id = ? AND waiting_options IS NOT NULL`,
      ).get(runId) !== undefined;
    },

    atomic<T>(work: () => T): T {
      return db.transaction(work)();
    },

    listRules(): Rule[] {
      return (db.prepare(`SELECT * FROM rules ORDER BY name`).all() as Row[]).map(
        rowToRule,
      );
    },

    getRule(id: string): Rule | null {
      const row = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as
        | Row
        | undefined;
      return row === undefined ? null : rowToRule(row);
    },

    findRuleByName(name: string): Rule | null {
      const row = db.prepare(`SELECT * FROM rules WHERE name = ?`).get(name) as
        | Row
        | undefined;
      return row === undefined ? null : rowToRule(row);
    },

    upsertRule(rule: Rule): void {
      db.prepare(
        `INSERT INTO rules (id, name, repo, enabled, mode, triggers, conditions,
           author_trust, prompt, request, dedupe, review_strategy, visibility,
           created_at, updated_at, settle_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, repo = excluded.repo, enabled = excluded.enabled,
           mode = excluded.mode, triggers = excluded.triggers,
           conditions = excluded.conditions, author_trust = excluded.author_trust,
           prompt = excluded.prompt, request = excluded.request,
           dedupe = excluded.dedupe, review_strategy = excluded.review_strategy,
           visibility = excluded.visibility, updated_at = excluded.updated_at,
           settle_minutes = excluded.settle_minutes`,
      ).run(
        rule.id,
        rule.name,
        rule.repo,
        rule.enabled ? 1 : 0,
        rule.mode,
        JSON.stringify(rule.triggers),
        JSON.stringify(rule.conditions),
        rule.authorTrust,
        rule.prompt,
        rule.request === null ? null : JSON.stringify(rule.request),
        rule.dedupe,
        rule.reviewStrategy,
        rule.visibility,
        rule.createdAt,
        rule.updatedAt,
        rule.settleMinutes,
      );
      discardWaiting("rule_id = ? AND (repo != ? OR ? = 0)",
        [rule.id, rule.repo, rule.enabled ? 1 : 0], "rule disabled or moved to a different repository");
    },

    deleteRule(id: string): void {
      discardWaiting("rule_id = ?", [id], "rule removed");
      db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
    },

    listDeferredReviews(repo: string): {
      ruleId: string; prNumber: number; trigger: Trigger;
    }[] {
      const rows = db.prepare(`SELECT * FROM deferred_reviews WHERE repo = ?`).all(repo) as Row[];
      return rows.map(row => ({
        ruleId: text(row, "rule_id"),
        prNumber: num(row, "pr_number"),
        trigger: text(row, "trigger") as Trigger,
      }));
    },

    deferReview(ruleId: string, repo: string, prNumber: number, trigger: Trigger, headSha: string, firstObservedAt: number): void {
      // A push can advance the head of a queued readiness review, not replace
      // its obligation to run in full. Closing or drafting the PR clears it.
      db.prepare(
        `INSERT INTO deferred_reviews (rule_id, repo, pr_number, trigger, head_sha, first_observed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(rule_id, repo, pr_number) DO UPDATE SET
           trigger = CASE WHEN deferred_reviews.trigger = 'ready_for_review' AND excluded.trigger = 'new_commits'
             THEN deferred_reviews.trigger ELSE excluded.trigger END,
           head_sha = excluded.head_sha,
           first_observed_at = CASE WHEN deferred_reviews.head_sha = excluded.head_sha
             THEN deferred_reviews.first_observed_at ELSE excluded.first_observed_at END`,
      ).run(ruleId, repo, prNumber, trigger, headSha, firstObservedAt);
    },

    getDeferredReview(ruleId: string, repo: string, prNumber: number): {
      trigger: Trigger; waiting: Run | null; headSha: string | null; firstObservedAt: number | null;
    } | null {
      const row = db.prepare(
        `SELECT deferred_reviews.trigger, deferred_reviews.first_observed_at,
           deferred_reviews.head_sha AS deferred_head_sha, runs.* FROM deferred_reviews
         LEFT JOIN runs ON runs.id = deferred_reviews.waiting_run_id
         WHERE deferred_reviews.rule_id = ? AND deferred_reviews.repo = ? AND deferred_reviews.pr_number = ?`,
      ).get(ruleId, repo, prNumber) as Row | undefined;
      if (row === undefined) return null;
      return {
        trigger: text(row, "trigger") as Trigger,
        waiting: row.id == null ? null : rowToRun(row),
        headSha: typeof row.deferred_head_sha === "string" ? row.deferred_head_sha : null,
        firstObservedAt: typeof row.first_observed_at === "number" ? row.first_observed_at : null,
      };
    },

    attachWaitingRun(run: Run): void {
      db.prepare(
        `UPDATE deferred_reviews SET waiting_run_id = ? WHERE rule_id = ? AND repo = ? AND pr_number = ?`,
      ).run(run.id, run.ruleId, run.repo, run.prNumber);
    },

    replaceWaitingHead(run: Run, trigger: Trigger, headSha: string, detail: string, now: number): void {
      db.transaction(() => {
        db.prepare(
          `UPDATE deferred_reviews SET waiting_run_id = NULL WHERE waiting_run_id = ?`,
        ).run(run.id);
        this.updateRun(run.id, { status: "skipped", detail });
        this.deferReview(run.ruleId, run.repo, run.prNumber, trigger, headSha, now);
      })();
    },

    discardDeferredReview(ruleId: string, repo: string, prNumber: number, detail: string): void {
      discardWaiting("rule_id = ? AND repo = ? AND pr_number = ?", [ruleId, repo, prNumber], detail);
    },

    clearDeferredReview(ruleId: string, repo: string, prNumber: number): void {
      db.prepare(
        `DELETE FROM deferred_reviews WHERE rule_id = ? AND repo = ? AND pr_number = ?`,
      ).run(ruleId, repo, prNumber);
    },

    listRuns(options: { ruleId?: string; limit?: number } = {}): Run[] {
      const limit = options.limit ?? 50;
      const rows =
        options.ruleId === undefined
          ? db
              .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
              .all(limit)
          : db
              .prepare(
                `SELECT * FROM runs WHERE rule_id = ? ORDER BY started_at DESC LIMIT ?`,
              )
              .all(options.ruleId, limit);
      return (rows as Row[]).map(rowToRun);
    },

    getRun(id: string): Run | null {
      const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
        | Row
        | undefined;
      return row === undefined ? null : rowToRun(row);
    },

    insertRun(run: Run): void {
      db.prepare(
        `INSERT INTO runs (id, rule_id, rule_name, repo, pr_number, pr_title,
           pr_author, head_sha, status, mode, detail, thread_id, comment_count,
           started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.ruleId,
        run.ruleName,
        run.repo,
        run.prNumber,
        run.prTitle,
        run.prAuthor,
        run.headSha,
        run.status,
        run.mode,
        run.detail,
        run.threadId,
        run.commentCount,
        run.startedAt,
        run.finishedAt,
      );
    },

    /** Atomically reserve a review or record a skip naming the winning run. */
    admitRun(run: Run, options: {
      dedupe: Rule["dedupe"];
      scope: ReviewScope;
      trigger: Trigger;
      isDraft: boolean;
      force?: boolean;
      promoted: boolean;
    }): Run {
      // One write statement, not a read followed by a write: SQLite serializes
      // this decision even for separate connections. Materialize the winner
      // before inserting so every derived field uses the same prior run.
      // A full non-draft run covers a narrower review, but not vice versa.
      // Only a GitHub-verified run can cover a different mode.
      const headSha = options.dedupe === "once_per_head_sha" ? run.headSha : null;
      const row = db.prepare(
        `WITH winner AS MATERIALIZED (
           SELECT id FROM runs
           WHERE ? = 0 AND rule_id = ? AND repo = ? AND pr_number = ?
             AND ${REVIEW_DEDUPE_WINNER} AND id != ?
             AND (? IS NULL OR (head_sha = ? AND (
               (? = 'new_commits' AND ${COVERED_PUSH})
               OR ((mode = ? OR ${VERIFIED_REVIEW})
                 AND (review_scope = 'full' OR review_scope = ?) AND (was_draft = 0 OR ? = 1))
             )))
           ORDER BY started_at, id LIMIT 1
         )
         INSERT INTO runs (id, rule_id, rule_name, repo, pr_number, pr_title,
           pr_author, head_sha, status, mode, detail, thread_id, comment_count,
           started_at, finished_at, review_scope, was_draft)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?,
           CASE WHEN EXISTS (SELECT 1 FROM winner) THEN 'skipped' ELSE ? END,
           ?,
           CASE WHEN EXISTS (SELECT 1 FROM winner)
             THEN 'already admitted by run ' || (SELECT id FROM winner) ELSE ? END,
           ?, ?, ?,
           CASE WHEN EXISTS (SELECT 1 FROM winner) THEN ? ELSE ? END, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, detail = excluded.detail, pr_title = excluded.pr_title,
           rule_name = excluded.rule_name,
           pr_author = excluded.pr_author, started_at = excluded.started_at, finished_at = excluded.finished_at,
           review_scope = excluded.review_scope, was_draft = excluded.was_draft
         RETURNING *`,
      ).get(
        options.force ? 1 : 0, run.ruleId, run.repo, run.prNumber, run.headSha, run.id, headSha, headSha,
        options.trigger, run.mode, run.mode, options.scope, options.isDraft ? 1 : 0,
        run.id, run.ruleId, run.ruleName, run.repo, run.prNumber, run.prTitle,
        run.prAuthor, run.headSha, run.status, run.mode, run.detail,
        run.threadId, run.commentCount, run.startedAt, options.promoted ? null : run.startedAt, run.finishedAt,
        options.scope, options.isDraft ? 1 : 0,
      ) as Row;
      return rowToRun(row);
    },

    listOlderActiveRuns(run: Pick<Run, "ruleId" | "repo" | "prNumber" | "headSha">): Run[] {
      return (db.prepare(
        `SELECT * FROM runs WHERE rule_id = ? AND repo = ? AND pr_number = ? AND head_sha != ?
         AND finished_at IS NULL AND (
           status IN ('dispatched', 'reviewing') OR
           (status = 'waiting' AND EXISTS (SELECT 1 FROM review_provisioning WHERE run_id = runs.id))
         )`,
      ).all(run.ruleId, run.repo, run.prNumber, run.headSha) as Row[]).map(rowToRun);
    },

    getCheckRunId(id: string): number | null {
      const row = db.prepare(`SELECT check_run_id FROM runs WHERE id = ?`).get(id) as Row | undefined;
      return typeof row?.check_run_id === "number" ? row.check_run_id : null;
    },

    setCheckRunId(id: string, checkRunId: number): void {
      db.prepare(`UPDATE runs SET check_run_id = ? WHERE id = ?`).run(checkRunId, id);
    },

    latestSupersededRun(ruleId: string, repo: string, prNumber: number): Run | null {
      const row = db.prepare(
        `SELECT * FROM runs WHERE rule_id = ? AND repo = ? AND pr_number = ?
         AND status IN ('cancelled', 'skipped') AND detail LIKE ? ORDER BY started_at DESC LIMIT 1`,
      ).get(ruleId, repo, prNumber, `${SUPERSEDED_DETAIL}%`) as Row | undefined;
      return row === undefined ? null : rowToRun(row);
    },

    updateRun(
      id: string,
      patch: Partial<
        Pick<
          Run,
          "status" | "detail" | "threadId" | "commentCount" | "finishedAt"
        >
      >,
    ): void {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.status !== undefined) {
        sets.push("status = ?");
        params.push(patch.status);
      }
      if (patch.detail !== undefined) {
        sets.push("detail = ?");
        params.push(patch.detail);
      }
      if (patch.threadId !== undefined) {
        sets.push("thread_id = ?");
        params.push(patch.threadId);
      }
      if (patch.commentCount !== undefined) {
        sets.push("comment_count = ?");
        params.push(patch.commentCount);
      }
      if (patch.finishedAt !== undefined) {
        sets.push("finished_at = ?");
        params.push(patch.finishedAt);
      }
      if (sets.length === 0) return;
      params.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(
        ...params,
      );
    },

    /**
     * Runs still reviewing or awaiting terminal check/thread cleanup.
     * A selected verdict stays unfinished until its finalization completes.
     */
    listUnfinishedRuns(): Run[] {
      const rows = db
        .prepare(
          `SELECT * FROM runs
           WHERE (finished_at IS NULL AND status != 'waiting')
             OR EXISTS (
               SELECT 1 FROM review_provisioning WHERE run_id = runs.id AND waiting_options IS NULL
             )
           ORDER BY started_at`,
        )
        .all();
      return (rows as Row[]).map(rowToRun);
    },

    listReviewCleanupRuns(): Run[] {
      return (db.prepare(
        `SELECT * FROM runs WHERE finished_at IS NULL AND (
           status IN ('skipped', 'no_pr_changes') OR (status = 'cancelled' AND (detail LIKE ? OR detail = ?))
         )`,
      ).all(`${SUPERSEDED_DETAIL}%`, WAITING_CANCELLED_DETAIL) as Row[]).map(rowToRun);
    },

    findRunByThread(threadId: string): Run | null {
      const row = db
        .prepare(`SELECT * FROM runs WHERE thread_id = ?`)
        .get(threadId) as Row | undefined;
      return row === undefined ? null : rowToRun(row);
    },

    /** A duplicate push need not settle before admission records its skip. */
    hasSettlingDuplicate(
      ruleId: string,
      repo: string,
      prNumber: number,
      headSha: string | null,
      mode: Rule["mode"],
      pendingHeadSha = headSha,
    ): boolean {
      const row = db.prepare(
        `SELECT 1 FROM runs
         WHERE rule_id = ? AND repo = ? AND pr_number = ?
           AND (? IS NULL OR head_sha = ?) AND ${REVIEW_DEDUPE_WINNER}
           AND (? IS NULL OR ${COVERED_PUSH} OR (mode = ? AND ${FULL_NON_DRAFT_REVIEW})) LIMIT 1`,
      ).get(ruleId, repo, prNumber, headSha, headSha, pendingHeadSha, headSha, mode, mode);
      return row !== undefined;
    },

    latestVerifiedHead(ruleId: string, repo: string, prNumber: number): string | null {
      const row = db.prepare(
        `SELECT head_sha FROM runs
         WHERE rule_id = ? AND repo = ? AND pr_number = ? AND ${VERIFIED_REVIEW}
           AND head_sha != ''
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      ).get(ruleId, repo, prNumber) as Row | undefined;
      return row === undefined ? null : text(row, "head_sha");
    },

    listComments(runId: string): RunComment[] {
      const rows = db
        .prepare(`SELECT * FROM run_comments WHERE run_id = ?`)
        .all(runId) as Row[];
      return rows.map((row) => ({
        runId: text(row, "run_id"),
        githubId: typeof row.github_id === "string" ? row.github_id : null,
        kind: text(row, "kind", "summary") as RunComment["kind"],
        path: typeof row.path === "string" ? row.path : null,
        line: typeof row.line === "number" ? row.line : null,
        url: typeof row.url === "string" ? row.url : null,
        bodyExcerpt: text(row, "body_excerpt"),
        attribution: text(
          row,
          "attribution",
          "marker",
        ) as RunComment["attribution"],
      }));
    },

    replaceComments(runId: string, comments: RunComment[]): void {
      db.prepare(`DELETE FROM run_comments WHERE run_id = ?`).run(runId);
      const insert = db.prepare(
        `INSERT INTO run_comments (run_id, github_id, kind, path, line, url,
           body_excerpt, attribution) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const comment of comments) {
        insert.run(
          runId,
          comment.githubId,
          comment.kind,
          comment.path,
          comment.line,
          comment.url,
          comment.bodyExcerpt,
          comment.attribution,
        );
      }
    },

    isBootstrapped(repo: string): boolean {
      return (
        db
          .prepare(`SELECT 1 AS hit FROM watched_repos WHERE repo = ?`)
          .get(repo) !== undefined
      );
    },

    markBootstrapped(repo: string, now: number): void {
      db.prepare(
        `INSERT INTO watched_repos (repo, bootstrapped_at) VALUES (?, ?)
         ON CONFLICT(repo) DO NOTHING`,
      ).run(repo, now);
    },

    getSeen(
      repo: string,
      prNumber: number,
    ): { headSha: string; wasDraft: boolean } | null {
      const row = db
        .prepare(`SELECT * FROM seen_prs WHERE repo = ? AND pr_number = ?`)
        .get(repo, prNumber) as Row | undefined;
      if (row === undefined) return null;
      return {
        headSha: text(row, "head_sha"),
        wasDraft: num(row, "was_draft") === 1,
      };
    },

    markSeen(
      repo: string,
      prNumber: number,
      headSha: string,
      wasDraft: boolean,
      now: number,
    ): void {
      db.prepare(
        `INSERT INTO seen_prs (repo, pr_number, head_sha, was_draft, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo, pr_number) DO UPDATE SET
           head_sha = excluded.head_sha, was_draft = excluded.was_draft,
           updated_at = excluded.updated_at`,
      ).run(repo, prNumber, headSha, wasDraft ? 1 : 0, now);
    },

    listGates(): GateCheck[] {
      return (
        db.prepare(`SELECT * FROM gate_checks ORDER BY name`).all() as Row[]
      ).map(rowToGateCheck);
    },

    getGate(id: string): GateCheck | null {
      const row = db
        .prepare(`SELECT * FROM gate_checks WHERE id = ?`)
        .get(id) as Row | undefined;
      return row === undefined ? null : rowToGateCheck(row);
    },

    findGateByName(name: string): GateCheck | null {
      const row = db
        .prepare(`SELECT * FROM gate_checks WHERE name = ?`)
        .get(name) as Row | undefined;
      return row === undefined ? null : rowToGateCheck(row);
    },

    upsertGate(gate: GateCheck): void {
      db.prepare(
        `INSERT INTO gate_checks (
           id, name, repo, enabled, mode, author_trust, repo_dir, command,
           timeout_seconds, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           repo = excluded.repo,
           enabled = excluded.enabled,
           mode = excluded.mode,
           author_trust = excluded.author_trust,
           repo_dir = excluded.repo_dir,
           command = excluded.command,
           timeout_seconds = excluded.timeout_seconds,
           updated_at = excluded.updated_at`,
      ).run(
        gate.id,
        gate.name,
        gate.repo,
        gate.enabled ? 1 : 0,
        gate.mode,
        gate.authorTrust,
        gate.repoDir,
        gate.command,
        gate.timeoutSeconds,
        gate.createdAt,
        gate.updatedAt,
      );
    },

    deleteGate(id: string): void {
      db.prepare(`DELETE FROM gate_checks WHERE id = ?`).run(id);
    },

    admitGateRun(
      run: GateRun,
      force = false,
    ): { run: GateRun; admitted: boolean } {
      if (run.status === "running") {
        const retried = db
          .prepare(
            `UPDATE gate_runs
             SET pr_number = ?,
                 base_sha = '',
                 status = 'running',
                 mode = ?,
                 exit_code = NULL,
                 output = '',
                 attempts = CASE WHEN ? = 1 THEN 1 ELSE attempts + 1 END,
                 started_at = ?,
                 finished_at = NULL
             WHERE id = (
               SELECT id FROM gate_runs
               WHERE gate_id = ? AND repo = ? AND head_sha = ?
                 AND status = 'error'
                 AND (
                   ? = 1
                   OR (
                     attempts < 3
                     AND NOT EXISTS (
                       SELECT 1 FROM gate_runs AS settled
                       WHERE settled.gate_id = ? AND settled.repo = ? AND settled.head_sha = ?
                         AND settled.status IN ('running', 'passed', 'failed', 'skipped')
                     )
                   )
                 )
               ORDER BY started_at DESC, id DESC
               LIMIT 1
             )
             RETURNING *`,
          )
          .get(
            run.prNumber,
            run.mode,
            force ? 1 : 0,
            run.startedAt,
            run.gateId,
            run.repo,
            run.headSha,
            force ? 1 : 0,
            run.gateId,
            run.repo,
            run.headSha,
          ) as Row | undefined;

        if (retried !== undefined) {
          return { run: rowToGateRun(retried), admitted: true };
        }
      }

      const inserted = db
        .prepare(
          `INSERT INTO gate_runs (
             id, gate_id, gate_name, repo, pr_number, head_sha, base_sha,
             status, mode, exit_code, output, check_run_id, attempts,
             started_at, finished_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ? = 1 OR NOT EXISTS (
             SELECT 1 FROM gate_runs
             WHERE gate_id = ? AND repo = ? AND head_sha = ?
           )
           RETURNING *`,
        )
        .get(
          run.id,
          run.gateId,
          run.gateName,
          run.repo,
          run.prNumber,
          run.headSha,
          run.baseSha,
          run.status,
          run.mode,
          run.exitCode,
          run.output,
          run.checkRunId,
          Math.max(1, run.attempts),
          run.startedAt,
          run.finishedAt,
          force ? 1 : 0,
          run.gateId,
          run.repo,
          run.headSha,
        ) as Row | undefined;

      if (inserted !== undefined) {
        return { run: rowToGateRun(inserted), admitted: true };
      }

      const existing = db
        .prepare(
          `SELECT * FROM gate_runs
           WHERE gate_id = ? AND repo = ? AND head_sha = ?
           ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(run.gateId, run.repo, run.headSha) as Row | undefined;
      return {
        run: existing === undefined ? run : rowToGateRun(existing),
        admitted: false,
      };
    },

    updateGateRun(
      id: string,
      patch: Partial<
        Pick<
          GateRun,
          "baseSha" | "status" | "exitCode" | "output" | "checkRunId" | "finishedAt"
        >
      >,
    ): void {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.baseSha !== undefined) {
        sets.push("base_sha = ?");
        params.push(patch.baseSha);
      }
      if (patch.status !== undefined) {
        sets.push("status = ?");
        params.push(patch.status);
      }
      if (patch.exitCode !== undefined) {
        sets.push("exit_code = ?");
        params.push(patch.exitCode);
      }
      if (patch.output !== undefined) {
        sets.push("output = ?");
        params.push(patch.output);
      }
      if (patch.checkRunId !== undefined) {
        sets.push("check_run_id = ?");
        params.push(patch.checkRunId);
      }
      if (patch.finishedAt !== undefined) {
        sets.push("finished_at = ?");
        params.push(patch.finishedAt);
      }
      if (sets.length === 0) return;
      params.push(id);
      db.prepare(`UPDATE gate_runs SET ${sets.join(", ")} WHERE id = ?`).run(
        ...params,
      );
    },

    getGateRun(id: string): GateRun | null {
      const row = db
        .prepare(`SELECT * FROM gate_runs WHERE id = ?`)
        .get(id) as Row | undefined;
      return row === undefined ? null : rowToGateRun(row);
    },

    listGateRuns(options: { gateId?: string; limit?: number } = {}): GateRun[] {
      const limit = options.limit ?? 50;
      const rows =
        options.gateId === undefined
          ? db
              .prepare(`SELECT * FROM gate_runs ORDER BY started_at DESC LIMIT ?`)
              .all(limit)
          : db
              .prepare(
                `SELECT * FROM gate_runs WHERE gate_id = ? ORDER BY started_at DESC LIMIT ?`,
              )
              .all(options.gateId, limit);
      return (rows as Row[]).map(rowToGateRun);
    },

    listRunningGateRuns(): GateRun[] {
      const rows = db
        .prepare(
          `SELECT * FROM gate_runs WHERE status = 'running' ORDER BY started_at`,
        )
        .all() as Row[];
      return rows.map(rowToGateRun);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
