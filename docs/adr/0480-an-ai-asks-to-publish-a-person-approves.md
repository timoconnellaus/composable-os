# ADR 0480: An AI actor asks to publish; a person approves

Status: accepted, 2026-11-22 (stage 28 criterion 12, decided by the owner; `feat/ai-publish-requests`).
Amends ADRs [0441](0441-publishable-states-schedules-and-versions.md) and
[0446](0446-publishable-without-its-public-half.md). Builds on ADRs
[0018](0018-invocation-pipeline-and-gate.md), [0041](0041-extension-authoring-and-proposals.md),
[0204](0204-policy-adjudicator.md), [0344](0344-agents-as-child-durable-objects.md),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md) and
[0449](0449-permissions-granted-one-by-one.md).

## Context
Stage 28's criterion 12 says an assistant drafting a post over MCP has its publish queued for a
person. ADRs 0446 and 0441 built the four publish operations for the `human` actor only, so an AI
actor's call was refused (`forbidden`), not queued. The owner decided: an AI actor may ask for a
publish; its request always waits for a person to approve it and can never be set to go through
on its own; the same rule for posts and for training programs.

## Decision

**The four operations take every actor, and every actor but a person is always reviewed.**
`record.publish`, `record.schedulePublish`, `record.unpublish` and `record.cancelSchedule` drop
`actors: ["human"]` and declare `alwaysReview: ["assistant", "mcp", "automation", "extension"]`
(`ALWAYS_REVIEWED_PUBLISHERS` in `records/publish.ts`). They are on MCP now (through
`call_operation`; not curated tools). This is the pipeline's existing class for "a person decides,
whatever the policy" (ADR 0041, extension installs), not a new mechanism:

- the pipeline forces a forced operation's `auto` to `review` for those actors before anything
  else, so no preset (cautious, balanced, autonomous) lets one through;
- the deploy floor only makes decisions stricter, so no floor does either;
- the pending action's review source is `always`, which the adjudicator never approves (ADR 0204,
  `decideAction`), however sure and whatever mode;
- an agent's grant (ADR 0344) only tightens: a routed-to-review call keeps `always`;
- the policy itself is a person's to change (`policy.update` is `actors: ["human"]`), and none of
  it reaches `alwaysReview`, which is code.

So "cannot be configured past" is what the gate already does for this class: there is no setting,
preset, floor, grant or adjudicator mode that turns it off. `record.restoreVersion` is unchanged
(it writes the working copy only, any actor the policy allows). `record.publishDue` is unchanged:
the minute cron publishes only what a person scheduled or approved scheduling.

**Who may ask.** The account the AI acts for must hold `records:publish` (its role or a grant,
ADR 0449), checked when it asks and again when the request is applied: an AI cannot ask for more
than its person could do. The MCP `write` scope now carries `records:publish`, so a member coach
granted it can ask from an MCP client; with that scope a client can still only ask.

**Who may approve.** `approveActions` (`approval.approve` and `approval.decide`) refuses a publish
request unless the approver is a person (`actor: "human"`) holding `records:publish` themselves,
by role or grant: the refund rule of ADR 0429. The requester's grant or token scope never stands in
for the approver's, and no AI actor approves, not even the assistant relaying the person's typed
or spoken yes in their own chat: a publish is approved by a press in the Approvals inbox.

**What the approver sees.** A request's diff is the publish's own: `publishedVersion` (live, and
the number it will be), `publishAt` for a schedule, and each content field whose working value
differs from the live one, live before and working after, as summaries (text up to 280
characters; a document as the words of its `text` nodes, cut the same way). The inbox labels them
with the object's field labels. The diff also carries `draftFingerprint`, the SHA-256 of the
working copy's content fields, which the inbox does not show.

**What goes live is what was asked for.** On approval the request re-runs as the AI actor with
the approver recorded, and the publish handler refuses it as a conflict (`changed_since_request`)
unless the working copy's fingerprint, the live version and the schedule time are still what the
request recorded (`assertAskedFor` in `records/publish.ts`). The pipeline's own preview check
compares only a record's first change, which is the filled-in date when a publish fills one, so
the handler makes its own. An edit by anyone after the request, or a publish meanwhile, fails the
request; it is asked for again. A request is also refused when the same session's earlier changes
to the record still wait for a person (`pending_changes`): judged against a working copy that is
not yet there, it would always be stale.

**Who did what.** The version (and a scheduled publish, carried to its version) keeps the person
who approved it in `published_by` (`scheduled_by`), and the request beside it: `requested_by`, the
staff user the AI acted for, and `requested_via`, the actor (migration 0520, also on
`rec_publish_version`). A person's own publish leaves both empty. `record.versions` and
`record.version` return `publishedBy`, `requestedBy` and `requestedVia`. The audit log has the
request's row (the AI actor, gate `review`), the applied row (the AI actor, under the pending
action's id) and the approval's row (the person).

**A person's own publish is unchanged**: at once, for a person with `records:publish`, under any
preset (humans are `auto` everywhere). Its audit diff now also names the content fields that went
live and the fingerprint.

**Programs.** The same rule, since it is the same four operations. ADR 0446's human-only refusal
is gone; the coaches' grants stay as they are. The Programs pack changes no code: `usePublish` and
`usePublishOffered` are a person's controls (the second asks `user.me` what the account holds), and
`x.programs.draft` still writes a working copy and never publishes, after which the assistant may
ask for a publish like any AI actor.

## Removal checks
Each security-relevant check was removed, its tests seen to fail, and restored
(`packages/core/test/publish-requests.test.ts`):

| Check removed | Tests that failed |
| --- | --- |
| `alwaysReview` on `record.publish` | 9 of 13: every preset's queueing, the floor, the adjudicator, approval, both stale tests, who approves |
| The approver is a person (`approveActions`) | who may approve |
| The approver holds `records:publish` (`approveActions`) | who may approve |
| The working copy unchanged since the request (`assertAskedFor`) | both stale tests |
| No request over the session's pending changes | the pending-changes test |

## Consequences
- An AI's publish request is one more item in the Approvals inbox; the adjudicator never takes it.
- A request against a record whose working copy keeps changing (an autosaving editor) will often be
  stale: ask once the edit is done.
- Under the cautious preset an AI's edit of the working copy waits too, and the publish request is
  refused until that edit is decided.
- Opening an operation to `customer` or `public`: none. The four operations stay `staff`.
