import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createStore, MIGRATIONS } from "./db";

it("resumes reviews queued before review bases were recorded without their cached inputs", () => {
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS.slice(0, -1)) db.exec(sql);
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
  db.exec(MIGRATIONS.at(-1)!);
  expect(createStore(db as never).listProvisioning()).toEqual([
    expect.objectContaining({ hostId: "host_a", waiting: { trigger: "new_commits" } }),
  ]);
});
