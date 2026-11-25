# ADR 0702: Acknowledgements: who must read, read again and small fix, a confirmation nobody changes

Status: accepted, 2026-11-24 (stage 38, build step 3; the interview's decisions 2, 3, 8 and 9).
Amends ADR [0480](0480-an-ai-asks-to-publish-a-person-approves.md) (the request card shows the
choice and the approver makes it) and ADR [0436](0436-pack-roles-and-the-door-role.md) (two
operations every pack role reaches). Builds on ADRs [0446](0446-publishable-without-its-public-half.md)
and [0441](0441-publishable-states-schedules-and-versions.md) (versions),
[0449](0449-permissions-granted-one-by-one.md), [0600](0600-a-pack-role-and-its-grants-add-up.md)
and [0625](0625-restricted-pack-permissions.md) (grants and restricted permissions). Migration 0971.

## Context
A business's procedures ("what we do when someone is hurt") must be confirmed as read and
understood by the people they concern, with one tap, and the owner must see who has and who has
not. A typo fix must not ask everyone again; a changed step must. Agreements (stage 44) were
weighed and rejected in the spec: they are a customer's evidence, keyed to a Person, checked at
checkout. This is a staff account's statement about a version of a publishable record, so it is
a small addition to `publishable`, for every object that wants it, enforced by the host.

## Decision

**The declaration.** `publishable.acknowledge: { who, manage }`. `who` names a `document` field
of the object's own, outside `content`, whose schema is the SDK's `MUST_READ_SCHEMA`:
`{ everyone: true }`, or `{ everyone: false, roles: [...] }` with each entry a staff role
(`admin`, `member`, `viewer`), a pack role (`<pack>.<role>`) or a pack permission an admin grants
(`<pack>:<word>`), at most 50. `manage` names a permission of the extension's tools that it
declares both `restricted` and `grantable` (ADR 0625). An acknowledged object declares no `public`
or `signedIn` (and, as every publishable object, no customer). `cos ext check` holds these.

**Who must read**, decided by `records/acknowledge.ts` on the day: every live person's account
(`kind` human, not deactivated) that "must read" names: everyone; a staff role, for an account
without a pack role (a pack role's account's own role grants nothing, ADR 0436); its pack role; or
a permission granted to it. An account that joins later has the record to read; a deactivated one
has nothing to read and keeps its confirmations; a change of role, pack role or grant counts from
that moment. Only published records ask anyone: an unpublished one is in nobody's list. "Must
read" is not content: a change takes effect at once, without a publish.

**Read again and small fix.** Each version of an acknowledged record keeps its publisher's choice
(`core_publish_version.read_again`; NULL on other objects). The first version always asks (`false`
is refused). After it, `record.publish` and `record.schedulePublish` refuse a publish that does not
say (`readAgain` required); an object that is not acknowledged refuses one that does. A scheduled
publish keeps the choice (`core_publish_schedule.read_again`) for the version the minute cron
makes, and asks nobody until then; one scheduled before the object was acknowledged asks.
**A confirmation counts** when it is of a version at or after the latest that asked again (a
version from before the object was acknowledged counts as asking).

**The request card (amends ADR 0480).** An AI's publish request must carry `readAgain` like a
person's publish, and its diff shows it (`readAgain: { before: null, after }`). The Approvals
inbox shows it as a choice, not a field line, with the suggestion chosen to start with;
`approval.approve` and `approval.decide` take `readAgain` by action id, and approving applies the
approver's choice in place of the suggestion (an assistant relaying a yes makes none; a publish is
a person's approval anyway). The working copy's fingerprint check is unchanged: the choice is not
content.

**A confirmation nobody changes.** `core_publish_ack` (object, record, version, account, when,
`how` = `self` only), keyed by all four. Triggers refuse an insert for a version that is not the
record's current one, for an account that is not a live person's, or for a key that already has a
row (so `INSERT OR REPLACE`, which deletes without the delete trigger, cannot rewrite one), every
update, and every
delete while the account and the version both exist: it goes only with the account's erase or the
record's purge, neither of which deletes these rows today (no staff-account erase exists yet; it
must remove them when it does). Kept through deactivation and unpublishing.

**The operations** (`operations/ack.ts`), audience `staff`. `ack.confirm` and `ack.mine` take
`actors: ["human", "extension"]`: an extension's call counts only from a `humanOnly` tool of the
**shipped, active pack that owns the object** (`ctx.extension.id` is the object's extension),
called by a person (its verified caller, `ctx.extension.tool.calledBy`, never input), so a
pack's confirm button is the person's act and no other extension's tool confirms or lists for
them (`ack.mine` from a tool lists only that pack's objects). `ack.status` and `ack.overview` are
`actors: ["human"]`: no extension reads who has confirmed, so the rows never reach an `x_*` table.
No AI actor or automation reaches any of them.

| Operation | Who | What |
| --- | --- | --- |
| `ack.confirm { object, id, version }` | the person themselves, pack roles included | One row. A record not published, or one "must read" does not name the caller in, is the same not-found as a record that does not exist (nothing about it, not its version, is told); then refused for a version that is not current, and a second time |
| `ack.mine {}` | the person themselves, pack roles included | What is to read (current version, since when) and what was confirmed (when) |
| `ack.status { object, id }` | admin, or a grant of `manage` | For the current version: everyone who must read, the confirmation that counts and when, the latest one, and since when for who has not |
| `ack.overview {}` | admin, or a grant of `manage` | Every published record of the objects the caller manages: how many must read, how many confirmed |

`ack.mine` and `ack.confirm` are the two core operations every pack role reaches
(`PACK_ROLE_OWN` in `pack-roles.ts`; `roles.json` in the API contract lists them for each role):
a cleaner, a coach and the door confirm their own procedures and nothing else opens. A grant of
`manage` counts only while an installed, active, shipped pack still declares it grantable, and
never for an account holding a pack role, whatever it is granted (`managedObjects` refuses it,
ADR 0600).
The rows are in no `rec_*` view: dashboards, `query.sql`, exports and the assistant's record reads
never reach them.

**Who changes who must read.** A person only: an AI actor's create or update that sets "must
read" is refused (an approved request too). Once a record has been published, only an admin or a
person granted `manage`. Setting it to what it already is changes nothing and is not refused.

**What is not in this step.** The `to_read` roster warning (step 4), staff reads of the published
version (`content.staffGet`, step 2: until then a pack-role account confirms what it was shown
elsewhere), the notices (step 5's pack words, the host's `notification.send`), and the Knowledge
pack itself (step 5) with its `knowledge:manage` and `knowledge:write`.

## Removal checks
Each check was removed, its tests seen to fail, and restored (`packages/core/test/acknowledgements.test.ts`):

| Check removed | Tests that failed |
| --- | --- |
| `PACK_ROLE_OWN` (the pack roles' reach) | who must read; pack roles |
| The guard on writing "must read" (`assertMayChangeMustRead`) | is changed by a person, by one who manages, never by an AI |
| The owning, shipped pack in `personCalling` (review of PR #340) | only a person-only tool of the shipped pack that owns the object |
| The pack role in `managedObjects` | an account holding a pack role manages nothing |
| The trigger's existing-key check | not even by INSERT OR REPLACE |

## Consequences
- Any publishable object can ask staff to confirm what it says; Knowledge's procedure is the
  first (step 5).
- Publishing a later version of an acknowledged record takes one more choice, in the admin's
  publish card and in the Approvals inbox.
- Whether a tap is enough evidence that someone was told a procedure is for the business to
  confirm with its lawyer or insurer; the host keeps the row, its version and its time for good.

## Proof
- `packages/core/test/acknowledgements.test.ts`: the contract's refusals; the first version asks,
  later ones must say, a non-acknowledged object takes no choice; a small fix keeps confirmations
  and a read-again version asks again; a scheduled read-again asks nobody until live; confirming
  is a person's, once, for the current version; the rows refuse update, delete and a non-current
  insert at the database; must read by staff role, pack role and grant, on the day, losing nothing
  on deactivation; who changes must read; `ack.status` and `ack.overview` exactly, refused to a
  member without the grant and to AI actors; a cleaner confirms and is refused everything else; an
  AI's request shows its suggestion and the approver's choice is what goes live.
- `apps/app/test/approvals-describe.test.ts`: the suggestion is read from the diff and not shown
  as a field line.

## Amended 2026-11-25: managed fields, the notices, and read status from the owning pack (ADR 0706)

- `acknowledge` gains `managed` (more fields of the object's own, outside the content, guarded as
  who must read is: a person's, once published only a manager's), `owner` (a user field) and
  `notices` (the pack's words). The host sends them: `asked` in the publish batch, to exactly who
  must read a version that asks; `reminder`, `outstanding` and `welcome` from `ack.due`, the minute
  cron's host step, once a local day.
- `ack.status` and `ack.overview` are now `actors: ["human", "extension"]`. From an extension the
  host checks, as `record.readRestricted` does: a person-only tool of the shipped, active pack that
  owns the objects; called by a person (its verified caller); not started by a person approving
  another actor's call (`startedByApproval`); naming the object's `manage` permission and no other.
  It then reads that pack's objects only, as that person would. This reverses the line above that
  no extension reads who has confirmed (the review of PR #340, finding 2): Knowledge's
  `readStatus` is that tool. Any other extension, an automation and every AI actor still read
  nothing of it, and the rows are still in no `rec_*` view; once read, what the tool does with the
  answer is the pack's shipped, reviewed code.
- The notices are the person's only (`human_only`), so no AI actor lists, counts or reads them in
  the digest (ADR 0706).
