// Comment identity: the visible header a human reads, and the hidden marker
// the plugin matches on.
//
// Two independent signals on purpose. The marker is the machine contract —
// exact, unambiguous, invisible in rendered markdown. The header is the human
// contract, and doubles as a fallback attribution when an agent drops the
// marker: a body with the header but no marker is still provably ours, just
// flagged as prompt drift.
//
// The header is NOT authoritative for matching. It is ordinary editable text
// that anyone can type into a comment; only the marker is treated as proof.
import type { CommentKind } from "./types";

export interface Marker {
  rule: string;
  run: string;
  sha: string;
  kind: CommentKind;
}

const MARKER_PATTERN = /<!--\s*slopcop:([^>]*?)\s*-->/;
const CANONICAL_MARKER_PATTERN =
  /<!--\s*slopcop:rule=(\S+)\s+run=(\S+)\s+sha=([0-9a-f]{40})\s+kind=(summary|inline)\s*-->/g;
export const OFF_DIFF_FINDINGS_HEADING = "### Findings outside the PR diff";
/** Carried off-diff findings the reviewer re-checked and found fixed or moot. */
export const RESOLVED_FINDINGS_HEADING = "### Resolved since the last review";
/** Separate metadata tag identifying a summary carried forward without a new review. */
export const CARRIED_REVIEW_MARKER_PREFIX = "<!-- slopcop-carried:from=";

export function buildCarriedReviewMarker(fromSha: string): string {
  return `${CARRIED_REVIEW_MARKER_PREFIX}${fromSha} -->`;
}

/** Values are constrained so a rule name can never break out of the marker. */
function sanitize(value: string): string {
  return value.replace(/[^\w.\-/]/g, "_");
}

export function buildMarker(marker: Marker): string {
  const fields = [
    `rule=${sanitize(marker.rule)}`,
    `run=${sanitize(marker.run)}`,
    `sha=${sanitize(marker.sha)}`,
    `kind=${marker.kind}`,
  ];
  return `<!-- slopcop:${fields.join(" ")} -->`;
}

export function parseMarker(body: string): Marker | null {
  const match = MARKER_PATTERN.exec(body);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const pair of match[1]!.trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    fields.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const rule = fields.get("rule");
  const run = fields.get("run");
  const kind = fields.get("kind");
  if (
    rule === undefined ||
    run === undefined ||
    (kind !== "summary" && kind !== "inline" && kind !== "reply")
  ) {
    return null;
  }
  return { rule, run, sha: fields.get("sha") ?? "", kind };
}

/** Returns true when `body` contains a canonical marker in strict field order matching rule, run, 40-hex sha, and kind. */
export function hasCanonicalMarker(
  body: string,
  expected: { rule: string; run: string; sha: string; kind: "summary" | "inline" },
): boolean {
  for (const match of body.matchAll(CANONICAL_MARKER_PATTERN)) {
    if (
      match[1] === expected.rule &&
      match[2] === expected.run &&
      match[3] === expected.sha &&
      match[4] === expected.kind
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Replaces the body's marker with `marker`.
 *
 * The run id and head SHA are the server's facts, and an agent transcribing
 * them by hand gets them wrong — a dropped character in the run id is enough
 * to make a correct review unattributable. Stamp the canonical marker instead
 * of asking the transcription to be perfect.
 */
export function restampMarker(body: string, marker: Marker): string {
  return body.replace(MARKER_PATTERN, buildMarker(marker));
}

/** The rule name as a marker carries it. */
export function markerRuleName(ruleName: string): string {
  return sanitize(ruleName);
}

/** True when this marker belongs to `ruleName` (after the same sanitizing). */
export function markerBelongsToRule(marker: Marker, ruleName: string): boolean {
  return marker.rule === sanitize(ruleName);
}

/**
 * The summary gets the full banner; inline comments and replies get a compact
 * one-liner. A full banner on each of six inline comments buries the finding
 * that is the actual point of the comment.
 */
export function buildHeader(kind: CommentKind, ruleName: string): string {
  if (kind === "summary") {
    return `🚨 **SLOP COP** 🚨 · \`${ruleName}\``;
  }
  return `🚨 \`slopcop/${ruleName}\` —`;
}

/**
 * Detects our visible header. Deliberately loose about the rule name: a body
 * that says SLOP COP is ours even if the agent mangled the rule slug, and
 * treating it as ours is what turns an unattributable comment into a warning.
 */
export function hasVisibleHeader(body: string): boolean {
  return /🚨\s*(\*\*)?\s*SLOP\s*COP|🚨\s*`?slopcop\//i.test(body);
}

/** The rule name a well-formed header shows, or null when there is none. */
export function headerRuleName(body: string): string | null {
  const match =
    /🚨\s*`slopcop\/([^`]+)`/.exec(body) ??
    /SLOP\s*COP\s*(?:\*\*)?\s*🚨\s*·\s*`([^`]+)`/.exec(body);
  return match?.[1] ?? null;
}

/** Wraps an agent-authored body in the header and marker. */
export function decorateBody(
  body: string,
  kind: CommentKind,
  marker: Marker,
): string {
  const header = buildHeader(kind, marker.rule);
  const trimmed = body.trim();
  const lead =
    kind === "summary" ? `${header}\n\n${trimmed}` : `${header} ${trimmed}`;
  return `${lead}\n\n${buildMarker(marker)}`;
}

export type Attribution = "marker" | "header" | "account" | null;

/**
 * How confidently a body can be attributed to a given run. `runId` scopes
 * marker matches so a previous run's comments are never counted as this one's.
 */
export function attributeBody(body: string, runId: string): Attribution {
  const marker = parseMarker(body);
  if (marker !== null) return marker.run === runId ? "marker" : null;
  if (hasVisibleHeader(body)) return "header";
  return null;
}

export interface FenceState {
  char: "`" | "~";
  len: number;
}

/** Matches a CommonMark opening code fence (` ``` ` / `~~~` or longer) on a trimmed line. */
export function matchFenceOpen(trimmed: string): FenceState | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
  if (match === null) return null;
  const char = match[1]![0]! as "`" | "~";
  if (char === "`" && (match[2] ?? "").includes("`")) return null;
  return { char, len: match[1]!.length };
}

/** True only when a trimmed line closes an active CommonMark fence of the same char and >= length. */
export function isFenceClose(trimmed: string, fence: FenceState): boolean {
  return new RegExp(`^${fence.char}{${fence.len},}[ \\t]*$`).test(trimmed);
}
