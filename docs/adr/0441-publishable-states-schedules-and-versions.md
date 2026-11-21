# ADR 0441: `publishable` completed: states, scheduling, unpublishing, comparing

Status: accepted, 2026-11-22 (stage 28, build step 2). Completes
[ADR 0446](0446-publishable-without-its-public-half.md); builds on ADRs
[0018](0018-invocation-pipeline-and-gate.md) and [0425](0425-one-transition-engine-for-stages-and-states.md).

## Context
ADR 0446 built a working copy, versions, `record.publish` (a person with `records:publish`, never
an AI actor) and restore, and left for stage 28 the four states, publishing at a set time,
unpublishing and comparing. The spec says the cron publishes "when it passes, through the
operations pipeline", and that stage 25's `states` is used if present.

## Decision

**The state is read, never kept.** A publishable record's `publishState` is a column of its
`rec_*` view: `published` when it has a current version, else `scheduled` when a publish is
scheduled, else `unpublished` when it has versions, else `draft`. `publishAt` is the scheduled
time. Both are read-only registry fields (`PUBLISHED_FIELDS`, beside `publishedVersion` and
`publishedAt`), so lists, views and filters use them. They are not a `states` machine: a state
stored beside the versions could disagree with what the public is given, and no move between
them is a person's choice of a select value. This is a deviation from the spec's "moves to
`states` later": the states are facts about versions and the schedule.

**Scheduling takes the snapshot when a person schedules.** `record.schedulePublish { object, id,
at, note? }` (`records:publish`, `actors: ["human"]`, not on MCP, as `record.publish`) checks the
record as `record.publish` does and stores the content fields as they are now in
`core_publish_schedule` (migration 0460), one row per record; scheduling again replaces it. `at`
is in the future and at most 366 days ahead. The minute cron (cos-runner's `minuteTick`, through
`runPublishDue`) calls `record.publishDue` as an automation (the system user, origin `system`),
which makes each due row the record's next current version in the published-by name of the person
who scheduled it, and deletes the row. So what goes live is what a person decided on: an edit
after scheduling, by anyone, the assistant included, waits for the next publish. The spec could be
read as snapshotting when the cron runs; that would let a later AI edit go live with no person
deciding it. `record.publishDue` takes no record and no content in its input: it publishes only
what a person scheduled. A record deleted meanwhile loses its schedule.

**`record.cancelSchedule`** drops a schedule; **`record.unpublish`** (`records:publish`, a person)
leaves no version current and drops any schedule, keeping every version, so it can be published
again. Publishing now drops a schedule too. Each records its change (`publishedVersion`,
`publishAt`) for the audit log and automations.

**The date a reader is shown.** `publishable.date` names a date or datetime field among the
content. Publishing (now, or when scheduling, with the scheduled time) fills it when it is empty,
in the version and in the working copy (an ordinary update), and keeps it when it is set: an
imported post keeps its date.

**A publishable record needs its address.** With `publishable.slug` declared, publishing or
scheduling a record whose slug is empty is refused (`slug_required`). Slugs are ADR 0442's.

**Comparing.** `record.compareVersions { object, id, from, to? }` (staff, read) lists each content
field that differs between two versions, or a version and the working copy, with both values.

**Only `records/publish.ts` writes the two tables.** `record.publish`, `record.publishDue` and
`record.unpublish` share its statements; `core_publish_schedule` is erased like the versions are
(a scheduled snapshot that mentions an erased person loses it).

## Proof
`packages/core/test/content.test.ts`:
- Criterion 2: a post is a draft and not found; scheduled an hour ahead it is `scheduled`, its date
  filled with the time, still not found; edited after scheduling; the cron a minute later
  publishes nothing; an hour later it publishes the scheduled snapshot (not the later edit), and the
  public reads it; unpublished it is `unpublished`, not found and not listed, its version kept;
  published again it is read. Scheduling and unpublishing are refused for the assistant, an MCP
  client, an automation and a member; a time in the past is refused; cancelling and publishing now
  drop a schedule.
- Criterion 3: two publishes keep two versions; comparing 1 with 2 and 2 with the working copy names
  the fields that changed; restoring version 1 changes the working copy and the public still reads
  version 2.
- `packages/core/test/publishable.test.ts` (ADR 0446's) passes unchanged.

## Consequences
- An existing publishable object (Programs) gets `publishState` and `publishAt` when it is next
  reconciled (an install or upgrade of its pack): the view is rebuilt then.
- Publishing at a set time is as late as the next minute tick, and later while the kill switch is
  engaged (ADR 0164): the published time is when it went live.
- **Criterion 12 is not met by this design as it stands**, and is left for the Content pack
  (step 6): ADR 0446 makes `record.publish` a person's only, so an AI actor's publish is refused
  (`forbidden`), not queued for a person. Queueing it would need an AI actor allowed to call it
  with the gate's approval always required. The door is open: publishing is its own operation
  with its own permission and risk class.

## Amendment, 2026-11-22 (criterion 12, ADR 0480)
Criterion 12 is met. The owner decided that an AI actor may ask for a publish and that a person
always approves it. `record.publish`, `record.schedulePublish`, `record.unpublish` and
`record.cancelSchedule` now take every actor and are always reviewed for every actor but a person
(`alwaysReview`), so the assistant, an MCP client, an automation or an extension asking is queued
under every preset and floor, and the adjudicator never approves it. "Refused for the assistant, an
MCP client, an automation" in the proof above now reads: queued for a person. Only a person holding
`records:publish` approves; the request is refused on approval when the working copy, the live
version or the schedule changed since it was asked for. A scheduled publish keeps who approved it
and who asked (`core_publish_schedule.requested_by`, `requested_via`, migration 0520) and carries
them to the version the cron publishes. See [ADR 0480](0480-an-ai-asks-to-publish-a-person-approves.md).
