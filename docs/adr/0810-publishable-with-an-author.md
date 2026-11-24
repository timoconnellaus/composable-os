# ADR 0810: Publishable with an author: author-only fields, no slug, publishing only in listed states

Status: accepted, 2026-11-24 (stage 54, build step 1, platform piece P1). Amends ADRs
[0442](0442-what-the-public-reads-of-content.md) and
[0446](0446-publishable-without-its-public-half.md); builds on ADRs
[0402](0402-staff-and-customers.md), [0414](0414-pack-tools-run-as-the-customer.md),
[0438](0438-the-public-scope.md), [0441](0441-publishable-states-schedules-and-versions.md) and
[0480](0480-an-ai-asks-to-publish-a-person-approves.md).

## Context
A review (stage 54) is two things at once: a Person's own record, which they write, change their
mind about and withdraw, and content the public reads once a person the business trusts approves
it. The contract refused both halves together: a publishable object could not declare a
`customer` (what outsiders read of it is its published version), an object could not declare
`customer` and `public`, and a publishable object the public reads had to name a slug. A review
also has no address of its own, and must never be publishable without its author's consent, nor
stay published once withdrawn. Decision 3 of the stage says staff never correct, shorten or change
a review: what is published is the author's words or nothing.

## Decision

**A publishable object may declare a `customer`, its author.** The author reads and writes their
working copy through the customer scope, as on any customer object (ADR 0402); `public` may be
declared beside it, and the public, and anyone who reads as the public (`content.list`, whoever
calls it), read only the published version through the live view (ADR 0442). A signed-in customer
who is not the author reads through the customer scope too, so sees only their own records there:
the published reviews of others are read through `content.list`. Such an object:
- declares **no slug** (its records are listed, not addressed) and no `customerVia`;
- may not list its customer field in `public.read`: the public never reads whose it is;
- may keep **read-only fields as content** (a formula still not): with an author, content is the
  author's and what the host sets beside it (what a review is about), not "what staff edit".

**No slug: listed only.** A publishable object the public reads no longer has to name a slug.
Without one, `content.list` lists it and `content.get`, `content.preview` and
`content.previewLink` answer it as an object that is not content, with the one not-found.

**Author-only fields.** The fields in `customer.write` of a publishable object, but its states
field, are the author's alone. The record code every write of an extension record goes through
(`prepareValues` in `operations/record.ts`, so `record.create`, `record.update`,
`record.createMany`, `record.import`, `record.restoreVersion` and any extension tool) refuses them, `forbidden` with
`reason: "author_only"` naming the field, to any staff-side caller: a person of any role, the
assistant, an MCP client, an automation, and the declaring extension's own code (which may write its
read-only fields). An AI's request is refused in its dry run, before it can be queued. The author's
own write passes: it comes from outside the org through the seam (`my.update`, a pack's tool run
as the customer, ADR 0414), which holds it to their own record and their writable fields. Platform
code writing as the host (`by: "host"`) passes, as it does for read-only fields. `schema.objects`
shows the author's fields as read-only. Staff still publish, unpublish and move the record's
states: those are not the author's fields.

**Publish only in listed states.** `publishable.publishIn` names values of the object's `states`
field (`cos ext check` refuses an unknown one, or `publishIn` on an object with no states). In
`records/publish.ts`:
- `record.publish` and `record.schedulePublish` refuse a record in any other state
  (`invalid_input`, `reason: "not_publishable_state"`, with the states);
- `record.publishDue` drops a schedule whose record has left them, publishing nothing;
- a write that sets the state field to a state outside them (a review withdrawn, consent taken
  back, by the author, staff or the host) unpublishes the record in the write's own batch: no
  version is current, the versions are kept, any schedule is dropped. The change bumps the
  object's content generation as any change does, so no cached answer serves it after.

The SDK's test harness (`publish` in `createTestHost`) refuses outside `publishIn` too.

## Why
- One record published as written, rather than a staff-made copy (the stage's rejected options):
  the rule that keeps a quote the author's is then a rule of the record code, enforced where every
  write passes, not of a pack's tool or a screen (ADR 0404: rules live in the host).
- A refusal by actor kind, not by role or grant: no preset, grant or role lets anyone on the staff
  side change an author's words, and an approval can only refuse what it could not apply.
- Unpublishing on leaving the states, rather than relying only on `public.when`: a withdrawal
  must take the quote down whatever else the object declares, and a record taken down by its
  author comes back only by a person's new publish of what they then see. `when` still holds
  beside it, so a published record outside the listed states is never read in between.
- No slug for an object with an author: a slug is staff's to write (`records/slug.ts`) and would
  be a second, public handle on a Person's record.

## Consequences
- A review whose author changes consent to "no" and back to "yes" is off the website until a
  person publishes it again. The stage spec described consent taken back as leaving through
  `when` alone; this is stricter, and recorded in the stage's build.
- A staff `record.create` of an object with an author fails as soon as it names an author's field:
  such records are made by their author (stage 29's door) or by the host.
- A signed-in customer reads other authors' published records only through `content.list`, not
  through `public.list` or `public.get` in a pack's tool: their scope on the object is their own.
- Leaving the listed states costs four statements in the write's batch (the unpublish's), on a
  write that sets the state; none otherwise.

## Proof
`packages/core/test/publishable-author.test.ts`: the declaration accepted and each refusal held by
the SDK and the host; the author writes and reads their own working copy and another customer
finds nothing; a staff update of each author's field, a staff create, an import and a restored
version refused, a staff note and a staff state move allowed; the assistant and an MCP client
refused, with nothing queued; a private review's publish and schedule refused, a consented one
published and listed with only its declared fields, a later change of the shown name not public
until published again, `content.get` not found; consent taken back and a withdrawal (the
author's and staff's) unpublishing in the batch, the versions kept; a schedule of a record moved
out dropped when due; and another customer's and the public's reads (lists, hostile filters on the
staff note and the author, a guessed address, a private review's id) carrying nothing but the
published version's declared fields. With the author check and the unpublish on leaving both
removed, 4 tests fail (restored after).
