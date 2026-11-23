import { describe, expect, it } from "vitest";
import {
  CARRIED_SUFFIX,
  collectCarriedFindings,
  parseFindingBullet,
  summaryFindings,
} from "./carry";
import { buildPrompt } from "./dispatch";
import { decorateBody, OFF_DIFF_FINDINGS_HEADING, RESOLVED_FINDINGS_HEADING } from "./marker";
import type { PullRequest, Rule } from "./types";
import { summaryToPost } from "./verify";

const RULE = "security-sweep";
const ACCESS = "- `src/access.ts:32` — **Restore the access check.** The guard was removed.";
const RETRY = "- `src/retry.ts:8` — **Cap the retry loop.** It never stops.";

function summary(run: string, body: string) {
  return decorateBody(body, "summary", { rule: RULE, run, sha: `sha_${run}`, kind: "summary" });
}

/** One posted summary per head, in order, as GitHub returns them. */
function history(...bodies: string[]) {
  return bodies.map((body, index) => ({ body: summary(`run_${index + 1}`, body), createdAt: (index + 1) * 1_000 }));
}

function finish(run: string, body: string | null, prior: { body: string; createdAt: number }[]) {
  return summaryToPost({
    rule: RULE,
    runId: run,
    sha: `sha_${run}`,
    finalMessage: body === null ? null : summary(run, body),
    carried: collectCarriedFindings(prior, RULE, run),
  });
}

const offDiff = (...items: string[]) => `${OFF_DIFF_FINDINGS_HEADING}\n\n${items.join("\n")}`;
const resolved = (...items: string[]) => `${RESOLVED_FINDINGS_HEADING}\n\n${items.join("\n")}`;

describe("reading findings from a summary", () => {
  it("keys a bullet by path and title, with or without backticks and bold", () => {
    expect(parseFindingBullet(ACCESS)).toEqual({
      path: "src/access.ts", line: 32, title: "Restore the access check", text: ACCESS,
    });
    expect(parseFindingBullet("- src/scroll.ts:42 — Preserve the saved scroll position. It resets.")).toMatchObject({
      path: "src/scroll.ts", line: 42, title: "Preserve the saved scroll position",
    });
    expect(parseFindingBullet("- `docs/README.md` — **Document the flag.**")).toMatchObject({
      path: "docs/README.md", line: null, title: "Document the flag",
    });
  });

  it("matches a moved line and strips SlopCop's carried suffix", () => {
    const moved = parseFindingBullet(`- \`src/access.ts:40\` — **Restore the access check.** ${CARRIED_SUFFIX}`);
    expect(moved).toMatchObject({ path: "src/access.ts", title: "Restore the access check" });
    expect(moved!.text).not.toContain(CARRIED_SUFFIX);
  });

  it("ignores follow-up notes, fenced examples, and other rules", () => {
    const body = [
      "```",
      OFF_DIFF_FINDINGS_HEADING,
      "- `src/example.ts:1` — **Quoted example.**",
      "```",
      "",
      offDiff(ACCESS),
      "",
      "**Follow-up notes**",
      "",
      "- `src/label.ts:3` — **Shorten the label.**",
    ].join("\n");
    expect(summaryFindings(summary("run_1", body)).open.map(item => item.title)).toEqual(["Restore the access check"]);
    const other = decorateBody(offDiff(RETRY), "summary", { rule: "other-rule", run: "run_x", sha: "s", kind: "summary" });
    expect(collectCarriedFindings([{ body: other, createdAt: 1 }], RULE)).toEqual([]);
  });
});

describe("carrying off-diff findings forward", () => {
  it("keeps A's finding open on B's clean incremental review", () => {
    const prior = history(offDiff(ACCESS));
    const b = finish("run_2", "No new findings in this patch.", prior);
    expect(b).toMatchObject({ hasOffDiffFindings: true, appended: 1 });
    expect(b!.body.split("\n").slice(0, 3)).toEqual([
      "🚨 **SLOP COP** 🚨 · `security-sweep`",
      "",
      OFF_DIFF_FINDINGS_HEADING,
    ]);
    expect(b!.body).toContain(`${ACCESS} ${CARRIED_SUFFIX}`);
    expect(b!.body).toContain("No new findings in this patch.");
  });

  it("clears it when C's reviewer resolves it, and C is clean", () => {
    const prior = history(offDiff(ACCESS), "No new findings.");
    const c = finish("run_3", resolved("- `src/access.ts:32` — **Restore the access check.** The guard is back in `authorize`."), prior);
    expect(c).toMatchObject({ hasOffDiffFindings: false, appended: 0 });
    expect(c!.body).toContain("The guard is back in `authorize`.");
    expect(collectCarriedFindings([...prior, { body: c!.body, createdAt: 9_000 }], RULE)).toEqual([]);
  });

  it("does not append an item the reviewer re-listed as still open", () => {
    const prior = history(offDiff(ACCESS));
    const relisted = "- `src/access.ts:35` — **Restore the access check.** Still missing at this head.";
    const b = finish("run_2", offDiff(relisted), prior);
    expect(b).toMatchObject({ hasOffDiffFindings: true, appended: 0 });
    expect(b!.body).not.toContain(CARRIED_SUFFIX);
  });

  it("splits two carried items: one resolved, one still open", () => {
    const prior = history(offDiff(ACCESS, RETRY));
    const b = finish("run_2", [
      offDiff("- `src/retry.ts:9` — **Cap the retry loop.** Still unbounded."),
      "",
      resolved("- `src/access.ts:32` — **Restore the access check.** Restored."),
    ].join("\n"), prior);
    expect(b).toMatchObject({ hasOffDiffFindings: true, appended: 0 });
    const next = collectCarriedFindings([...prior, { body: b!.body, createdAt: 9_000 }], RULE);
    expect(next.map(item => item.title)).toEqual(["Cap the retry loop"]);
  });

  it("appends an omitted item into the reviewer's own off-diff list", () => {
    const prior = history(offDiff(ACCESS));
    const fresh = "- `src/new.ts:4` — **Drop the fallback.** It hides errors.";
    const b = finish("run_2", `${offDiff(fresh)}\n\n**Follow-up notes**\n\n- A note.`, prior);
    expect(b!.appended).toBe(1);
    const lines = b!.body.split("\n");
    expect(lines.indexOf(`${ACCESS} ${CARRIED_SUFFIX}`)).toBe(lines.indexOf(fresh) + 1);
    expect(summaryFindings(b!.body).open.map(item => item.title)).toEqual(["Drop the fallback", "Restore the access check"]);
  });

  it("appends back a carried item whose title the reviewer reworded", () => {
    const prior = history(offDiff(ACCESS));
    const reworded = "- `src/access.ts:32` — **Put the access check back.** Same finding, new words.";
    const b = finish("run_2", resolved(reworded), prior);
    expect(b).toMatchObject({ hasOffDiffFindings: true, appended: 1 });
    expect(b!.body).toContain(`${ACCESS} ${CARRIED_SUFFIX}`);
  });

  it("keeps one suffix across generations of unchecked carrying", () => {
    let prior = history(offDiff(ACCESS));
    for (const run of ["run_2", "run_3"]) {
      const next = finish(run, "Nothing new.", prior)!;
      prior = [...prior, { body: next.body, createdAt: prior.length * 1_000 + 1_000 }];
    }
    const last = prior.at(-1)!.body;
    expect(last.split(CARRIED_SUFFIX)).toHaveLength(2);
    expect(collectCarriedFindings(prior, RULE)).toHaveLength(1);
  });

  it("writes the summary itself when the reviewer ended without one", () => {
    const prior = history(offDiff(ACCESS));
    const b = summaryToPost({
      rule: RULE, runId: "run_2", sha: "sha_run_2",
      finalMessage: "Posted 1 inline finding: https://github.com/acme/widgets/pull/1#discussion_r1",
      carried: collectCarriedFindings(prior, RULE),
    });
    expect(b).toEqual({
      body: summary("run_2", offDiff(`${ACCESS} ${CARRIED_SUFFIX}`)),
      hasOffDiffFindings: true,
      appended: 1,
    });
    expect(summaryToPost({ rule: RULE, runId: "run_2", sha: "s", finalMessage: "Review incomplete: no head", carried: collectCarriedFindings(prior, RULE) })).toBeNull();
  });

  it("changes nothing without a prior summary", () => {
    expect(collectCarriedFindings([], RULE)).toEqual([]);
    expect(finish("run_1", "Nothing survives the review.", [])).toEqual({
      body: summary("run_1", "Nothing survives the review."), hasOffDiffFindings: false, appended: 0,
    });
    expect(finish("run_1", null, [])).toBeNull();
  });
});

describe("the open set across every earlier summary", () => {
  it("recovers an item from summary 1 that summary 2 dropped before carrying shipped", () => {
    const prior = history(offDiff(ACCESS), "Clean incremental review.");
    expect(collectCarriedFindings(prior, RULE).map(item => item.title)).toEqual(["Restore the access check"]);
    expect(finish("run_3", "Clean again.", prior)!.body).toContain(ACCESS);
  });

  it("keeps an item resolved in summary 3 out of summary 4", () => {
    const prior = history(
      offDiff(ACCESS, RETRY),
      "Clean incremental review.",
      `${offDiff(RETRY)}\n\n${resolved("- `src/access.ts:32` — **Restore the access check.** Restored.")}`,
    );
    const d = finish("run_4", "Nothing new.", prior)!;
    expect(d.body).toContain(RETRY);
    expect(d.body).not.toContain("src/access.ts");
  });

  it("re-opens an item a later summary lists again after resolving it", () => {
    const prior = history(
      offDiff(ACCESS),
      resolved("- `src/access.ts:32` — **Restore the access check.** Restored."),
      offDiff("- `src/access.ts:33` — **Restore the access check.** Removed again."),
    );
    expect(collectCarriedFindings(prior, RULE)).toEqual([
      expect.objectContaining({ line: 33, text: "- `src/access.ts:33` — **Restore the access check.** Removed again." }),
    ]);
  });

  it("leaves out the finishing run's own summary", () => {
    const prior = history(offDiff(ACCESS), offDiff(RETRY));
    expect(collectCarriedFindings(prior, RULE, "run_2").map(item => item.title)).toEqual(["Restore the access check"]);
  });
});

describe("the review prompt", () => {
  const rule = { name: RULE, repo: "acme/widgets", prompt: "Review it.", mode: "live" } as Rule;
  const pullRequest = {
    number: 7, title: "t", headRefOid: "h".repeat(40), baseRefOid: "b".repeat(40), baseRefName: "main",
    author: { login: "dana" }, authorAssociation: "MEMBER", isCrossRepository: false, labels: [], files: [],
  } as unknown as PullRequest;
  const base = {
    rule, pullRequest, runId: "run_2", trigger: "synchronize" as const, previousVerifiedHead: "a".repeat(40),
    incremental: { tree: "t".repeat(40), patchName: "slopcop-run_2.patch" },
  };

  it("hands carried findings to an incremental reviewer with leave to read their paths", () => {
    const carriedFindings = collectCarriedFindings(history(offDiff(ACCESS)), RULE);
    const prompt = buildPrompt({ ...base, carriedFindings });
    expect(prompt).toContain("## OPEN OFF-DIFF FINDINGS FROM EARLIER REVIEWS");
    expect(prompt).toContain("read each finding's `path` at the head even when the patch does");
    expect(prompt).toContain("Copy each finding's path and title exactly as given");
    expect(prompt).toContain('"path":"src/access.ts","line":32,"title":"Restore the access check"');
    expect(prompt).toContain(RESOLVED_FINDINGS_HEADING);
    expect(prompt).toContain("always end with the\nConversation body above");
  });

  it("adds no carried block or finishing rule without carried findings", () => {
    const prompt = buildPrompt(base);
    expect(prompt).not.toContain("OPEN OFF-DIFF FINDINGS");
    expect(prompt).toContain("If all findings were posted inline, end with a one-line summary");
  });
});
