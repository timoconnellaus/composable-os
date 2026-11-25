# ADR 0701: Staff read of published versions, and its reach for pack roles

Status: accepted, 2026-11-24 (stage 38, build step 2). Amends ADRs
[0436](0436-pack-roles-and-the-door-role.md) (three reads every pack role reaches),
[0446](0446-publishable-without-its-public-half.md) (a published version read by staff, not only by
the public) and [0600](0600-a-pack-role-and-its-grants-add-up.md) (a pack role's reach beside its
grants), and [0700](0700-the-published-text-index-and-content-search.md) (staff search of a
staff-read object). Builds on ADRs [0442](0442-what-the-public-reads-of-content.md) (the live view)
and [0889](0889-a-pack-role-limited-to-the-people-its-holder-looks-after.md) (the looks-after
limit). No migration.

## Context
A business's procedures ("what we do when someone is hurt") are read by every member of staff in
the wording a person published, never in the draft being edited. Staff with a full role read every
record's working copy (`record.get`), which is the draft. A pack-role account (a cleaner, a coach,
the door) reads nothing outside its own pack (ADR 0436), so it could not read a procedure at all,
and step 3's `ack.confirm` had it confirm what it was shown elsewhere. Procedures must never be
public (spec criterion 1), so the public's reads (`content.get`, `content.list`) cannot be used.

## Decision

**The declaration.** `publishable.staffRead: true` (the SDK's `PublishableSpec`, carried to the
registry as `PublishableDefinition.staffRead`). It needs nothing else: an object may declare it
with or without `public`, a slug, `acknowledge` or an author. It opens, to every staff account, the
record's **current published version**: its `content` fields and its slug, from the object's live
view (`pub_x_<ext>_<object>`, ADR 0442), with the version number and when it was published. Never
the working copy, never a field outside the content (a "must read", an owner, another extension's
field, a formula), never a draft, an unpublished record or a deleted one.

**The seam's door** (`visibility/staff-read.ts`). `staffReadSource` is the live view with only
`id`, those fields' columns and the two published values; for a caller who is not staff it is the
unknown object. `getPublished` (by id or slug) and `listPublished` (the list's own paging, filter
and sort, on those fields only, so a filter on anything else is an unknown field) read through it.

**The operations** (`operations/content.ts`), audience `staff`, `risk: read`, every actor:

| Operation | What |
| --- | --- |
| `content.staffGet { object, id \| slug }` | The current published version; by an old slug, the record with `redirect` naming its slug now. A draft, an unpublished record, an unknown id or slug, and an object that does not declare `staffRead` are one not-found |
| `content.staffList { object, filter?, sort?, cursor?, limit? }` | A page of published versions, each with its version and date; the object's default sort when it is one of the fields, else newest published first |
| `content.search` (amended) | A staff caller (`onBehalfOf`, else the principal) on a `staffRead` object searches every text content field of the published version and reads the records through `staffReadSource`; anyone else, and staff on any other object, is unchanged (what the public reads) |

An AI actor reads them as the person it acts for would: the assistant reading published
procedures is what the spec allows; it never reads a draft through them.

**The index (amends ADR 0700).** `indexedFields` is now what any reader's search matches: on a
`staffRead` object every text content field, beside what the public reads. A search matches only
its own reader's fields (`searchedFields(object, "public" | "staff")`), so on an object both public
and staff-read a staff-only field's rows are never a public result or snippet. The minute cron's
fingerprint follows the fields, so declaring `staffRead` remakes the object's rows. A staff search
is not cached: the cache's generation follows only what the public reads (ADR 0442).

**The reach for pack roles (amends ADRs 0436 and 0600).** Every pack role reaches
`content.staffGet`, `content.staffList` and `content.search` (`PACK_ROLE_STAFF_READS` in
`pack-roles.ts`), and `packRoleAllows` allows them only when the input names an object that
declares `staffRead`. So a cleaner reads published procedures, and through these reads reaches no
other object: not a blog post's search, not a record's working copy, not `record.get` or
`search.global`. A grant changes nothing here (a grant opens a pack tool, ADR 0600). Under a
looks-after limit (ADR 0889) they pass for an object the limit does not name and are refused for
one it does (fail closed); a today limit (ADR 0553) already refuses an operation it does not know
on an object it limits. `roles.json` in the API contract lists them for each role. As with
`ack.mine` and `ack.confirm` (ADR 0702), they do not depend on the role's pack being installed: an
account whose role holds nothing of its pack is still a staff account, and reads published
procedures (an MCP client acting for it is described these three reads and nothing else).

**Not in this step.** Pictures in a procedure are served by `media.serve`, which a pack-role
account does not reach: a cleaner reads a procedure's words and not its pictures until a reach of
`media.serve` for a picture a published staff-read version shows is decided and reviewed (the spec
lists none). The Knowledge pack's objects (step 5), its screens and the reader (step 6), and
passages for the assistant (step 7).

## Removal checks
Each check was removed, its tests seen to fail, and restored (`packages/core/test/staff-read.test.ts`):

| Check removed | Tests that failed |
| --- | --- |
| `PACK_ROLE_STAFF_READS` in `packRoleReaches` | a pack-role account reads published procedures; only on a staff-read object |
| `namesStaffRead` in `packRoleAllows` (allowing any object) | a pack-role account is refused everything else; only on a staff-read object |
| The staff check in `staffReadSource` | the seam's staff-read source is the unknown object for anyone but staff |
| The reader in `searchedFields` | the public never searches a staff-only field |

## Consequences
- Any publishable object can be read by the whole staff as published; Knowledge's procedure is the
  first (step 5), with `acknowledge` beside it.
- A pack-role account reaches three more core reads, each bounded by the object's declaration.
- Editing a published procedure changes nothing staff read until a person publishes it again.

## Proof
`packages/core/test/staff-read.test.ts`: a draft not found; the published version read by id, by
slug and by an old slug, unchanged by an edit until published again, gone when unpublished; only
the content and the slug; filter on a field outside them refused; an object without `staffRead`
not found; an AI actor reads the published version; the seam's source refused to anyone but
staff; the public and customers refused the staff reads and given not-found for the procedure by `content.get`, `content.list` and `content.search`;
a staff-only field of a public object never found by the public; a fixture pack role and the
shipped `rostering.team`, `bookings.coach` and `ticketing.door` read published procedures and are
refused another object, the public reads, `record.get`, `record.list` and `search.global`; the
looks-after limit. `packages/core/test/screens.test.ts` (the registry walk) and
`packages/core/test/api-contract.test.ts` (the door role) hold the exact reach.
