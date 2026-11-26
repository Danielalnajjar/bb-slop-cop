import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createStore, MIGRATIONS } from "./db";

it("resumes reviews queued before review bases were recorded without their cached inputs", () => {
  // The schema as PR #31 left it: every statement before the five PR #32 appended
  // and the scope note added after them.
  const db = new Database(":memory:");
  const before = MIGRATIONS.slice(0, -7);
  expect(before.at(-1)).toContain("ADD COLUMN was_draft");
  for (const sql of before) db.exec(sql);
  db.prepare(`INSERT INTO runs (id, rule_id, rule_name, repo, pr_number, pr_title, pr_author, head_sha, status, mode, started_at)
    VALUES ('run_queued', 'rule_1', 'rule', 'acme/widgets', 7, 't', 'dana', ?, 'waiting', 'live', 1)`).run("b".repeat(40));
  db.prepare(`INSERT INTO review_provisioning (run_id, host_id, waiting_options) VALUES ('run_queued', 'host_a', ?)`)
    .run(JSON.stringify({
      trigger: "new_commits",
      reviewInputs: {
        baseRefOid: "7".repeat(40), previousVerifiedHead: "a".repeat(40),
        incremental: { tree: "d".repeat(40), patch: { type: "localFile", path: "p.patch" }, projectId: "project" },
      },
    }));
  for (const sql of MIGRATIONS.slice(-7)) db.exec(sql);
  const store = createStore(db as never);
  expect(store.listProvisioning()).toEqual([
    expect.objectContaining({ hostId: "host_a", waiting: { trigger: "new_commits" } }),
  ]);
  store.insertRun({
    id: "run_prev",
    ruleId: "rule_1",
    ruleName: "rule",
    repo: "acme/widgets",
    prNumber: 7,
    prTitle: "t",
    prAuthor: "dana",
    headSha: "a".repeat(40),
    status: "commented",
    mode: "live",
    detail: null,
    scopeNote: null,
    previousVerifiedHead: null,
    threadId: null,
    commentCount: 1,
    startedAt: 2,
    finishedAt: 3,
  });
  store.insertRun({
    id: "run_follow",
    ruleId: "rule_1",
    ruleName: "rule",
    repo: "acme/widgets",
    prNumber: 7,
    prTitle: "t",
    prAuthor: "dana",
    headSha: "c".repeat(40),
    status: "commented_partial",
    mode: "live",
    detail: null,
    scopeNote: null,
    previousVerifiedHead: "a".repeat(40),
    threadId: null,
    commentCount: 1,
    startedAt: 4,
    finishedAt: 5,
  });
  expect(store.getRun("run_follow")?.previousVerifiedHead).toBe("a".repeat(40));
  expect(store.latestVerifiedReview("rule_1", "acme/widgets", 7)).toEqual({
    id: "run_follow",
    headSha: "c".repeat(40),
    baseSha: null,
    status: "commented_partial",
    finishedAt: 5,
  });
});
