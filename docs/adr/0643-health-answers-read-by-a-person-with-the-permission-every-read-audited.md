# ADR 0643: Health answers: read by a person with the permission, every read audited

Status: accepted, 2026-11-23 (stage 44, build step 2). Builds on
[ADR 0642](0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md),
[ADR 0019](0019-audit-redaction-for-erasure.md) (audit redaction), [ADR 0436](0436-pack-roles-and-the-door-role.md)
(pack roles) and [ADR 0449](0449-permissions-granted-one-by-one.md) (grants). Stage 44's spec,
"Health questions", decisions 5, 18 and 19.

## Context
A health form's answers are health information. A field on a Person or a record would put them in
every `rec_*` view, and so in `query.sql`, dashboards, exports, search, embeddings, summaries and
the assistant's reads. The coach on the floor needs to know to ask, but not what was answered.

## Decision
- **Their own table**, `core_agreement_answer` (migration 0851): the acceptance, the answers as
  JSON, `any_yes`, and `entered_by` for a paper form's answers typed in by staff. In no view;
  refused any update; deleted only once its acceptance is erased (decision 15: at once on erase).
- **Who reads them**: the person (and a guardian, for a dependant) in `me.agreements.get`; and
  `agreement.answers.get`: permission `agreements:health` (new; admins by default, grantable one
  by one), `actors: ["human"]`. No AI actor reads them with any grant, and an account holding a
  pack role reaches none of the core reads. There is no practitioner principal yet (stage 43);
  when there is, it is not given this permission.
- **Every read is audited**, a person's included: a new operation option, `auditReads: true`,
  makes the pipeline write an audit row for each successful read, holding `auditSummary`'s
  result (who read whose: the acceptance and the Person) and never the output. The option needs
  an `auditSummary` and a read.
- **No value in the audit, an error or a log**: the inputs that hold a name typed, a signature,
  answers, a paper form's signer or note are redacted (`redact`); the answers' and strokes'
  checks name the rule and the question key (the business's), never a value; errors carry no
  values.
- **The coach's mark** (decision 18): `agreement.healthNotes { personIds }` returns a yes or no
  per Person (a yes on their current health form). `actors: ["human", "extension"]`; pack code
  gets it only inside a tool a person called (the runner sets `startedBy`), so the assistant
  reading the same tool gets no mark. Bookings' `roster` and `classList` carry `healthNote`, and
  the class list blocks show "Health note" beside the name, nothing else.
- **A yes tells staff** who may read answers (decision 19), as an in-app notice whose words name
  no one and nothing of the form ("A member's health form needs a look"), linking to the Person,
  because a notice may also go out by email or Slack. The member can still book.

## Consequences
- The Person page's Agreements tab shows the answers behind "Show answers" for staff who hold the
  permission, asking once per click (each ask is a row in the audit).
- Stage 43's restrictions stay separate: neither feeds the other.

## Proof
`packages/core/test/agreement-acceptances.test.ts`, "health answers are isolated": a person with
the permission reads them and each read is an audit row with no value; a member without is
refused, granted reads them; every AI actor is refused the answers and the full acceptance, with
any grant, and the Person tab it may read has no mark and no value; pack code without a person
gets no mark; a pack-role coach is refused; the notice names nothing; `query.sql` refuses every
agreements table, no view names one, `search.global`, `export.csv` and the assistant's person
summary (the model's input) hold none of it, and no audit row of any operation does.
`packs/bookings/test/bookings.test.ts`: the roster's mark, and none when the host gives none.

## Amended 2026-11-23: the security review of PR #274

- **The notice names no Person**: no name, no id and no link to them, because an AI acting for a
  recipient reads their notices (`notification.list`). It sends staff to Settings → Agreements →
  Health forms, `agreement.healthReviews`: `agreements:health`, a person only, every read audited.
- **Marks for staff need the permission**: `agreement.healthNotes { personIds }` is now
  `agreements:health`, `actors: ["human"]`, every read audited; the Person tab shows the mark only
  to a caller who holds it.
- **Pack code names a list, not people**: `agreement.listHealthNotes` (actors `extension` only)
  reads the People itself from the calling pack's own object, and is refused unless a person
  called the tool themselves: a run started by a person's approval of another actor's call
  (`startedByApproval`, set by the runner) gets no mark. A runtime extension may not declare it.
  (As amended the same day, below: the list is declared in the manifest.)

## Amended 2026-11-23: the second review of PR #274

- **A notice for the person only.** `core_notifications.human_only` (migration 0851): a health
  "yes" notice sets it, and `notification.list`, `notification.unreadCount` and
  `notification.markRead` never list, count or mark it for a non-human actor. Its time matched the
  acceptance's, which an AI could read from `agreement.acceptances`. No other read of
  notifications exists (the digest and search do not read them; delivery to email or Slack is the
  person's own channel).
- **Audited reads are for people.** Every operation with `auditReads` is listed in
  `AUDITED_READS` (`operation.ts`), and `audit.list` returns none of their rows to a non-human
  actor: together they would list who answered yes.
- **What one guardian typed and drew is theirs.** `me.agreements.get` returns the name typed, the
  signature and which guardian agreed only to the one who agreed (a guardian, or the person for
  their own); another guardian, or the child, sees only that a parent or guardian agreed.
  `me.agreements.list` names the agent only to that agent. Health answers stay as above (a second
  live guardian reads them).
- **The list is declared.** An object declares `healthNotes: { list, person }` (the SDK; checked
  at install: `list` is a relation to one record of another object, `person` one to a Person).
  `agreement.listHealthNotes { records, value }` needs `value` to be a live record of the list's
  own object, reads only live records of the declaring object, and is audited on every call.
  Bookings declares `booking.healthNotes: { list: "class", person: "person" }`. A pack role's
  today-only limit holds on `value` as a record of the list's object (`pack-role-today.ts`), so a
  coach gets no marks for another day's class.

## Amended 2026-11-23: the copy and the signed PDF (stage 44 step 4, [ADR 0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md))
The emailed copy of a health form never holds the answers: the email gatekeeper's `agreement`
part has no field for them (only "in the app"). A downloaded PDF holds them for the person and a
guardian (`me.agreements.pdf`) and for staff with `agreements:health` (`agreement.acceptance.pdf`,
every download audited with no value in the row); staff without it get "withheld".
