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
been published, only an admin's or a holder of `manage`. The procedure's `reviewEvery`.

**The notices (amends ADR 0702).** `acknowledge.owner` names a user field; `acknowledge.notices`
holds the pack's words (`asked`, `reminder` with `afterDays`, `outstanding`, `welcome`; `{record}`
is the record's title). The host sends them as `system.message` notifications, each keyed in
`core_notifications_dedupe_idx` so none is sent twice:

| Notice | When | To |
| --- | --- | --- |
| `asked` | a version that asks everyone goes live, in the publish batch (`record.publish`; `record.publishDue` for a scheduled one) | every live account the record's must read names, once a version |
| `reminder` | still to read `afterDays` after the version asked, or after the account was made if later (within 30 days of falling due) | that person, once a version |
| `outstanding` | each week while anyone has not confirmed | the record's owner: the names when the owner manages the object (decision 13), a count otherwise |
| `welcome` | an account made in the last 7 days with records to read | that person, once, listing them |

The last three are `ack.due`, the minute cron's host step (`runAckDue`), once a local day from
07:00, marked in `core_staff_run` (`ack.notices`) as the roster's daily notice is.

**Read status from the pack (amends ADR 0702).** `ack.status` and `ack.overview` take
`actors: ["human", "extension"]`, and `managedObjects` reads the person as `personCalling` does: a
person's own call, or a person-only tool of the shipped, active pack that owns the objects,
called by a person (its verified caller), which then reads that pack's objects only and as that
person would. Any other extension's call, an automation and an AI actor manage nothing. This is
what ack.confirm and ack.mine already allowed; the rows still reach no `rec_*` view, and the
tool's answer goes only to the person who called it.

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
