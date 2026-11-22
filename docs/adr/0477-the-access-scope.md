# ADR 0477: The access scope and the holders' parts of a document

Status: accepted, 2026-11-22 (stage 42, build step 3). Builds on ADRs
[0401](0401-platform-packs-screens.md) and [0404](0404-behaviours-are-the-vocabulary.md) (rules
live in the host), [0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md)
(grants, voided on a full refund), [0438](0438-the-public-scope.md),
[0439](0439-what-a-customer-reads-through-their-own-records.md), [0445](0445-the-document-field.md)
and [0447](0447-the-signed-in-scope.md). With ADRs [0475](0475-video-and-file-media-in-stream.md)
and [0476](0476-signed-playback.md).

## Context
A course's outline is public in its lesson titles and for those who paid in its lessons' videos
and text. The seam had scopes for a customer's own records, the public, every signed-in customer
and records one's own point to, and none for "a customer who has paid for this". The spec
(section 3) asks for one: sources declared as a list, asked by one question, enrolments and
bundles as the first two sources, a test proving a third kind (stage 32's subscriptions) needs no
change to the seam, and a node flag beside `private` so a document's parts can be for holders.

## Decision

### The declaration
```
access: {
  sources: [
    { via: "courses.enrolment", field: "course", states: ["active"], until: "until" },
    { via: "courses.enrolment", field: "bundle", through: "courses", states: ["active"], until: "until" },
  ],
}
```
- A **record source** (named by `via`) is one of the caller's own records of another object of
  the same extension that declares a customer (its customer field is the caller's Person), live
  (not in the Trash), in one of `states` (required when `via` has a lifecycle), before its `until`
  when that is set (a date counts through its day; a datetime until its moment; empty is no end),
  and pointing at the record through the single relation `field`, or, with `through`, at a record
  whose field `through` lists it: a many relation, or a document whose refs name it.
- **What a bundle lists is its published version** when the public reads that object as
  published: a course added to the working copy reaches buyers once a person publishes the
  bundle, and one removed stops then (the stated default, "read live", as of the published
  version; editing a draft gives nobody anything).
- **The void state gives nothing.** The SDK refuses a source whose `states` name the state a
  sellable grant of `via` is voided to on a full refund (ADR 0435), so a refund ends access in the
  refund's own batch, with no read of orders.
- **Other kinds** of source are the host's: `{ kind: "<name>", options }`, provided by
  `registerAccessSource(kind, { holders, problems })` in platform code. The host refuses at install
  a kind it does not provide. Stage 32 adds `subscription` this way.
- Only shipped extensions and an org's own may declare `access`: a runtime extension is refused,
  as for `customer`, `public`, `signedIn` and `customerVia`.

### The one question
`holdsAccess(reader, object, ids)` (`visibility/access.ts`): of these records, which the caller
holds. Staff hold every record; the public none; a customer those any source gives them, asked of
each kind in turn for the ids still open. It is asked once per page by the seam's reads
(`listVisible`, `getVisible`, so `my.list`, `my.get`, `public.list`, `public.get`), and by
`media.play` and `media.serve` (`outsiderShown`) for an item a version shows only in a holders'
part. A block, a hook and a client app are told the answer by what they are given and nothing
more. `my.get` and `my.list` now read an object that declares `access` (the spec's criterion 7
asks for a customer's `my.get` of a course), with the public scope's rows and fields.

### The holders' flag
On a document's object node, beside `private`: `holders: true | { unless } | { keys, unless? }`.
`true` (or `{ unless }`) removes the whole object for a reader without access, as `private` does
for every outsider; `{ keys }` removes only those keys (a lesson's `video` and `notes`, while its
`key`, `title`, `duration` and `preview` stay); `unless` names a boolean key of the object that
keeps it for everyone (a free preview). `private` still wins: a private part is no outsider's,
holder or not. The schema check refuses keys that are not the object's, an `unless` that is not a
boolean key or is itself withheld, and a declared path (a `rec_*` column) through a holders'
part, which a column could not keep from others. `redactDocument(schema, value, { holder })` does
it; `documentMediaReach` reads from it which media each part shows, and `records/publish.ts`
writes that reach with the version (`core_published_media.reach`, migration 0510). Rows from
before 0510 are `all`, as `media.serve` read them; the next publish writes the exact reach.

### Not built: whole fields for holders only
The spec says an object declares "which of its fields, and which parts of a document field" are
for holders. This build does the parts. A whole field for holders would need the source to blank
a column per row with a question that is not one SQL predicate (a bundle's list is read from a
document), and filtering on such a field would then leak; no object in the stage needs one (a
course's holders' material is all in its outline). A field that must be for holders is a holders'
part of a document. Recorded as a deviation; a later need gets its own ADR.

### Where enrolment stops in this step
The platform knows **no enrolment object**. The seam knows only "a record of `via` that declares
a customer, in a state, before an `until`, pointing at the record or at a record listing it". The
Courses pack (step 4) declares `courses.enrolment` (its Person, course or bundle, order, where it
came from, `from`, `until`, `completed`), its states (`active`, `ended`, `void`), and the
course's and the bundle's `sellable.grants` of it; the tests use a fixture extension of that
shape. `from` (access starting later) is not a condition: every enrolment gives access from when
it exists, as the spec has it (no drip). Who may create an enrolment (staff's `enrol`, a paid
line's grant, the import) is the pack's and `sellable`'s, unchanged.

## Proof
- `packages/core/test/access.test.ts`: `redactDocument` with and without access, `private` kept
  out of both; each media item's reach; the schema checks of `holders` and of `access` (states
  named and known, never the grant's void state, `via` a customer's object, `field` a relation,
  `until` a date). Against a fixture course (a free preview lesson, a holders' lesson, a private
  staff note, a trailer), a bundle and enrolments: a holder reads the lesson's video and notes and
  never the staff note; a non-holder, a voided enrolment, a lapsed one and a bundle holder of
  another course read the titles and the preview only; the public the same; a bundle holder reads
  the bundle's course and no other; a course added to a bundle reaches the earlier buyer once the
  bundle is published, and stops when removed; voiding ends access at once; `holdsAccess` itself
  for staff, the public and each customer. `media.play`: the holder plays the lesson's video,
  everyone else gets the one not-found; the preview and the trailer play for anyone; the bundle
  holder plays the bundle's course's video; narrowing to another record is not found; no audited
  call keeps a token; the reach written with the version; a new version's video plays and the old
  one's stops. **Criterion 6:** a fixture kind of source (passes in a setting), registered and
  declared in the test only, gives access to the parts and to `media.play` with no change to the
  seam; a kind the host lacks is refused at install.
- `packages/core/test/isolation-suite.ts` (run by `audiences-isolation.test.ts` directly and by
  `http-isolation.test.ts` over `POST /api/v1/op/<name>`): a holder, a holder of a bundle, a
  non-holder, a voided enrolment, a lapsed one, staff and the public, on `my.get`, `my.list`,
  `content.get`, `record.get` and `media.play`. The suite's generic pass covers `media.play` as a
  newly opened operation.

Each security check removed, the tests fail; restored, they pass (run 2026-11-22 with a script
that changes one line, runs the tests and puts the line back):

| Check removed | Tests that failed |
| --- | --- |
| Who may play: `media.play` skips `outsiderShown` | 8 (a stranger, the public and a non-holder were given tokens) |
| A token is bound to one video: `sub` not the video's id | 4 (the token did not play; the signer's claims) |
| A token expires within the hour: no cap on `seconds` | 1 |
| Holders-only redaction: every outsider read as a holder | 10 |
| A voided enrolment gives nothing: the state condition dropped | 6 (3 directly and over HTTP) |
| An enrolment past its `until` gives nothing: the condition dropped | 5 |
| The one not-found: a refusal answered as `invalid_input` | 8 |
| A holders' part's video for holders only: `reach` not matched | 6 |
| A private part's video for no outsider: its reach written as `all` | 3 |
| What a bundle lists is its published version: the working copy read | 2 |
| Staff play only a ready video: the state check dropped | 1 |
| A record names only a ready video: the check dropped | 1 |

Each count is of `access.test.ts`, `video.test.ts`, `media.test.ts` and the isolation suite run
both ways (70 tests); every one passes with the check restored.

**Not run:** a refund through the payments fake voiding a granted enrolment (the course's
`sellable.grants` is the pack's, step 4; criterion 4 is tested there). The void state's
behaviour is tested here by moving the enrolment to it.

## Consequences
- A customer's read of an object with access costs one more query per page (one per source) when
  the object has a document field.
- Stage 32 registers `subscription` as a kind and lists it in the Courses manifest's sources; the
  seam, the flag and `media.play` do not change.
- `my.get` and `my.list` open on any object with `access`: what they show is still the public
  scope's rows and columns, plus the holders' parts the caller holds.

## Note (2026-11-22)
Stage 32a step 3 registered the `subscription` kind as this ADR said, and Courses declares it on
`courses.course`, with no change to the seam, the flag or `media.play`; stage 42's access tests
run unchanged ([ADR 0488](0488-the-subscription-access-source.md)).
