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
  - every column but these movements (as amended below, 2026-11-23): a guest's Person set to its
    order's Person (settlement, step 3); a Person or guardian moved to their `merged_into_id`
    (merge); and, once the Person or the guardian who agreed is gone from `core_person` (erase),
    who it names cleared and `erased_at` set once. Nothing is set back, and an erased acceptance
    is nobody's again;
  - a delete, except a guest's with no Person (an unpaid order, step 3). Erased ones are kept;
    step 8 adds the retention purge. No operation updates or deletes one.
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

## Amended 2026-11-23: the security review of PR #274

- **What changes what is due bumps the counter**, by trigger in migration 0851 so every writer
  does: a minor mark set or cleared; a family link made, ended, re-pointed or deleted; a Person
  moved to or from the Trash, merged (`merged_into_id`) or deleted (erase, the Trash purge);
  besides every publish, version taking effect, attach, detach and retire (ADR 0640). A batch
  planned from a read before any of them fails on the `agreements` guard.
- **Erasing a guardian** (coordinator decision of 2026-11-23, **owner to confirm**): erasing a
  person treats the acceptances they made as a guardian as their own. The record that a guardian
  agreed, the version and the time stay for the retention period; the guardian, their account,
  their typed name and their drawn signature are cleared; the address stays, as decision 15 keeps
  it for a person's own; `erased_at` is set, so the acceptance no longer counts for the child (a
  guardian or paper agrees again) and step 8's purge covers it. The child's health answers are
  the child's and stay. Erase keeps the address on a person's own acceptances too (the earlier
  text said it cleared it; it never did).
- **Detaching needs the Person gone**: the triggers allow clearing the Person (or the guardian)
  only when that Person has no `core_person` row, so erase and the purge queue the detach after
  deleting the Person. A detach never enables a delete: an erased acceptance is kept.
- **Guests**: a guest's row is inserted with no Person and an order (or subscription checkout)
  that exists, and its Person can be set only to that order's Person (or the checkout's payer or
  holder).
- **A minor never agrees for anyone**: refused by `accept.ts` and the insert trigger.
- **One version once**: `me.agreements.accept` refuses a document not attached anywhere that
  applies to that Person (`agreement_not_asked`), and agreeing again to the same version (with the
  same answers) returns the existing acceptance, writing and sending nothing. Different health
  answers make a new acceptance (a person may update their answers).
- **Paper counts from its date**: "ask again after" counts a paper acceptance from `signed_on`.
- **One rule for what applies** (`appliesTo`): a `dependants` document only when the participant
  is a minor, a `payer` document never to a minor; the Person tab, "before you go on" and
  `agreementsDue` all use it.
- **A merge that moves agreements** (acceptances, as the Person or as a guardian, or the minor
  mark) is a person's act with `agreements:manage`: refused to any AI actor (so never queued for
  approval) and to staff without it.
- **What a raw writer with database access can still do**: insert a forged acceptance for a live
  Person that copies a real version's hash (SQLite cannot sign: the copy emailed in step 4 is the
  person's own evidence); set an order's Person and then attach a guest's acceptance to it; set
  `merged_into_id` on a Person and then move acceptances to it; delete the minor mark or a family
  link (each bumps the counter). **What it cannot**: change what an acceptance says, detach one
  from a Person who exists, delete one (other than an unsettled guest's), insert one for a minor
  themselves or by a minor guardian, insert a guardian's without a live link, a guest's with a
  Person or without a real order, or one of a version not open or with another hash.

## Amended 2026-11-23: the second review of PR #274

- **Two more shapes that would change what is due without a bump are refused**: an update of
  `core_agreement_minor` (a mark is set or cleared, never moved to another Person), and an insert
  into `core_person` over an existing id (`INSERT OR REPLACE` would delete the old row without its
  delete trigger, so a Person could leave or enter the Trash unseen). Refusing was chosen over
  bumping: the host only ever inserts a new Person (`person.create`, a new id) and changes one in
  place, so no host path needs it. `INSERT OR IGNORE` over an existing Person is refused too.

## Amended 2026-11-23: a guest's acceptances (stage 44 step 3, [ADR 0644](0644-enforcement-nobody-pays-or-books-without-what-is-due.md))
`accept.ts` plans a guest's acceptance (`by: "guest"`, no Person, the order or the subscription
checkout, the order's address, channel `web`), queued after the order or the checkout row. They
settle by trigger (migration 0853): to the order's Person once something is paid on it, or to the
checkout's holder (payer for a payer document) once the provider confirms the subscription; an
order that closes unpaid deletes them, and the minute cron deletes those of a checkout never
confirmed after three days.

## Amended 2026-11-23: the copy (stage 44 step 4, [ADR 0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md))
Whether an acceptance's copy went is kept beside it (`core_agreement_copy`, migration 0854); the
acceptance's own triggers are unchanged. A row a raw writer inserts still makes a copy, to the
address that row holds: the person named there hears of it, which is what the copy is for.
