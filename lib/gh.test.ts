import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGhClient } from "./gh";

const commentProjection = "map({id, body, html_url, user: {login: .user.login}, path, line, original_line, submitted_at, created_at})";

async function setup(count: number, bodySize = 0, hunkSize = 0) {
  const dir = await mkdtemp(join(tmpdir(), "slopcop-gh-"));
  const executable = join(dir, "gh");
  const calls = join(dir, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const endpoint = args.find(arg => arg.startsWith("repos/"));
const url = new URL(endpoint, "https://api.github.com/");
const page = Number(url.searchParams.get("page") ?? 1);
const size = Number(url.searchParams.get("per_page") ?? 30);
const start = args.includes("--paginate") ? 0 : (page - 1) * size;
const end = args.includes("--paginate") ? ${count} : Math.min(start + size, ${count});
const projected = args[args.indexOf("--jq") + 1] === ${JSON.stringify(commentProjection)};
const rows = Array.from({length: Math.max(0, end - start)}, (_, i) => ({
  id: start + i + 1, body: "x".repeat(${bodySize}),
  html_url: "https://github.com/comment/" + (start + i + 1),
  user: {login: "reviewer"}, path: "docs/large.md", line: null,
  original_line: 3000, created_at: "2026-10-15T00:00:00Z",
  ...(projected ? {} : {diff_hunk: "h".repeat(${hunkSize})}),
}));
process.stdout.write(JSON.stringify(rows));
`, { mode: 0o755 });
  return {
    client: createGhClient(executable),
    calls: async () => (await readFile(calls, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as string[]),
    cleanup: () => rm(dir, { recursive: true }),
  };
}

it("returns every comment when retained comment data totals over 16 MiB", async () => {
  const count = 250;
  const bodySize = 72_000;
  expect(count * bodySize).toBeGreaterThan(16 * 1024 * 1024);
  const { client, cleanup } = await setup(count, bodySize);
  try {
    const comments = await client.listReviewComments("owner/repo", 867);
    expect(comments.map((comment) => comment.id)).toEqual(
      Array.from({ length: count }, (_, i) => String(i + 1)),
    );
    expect(comments.every((comment) => comment.body.length === bodySize)).toBe(true);
  } finally {
    await cleanup();
  }
});

it("projects huge diff hunks out of each page before buffering stdout", async () => {
  const { client, calls, cleanup } = await setup(100, 10, 300_000);
  try {
    const comments = await client.listReviewComments("owner/repo", 867);
    expect(comments).toHaveLength(100);
    expect(comments[99]).toEqual({
      id: "100", body: "xxxxxxxxxx", url: "https://github.com/comment/100",
      author: "reviewer", path: "docs/large.md", line: 3000,
      createdAt: Date.parse("2026-10-15T00:00:00Z"),
    });
    for (const args of await calls()) {
      expect(args[args.indexOf("--jq") + 1]).toBe(commentProjection);
    }
  } finally {
    await cleanup();
  }
});

it("still rejects a single projected page larger than 16 MiB", async () => {
  const { client, cleanup } = await setup(1, 17 * 1024 * 1024);
  try {
    await expect(client.listReviewComments("owner/repo", 867))
      .rejects.toThrow("maxBuffer");
  } finally {
    await cleanup();
  }
});

it.each([
  { read: "single", mergeBase: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  { read: "list", mergeBase: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  { read: "single", mergeBase: "" },
  { read: "list", mergeBase: "" },
  { read: "single", mergeBase: "not-a-sha" },
])("captures the merge base without a stale fallback ($read, mergeBase=$mergeBase)", async ({ read, mergeBase }) => {
  const dir = await mkdtemp(join(tmpdir(), "slopcop-gh-base-"));
  try {
    const executable = join(dir, "gh");
    await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const endpoint = args[1];
const pr = {number: 7, base: {ref: "release/current", sha: "stale-base"}, head: {sha: "pinned-head"}};
if (endpoint === "repos/owner/repo/compare/release%2Fcurrent...pinned-head") {
  process.stdout.write(${JSON.stringify(mergeBase + "\n")});
} else if (endpoint === "repos/owner/repo/pulls/7") {
  process.stdout.write(JSON.stringify(pr));
} else if (endpoint === "repos/owner/repo/pulls?state=open&per_page=100&page=1") {
  process.stdout.write(JSON.stringify([pr]));
} else {
  process.stderr.write("Unexpected endpoint: " + endpoint);
  process.exitCode = 1;
}
`, { mode: 0o755 });
    const client = createGhClient(executable);
    const result = read === "single"
      ? client.getPullRequest("owner/repo", 7)
      : client.listOpenPullRequests("owner/repo").then((prs) => prs[0]);
    if (mergeBase !== "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
      await expect(result).rejects.toThrow("GitHub compare did not return a valid review merge base SHA");
      return;
    }
    const pr = await result;
    expect(pr.baseRefOid).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(pr.headRefOid).toBe("pinned-head");
  } finally {
    await rm(dir, { recursive: true });
  }
});
