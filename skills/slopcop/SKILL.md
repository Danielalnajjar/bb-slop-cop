---
name: slopcop
description: Configure automated PR review rules with the `bb slopcop` CLI. Use when asked to set up, change, inspect, or debug automatic pull-request reviews — creating a review rule for a repo, changing what a rule looks for, restricting which authors get reviewed, checking why a PR was or was not reviewed, or reading what a shadow-mode rule would have posted.
---

# SlopCop — automated PR review rules

A **rule** watches one GitHub repo and dispatches a BB agent to review PRs that
match it. Rules are configured entirely from the CLI, so you can set them up on
the user's behalf.

## Safety defaults — do not loosen without being asked

Two defaults exist to stop the agent running untrusted code, and you should
leave them alone unless the user explicitly asks:

- **`--trust write_access`** (default) — only reviews PRs from `OWNER`,
  `MEMBER`, `COLLABORATOR`. Note that GitHub's `CONTRIBUTOR` means only "has
  had a commit merged before", **not** write access. Wider matching thresholds
  do not authorize managed repository setup: input preparation requires one
  of those write-access associations, including when dispatch is forced.
- **shadow mode** (default for new rules) — the rule runs the full review and
  stores the body, but posts nothing. Promote with `--live` only when the user
  has seen a shadow result and asked for it.

## Creating a rule

A rule needs a repo AND an agent configuration (`--project` at minimum), or it
cannot dispatch:

```sh
bb slopcop rules add \
  --name security-sweep \
  --repo owner/repo \
  --project <bb-project-name> \
  --model "claude-opus-5-5[1m]" \
  --paths "src/auth/**,src/payments/**" \
  --base main \
  --prompt "Review the diff for auth and payment issues."
```

Flags: `--name --repo --project --machine --provider --model --reasoning --permission
--prompt --paths --base --label --skip-label --trust --dedupe
--trigger --settle-minutes --live --shadow --disabled --hidden --visible`.
`--machine <host id|name>` pins the BB machine the review worktrees run on.

`--hidden` spawns review threads with `visibility: "hidden"`: they stay out of
sidebar organization and raise no unread or notification attention. Right for a
rule that fires often. Default is `--visible`, so a new rule is watchable while
you tune it.

Set a default BB section for all new review threads with a section name or ID:

```sh
bb plugin config slopcop set defaultThreadSection "Automated reviews"
```

Clear `defaultThreadSection` to create review threads without a section. A run
fails with an explicit error if the configured section no longer exists.

Permission modes are BB's own: `full`, `auto` (default), `accept-edits`. There
is no read-only mode, which is why the trust gate is the real protection.

## Inspecting and debugging

```sh
bb slopcop rules                       # list rules
bb slopcop status                      # gh auth, watched repos, poll interval
bb slopcop check <rule> <pr-number>    # match, settle wait, and most recent superseded head
bb slopcop runs [--rule <r>] [--json]  # recent runs and their status
bb slopcop show [run-id]               # the review body a run produced
bb slopcop runs cancel <run-id>        # cancel an unfinished run and stop its thread if started
bb slopcop verify [run-id]             # re-check GitHub and complete the merge-box check
bb slopcop dispatch <rule> <pr> [--force] [--include-draft]
bb slopcop rules edit|enable|disable|rm <rule>
```

`check` explains why a rule did not match and shows waits or supersession.
Use `--settle-minutes` to delay only commit-triggered reviews; readiness and
explicit dispatch do not wait. Polling never reviews a draft;
`--include-draft` on `check` or `dispatch` lifts only that
gate, so trust and conditions still decide, while `--force` lifts all of them.
A draft-time run counts for dedupe: under `once_per_pr` it is the PR's one
review, and under `once_per_head_sha` marking the PR ready on the same head does
not review it again. Every review after a GitHub-verified head, including a
dispatch or the readiness review, covers only the changes since that head.
`--force` re-reviews a head in full, even one that was already reviewed.

## Run statuses

Each review requests a fresh `git-worktree` environment at the captured PR head,
retaining the selected machine rather than reusing its checkout. GitHub's captured
base SHA is included in the review prompt. The agent checks HEAD, tracked-file
cleanliness, and captured base/history before reading the pinned diff and files.
Missing head objects cause provider failure, not fallback to the project checkout.

Managed setup hooks and include copying still run. This is not a hermetic input
receipt: the agent must carry out the checks. On an input-check failure it returns
plain `Review incomplete: <reason>`, without posting, a header, or a marker.
SlopCop records that result as `cancelled`, never as a clean review, including
when recovering a finished thread after reload. `--head` waits for that live PR
head to be observed; it does not select a historical PR version.

`shadowed` (shadow review produced, nothing posted) · `commented` (verified on
GitHub by marker) · `commented_partial` / `commented_unmarked` /
`commented_unattributed` (posted but attribution degraded — the prompt contract
slipped) · `no_comment` (thread finished without posting) · `waiting` (no
review thread has started) · `skipped` (the review did not dispatch, e.g.
because the head was superseded) · `cancelled` (the thread
ended, errored, was retired, or was cancelled before the review reached a
verdict) · `failed` (the review ran and its own result or posting failed).

`failed` is the only one that puts a red `failure` on the head SHA, so a run
with no verdict is `cancelled` instead — including a thread that errors, live
or reconciled — and a cancelled run never dedupes away
a later re-review of the same PR.

A run stays at `reviewing` only while BB still says its thread is working. The
watcher reconciles once on start, so a thread that errored, went idle, or was
archived or deleted while the plugin was down is finished then — errored and
retired threads are cancelled with the reason recorded. `runs cancel` accepts
a waiting or active run and refuses a run that already reached a terminal status.

Every comment SlopCop posts carries a visible `🚨 SLOP COP 🚨` header and a
hidden `<!-- slopcop:… -->` marker; verification polls GitHub for that marker
rather than trusting the agent's transcript. The agent posts anchored findings
inline. SlopCop posts one Conversation body from the agent's final message for
findings outside the current PR diff, or for a clean review. A live agent never
runs `gh pr review`. Later runs on the same PR receive the rule's prior inline
comments to avoid duplicates. GitHub line comments are a title plus two
sentences, not the full review memo.

Live runs also open a GitHub Check named `SlopCop` on the head SHA
(in progress from dispatch, before the thread is spawned, then completed
from verified comment state). `bb slopcop verify` re-completes that check
once the thread has finished — it will not close a spinner still in flight.
That is the merge-box row next to CI; the GitHub App avatar is the left-hand
identity. Shadow runs never open a check. A missing Checks permission on the
GitHub App is non-fatal — comments still post.
