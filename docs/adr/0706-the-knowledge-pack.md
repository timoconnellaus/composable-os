# ADR 0706: The Knowledge pack

Status: accepted, 2026-11-25 (stage 38, build step 5; the interview's decisions 1, 2, 5, 8, 9 and
10, and decision 13). Amends ADR [0702](0702-acknowledgements-read-again-and-a-confirmation-nobody-changes.md)
(the declaration's `managed`, `owner` and `notices`; who-has-confirmed read through the owning
pack's person-only tool). Builds on ADRs [0440](0440-rich-text-is-data.md),
[0442](0442-what-the-public-reads-of-content.md), [0446](0446-publishable-without-its-public-half.md),
[0480](0480-an-ai-asks-to-publish-a-person-approves.md), [0570](0570-date-relative-triggers-in-minutes.md),
[0600](0600-a-pack-role-and-its-grants-add-up.md), [0652](0652-a-tool-for-every-staff-account-and-a-tool-held-to-a-core-permission.md),
[0700](0700-the-published-text-index-and-content-search.md) and
[0701](0701-staff-read-of-published-versions-and-its-reach-for-pack-roles.md). No migration.

## Context
Steps 1 to 3 built the platform's half of a knowledge base: the published-text index and
`content.search`, staff read of a published version, and read and understood. Step 5 is the pack
that composes them: staff procedures and public help pages. Three things the pack needs were not
in the manifest: who changes a procedure's review period (a person's, once published only a
manager's, as who must read is), the notices (who must read a version and who has not are the
host's to know, and an extension never reads them), and a review date that follows the last
publish (a formula could not read when a version went live, and a date-relative trigger could not
name a formula).

## Decision

**The pack** (`packs/knowledge`, optional):

| Object | What | Behaviours |
| --- | --- | --- |
| `knowledge.procedure` | title, slug, summary, body (rich text), section, owner (user), must read, review every (months, 12, 0 for never), next review (formula) | `publishable { content: [title, summary, body, section], slug, staffRead, acknowledge }`; no `public`, no `signedIn` |
| `knowledge.section` | name, order | none; staff only |
| `knowledge.helppage` | title, slug, summary, body, topic, order, related pages, search title and description, hide from search engines | `publishable { content: [...all but slug], slug }`, `public.read` of the content, the slug and `publishedAt` |
| `knowledge.helptopic` | name, slug, order, icon (a fixed list) | `public.read: [name, slug, order, icon]` |

Object names are lowercase in the contract: the spec's `helpPage` and `helpTopic` are
`helppage` and `helptopic`.

Permissions: `knowledge:manage` (restricted and grantable: read status, and the `manage` of the
acknowledgement) and `knowledge:write` (grantable, to a pack-role account too, ADR 0600). Tools:

| Tool | Who | What |
| --- | --- | --- |
| `toRead` | every staff account, a person (`anyStaff`, `humanOnly`) | `ack.mine`, this pack's procedures |
| `confirm` | every staff account, a person | `ack.confirm` of the version read |
| `readStatus` | `knowledge:manage`, a person | `ack.status` (one procedure) or `ack.overview` |
| `helpTopics` | staff, customers, the public | `public.list` of the topics, by order |
| `draftProcedure`, `draftHelpPage` | `knowledge:write` (members and admins hold it) | the working copy from notes, made into rich text; never who must read |

The review reminder (`reviewDue`) is a date-relative automation on the next review date: the
owner, else the admins. The client entry (`@composable-os/pack-knowledge/client`) holds hooks over
staff read, the tools and the public content reads.

**Managed fields (amends ADR 0702).** `acknowledge.managed: [fields]`: fields of the object's own,
outside the content, that the host guards exactly as it guards who must read
(`assertMayChangeMustRead`): a person's write only, never an AI actor's, and once the record has
been published, only an admin's or a holder of `manage`. The procedure's `reviewEvery` and its
`owner` (who is told each week who has not confirmed: a member cannot make themselves owner of a
published procedure, and the assistant never sets it).

**The notices (amends ADR 0702).** `acknowledge.owner` names a user field; `acknowledge.notices`
holds the pack's words (`asked`, `reminder` with `afterDays`, `outstanding`, `welcome`; `{record}`
is the record's **published** title). The host sends them as `system.message` notifications, each
keyed in `core_notifications_dedupe_idx` so none is sent twice:

| Notice | When | To |
| --- | --- | --- |
| `asked` | a version that asks everyone goes live, in the publish batch (`record.publish`; `record.publishDue` for a scheduled one); and on a later day, to anyone it asks who was never told of that version (they came into "must read" after it went live) | every live account the record's must read names, once a version |
| `reminder` | still to read `afterDays` after they were told of the version (its `asked`, or their `welcome`), within 30 days of falling due | that person, once a version |
| `outstanding` | each week while anyone has not confirmed, from `afterDays` after the version asked | the record's owner when that account is live and manages the object (decision 13), else the admins (as the review reminder falls back); always the names |
| `welcome` | an account made in the last 7 days with records to read | that person, once, listing them |

**Every notice is the person's only** (`human_only`, ADR 0643): it says who has or has not
confirmed what, which no AI actor may learn (the spec's "What an AI may do"). `notification.list`,
`notification.unreadCount` and `notification.markRead` already leave such notices out for any
actor but a person (the assistant, MCP, an automation, an extension). The daily digest now leaves
them out too (`unreadNotices` in `notifications/delivery.ts`), because the digest is itself a
notification an AI may list and its overview is written by a model; this also closes the gap for
ADR 0643's own notices. The person's own email or Slack copy of a notice, by their preferences, is
unchanged: it goes to that person.

**The daily run is bounded.** The last three notices (and the late `asked`) are `ack.due`, the
minute cron's host step (`runAckDue`), from 07:00 local. A run reads the live staff once, then per
acknowledged object its published records, the confirmations of those records only and their
owners, then which of the notices it would send exist already (one read per 400, joined on the
dedupe index). It writes at most `ACK_NOTICES_PER_RUN` (300) notices, a hundred to an INSERT over
`json_each`, with no read per recipient (the accounts are live staff already). A day with more
carries on at the next tick, skipping what was sent; the day's marker (`core_staff_run`,
`ack.notices`) is written only in the batch of the run that finishes it, so a run that fails is
tried again and never marks the day done.

**Read status from the pack (amends ADR 0702).** `ack.status` and `ack.overview` take
`actors: ["human", "extension"]`. From an extension, `managedObjects` checks, as
`record.readRestricted` does: the calling tool is a person-only tool of the shipped, active pack
that owns the objects; a person called it (its verified caller, not an AI acting for one); the
call was not started by a person approving another actor's (`startedByApproval`); and the tool
names the object's `acknowledge.manage` permission and no other, so the pipeline held the caller to
it. It then reads that pack's objects only, as that person would (an admin, or a live account
without a pack role granted `manage` while a shipped pack declares it grantable). Any other
extension's call, an automation and an AI actor manage nothing. The rows still reach no `rec_*`
view; what the pack's tool does with its answer is the pack's code, reviewed as shipped code is.

**Formulas on the published date.** A formula of a publishable object's own field may read
`publishedAt` and `publishedVersion` (the rec_* view's join of the current version), on the host
(`formulaEnvironment`) and in the check (`objectFormulaEnvironment`, `PUBLISHED_FORMULA_FIELDS`).
Empty while the record is not published. A date-relative trigger may name a formula field whose
value is a date or a datetime: the daily scan reads its rec_* column as for any date field.

**What the manifest still cannot say.** Pictures in a procedure are not served to a pack-role
account (`media.serve` is outside its reach, ADR 0701); the spec's decisions do not settle it, so
it stays as it is. A pack-role account cannot read a section's name (it reaches only staff-read
objects); the reader (step 6) shows a procedure's section to a full role only, or a later step
makes sections staff-read.

## Removal checks
Each check was removed, its tests seen to fail, and restored:

| Check removed | Tests that failed |
| --- | --- |
| `managed` in `assertMayChangeMustRead` | apps/runner/test/knowledge.test.ts: who must read and the review period are a manager's once published, never an AI's |
| The must-read filter of the `asked` notice | apps/runner/test/knowledge.test.ts: everyone who must read it is told, and nobody else |
| `human_only` on the notices | packages/core/test/acknowledge-notices.test.ts: every notice is the person's only (M1) |
| `human_only = 0` in the digest's unread notices | packages/core/test/daily-digest.test.ts: never lists a notice for the person only |
| The cap of a run | acknowledge-notices.test.ts: a large day is written a few hundred at a time |
| The published title in `dueRecords` | acknowledge-notices.test.ts: welcome once, remind once … (the reminder's and `ack.mine`'s title) |
| `ack.due`'s system-surface check | acknowledge-notices.test.ts: is the host's only |
| `owner` guarded (`managed` in `assertMayChangeMustRead`) | acknowledge-notices.test.ts: the owner (F3) |
| That pack's objects only, the tool naming `manage`, `startedByApproval` in `managedObjects` (each) | acknowledgements.test.ts: from a pack's tool, only that pack's objects … |

## Consequences
- A business turns Knowledge on and writes its own procedures and help pages; nothing is shipped.
- Any acknowledged object can declare its notices; any publishable object can show a date
  computed from its last publish.
- A pack's own person-only tool can show those who manage who has read what.

## Proof
- `packs/knowledge/test/knowledge.test.ts` (the test host): the contract; each tool's reach and
  calls; notes made into rich text; the reminder to the owner, else the admins.
- `apps/runner/test/knowledge.test.ts` (the real host, with Content, Programs and Bookings): a
  member drafts and cannot publish; a person publishes and exactly who must read is told; a coach
  reads the published wording and not the draft, by id and by search, and not the working copy;
  confirms once; a small fix keeps it and a read-again version asks and tells again; read status
  for a manager and an admin, refused to a member, the assistant and a pack role; the review
  period guarded; the next review a year after the publish and the reminder reaching the owner on
  it; the reminder sent once; a coach writes only with `knowledge:write`; the assistant drafts and
  its publish is a request; the public reads and finds a help page only once published, and never
  a procedure.
- `packages/core/test/acknowledge-notices.test.ts`: the declaration's checks; the formula and the
  trigger; the asked notice, scheduled too; the managed field; the day's notices (once, names to a
  manager only, welcome once); `ack.status` refused to an automation.
- `packages/core/test/acknowledgements.test.ts`: who-has-confirmed through the owning pack's
  person-only tool only.
