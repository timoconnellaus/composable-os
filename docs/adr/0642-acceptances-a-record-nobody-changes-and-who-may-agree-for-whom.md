# ADR 0642: Acceptances: a record nobody changes, and who may agree for whom

Status: accepted, 2026-11-23 (stage 44, build step 2). Builds on
[ADR 0640](0640-agreement-documents-versions-nobody-changes-published-by-a-person.md) (versions),
[ADR 0641](0641-agreement-points-a-pack-declares-documents-a-person-attaches.md) (points, amended
below for `agreementsDue`), [ADR 0540](0540-the-family-link.md) (the family link) and
[ADR 0402](0402-staff-and-customers.md) (audiences). Stage 44's spec: "How a person agrees", "The
acceptance record", "Drawn signatures", "Children".

## Context
An acceptance is evidence: of what wording a person was shown, who agreed, how and when. It must
not be editable by anyone, host code included, or it proves nothing. Who may agree for whom is
identity: a child cannot agree for themselves, a guardian only while their family link is live,
and staff never agree for a member (they record a paper form, shown as such). And D1 runs with
recursive triggers off, so the rows an `INSERT OR REPLACE` or `UPDATE OR REPLACE` deletes fire no
delete trigger (the review of step 1).

## Decision
- **`core_agreement_acceptance`** (migration 0851, `aga_…`) holds the version and the hash shown,
  whom it is for, `by` (`self`, `guardian`, `guest`, `paper`), the agent and account, how
  (`typed`, `drawn`, `paper`), the name typed, the channel (`web`, `app` from a device session,
  `paper`; `desk` in step 6), the host's time, and for paper the date on the form, the staff user
  who recorded it, who signed it and a note. It is a core table, in no `rec_*` view.
- **The database refuses any change** to what it says, for every statement shape:
  - an insert over an existing id (so `INSERT OR REPLACE`, `INSERT OR IGNORE` and an upsert are
    refused before any conflict resolution), a change of id, and an `UPDATE OR REPLACE` (the table
    has no unique index but its key, so no allowed update can delete another row);
  - every column but three movements, all host code: its Person set where it was a guest's and
    null (settlement, step 3), or moved to the Person's `merged_into_id` (merge); and who it names
    cleared to null on erase (the Person with `erased_at` set once, the agent, the account, the
    address). Nothing is set back, and an erased acceptance is nobody's again;
  - a delete, except of an erased one (step 8's retention purge) or a guest's with no Person (an
    unpaid order, step 3). No operation updates or deletes one.
- **What the database checks on insert**, whatever the writer: the version is of a live document
  and is its current or a scheduled one, and the hash shown is the version's; a Person-less row
  is only a guest's; a `self` acceptance is refused for a minor (a Person staff marked, or a live
  dependant); a `guardian` acceptance needs a live link from the agent to the Person. The host
  also recomputes the version's hash (`versionIntact`) and refuses one that does not match.
- **Every acceptance goes through `agreements/accept.ts`**, which checks the version, the capture
  and who may agree, and returns the batch: the `agreements` guard (below), the row, the
  signature, the answers (ADR 0643), a guardian's `core_person_link_guard`, and a health "yes"'s
  notice. The paths in this step: `me.agreements.accept` (a signed-in customer, for themselves or
  a live dependant; open to `customer`, `hostInternal`) and `agreement.recordPaper` (staff,
  `agreements:paper`, `actors: ["human"]`). A paper acceptance is shown everywhere as "Recorded
  from paper by [staff] on [date]", never as the member's own.
- **A drawn signature is its strokes** (`core_agreement_signature`): integer points in a
  1000 × 400 box, at most 30 strokes, 5,000 points and 32 KB; empty, a dot or too little ink is
  refused. It is personal data: read only by `me.agreements.get` and `agreement.acceptance.get`
  (staff, a person only), never in an error or an audit value.
- **The minor mark** (`core_agreement_minor`): `agreement.setMinor` (staff, `people:link`,
  `actors: ["human"]`). For a minor every attached document is due as for a dependant, and only a
  guardian's or a paper acceptance counts. The host never works out an age.
- **What counts**: `agreementsDue` (ADR 0641 as amended) and the Person tab use one rule
  (`countingAcceptance`): the version has taken effect and is at least the document's
  `agree_from`; a health form's "ask again after" has not passed; a minor's own never counts; a
  Person in the Trash has none.
- **Erase, the Trash purge and merge** do what these tables need now: answers and the minor mark
  are deleted, acceptances kept detached (`erased_at`); merge moves acceptances, and those made
  as a guardian, to the survivor and keeps the mark. The retention purge and the erase screen's
  words are step 8.
- **No AI actor accepts, records paper or sets the mark**: the accept operation is open to
  customers only, the others are `actors: ["human"]`. Staff reads an AI may make
  (`agreement.person`, `agreement.acceptances`, `agreement.due.list`) carry titles, people and
  dates, never a name typed, a signature or an answer.

## Consequences
- Step 3 asks `requireNothingDue` (in `agreements/due.ts`) from the orders pipeline, subscription
  start and the transition engine, and carries the guard it returns.
- A raw writer with database access still cannot rewrite an acceptance; it could insert a forged
  one that matches a real version's hash (SQLite cannot sign). The copy emailed in step 4 is the
  person's own evidence against that.

## Proof
`packages/core/test/agreement-acceptances.test.ts`: every column and statement shape refused by
raw SQL (updates, `UPDATE OR REPLACE` onto another id, `INSERT OR REPLACE`, `INSERT OR IGNORE`,
`ON CONFLICT DO UPDATE` and `DO NOTHING`, delete), the host's batch too; a hash other than the
version's and a replaced version refused; a forged, non-intact version refused; signatures and
answers refused any update or delete; a guardian's acceptance, its link ended before the commit
failing the batch; a dependant's and a marked minor's own refused by the operation and the
database; paper naming its staff user, refused to every AI actor and to staff without the
permission; erase and merge.
