import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createStore, MIGRATIONS } from "./db";

it("resumes reviews queued before review bases were recorded without their cached inputs", () => {
  // The schema as PR #31 left it: every statement before the five PR #32 appended
  // and the scope note added after them.
  const db = new Database(":memory:");
  const before = MIGRATIONS.slice(0, -6);
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
  for (const sql of MIGRATIONS.slice(-6)) db.exec(sql);
  expect(createStore(db as never).listProvisioning()).toEqual([
    expect.objectContaining({ hostId: "host_a", waiting: { trigger: "new_commits" } }),
  ]);
});
