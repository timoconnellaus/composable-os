# ADR 0446: `publishable`, without its public half

Status: accepted, 2026-11-21 (stage 41, build step 1). Brings forward part of stage 28's
`publishable` (ADR 0404's planned behaviour). Builds on ADRs [0017](0017-audit-and-change-tracking.md),
[0018](0018-invocation-pipeline-and-gate.md) and [0429](0429-payments-gatekeeper-verified-events-and-refunds.md)
(the shape of `orders:refund`).

## Context
A coach edits a program while clients are training from it. The stage 41 interview decided that a
program has a working copy, published versions, and that an assignment follows a version: editing
changes nothing for anyone until a new version is published and assigned. Stage 28 specced the
same behaviour for content the public reads (posts, event pages): a working copy, at most one
published version a reader is served, versions kept, restore, and publishing as its own operation
so a person decides it. Stage 41 comes first and needs only the half without a public.

## Decision

**An object declares `publishable: { content: [fields] }`** (`PublishableSpec` in the SDK;
`PublishableDefinition` in the field registry, carried by the reconciler). `content` names fields
of the object's own that staff edit (not formulas, not read-only ones): what a version keeps. The
record itself is the working copy and is edited with `record.update` like any record, by any
actor the policy allows, the assistant included.

**Versions are rows of `core_publish_version`** (migration 0470): the record, a number from 1, the
content fields' values as JSON (at most 1 MB), when, who and a note, and `current`, at most one
per record (a partial unique index): the version readers are given. Nothing but `record.publish`
writes there.

**Four operations** (`packages/core/src/operations/record-versions.ts`):

| Operation | Who | What |
| --- | --- | --- |
| `record.publish { object, id, note? }` | a person with `records:publish` (`actors: ["human"]`, not on MCP) | the working copy's content becomes the next version, and current |
| `record.versions { object, id }` | staff (`records:read`) | the versions, newest first, without content |
| `record.version { object, id, version? }` | staff (`records:read`) | one version's content; the current one by default; not found when never published |
| `record.restoreVersion { object, id, version }` | staff (`records:write`) | a version's content copied into the working copy, as an ordinary update; no version changes |

Publishing reads the record through the seam, takes the next number from the highest one, closes
the current row and inserts the new one in the operation's batch, and records a change of
`publishedVersion` on the record (so the audit log has it and automations can react to it). Two
publishes at once take the same number; the second batch fails on the primary key and is a
`conflict` with `reason: "published_meanwhile"`.

**Records get two read-only fields, `publishedVersion` and `publishedAt`,** columns of the object's
`rec_*` view joined from the current row (`_pub_version`, `_pub_at`), so lists filter and sort by
them. An object may not declare fields of those names. `rec_publish_version` shows every version
without its content to `query.sql` and dashboards.

**Who publishes: the shape of `orders:refund`.** A permission, `records:publish`, that admins hold
by default and no other role does; and `record.publish` is for the `human` actor only. So no AI
actor publishes, whatever its user's role or its token's scope: not the assistant, not an MCP
client, not an automation, not a pack's tool (the pack's assistant draft, stage 41 step 6, writes a
working copy and stops). An AI may still edit the working copy, as any write the policy allows.

## What is left for stage 28
- **Public reads of the current version.** `when` in the public scope (ADR 0438) gains "has a
  current version", and the public source reads the current row's content instead of the working
  copy. `record.version` is staff-only today; stage 28's `content.get` and `content.list` are the
  public's doors, through the seam, not this operation.
- **States:** draft, scheduled, published, unpublished; the minute cron publishing at a set time;
  unpublishing (`current` set to 0 with the versions kept). This stage has no state on the record:
  "published" means it has a current version.
- **Slugs** and their redirects; **preview links**; **comparing** two versions; cache purges.
- ~~Whether a member may publish.~~ Settled at review: a human admin grants `records:publish` to a
  member (ADR 0449); still never to an AI actor.

None of these changes the table, the four operations or the fields above.

## Why
- A version is a snapshot, not a log of changes: what was published must be what an assignment
  reads, byte for byte, whatever happens to the working copy. The audit log's diffs are history,
  not something a reader is served.
- One table for every publishable object, keyed by object and record, so the host finds the
  versions whatever an extension called its fields, and stage 28 builds on it rather than beside
  it.
- A person decides what people are given. Making that a permission and an actor rule, rather than
  a policy preset, means no preset, floor or admin setting can let an AI publish.

## Consequences
- Publishing costs two statements and one read beyond the record's own load. A version holds at
  most 1 MB; a program's layout is at most 512 KB (ADR 0445).
- Versions are kept when a record is deleted (Trash), as stage history is. Purging extension
  records is not built yet; when it is, a record's versions go with it.

## Amendment, 2026-11-22 (stage 28, ADRs 0441 to 0443)
The public half is built. `publishable` also takes `slug` and `date`. Records also get
`publishState` and `publishAt`, read from the versions and a new `core_publish_schedule` table
(migration 0460), so "nothing but `record.publish` writes there" now reads: only
`records/publish.ts` writes there, for `record.publish`, `record.publishDue` (the minute cron,
publishing what a person scheduled) and `record.unpublish`. The table, the four operations above
and the two fields are unchanged. `record.publish` fills an empty `date` and refuses a record with
no slug. See [ADR 0441](0441-publishable-states-schedules-and-versions.md),
[ADR 0442](0442-what-the-public-reads-of-content.md) and [ADR 0443](0443-preview-links.md).
